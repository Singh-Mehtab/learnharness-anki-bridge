import { createHash, randomUUID } from 'node:crypto';
import type { PluginBackendContext } from '../../sdk/index.d.ts';
import type { PluginTaskSnapshot } from '../../sdk/src/core/plugin-workers.d.ts';
import type { ModelCatalogEntry } from '../../sdk/src/core/contracts/models.d.ts';
import { StateStore } from '../anki/state.ts';
import { DeliveryService } from '../anki/delivery.ts';
import { renderMarkdown } from '../anki/render.ts';
import { pack, sourcePassage, estimateTokens, outputAllowance } from '../writer/input.ts';
import { writerInstructions, writerPrompt } from '../writer/prompt.ts';
import { resultSchemaFor } from '../writer/schema.ts';
import { validateResult } from '../writer/validate.ts';
import type { Batch } from '../writer/input.ts';
import type { WriterInput, WriterResult } from '../writer/types.ts';
import { validGenerationSettings } from './types.ts';
import type { Generation, GenerationSettings, GenerationTask, SourceSnapshot } from './types.ts';

const WORKER = 'manual-card-writer';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const statementHash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an input object.');
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unsupported generation input.');
}
function nodeIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 1000 || v.some(id => typeof id !== 'string' || !id) || new Set(v).size !== v.length) throw new Error('Choose 1–1000 distinct nodes.');
  return v;
}
interface Prepared {
  binding: string;
  settings: GenerationSettings;
  model: ModelCatalogEntry;
  batches: Batch[];
  sources: SourceSnapshot[];
  skipped: { nodeId: string; reason: string }[];
}
interface Preflight { id: string; nodeIds: string[]; prepared: Prepared }

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
  private active(): void {
    if (this.closed || this.lifetime.signal.aborted) throw new Error('Anki Bridge is disabled.');
  }
  async activate(): Promise<void> {
    this.active();
    this.unregister = this.ctx.workers.register({ id: WORKER, instructions: writerInstructions(),
      resultSchema: resultSchemaFor() as unknown as Parameters<PluginBackendContext['workers']['register']>[0]['resultSchema'],
      validateResult: (result, context) => validateResult(result, context),
    });
    await this.delivery.exclusive(async () => {
      for (const g of this.store.snapshot().generations.filter(g => g.status === 'running')) {
        for (const t of g.tasks.filter(t => ['pending', 'running'].includes(t.status))) {
          const worker = this.findWorker(t);
          if (worker?.status === 'succeeded') await this.apply(g.id, t.requestId, worker);
          else {
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
    if (!w || w.definitionId !== WORKER || digest(w.input) !== digest(t.input)) return undefined;
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
    await this.delivery.save(s => {
      const g = s.generations.find(g => g.id === id)!;
      if (g.tasks.some(t => ['pending', 'running'].includes(t.status))) return;
      if (g.status === 'cancelled') return;
      g.status = g.tasks.some(t => t.status === 'cancelled') ? 'cancelled' : g.tasks.some(t => t.status === 'interrupted') ? 'interrupted' : g.tasks.some(t => t.status === 'failed') ? 'failed' : 'completed';
    });
  }
  private async apply(id: string, requestId: string, worker: PluginTaskSnapshot): Promise<void> {
    this.active();
    const task = this.generation(id).tasks.find(t => t.requestId === requestId)!;
    if (task.status === 'applied') return;
    try {
      if (worker.status !== 'succeeded' || worker.requestId !== requestId || worker.definitionId !== WORKER || digest(worker.input) !== digest(task.input)) throw new Error('Worker identity or input does not match this generation.');
      validateResult(worker.result, { input: task.input });
      const result = worker.result as WriterResult;
      for (const target of result.targets) for (const c of target.cards) { renderMarkdown(c.front); renderMarkdown(c.back); renderMarkdown(c.extra ?? ''); }
    } catch (error) {
      await this.patch(id, requestId, { status: 'failed', error: errorText(error) });
      return;
    }
    const result = worker.result as WriterResult;
    // Cards, the authoritative result and its application mark share one commit.
    await this.delivery.save(s => {
        const stored = s.generations.find(g => g.id === id)!.tasks.find(t => t.requestId === requestId)!;
        if (stored.status === 'applied') return;
        for (const target of result.targets) {
          const source = stored.sources.find(n => n.nodeId === target.nodeId)!;
          for (const c of target.cards) s.cards.push({ id: randomUUID(), nodeId: source.nodeId, nodeName: source.name,
            sessionId: source.sessionId, sessionName: source.sessionName, statementHash: source.statementHash,
            sourceSnapshot: source, generationId: id, requestId, kind: c.kind as import('../anki/state.ts').CardKind,
            front: c.front, back: c.back, extra: c.extra ?? '', status: 'draft' });
        }
        stored.taskId = worker.id; stored.status = 'applied'; stored.result = result; delete stored.error;
    });
  }
  private async prepare(ids: string[]): Promise<Prepared> {
    this.active();
    const settings = this.store.snapshot().generationSettings;
    if (!settings.model) throw new Error('Choose a model explicitly before preflight.');
    const catalog = await this.ctx.inference.catalog();
    this.active();
    const model = catalog.models.find(m => m.provider === settings.model!.provider && m.id === settings.model!.id);
    if (!model || !catalog.providers.some(p => p.id === model.provider && p.keyPresent)) throw new Error('The selected model is unavailable. Choose an available model; no fallback is used.');
    const graph = this.ctx.learning.graph();
    const cards = this.store.snapshot().cards.filter(c => c.status !== 'dropped');
    const sources: SourceSnapshot[] = [];
    for (const id of ids) {
      const n = graph.propositions.find(n => n.id === id);
      if (!n) throw new Error(`Selected node is missing: ${id}. Refresh the picker.`);
      const sessionId = n.provenance?.find(p => p.messageId)?.chatId ?? '';
      const session = sessionId ? this.ctx.learning.getSession(sessionId) : null;
      sources.push({ nodeId: id, name: n.name, statement: n.statement, statementHash: statementHash(n.statement),
        sessionId, sessionName: session?.title ?? '',
        source: sourcePassage(n, chatId => this.ctx.learning.getSession(chatId)) });
    }
    const packed = pack(graph, ids, id => ({ source: sources.find(s => s.nodeId === id)?.source,
      existingCards: cards.filter(c => c.nodeId === id).reverse().slice(0, 6).map(c => ({ kind: c.kind, front: c.front, back: c.back })) }),
    { maxCardsPerNode: settings.cardsPerNode, enabledKinds: settings.enabledKinds, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
    const batches: Batch[] = [], skipped = [...packed.skipped];
    // The pure packer budgets source material. Also account for prompt/schema overhead
    // and the growing output reserve when the selected model has known limits.
    const overhead = estimateTokens(writerInstructions() + JSON.stringify(resultSchemaFor()));
    for (const original of packed.batches) {
      let current: WriterInput = { ...original.input, targets: [] };
      const batch = (input: WriterInput): Batch => ({ input, inputTokens: estimateTokens(writerPrompt(input)) + overhead, outputAllowance: outputAllowance(input.targets.length, settings.cardsPerNode) });
      const fits = (b: Batch) => (model.contextWindow === null || b.inputTokens + b.outputAllowance <= model.contextWindow) && (model.maxTokens === null || b.outputAllowance <= model.maxTokens);
      for (const target of original.input.targets) {
        const next = batch({ ...current, targets: [...current.targets, target] });
        if (current.targets.length && !fits(next)) { batches.push(batch(current)); current = { ...current, targets: [] }; }
        const alone = batch({ ...current, targets: [...current.targets, target] });
        if (!fits(alone)) skipped.push({ nodeId: target.nodeId, reason: 'Model limits cannot fit this target, prompt and reserved output.' });
        else current = alone.input;
      }
      if (current.targets.length) batches.push(batch(current));
    }
    // Bind exactly what would be sent and spent: prompts, limits, model entry and skips.
    return { binding: digest({ batches, skipped, settings, model, sources }), settings, model, batches, skipped, sources };
  }
  private async preflight(ids: string[]): Promise<unknown> {
    const prepared = await this.prepare(ids), id = randomUUID();
    // Preflights are ephemeral confirmations, never autonomous durable work.
    if (this.preflights.size >= 32) this.preflights.delete(this.preflights.keys().next().value!);
    this.preflights.set(id, { id, nodeIds: ids, prepared });
    const inputTokens = prepared.batches.reduce((n, b) => n + b.inputTokens, 0);
    const outputTokens = prepared.batches.reduce((n, b) => n + b.outputAllowance, 0);
    return { preflightId: id, nodeIds: ids, nodeCount: ids.length, maximumCards: prepared.batches.reduce((n, b) => n + b.input.targets.length * prepared.settings.cardsPerNode, 0),
      inputTokens, outputTokens, estimatedCost: prepared.model.cost ? (inputTokens * prepared.model.cost.input + outputTokens * prepared.model.cost.output) / 1_000_000 : null,
      model: prepared.settings.model, settings: prepared.settings, skipped: prepared.skipped,
      batches: prepared.batches.map(b => ({ nodeIds: b.input.targets.map(t => t.nodeId), inputTokens: b.inputTokens, outputAllowance: b.outputAllowance })) };
  }
  async command(name: string, input: unknown = {}): Promise<unknown> {
    if (name === 'generationStatus') { this.active(); keys(object(input), []); return this.delivery.snapshot(); }
    return this.delivery.exclusive(async () => {
      this.active();
      const value = object(input);
      if (name === 'generationContext') {
        keys(value, []);
        const catalog = await this.ctx.inference.catalog(); this.active();
        return { nodes: this.ctx.learning.graph().propositions.map(({ id, name, statement }) => ({ id, name, statement })), catalog };
      }
      if (name === 'generationSettings') {
        keys(value, ['cardsPerNode', 'enabledKinds', 'model']);
        const settings = { ...this.store.snapshot().generationSettings, ...value };
        if (!validGenerationSettings(settings)) throw new Error('Choose 1–4 cards per node, one or more core kinds, and an explicit model or null.');
        await this.delivery.save(s => { s.generationSettings = settings; });
      } else if (name === 'preflight') {
        keys(value, ['nodeIds']); return this.preflight(nodeIds(value.nodeIds));
      } else if (name === 'retryGeneration') {
        keys(value, ['id']); const g = this.generation(value.id);
        if (g.status === 'running') throw new Error('Cancel or finish this generation before retrying.');
        const ids = g.tasks.filter(t => t.status !== 'applied').flatMap(t => t.input.targets.map(n => n.nodeId));
        if (!ids.length) throw new Error('No unfinished tasks to retry.');
        return this.preflight([...new Set(ids)]);
      } else if (name === 'generate') {
        keys(value, ['preflightId']);
        if (typeof value.preflightId !== 'string') throw new Error('Confirm a valid preflight ID.');
        if (this.store.snapshot().generations.some(g => g.id === value.preflightId)) return this.delivery.snapshot();
        if (this.store.snapshot().generations.some(g => g.status === 'running')) throw new Error('A generation is already running.');
        const p = this.preflights.get(value.preflightId);
        if (!p) throw new Error('Preflight expired. Run preflight again.');
        const fresh = await this.prepare(p.nodeIds);
        if (fresh.binding !== p.prepared.binding) throw new Error('Preflight is stale. Review a new preflight before generating.');
        if (!fresh.batches.length) throw new Error('No targets fit this preflight. Review the skipped reasons.');
        const g: Generation = { id: p.id, createdAt: new Date().toISOString(), status: 'running', nodeIds: p.nodeIds,
          settings: fresh.settings, skipped: fresh.skipped,
          tasks: fresh.batches.map(b => ({ requestId: randomUUID(), status: 'pending', input: b.input, outputAllowance: b.outputAllowance,
            sources: fresh.sources.filter(s => b.input.targets.some(t => t.nodeId === s.nodeId)) })) };
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
        if (g.status !== 'running') return this.delivery.snapshot();
        for (const t of g.tasks.filter(t => ['pending', 'running'].includes(t.status))) {
          const w = this.findWorker(t);
          if (w?.status === 'succeeded') await this.apply(g.id, t.requestId, w);
          else { if (w && ['queued', 'running'].includes(w.status)) this.ctx.workers.cancel(w.id);
            await this.patch(g.id, t.requestId, { status: 'cancelled', error: 'Cancelled by user. Finished tasks retain their drafts.' }); }
        }
        await this.delivery.save(s => { s.generations.find(x => x.id === g.id)!.status = 'cancelled'; });
      } else throw new Error('Unknown generation operation.');
      return this.delivery.snapshot();
    });
  }
  private drive(id: string): void {
    const driver = this.run(id).catch(async error => {
      if (this.closed || this.lifetime.signal.aborted) return;
      this.delivery.reportRecoveryError(error);
      // Never leave a batch 'running' without a driver: that would block new generations.
      try {
        await this.delivery.exclusive(async () => {
          this.active();
          for (const t of this.generation(id).tasks.filter(t => ['pending', 'running'].includes(t.status))) {
            const w = this.findWorker(t);
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
        if (this.generation(id).status !== 'running') return;
        const t = this.generation(id).tasks.find(t => t.status === 'pending');
        if (!t) { await this.finish(id); return; }
        let w: PluginTaskSnapshot;
        try {
          w = this.ctx.workers.start(WORKER, { requestId: t.requestId, input: t.input, prompt: writerPrompt(t.input),
            model: this.generation(id).settings.model!, purpose: 'user', maxTurns: 3, timeoutMs: 180_000,
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
      await this.delivery.exclusive(async () => {
        this.active(); const w = this.ctx.workers.get(taskId);
        const t = this.generation(id).tasks.find(t => t.taskId === taskId)!;
        if (t.status === 'applied' || !['running', 'pending'].includes(t.status)) return;
        if (w.status === 'succeeded') await this.apply(id, t.requestId, w);
        else await this.patch(id, t.requestId, { status: w.status === 'cancelled' ? 'cancelled' : w.status === 'interrupted' ? 'interrupted' : 'failed', error: w.error?.message ?? 'Worker did not return a complete result.' });
      }, true);
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

export const GENERATION_OPERATIONS = ['generationContext', 'generationSettings', 'preflight', 'generate', 'generationStatus', 'cancelGeneration', 'retryGeneration'] as const;
