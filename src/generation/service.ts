import { createHash, randomUUID } from 'node:crypto';
import type { PluginBackendContext, PluginModelSpec } from '../../sdk/index.d.ts';
import type { PluginTaskSnapshot } from '../../sdk/src/core/plugin-workers.d.ts';
import type { ModelCatalogEntry } from '../../sdk/src/core/contracts/models.d.ts';
import { StateStore } from '../anki/state.ts';
import { DeliveryService } from '../anki/delivery.ts';
import { renderMarkdown } from '../anki/render.ts';
import { DEFAULT_CHUNK_BUDGET, pack, sourcePassage, estimateTokens, targetsAllowance, trimTarget } from '../writer/input.ts';
import { writerInstructions, writerPrompt } from '../writer/prompt.ts';
import { resultSchemaFor } from '../writer/schema.ts';
import { validateResult } from '../writer/validate.ts';
import { clozeCardProblems } from '../writer/cloze.ts';
import { allowedKindsFor, capFor, minimumNeighbours } from '../writer/kinds.ts';
import { CORE_KINDS, isCoreKind, isStoredKind } from '../writer/types.ts';
import type { Batch } from '../writer/input.ts';
import type { WriterInput, WriterResult } from '../writer/types.ts';
import { activeCloze, MAX_BATCH_CONTEXT_TOKENS, normaliseWriterNotes, validGenerationSettings, WRITER_NOTES_LIMIT } from './types.ts';
import { replayBatchContext, selectBatchContext } from './batch-context.ts';
import type { EarlierRepeatSkipRef, Generation, GenerationSettings, GenerationTask, SourceSnapshot } from './types.ts';
import { addEarlierRepeatCandidates, indexEarlierRepeats, possibleEarlierRepeat } from './earlier-repeats.ts';
import { graphCoverage, statementHash } from '../coverage/service.ts';
import { MAX_SELECTED_NODES } from '../coverage/flow.ts';
import { flagRevision, type FlagReference } from '../session/flow.ts';
import { readFlagSelection, resolveFlags, type FlagScope, type FlagSelection } from './flag-selection.ts';
import { packNoteBatches, refsForBatch } from './note-batches.ts';
import { resolveWriterModel } from './writer-model.ts';

const WORKER = 'manual-card-writer';
/** Auto and prefer use the cloze definition. Off and tasks saved before cloze use WORKER. */
const CLOZE_WORKER = 'manual-card-writer-cloze';
type Definition = typeof WORKER | typeof CLOZE_WORKER;
export const definitionFor = (input: WriterInput): Definition => input.cloze ? CLOZE_WORKER : WORKER;
/** Instructions and schema per definition, built once. */
export const definitions = (): Record<Definition, { instructions: string; resultSchema: unknown }> => ({
  [WORKER]: { instructions: writerInstructions({ checkBatchDuplicates: true, earlierRepeats: true }), resultSchema: resultSchemaFor(undefined, { earlierRepeats: true }) },
  [CLOZE_WORKER]: { instructions: writerInstructions({ cloze: true, checkBatchDuplicates: true, earlierRepeats: true }), resultSchema: resultSchemaFor(undefined, { cloze: true, earlierRepeats: true }) },
});
/** A task saved by 0.9.0 or earlier has no definitionId: it ran on WORKER. */
const taskDefinition = (t: GenerationTask): string => t.definitionId ?? WORKER;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
class ResultSavePending extends Error {}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an input object.');
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unsupported generation input.');
}
function nodeIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_SELECTED_NODES || v.some(id => typeof id !== 'string' || !id) || new Set(v).size !== v.length) throw new Error('Choose 1–1000 distinct nodes.');
  return v;
}
function backfillIds(value: unknown, ids: readonly string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SELECTED_NODES || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !ids.includes(id))) throw new Error('Backfill targets must be a distinct subset of the selected nodes.');
  return ids.filter(id => value.includes(id));
}
interface Prepared {
  binding: string;
  settings: GenerationSettings;
  model: ModelCatalogEntry;
  /** What is sent: the override, or the host's cheap slot with its thinking level. */
  spec: PluginModelSpec;
  batches: (Batch & { batchContextTokens?: number; flagRefs?: FlagReference[] })[];
  sources: SourceSnapshot[];
  skipped: { nodeId: string; reason: string }[];
  skippedFlagRequests: { count: number; reason: string }[];
}
interface Preflight { id: string; nodeIds: string[]; backfillNodeIds: string[]; selection: FlagSelection; prepared: Prepared; repeatOverride?: EarlierRepeatSkipRef }

function settledStatus(g: Generation): Generation['status'] {
  if (g.status === 'cancelled' || g.tasks.some(t => t.status === 'pending' || t.status === 'running')) return g.status;
  if (g.tasks.some(t => t.status === 'cancelled')) return 'cancelled';
  if (g.tasks.some(t => t.status === 'interrupted')) return 'interrupted';
  if (g.tasks.some(t => t.status === 'failed')) return 'failed';
  return 'completed';
}

