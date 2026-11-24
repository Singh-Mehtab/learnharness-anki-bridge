import { createHash, randomUUID } from 'node:crypto';
import type { PluginBackendContext } from '../../sdk/index.d.ts';
import type { PluginTaskSnapshot, PluginWorkerStartOptions } from '../../sdk/src/core/plugin-workers.d.ts';
import type { DeliveryService } from '../anki/delivery.ts';
import type { StateStore } from '../anki/state.ts';
import { isStoredKind, type WriterResult } from '../writer/types.ts';
import { validateResult } from '../writer/validate.ts';
import { assertDistinctReplacement, prepareRegeneration } from './request.ts';
import { canRegenerate, regenerationRevision, REWRITE_INSTRUCTION_LIMIT, type Regeneration, type Replacement } from './types.ts';

export const REGENERATION_OPERATIONS = ['regenerateCard', 'acceptRegeneration', 'keepOriginalCard', 'retryRegenerationResult'] as const;
type Operation = typeof REGENERATION_OPERATIONS[number];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const activeRequest = (r: Regeneration) => r.status === 'queued' || r.status === 'running';
const binding = (id: string, { input, prompt }: PluginWorkerStartOptions) =>
  createHash('sha256').update(JSON.stringify([id, input, prompt])).digest('hex');

/** Jobs and decisions share delivery's fence. The worker never writes cards. */
export class RegenerationService {
  private readonly lifetime = new AbortController();
  private readonly abort = () => this.lifetime.abort();
  private driver?: Promise<void>;
  private readonly ctx: PluginBackendContext;
  private readonly store: StateStore;
  private readonly delivery: DeliveryService;

