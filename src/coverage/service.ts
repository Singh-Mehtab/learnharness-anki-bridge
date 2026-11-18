import { createHash } from 'node:crypto';
import type { PluginBackendContext } from '../../sdk/index.d.ts';
import type { State, StateStore } from '../anki/state.ts';
import type { DeliveryService } from '../anki/delivery.ts';
import { projectCoverage } from './flow.ts';
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
  snapshot(): CoverageContext {
    if (this.closed || this.ctx.signal.aborted) throw new Error('Anki Bridge is disabled.');
    return graphCoverage(this.ctx.learning.graph(), this.store.snapshot());
  }
  async command(name: string, input: unknown = {}): Promise<CoverageContext> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an input object.');
    const value = input as Record<string, unknown>;
    const allowed = name === 'coverageContext' ? [] : ['nodeId', 'statementHash'];
    if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported coverage input.');
    if (name === 'coverageContext') return this.snapshot();
    if (name !== 'dismissNode' && name !== 'restoreNode') throw new Error('Unknown coverage operation.');
    if (typeof value.nodeId !== 'string' || !value.nodeId || value.nodeId.length > 500 || value.nodeId.includes('\0') || typeof value.statementHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.statementHash)) throw new Error('Choose a current source node.');
    return this.delivery.exclusive(async () => {
      const view = this.snapshot(), node = view.nodes.find(n => n.id === value.nodeId);
      if (!node) throw new Error('Source node is missing from the returned snapshot. The host may have returned incomplete data. Refresh the graph.');
      if (node.statementHash !== value.statementHash) throw new Error('Source changed. Refresh before changing its dismissal.');
      if (name === 'dismissNode') {
        if (!node.coverage.canDismiss) throw new Error('Review or drop waiting cards, settle generation or delivery, or restore the existing dismissal first. Current sent coverage cannot be dismissed.');
        this.onChanged?.();
        await this.delivery.save(state => {
          state.dismissals = state.dismissals.filter(d => d.nodeId !== node.id);
          state.dismissals.push({ nodeId: node.id, statementHash: node.statementHash, dismissedAt: new Date().toISOString() });
        });
      } else {
        if (!node.coverage.dismissed) throw new Error('This statement has no current dismissal. Refresh the graph.');
        this.onChanged?.();
        await this.delivery.save(state => { state.dismissals = state.dismissals.filter(d => d.nodeId !== node.id); });
      }
      return this.snapshot();
    });
  }
}