/** No model I/O here: only the host worker service starts bounded, explicitly confirmed calls. */
export class GenerationService {
  private readonly ctx: PluginBackendContext;
  private readonly store: StateStore;
  private readonly delivery: DeliveryService;
  private readonly preflights = new Map<string, Preflight>();
  private readonly lifetime = new AbortController();
  private readonly drivers = new Set<Promise<void>>();
  private unregister?: () => void;
  private closed = false;
  private readonly abort = () => { this.lifetime.abort(); };
  constructor(ctx: PluginBackendContext, store: StateStore, delivery: DeliveryService) {
    this.ctx = ctx; this.store = store; this.delivery = delivery;
    if (ctx.signal.aborted) this.abort(); else ctx.signal.addEventListener('abort', this.abort, { once: true });
    delivery.sourceStatements = () => new Map(ctx.learning.graph().propositions.map(n => [n.id, n.statement]));
  }
  /** Reversible coverage/pairing edits must not revive an earlier confirmation. */
  invalidatePreflights(): void { this.preflights.clear(); }
  private active(): void {
    if (this.closed || this.lifetime.signal.aborted) throw new Error('Anki Bridge is disabled.');
  }
  async activate(): Promise<void> {
    this.active();
    const defs = definitions();
    const unregister = (Object.keys(defs) as Definition[]).map(id => this.ctx.workers.register({ id, instructions: defs[id].instructions,
      resultSchema: defs[id].resultSchema as Parameters<PluginBackendContext['workers']['register']>[0]['resultSchema'],
      // Both validate against the task input: without a cloze mode, a cloze card is rejected (C2a).
      validateResult: (result, context) => validateResult(result, context),
    }));
    this.unregister = () => { for (const u of unregister) u(); };
    await this.delivery.exclusive(async () => {
      // A result-save retry can commit its tasks before the separate finish write.
      for (const g of this.store.snapshot().generations.filter(g => g.status === 'running' || g.tasks.some(t => t.resultPending)
        || (g.status === 'interrupted' && settledStatus(g) !== g.status))) {
        for (const t of g.tasks.filter(t => t.resultPending || (g.status === 'running' && ['pending', 'running'].includes(t.status)))) {
          const worker = this.findWorker(t);
          if (worker?.status === 'succeeded') await this.applyFinished(g.id, t.requestId, worker);
          else if (!t.resultPending) {
            if (worker && ['running', 'queued'].includes(worker.status)) this.ctx.workers.cancel(worker.id);
            await this.patch(g.id, t.requestId, { status: 'interrupted', error: 'Generation was interrupted. Retry requires a new preflight.' });
          }
        }
        await this.finish(g.id);
      }
    }, true);
  }
  private findWorker(t: GenerationTask): PluginTaskSnapshot | undefined {
    const w = this.ctx.workers.list().find(w => w.requestId === t.requestId);
    if (!w || w.definitionId !== taskDefinition(t) || digest(w.input) !== digest(t.input)) return undefined;
    return w;
  }
  private generation(id: unknown): Generation {
    const g = this.store.snapshot().generations.find(g => g.id === id);
    if (!g) throw new Error('Generation not found.');
    return g;
  }
  private async patch(id: string, requestId: string, patch: Partial<GenerationTask>): Promise<void> {
    await this.delivery.save(s => { const t = s.generations.find(g => g.id === id)!.tasks.find(t => t.requestId === requestId)!; Object.assign(t, patch); });
  }
  private async finish(id: string): Promise<void> {
    const current = this.generation(id);
    const status = settledStatus(current);
    if (current.status !== status) await this.delivery.save(s => { s.generations.find(g => g.id === id)!.status = status; });
  }
  private async applyFinished(id: string, requestId: string, worker: PluginTaskSnapshot): Promise<void> {
    try { await this.apply(id, requestId, worker); }
    catch (error) {
      this.active();
      const task = this.generation(id).tasks.find(t => t.requestId === requestId)!;
      // Rename may already have committed both cards and the applied mark.
      if (task.status === 'applied' || task.status === 'failed' && !task.resultPending) {
        this.delivery.reportGenerationRecoveryError(`The result was recorded, but saving reported an error: ${errorText(error)}`);
        return;
      }
      await this.markResultPending(id, requestId, worker);
    }
  }
  private async markResultPending(id: string, requestId: string, worker: PluginTaskSnapshot): Promise<void> {
    await this.patch(id, requestId, { taskId: worker.id, status: 'interrupted', resultPending: true,
      error: 'The model finished, but Anki Bridge could not save its result. Retry saving without another model call.' });
  }
  private async apply(id: string, requestId: string, worker: PluginTaskSnapshot): Promise<void> {
    this.active();
    const task = this.generation(id).tasks.find(t => t.requestId === requestId)!;
    if (task.status === 'applied') return;
    try {
      if (worker.status !== 'succeeded' || worker.requestId !== requestId || worker.definitionId !== taskDefinition(task) || digest(worker.input) !== digest(task.input)) throw new Error('Worker identity or input does not match this generation.');
      validateResult(worker.result, { input: task.input });
      const result = worker.result as WriterResult;
      for (const target of result.targets) for (const c of target.cards) {
        // A cloze back can be raw TeX, so cloze cards get the assembled check instead (C6).
        if (c.format === 'cloze') { const problems = clozeCardProblems(c); if (problems.length) throw new Error(problems.join(' ')); }
        else { renderMarkdown(c.front); renderMarkdown(c.back); }
        renderMarkdown(c.extra ?? '');
      }
    } catch (error) {
      await this.patch(id, requestId, { status: 'failed', resultPending: undefined, error: errorText(error) });
      return;
    }
    const result = worker.result as WriterResult;
    // Exact full content only, checked against live cards, never the previous raw
    // result. A user edit/drop cannot make an obsolete original block a new card.
    const currentHashes = new Map<string, string>();
    try { for (const n of this.ctx.learning.graph().propositions) currentHashes.set(n.id, statementHash(n.statement)); }
    catch { /* An unavailable graph prevents duplicate suppression, not recovery of valid cards. */ }
    const contentKey = (c: { kind: string; format?: string; front: string; back: string; extra?: string }) =>
      JSON.stringify([c.kind, c.format ?? 'basic', c.front, c.back, c.extra ?? '']);
    // Cards, omissions and the unfiltered worker result share one commit.
    await this.delivery.save(s => {
      const generation = s.generations.find(g => g.id === id)!;
      const stored = generation.tasks.find(t => t.requestId === requestId)!;
      if (stored.status === 'applied') return;
      // A changed draft may have suppressed a card even if the target still got other cards.
      if (stored.batchContextDigest && stored.batchContextDigest !== digest(replayBatchContext(generation, stored, s.cards))) {
        stored.taskId = worker.id; stored.status = 'failed'; delete stored.resultPending;
        stored.error = 'An earlier draft used to check for repeats changed while writing. Retry requires a new estimate.';
        return;
      }
      const earlier = indexEarlierRepeats(s.cards, { generationId: id });
      for (const target of result.targets) {
        if (target.earlierRepeatOf === undefined) continue;
        const candidate = stored.input.targets.find(t => t.nodeId === target.nodeId)?.earlierRepeatCandidates?.find(c => c.id === target.earlierRepeatOf);
        if (!candidate || !earlier.current(candidate)) {
          stored.taskId = worker.id; stored.status = 'failed'; delete stored.resultPending;
          stored.error = 'An earlier card used to skip writing changed or is no longer available. Retry requires a new estimate.';
          return;
        }
      }
      const matching = new Map<string, typeof s.cards>();
      for (const card of s.cards) {
        if (!card.requestId || card.requestId === requestId || currentHashes.get(card.nodeId) !== card.statementHash
          || !(card.status === 'draft' || card.status === 'approved')) continue;
        const key = contentKey(card), group = matching.get(key) ?? [];
        group.push(card);
        matching.set(key, group);
      }
      let omitted = 0;
      for (const target of result.targets) {
        const source = stored.sources.find(n => n.nodeId === target.nodeId)!;
        const input = stored.input.targets.find(n => n.nodeId === target.nodeId)!;
        const allowCrossNode = !input.flagged && !input.flagNote && !!source.sessionId;
        for (const c of target.cards) {
          if (!isStoredKind(c.kind)) throw new Error('Invalid card kind.');
          if (currentHashes.get(source.nodeId) === source.statementHash && matching.get(contentKey(c))?.some(other =>
            other.sessionId === source.sessionId && (other.nodeId === source.nodeId || allowCrossNode))) {
            omitted++;
            continue;
          }
          const possibleRepeatOf = possibleEarlierRepeat(c, input.earlierRepeatCandidates, earlier);
          s.cards.push({ id: randomUUID(), nodeId: source.nodeId, nodeName: source.name,
            sessionId: source.sessionId, sessionName: source.sessionName, statementHash: source.statementHash,
            sourceSnapshot: source, generationId: id, requestId, kind: c.kind, ...(c.format === 'cloze' ? { format: 'cloze' as const } : {}),
            front: c.front, back: c.back, extra: c.extra ?? '', status: 'draft', ...(possibleRepeatOf && { possibleRepeatOf }) });
        }
      }
      // Keep the completion after a card is dropped, but never resolve a newer flag revision.
      const current = new Set(stored.sources.filter(n => currentHashes.get(n.nodeId) === n.statementHash).map(n => n.nodeId));
      const drafted = new Set(result.targets.filter(t => t.cards.length && current.has(t.nodeId)).map(t => t.nodeId));
      // Each returned card was saved or matched to an exact duplicate above. A
      // changed source keeps its own request pending without reopening other candidates.
      const answered = new Set(result.targets.filter(t => t.cards.length).flatMap(t => t.flagMatches ?? []));
      const noted = new Set(stored.input.flagRequests?.map(r => r.id));
      for (const ref of stored.flagRefs ?? []) {
        const flag = s.flags.find(f => f.id === ref.id && flagRevision(f) === ref.revision);
        if (!flag || (noted.has(ref.id) && !answered.has(ref.id))) continue;
        const handled = new Map((flag.handledIdeas ?? []).map(n => [n.nodeId, n]));
        for (const source of stored.sources) {
          if (ref.nodeIds.includes(source.nodeId) && (noted.has(ref.id) ? current.has(source.nodeId) : drafted.has(source.nodeId))) {
            handled.set(source.nodeId, { nodeId: source.nodeId, statementHash: source.statementHash });
          }
        }
        if (handled.size) flag.handledIdeas = [...handled.values()].slice(-100_000);
      }
      stored.taskId = worker.id; stored.status = 'applied'; stored.result = result; delete stored.error; delete stored.resultPending;
      if (omitted) stored.duplicatesOmitted = omitted;
    });
  }