  constructor(ctx: PluginBackendContext, store: StateStore, delivery: DeliveryService) {
    this.ctx = ctx; this.store = store; this.delivery = delivery;
    if (ctx.signal.aborted) this.abort(); else ctx.signal.addEventListener('abort', this.abort, { once: true });
  }
  private active(): void {
    if (this.lifetime.signal.aborted) throw new Error('Anki Bridge is disabled.');
  }
  private find(requestId: string): Regeneration | undefined {
    return this.store.snapshot().regenerations?.find(r => r.requestId === requestId);
  }
  private worker(r: Regeneration): PluginTaskSnapshot | undefined {
    return r.workerBinding ? this.ctx.workers.list().find(w => w.requestId === r.requestId && binding(w.definitionId, w) === r.workerBinding) : undefined;
  }
  private async patch(r: Regeneration, patch: Partial<Regeneration>): Promise<void> {
    await this.delivery.save(s => { Object.assign(s.regenerations!.find(x => x.requestId === r.requestId)!, patch); });
  }
  private cancel(worker: PluginTaskSnapshot | undefined): void {
    if (worker && (worker.status === 'queued' || worker.status === 'running')) {
      try { this.ctx.workers.cancel(worker.id); }
      catch (error) { this.delivery.reportGenerationRecoveryError(error); }
    }
  }
  async activate(): Promise<void> {
    await this.delivery.exclusive(async () => {
      this.active();
      for (const r of this.store.snapshot().regenerations ?? []) {
        if (!activeRequest(r) && r.status !== 'resultPending') continue;
        const worker = this.worker(r);
        if (worker?.status === 'succeeded') await this.recordResult(r, worker);
        else if (activeRequest(r)) {
          this.cancel(worker);
          await this.patch(r, { status: 'failed', error: 'The rewrite was interrupted. Keep the original to start a new rewrite.' });
        }
      }
    }, true);
  }
  async command(name: Operation, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a card rewrite request.');
    const value = input as Record<string, unknown>;
    const allowed = name === 'regenerateCard' ? ['id', 'revision', 'instruction'] : ['id', 'requestId'];
    if (typeof value.id !== 'string' || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid card rewrite request.');
    return this.delivery.exclusive(async () => {
      this.active();
      const state = this.store.snapshot(), card = state.cards.find(c => c.id === value.id);
      if (!card) throw new Error('Card not found.');
      const current = state.regenerations?.find(r => r.cardId === card.id);
      if (name === 'regenerateCard') {
        if (current) throw new Error('This card already has a rewrite request.');
        if (!canRegenerate(card)) throw new Error('Only an unsent draft with saved source and no unresolved delivery can be rewritten.');
        const revision = regenerationRevision(card);
        if (value.revision !== revision) throw new Error('This card changed. Refresh Review and start a new rewrite.');
        const instruction = value.instruction === undefined ? '' : typeof value.instruction === 'string' ? value.instruction.trim() : undefined;
        if (instruction === undefined || instruction.length > REWRITE_INSTRUCTION_LIMIT || instruction.includes('\0')) throw new Error(`Use a rewrite instruction of at most ${REWRITE_INSTRUCTION_LIMIT} characters.`);
        const request: Regeneration = { cardId: card.id, requestId: randomUUID(), revision, instruction, status: 'queued' };
        try { await this.delivery.save(s => { (s.regenerations ??= []).push(request); }); }
        finally { if (this.find(request.requestId)) this.kick(); }
      } else {
        if (!current || current.requestId !== value.requestId) throw new Error('This rewrite is no longer current. Refresh Review.');
        if (name === 'retryRegenerationResult') {
          if (current.status !== 'resultPending') throw new Error('This rewrite has no result waiting to be saved.');
          const worker = this.worker(current);
          if (worker?.status !== 'succeeded') throw new Error('The saved rewrite is unavailable. Keep the original to continue.');
          await this.recordResult(current, worker);
        } else if (name === 'acceptRegeneration') {
          if (current.status !== 'ready' || !current.replacement) throw new Error('The replacement is not ready.');
          if (!canRegenerate(card) || regenerationRevision(card) !== current.revision) throw new Error('The original changed. Keep the original to continue.');
          assertDistinctReplacement(state, card, current.replacement);
          const replacement = current.replacement;
          await this.delivery.save(s => {
            const stored = s.cards.find(c => c.id === card.id)!;
            delete stored.format;
            Object.assign(stored, replacement, { status: 'draft' });
            s.regenerations = s.regenerations!.filter(r => r.requestId !== current.requestId);
          });
        } else {
          await this.delivery.save(s => { s.regenerations = s.regenerations!.filter(r => r.requestId !== current.requestId); });
          // Clearing the request is authoritative even if the host cannot cancel.
          this.cancel(this.worker(current));
          this.kick();
        }
      }
      return this.delivery.snapshot();
    });
  }
  private kick(): void {
    if (this.driver || this.lifetime.signal.aborted) return;
    this.driver = this.run().then(() => {
      this.driver = undefined;
      // Requests can arrive as a drained driver releases its fence.
      if (this.store.snapshot().regenerations?.some(r => r.status === 'queued')) this.kick();
    }, error => {
      this.driver = undefined;
      if (!this.lifetime.signal.aborted) this.delivery.reportGenerationRecoveryError(error);
    });
  }
  private async run(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      const next = this.store.snapshot().regenerations?.find(r => r.status === 'queued');
      if (!next) return;
      try {
        const catalog = await this.ctx.inference.catalog();
        const worker = await this.delivery.exclusive(async () => {
          this.active();
          const state = this.store.snapshot(), r = state.regenerations?.find(r => r.requestId === next.requestId);
          if (r?.status !== 'queued') return;
          const card = state.cards.find(c => c.id === r.cardId)!;
          if (!canRegenerate(card) || regenerationRevision(card) !== r.revision) throw new Error('The original changed. Start a new rewrite.');
          const { definitionId, options } = prepareRegeneration(state, card, r, catalog);
          await this.patch(r, { status: 'running', workerBinding: binding(definitionId, options) });
          this.active();
          return this.ctx.workers.start(definitionId, options);
        }, true);
        if (!worker) continue;
        this.active();
        await this.ctx.workers.wait(worker.id, this.lifetime.signal);
        await this.delivery.exclusive(async () => {
          this.active();
          const r = this.find(next.requestId);
          if (!r || r.status !== 'running') return;
          const finished = this.ctx.workers.get(worker.id);
          if (finished.status === 'succeeded') await this.recordResult(r, finished);
          else await this.patch(r, { status: 'failed', error: finished.error?.message ?? 'The writer did not finish the rewrite.' });
        }, true);
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        await this.delivery.exclusive(async () => {
          this.active();
          const r = this.find(next.requestId);
          if (!r || !activeRequest(r)) return;
          const worker = this.worker(r);
          if (worker?.status === 'succeeded') await this.recordResult(r, worker);
          else {
            this.cancel(worker);
            await this.patch(r, { status: 'failed', error: errorText(error) });
          }
        }, true);
      }
    }
  }
  private async recordResult(r: Regeneration, worker: PluginTaskSnapshot): Promise<void> {
    let update: Partial<Regeneration>;
    try {
      if (worker.status !== 'succeeded' || worker.requestId !== r.requestId || binding(worker.definitionId, worker) !== r.workerBinding) throw new Error('The saved result does not match this rewrite request.');
      const state = this.store.snapshot(), card = state.cards.find(c => c.id === r.cardId)!;
      if (!canRegenerate(card) || regenerationRevision(card) !== r.revision) throw new Error('The original changed. Keep the original to continue.');
      validateResult(worker.result, { input: worker.input });
      const target = (worker.result as WriterResult).targets[0]!;
      const output = target.cards[0];
      if (!output) throw new Error(target.skipReason || 'The writer did not return a replacement.');
      const { kind, front, back, extra, format } = output;
      if (!isStoredKind(kind) || extra !== undefined && typeof extra !== 'string') throw new Error('The writer returned invalid card fields.');
      const replacement: Replacement = { kind, front, back, extra: extra ?? '', ...(format === 'cloze' ? { format } : {}) };
      assertDistinctReplacement(state, card, replacement);
      update = { status: 'ready', replacement, error: undefined };
    } catch (error) {
      update = { status: 'failed', error: errorText(error) };
    }
    try { await this.patch(r, update); }
    catch (error) {
      // A rename may have committed the comparison even if durability was not confirmed.
      const stored = this.find(r.requestId);
      if (stored?.status === 'ready' || stored?.status === 'failed') {
        this.delivery.reportGenerationRecoveryError(error);
        return;
      }
      await this.patch(r, { status: 'resultPending', error: 'The rewrite finished, but its result could not be saved. Retry saving without another model call, or keep the original.' });
    }
  }
  async close(): Promise<void> {
    this.abort();
    this.ctx.signal.removeEventListener('abort', this.abort);
    await this.driver;
  }
}
