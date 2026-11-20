import { createHash } from 'node:crypto';
import type { PluginBackendContext } from '../../sdk/index.d.ts';
import type { State, StateStore } from '../anki/state.ts';
import type { DeliveryService } from '../anki/delivery.ts';
import { isUnsentRecord, projectCoverage } from './flow.ts';
import type { CoverageContext } from './flow.ts';

export const COVERAGE_OPERATIONS = ['coverageContext', 'dismissNode', 'restoreNode'] as const;
export const statementHash = (statement: string): string => createHash('sha256').update(statement).digest('hex');
export function graphCoverage(graph: { propositions: readonly { id: string; name: string; statement: string }[] }, state: State): CoverageContext {
  return projectCoverage(graph.propositions.map(n => ({ id: n.id, name: n.name, statement: n.statement, statementHash: statementHash(n.statement) })), state);
}

/** Graph reads never catch failures as an empty graph. Mutations share delivery's writer fence. */
export class CoverageService {
  private closed = false;
  onChanged?: () => void;
  private readonly ctx: PluginBackendContext;
  private readonly store: StateStore;
  private readonly delivery: DeliveryService;
  constructor(ctx: PluginBackendContext, store: StateStore, delivery: DeliveryService) {
    this.ctx = ctx; this.store = store; this.delivery = delivery;
  }
  close(): void { this.closed = true; }
  private readGraph() {
    if (this.closed || this.ctx.signal.aborted) throw new Error('Anki Bridge is disabled.');
    return this.ctx.learning.graph();
  }
  snapshot(): CoverageContext { return graphCoverage(this.readGraph(), this.store.snapshot()); }
  async command(name: string, input: unknown = {}): Promise<CoverageContext> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an input object.');
    const value = input as Record<string, unknown>;
    const allowed = name === 'coverageContext' ? [] : ['nodeId', 'statementHash'];
    if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported coverage input.');
    if (name === 'coverageContext') return this.snapshot();
    if (name !== 'dismissNode' && name !== 'restoreNode') throw new Error('Unknown coverage operation.');
    if (typeof value.nodeId !== 'string' || !value.nodeId || value.nodeId.length > 500 || value.nodeId.includes('\0') || typeof value.statementHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.statementHash)) throw new Error('Choose a current source node.');
    return this.delivery.exclusive(async () => {
      const graph = this.readGraph();
      const state = this.store.snapshot();
      const node = graphCoverage(graph, state).nodes.find(n => n.id === value.nodeId);
      if (!node) throw new Error('Source idea is missing. Refresh the graph.');
      if (node.statementHash !== value.statementHash) throw new Error('Idea changed. Refresh first.');
      if (name === 'dismissNode') {
        if (!node.coverage.canDismiss) {
          if (node.coverage.dismissed) throw new Error('Idea is already dismissed. Refresh the graph.');
          if (node.coverage.generating) {
            const hasPendingResult = state.generations.some(g => g.tasks.some(t => t.resultPending && t.input.targets.some(target => target.nodeId === node.id)));
            if (hasPendingResult) throw new Error('Use Retry saving before dismissing this idea. If the result is unavailable, use Abandon unavailable result.');
            throw new Error('Wait for card writing to finish before dismissing this idea.');
          }
          if (node.coverage.unresolved) throw new Error('Use Check unconfirmed sends before dismissing this idea.');
          if (state.cards.some(c => c.nodeId === node.id && isUnsentRecord(c))) throw new Error('Review or drop waiting cards before dismissing this idea.');
          throw new Error('This destination has sent cards for this idea version, or sent cards with no saved version.');
        }
        this.onChanged?.();
        await this.delivery.save(state => {
          state.dismissals = state.dismissals.filter(d => d.nodeId !== node.id);
          state.dismissals.push({ nodeId: node.id, statementHash: node.statementHash, dismissedAt: new Date().toISOString() });
        });
      } else {
        if (!node.coverage.dismissed) throw new Error('Idea is not dismissed. Refresh the graph.');
        this.onChanged?.();
        await this.delivery.save(state => { state.dismissals = state.dismissals.filter(d => d.nodeId !== node.id); });
      }
      return graphCoverage(graph, this.store.snapshot());
    });
  }
}