  private async prepare(ids: string[], backfillNodeIds: string[], selection: FlagSelection, writeAnyway?: true): Promise<Prepared> {
    this.active();
    // History stores the resolved mode, so a later default change can't rewrite it.
    const stored = this.store.snapshot().generationSettings, mode = activeCloze(stored);
    const settings: GenerationSettings = { ...stored, cloze: mode };
    const catalog = await this.ctx.inference.catalog();
    this.active();
    const { model, spec } = resolveWriterModel(catalog, settings);
    const graph = this.ctx.learning.graph();
    const state = this.store.snapshot(), coverage = graphCoverage(graph, state);
    const cards = state.cards.filter(c => c.status !== 'dropped');
    for (const id of ids) {
      const node = coverage.nodes.find(n => n.id === id);
      if (node && !node.coverage.selectable) throw new Error(`Node ${id} is dismissed, generating, or has unresolved delivery. Restore or settle it before generating.`);
      if (node && backfillNodeIds.includes(id) && !node.coverage.uncarded) throw new Error(`Backfill target ${id} is no longer uncarded. Refresh and explicitly reselect it for another angle.`);
    }
    const sources: SourceSnapshot[] = [];
    for (const id of ids) {
      const n = graph.propositions.find(n => n.id === id);
      if (!n) throw new Error(`Selected node is missing from the returned graph snapshot: ${id}. The host may have returned incomplete data. Refresh the picker.`);
      const sessionId = n.provenance?.find(p => p.messageId)?.chatId ?? '';
      const session = sessionId ? this.ctx.learning.getSession(sessionId) : null;
      sources.push({ nodeId: id, name: n.name, statement: n.statement, statementHash: statementHash(n.statement),
        sessionId, sessionName: session?.title ?? '',
        source: sourcePassage(n, chatId => this.ctx.learning.getSession(chatId)) });
    }
    const flags = resolveFlags(selection.scopes, state.flags, graph);
    const blank = new Set(flags.filter(f => !f.note).flatMap(f => f.nodeIds));
    const extrasFor = (id: string) => ({ source: sources.find(s => s.nodeId === id)?.source, flagged: blank.has(id),
      existingCards: cards.filter(c => c.nodeId === id).reverse().slice(0, 6).map(c => c.format !== 'cloze' ? { kind: c.kind, front: c.front, back: c.back }
        // Off mode's writer doesn't know the placeholder, so it sees the blank as [...].
        : mode === 'off' ? { kind: c.kind, front: c.front.replace('{{blank}}', '[...]'), back: c.back } : { kind: c.kind, front: c.front, back: c.back, format: 'cloze' as const }) });
    const base = { version: 1 as const, maxCardsPerNode: settings.cardsPerNode, enabledKinds: settings.enabledKinds,
      ...(mode === 'off' ? {} : { cloze: mode }), ...(settings.writerNotes ? { writerNotes: settings.writerNotes } : {}), ...(writeAnyway && { writeAnyway }) };
    const definition = definitions()[mode === 'off' ? WORKER : CLOZE_WORKER];
    const overhead = estimateTokens(definition.instructions + JSON.stringify(definition.resultSchema));
    const batch = (input: WriterInput): Batch => ({ input, inputTokens: estimateTokens(writerPrompt(input)) + overhead, outputAllowance: targetsAllowance(input.targets, settings.cardsPerNode) });
    const fits = (b: Batch) => (model.contextWindow === null || b.inputTokens + b.outputAllowance <= model.contextWindow) && (model.maxTokens === null || b.outputAllowance <= model.maxTokens);
    const noted = packNoteBatches({ graph, flags, independent: selection.independent, extrasFor, base, batch, fits });
    const ordinary = new Set(selection.independent);
    const ungrouped = ids.filter(id => !noted.assigned.has(id) && (blank.has(id) || ordinary.has(id)));
    // Noted groups and blank flags precede ordinary targets, so they get first claim on recall tasks.
    const orderedIds = [...ungrouped.filter(id => blank.has(id)), ...ungrouped.filter(id => !blank.has(id))];
    const packed = pack(graph, orderedIds, extrasFor, { ...base, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
    const batches: Prepared['batches'] = [], excluded = new Map([...noted.skipped, ...packed.skipped].map(s => [s.nodeId, s.reason]));
    const push = (next: Batch) => {
      const previous = batches.at(-1);
      if (previous && (previous.input.flagRequests || next.input.flagRequests)) {
        const joined = batch({ ...base, targets: [...previous.input.targets, ...next.input.targets],
          flagRequests: [...(previous.input.flagRequests ?? []), ...(next.input.flagRequests ?? [])] });
        if (fits(joined) && joined.inputTokens - overhead <= DEFAULT_CHUNK_BUDGET) {
          batches[batches.length - 1] = joined;
          return;
        }
      }
      batches.push(next);
    };
    for (const b of noted.batches) push(b);
    for (const original of packed.batches) {
      let current: WriterInput = { ...base, targets: [] };
      for (const target of original.input.targets) {
        const next = batch({ ...current, targets: [...current.targets, target] });
        if (current.targets.length && !fits(next)) { push(batch(current)); current = { ...current, targets: [] }; }
        if (fits(next)) { current = next.input; continue; }
        const withKinds = (candidate: typeof target) => ({ ...candidate, allowedKinds: allowedKindsFor(candidate, settings.enabledKinds) });
        const trimmed = trimTarget(target, candidate => {
          const node = withKinds(candidate);
          return node.allowedKinds.length > 0 && fits(batch({ ...current, targets: [node] }));
        }, minimumNeighbours(target, settings.enabledKinds));
        if (!trimmed) excluded.set(target.nodeId, 'Model limits cannot fit this target, prompt and reserved output.');
        else current = { ...current, targets: [withKinds(trimmed)] };
      }
      if (current.targets.length) push(batch(current));
    }
    for (const b of batches) {
      const refs = refsForBatch(flags, b.input);
      if (refs.length) b.flagRefs = refs;
    }
    // Earlier drafts don't exist at preflight. Reserve space within the model limit
    // without splitting a batch or skipping a target just to fit this context.
    for (const b of batches.slice(1)) {
      const available = model.contextWindow === null ? MAX_BATCH_CONTEXT_TOKENS : model.contextWindow - b.inputTokens - b.outputAllowance;
      const reserve = Math.min(MAX_BATCH_CONTEXT_TOKENS, Math.floor(available));
      if (reserve > 0) { b.batchContextTokens = reserve; b.inputTokens += reserve; }
    }
    // Add optional historical evidence after groups and same-run reserves are fixed.
    const earlier = indexEarlierRepeats(state.cards);
    const sourceText = new Map(sources.map(source => [source.nodeId, source]));
    for (const b of batches) {
      const reserve = b.batchContextTokens ?? 0;
      const original = b.inputTokens - reserve;
      const limit = Math.min(DEFAULT_CHUNK_BUDGET + overhead,
        model.contextWindow === null ? Infinity : model.contextWindow - b.outputAllowance - reserve);
      if (limit <= original) continue;
      b.input = addEarlierRepeatCandidates(b.input, earlier, input => batch(input).inputTokens <= limit, sourceText);
      b.inputTokens = batch(b.input).inputTokens + reserve;
    }
    // Bind the initial input, bounded reserve, model entry and skips.
    const coverageBinding = { destination: state.destination, nodes: coverage.nodes.filter(n => ids.includes(n.id)),
      dismissals: state.dismissals.filter(d => ids.includes(d.nodeId)) };
    const scheduled = new Set(batches.flatMap(b => b.input.targets.map(t => t.nodeId)));
    const skipped = [...excluded].filter(([nodeId]) => !scheduled.has(nodeId)).map(([nodeId, reason]) => ({ nodeId, reason }));
    const { skippedFlagRequests } = noted;
    return { binding: digest({ batches, skipped, skippedFlagRequests, settings, model, spec, sources, coverageBinding, backfillNodeIds, flags, selection }), settings, model, spec, batches, skipped, skippedFlagRequests, sources };
  }
  private async preflight(ids: string[], backfillNodeIds: string[], selection: FlagSelection, repeatOverride?: EarlierRepeatSkipRef): Promise<unknown> {
    const prepared = await this.prepare(ids, backfillNodeIds, selection, repeatOverride && true), id = randomUUID();
    // Preflights are ephemeral confirmations, never autonomous durable work.
    if (this.preflights.size >= 32) this.preflights.delete(this.preflights.keys().next().value!);
    this.preflights.set(id, { id, nodeIds: ids, backfillNodeIds, selection, prepared, repeatOverride });
    const inputTokens = prepared.batches.reduce((n, b) => n + b.inputTokens, 0);
    const outputTokens = prepared.batches.reduce((n, b) => n + b.outputAllowance, 0);
    return { preflightId: id, nodeIds: ids, backfillNodeIds, nodeCount: ids.length, maximumCards: prepared.batches.reduce((n, b) => n + b.input.targets.reduce((sum, target) => sum + capFor(target, b.input.maxCardsPerNode), 0), 0),
      inputTokens, outputTokens, estimatedCost: prepared.model.cost ? (inputTokens * prepared.model.cost.input + outputTokens * prepared.model.cost.output) / 1_000_000 : null,
      model: prepared.spec, modelName: prepared.model.name, followsCheapSlot: !prepared.settings.model, settings: prepared.settings, skipped: prepared.skipped,
      ...(prepared.skippedFlagRequests.length && { skippedFlagRequests: prepared.skippedFlagRequests }),
      earlierRepeatCandidateCount: prepared.batches.reduce((n, b) => n + b.input.targets.reduce((sum, t) => sum + (t.earlierRepeatCandidates?.length ?? 0), 0), 0),
      batches: prepared.batches.map(b => ({ nodeIds: b.input.targets.map(t => t.nodeId), inputTokens: b.inputTokens, outputAllowance: b.outputAllowance })) };
  }
  private checkRepeatOverride(ref: EarlierRepeatSkipRef): void {
    const generations = this.store.snapshot().generations;
    const original = generations.find(g => g.id === ref.generationId);
    const task = original?.tasks.find(t => t.requestId === ref.requestId && t.status === 'applied');
    if (original?.status === 'running' || !task?.result?.targets.some(t => t.nodeId === ref.nodeId && t.earlierRepeatOf)) throw new Error('Choose a previously skipped idea after its write finishes.');
    if (generations.some(g => g.repeatOverride?.generationId === ref.generationId && g.repeatOverride.requestId === ref.requestId && g.repeatOverride.nodeId === ref.nodeId && g.tasks.some(t => t.status === 'applied' || t.resultPending))) {
      throw new Error('This idea already has a Write anyway result.');
    }
  }
  async command(name: string, input: unknown = {}): Promise<unknown> {
    if (name === 'generationStatus') { this.active(); keys(object(input), []); return this.delivery.snapshot(); }
    if (name === 'writerModelLevels') {
      this.active();
      const value = object(input); keys(value, ['provider', 'id']);
      const catalog = await this.ctx.inference.catalog(); this.active();
      return catalog.models.find(m => m.provider === value.provider && m.id === value.id)?.supportedLevels ?? [];
    }
    return this.delivery.exclusive(async () => {
      this.active();
      const value = object(input);
      if (name === 'generationContext') {
        keys(value, []);
        const catalog = await this.ctx.inference.catalog(); this.active();
        return { ...graphCoverage(this.ctx.learning.graph(), this.store.snapshot()), catalog };
      }
      if (name === 'generationSettings') {
        keys(value, ['cardsPerNode', 'enabledKinds', 'model', 'toggleKind', 'cloze', 'writerNotes']);
        const { toggleKind, writerNotes, ...patch } = value;
        const settings: Record<string, unknown> & GenerationSettings = { ...this.store.snapshot().generationSettings, ...patch };
        if (writerNotes !== undefined) {
          // #54: blank clears the notes. The limit applies to the saved, trimmed text.
          if (typeof writerNotes !== 'string') throw new Error('Writer notes must be text.');
          const notes = normaliseWriterNotes(writerNotes);
          if ((notes?.length ?? 0) > WRITER_NOTES_LIMIT) throw new Error(`Writer notes can be at most ${WRITER_NOTES_LIMIT.toLocaleString('en-GB')} characters.`);
          if (notes === undefined) delete settings.writerNotes; else settings.writerNotes = notes;
        }
        if (toggleKind !== undefined) {
          // One checkbox change, applied to the saved set inside the fence, so Write and Settings can't undo each other.
          const t = object(toggleKind); keys(t, ['kind', 'enabled']);
          if ('enabledKinds' in patch || !isCoreKind(t.kind) || typeof t.enabled !== 'boolean') throw new Error('Unsupported generation input.');
          settings.enabledKinds = CORE_KINDS.filter(k => k === t.kind ? t.enabled : settings.enabledKinds.includes(k));
          if (!settings.enabledKinds.length) throw new Error('Keep at least one card type on.');
        }
        if (!validGenerationSettings(settings)) throw new Error('Choose 1–4 cards per node, one or more available card types, a cloze setting, and a model, or null for the cheap model.');
        if ('model' in patch && settings.model?.thinkingLevel !== undefined) {
          const { provider, id, thinkingLevel } = settings.model;
          const catalog = await this.ctx.inference.catalog(); this.active();
          const model = catalog.models.find(m => m.provider === provider && m.id === id);
          if (!model?.supportedLevels?.includes(thinkingLevel)) throw new Error('That model does not support the selected reasoning level.');
        }
        // Changes that affect the writer invalidate a previously prepared estimate.
        const sent = (s: GenerationSettings) => JSON.stringify([activeCloze(s), s.writerNotes ?? '', s.model]);
        const before = sent(this.store.snapshot().generationSettings);
        try { await this.delivery.save(s => { s.generationSettings = settings; }); }
        finally { if (sent(this.store.snapshot().generationSettings) !== before) this.preflights.clear(); }
      } else if (name === 'preflight') {
        keys(value, ['nodeIds', 'backfillNodeIds', 'flagScopes', 'independentNodeIds']);
        const ids = nodeIds(value.nodeIds), backfill = backfillIds(value.backfillNodeIds, ids);
        return this.preflight(ids, backfill, readFlagSelection(value.flagScopes, value.independentNodeIds, ids, backfill));
      } else if (name === 'preflightWriteAnyway') {
        keys(value, ['generationId', 'requestId', 'nodeId']);
        const g = this.generation(value.generationId);
        const nodeId = value.nodeId, task = g.tasks.find(t => t.requestId === value.requestId);
        if (typeof nodeId !== 'string' || !task) throw new Error('Choose a previously skipped idea.');
        const ref = { generationId: g.id, requestId: task.requestId, nodeId };
        this.checkRepeatOverride(ref);
        const scopes = (task.flagRefs ?? []).filter(f => f.nodeIds.includes(nodeId)).map(f => ({ id: f.id, revision: f.revision, nodeIds: [nodeId] }));
        return this.preflight([nodeId], (g.backfillNodeIds ?? []).filter(id => id === nodeId),
          { scopes, independent: (g.independentNodeIds ?? g.nodeIds).filter(id => id === nodeId) }, ref);
      } else if (name === 'retryGeneration') {
        keys(value, ['id']); const g = this.generation(value.id);
        if (g.status === 'running') throw new Error('Cancel or finish this generation before retrying.');
        // Also recover interrupted batches written by older versions when their host result still exists.
        const recoverable = g.tasks.filter(t => t.status === 'interrupted').map(task => ({ task, worker: this.findWorker(task) }))
          .filter(({ task, worker }) => task.resultPending || worker?.status === 'succeeded');
        if (recoverable.length) {
          if (recoverable.some(({ worker }) => worker?.status !== 'succeeded')) throw new Error('The saved worker result is unavailable. No model call was started. You can abandon the unavailable result to select those ideas again.');
          for (const { task, worker } of recoverable) await this.applyFinished(g.id, task.requestId, worker!);
          await this.finish(g.id);
          return { recovery: true, snapshot: this.delivery.snapshot(false) };
        }
        const unfinished = g.tasks.filter(t => t.status !== 'applied');
        const selected = [...new Set(unfinished.flatMap(t => t.input.targets.map(n => n.nodeId)))];
        if (!selected.length) throw new Error('No unfinished tasks to retry.');
        const scopes = new Map<string, FlagScope>();
        const live = new Map(this.store.snapshot().flags.map(f => [f.id, flagRevision(f)]));
        if (g.independentNodeIds) for (const task of unfinished) for (const ref of task.flagRefs ?? []) {
          if (live.get(ref.id) !== ref.revision) throw new Error('A flag changed since this run. Select it again to get a new estimate.');
          const prior = scopes.get(ref.id)?.nodeIds ?? [];
          scopes.set(ref.id, { id: ref.id, nodeIds: [...new Set([...prior, ...ref.nodeIds])] });
        }
        return this.preflight(selected, (g.backfillNodeIds ?? []).filter(id => selected.includes(id)),
          { scopes: [...scopes.values()], independent: selected.filter(id => (g.independentNodeIds ?? selected).includes(id)) }, g.repeatOverride);
      } else if (name === 'abandonGenerationResult') {
        keys(value, ['id', 'confirmed']); const g = this.generation(value.id);
        if (value.confirmed !== true) throw new Error('Confirm abandoning the unavailable result.');
        if (g.status === 'running') throw new Error('Cancel or finish this generation before abandoning a result.');
        const unavailable = new Set(g.tasks.filter(t => t.resultPending && this.findWorker(t)?.status !== 'succeeded').map(t => t.requestId));
        if (!unavailable.size) throw new Error('No pending result is unavailable. If a result is pending, retry saving it.');
        // Do not let an estimate from before this generation become usable again.
        this.invalidatePreflights();
        await this.delivery.save(s => {
          const stored = s.generations.find(x => x.id === g.id)!;
          for (const task of stored.tasks.filter(t => unavailable.has(t.requestId))) {
            delete task.resultPending;
            task.status = 'failed';
            task.error = 'The unavailable result was abandoned. Generating cards for these ideas requires a new preflight.';
          }
          stored.status = settledStatus(stored);
        });
      } else if (name === 'generate') {
        keys(value, ['preflightId']);
        if (typeof value.preflightId !== 'string') throw new Error('Confirm a valid preflight ID.');
        if (this.store.snapshot().generations.some(g => g.id === value.preflightId)) return this.delivery.snapshot(false);
        if (this.store.snapshot().generations.some(g => g.status === 'running')) throw new Error('A generation is already running.');
        const p = this.preflights.get(value.preflightId);
        if (!p) throw new Error('Preflight expired. Run preflight again.');
        if (p.repeatOverride) this.checkRepeatOverride(p.repeatOverride);
        const fresh = await this.prepare(p.nodeIds, p.backfillNodeIds, p.selection, p.repeatOverride && true);
        if (fresh.binding !== p.prepared.binding) throw new Error('Preflight is stale. Review a new preflight before generating.');
        if (!fresh.batches.length) throw new Error('No targets fit this preflight. Review the skipped reasons.');
        const g: Generation = { id: p.id, createdAt: new Date().toISOString(), status: 'running', nodeIds: p.nodeIds, backfillNodeIds: p.backfillNodeIds,
          independentNodeIds: p.selection.independent, settings: fresh.settings, modelSpec: fresh.spec, skipped: fresh.skipped,
          ...(p.repeatOverride && { repeatOverride: p.repeatOverride }),
          tasks: fresh.batches.map(b => ({ requestId: randomUUID(), definitionId: definitionFor(b.input), status: 'pending', input: b.input, outputAllowance: b.outputAllowance,
            ...(b.batchContextTokens ? { batchContextTokens: b.batchContextTokens } : {}), ...(b.flagRefs ? { flagRefs: b.flagRefs } : {}), sources: fresh.sources.filter(s => b.input.targets.some(t => t.nodeId === s.nodeId)) })) };
        try { await this.delivery.save(s => { s.generations.push(g); }); }
        catch (error) {
          // The snapshot can be committed even if a later fsync throws; drive it so it cannot stay stuck.
          if (this.store.snapshot().generations.some(x => x.id === g.id)) { this.preflights.delete(p.id); this.drive(g.id); }
          throw error;
        }
        this.preflights.delete(p.id);
        this.drive(g.id);
      } else if (name === 'cancelGeneration') {
        keys(value, ['id']); const g = this.generation(value.id);
        if (g.status !== 'running') return this.delivery.snapshot(false);
        for (const t of g.tasks.filter(t => ['pending', 'running'].includes(t.status))) {
          const w = this.findWorker(t);
          if (w?.status === 'succeeded') await this.applyFinished(g.id, t.requestId, w);
          else { if (w && ['queued', 'running'].includes(w.status)) this.ctx.workers.cancel(w.id);
            await this.patch(g.id, t.requestId, { status: 'cancelled', error: 'Cancelled by user. Finished tasks retain their drafts.' }); }
        }
        await this.delivery.save(s => { s.generations.find(x => x.id === g.id)!.status = 'cancelled'; });
      } else if (name === 'dismissGeneration') {
        // Hides a finished batch from the page. Its drafts, skips and history stay.
        keys(value, ['id']); const g = this.generation(value.id);
        if (g.status === 'running') throw new Error('Cancel or finish this generation before dismissing it.');
        if (g.tasks.some(t => t.resultPending)) throw new Error('Save or abandon the pending result before dismissing this generation.');
        await this.delivery.save(s => { s.generations.find(x => x.id === g.id)!.hidden = true; });
      } else throw new Error('Unknown generation operation.');
      return this.delivery.snapshot(false);
      // A card-type toggle is a short merge, so it queues behind the current writer
      // instead of failing busy when Write and Settings save at the same moment.
    }, name === 'generationSettings' && !!input && typeof input === 'object' && 'toggleKind' in input);
  }
  private drive(id: string): void {
    const driver = this.run(id).catch(async error => {
      if (this.closed || this.lifetime.signal.aborted) return;
      // Review derives this warning from the pending task rather than latching it here.
      if (!(error instanceof ResultSavePending)) this.delivery.reportGenerationRecoveryError(error);
      // Never leave a batch 'running' without a driver: that would block new generations.
      try {
        await this.delivery.exclusive(async () => {
          this.active();
          for (const t of this.generation(id).tasks.filter(t => ['pending', 'running'].includes(t.status))) {
            const w = this.findWorker(t);
            if (w?.status === 'succeeded') { await this.markResultPending(id, t.requestId, w); continue; }
            if (w && ['queued', 'running'].includes(w.status)) this.ctx.workers.cancel(w.id);
            await this.patch(id, t.requestId, { status: 'interrupted', error: `Generation stopped: ${errorText(error)} Retry requires a new preflight.` });
          }
          await this.finish(id);
        }, true);
      } catch { /* Activation recovery handles it next time. */ }
    });
    this.drivers.add(driver); void driver.finally(() => this.drivers.delete(driver));
  }
  private async run(id: string): Promise<void> {
    while (!this.closed && !this.lifetime.signal.aborted) {
      const taskId = await this.delivery.exclusive(async () => {
        this.active();
        const generation = this.generation(id);
        if (generation.status !== 'running') return;
        const t = generation.tasks.find(t => t.status === 'pending');
        if (!t) { await this.finish(id); return; }
        const { prompt: earlierDrafts, ids } = selectBatchContext(generation, t, this.store.snapshot().cards);
        // Record what the model saw before acceptance, so recovery after a crash can check it too.
        if (earlierDrafts || t.batchContextDigest) await this.patch(id, t.requestId, {
          batchContextDigest: earlierDrafts ? digest(earlierDrafts) : undefined,
          batchContextCardIds: earlierDrafts ? ids : undefined,
        });
        this.active();
        let w: PluginTaskSnapshot;
        try {
          w = this.ctx.workers.start(taskDefinition(t), { requestId: t.requestId, input: t.input, prompt: writerPrompt(t.input) + earlierDrafts,
            model: generation.modelSpec ?? generation.settings.model!, purpose: 'user', maxTurns: 3, timeoutMs: 180_000,
            options: { maxTokens: t.outputAllowance } as Parameters<PluginBackendContext['workers']['start']>[1]['options'] });
        } catch (error) { await this.patch(id, t.requestId, { status: 'failed', error: errorText(error) }); return null; }
        await this.patch(id, t.requestId, { taskId: w.id, status: 'running' });
        return w.id;
      }, true);
      if (taskId === undefined) return;
      if (taskId === null) continue;
      // Disable may land between start and wait; never wait on an already-aborted lifetime.
      this.active();
      await this.ctx.workers.wait(taskId, this.lifetime.signal);
      this.active();
      const resultPending = await this.delivery.exclusive(async () => {
        this.active(); const w = this.ctx.workers.get(taskId);
        const t = this.generation(id).tasks.find(t => t.taskId === taskId)!;
        if (t.status === 'applied' || !['running', 'pending'].includes(t.status)) return;
        if (w.status === 'succeeded') {
          await this.applyFinished(id, t.requestId, w);
          return this.generation(id).tasks.some(t => t.resultPending);
        }
        await this.patch(id, t.requestId, { status: w.status === 'cancelled' ? 'cancelled' : w.status === 'interrupted' ? 'interrupted' : 'failed', error: w.error?.message ?? 'Worker did not return a complete result.' });
      }, true);
      if (resultPending) throw new ResultSavePending('A finished result could not be saved.');
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.abort();
    this.ctx.signal.removeEventListener('abort', this.abort);
    this.preflights.clear();
    try { this.unregister?.(); } finally { await Promise.all(this.drivers); }
  }
}

export const GENERATION_OPERATIONS = ['generationContext', 'generationSettings', 'writerModelLevels', 'preflight', 'preflightWriteAnyway', 'generate', 'generationStatus', 'cancelGeneration', 'retryGeneration', 'abandonGenerationResult', 'dismissGeneration'] as const;
