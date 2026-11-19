import assert from 'node:assert/strict';
import type { PluginBackendContext } from '../sdk/index.d.ts';
import type { PluginTaskSnapshot, PluginWorkerStartOptions } from '../sdk/src/core/plugin-workers.d.ts';

type Snapshot = PluginTaskSnapshot;
/** In-memory stand-in for the host worker service. Records survive plugin restarts, like host history. */
export class FakeWorkers {
  readonly tasks = new Map<string, Snapshot>();
  readonly starts: PluginWorkerStartOptions[] = [];
  readonly cancelled: string[] = [];
  registered = 0;
  private waiters = new Map<string, Array<() => void>>();
  private next = 1;
  register(): () => void { this.registered++; return () => { this.registered--; }; }
  start(definitionId: string, options: PluginWorkerStartOptions): Snapshot {
    const existing = [...this.tasks.values()].find(t => t.requestId === options.requestId);
    if (existing) return structuredClone(existing);
    this.starts.push(structuredClone(options));
    const now = new Date().toISOString();
    const task = { ...structuredClone(options), version: 1, id: `task-${this.next++}`, definitionId, createdAt: now, updatedAt: now,
      status: 'running', messages: [], turns: 0 } as Snapshot;
    this.tasks.set(task.id, task);
    return structuredClone(task);
  }
  list(): Snapshot[] { return [...this.tasks.values()].map(t => structuredClone(t)); }
  get(id: string): Snapshot { const t = this.tasks.get(id); assert(t, `unknown task ${id}`); return structuredClone(t); }
  wait(id: string, signal?: AbortSignal) {
    const t = this.get(id);
    const outcome = () => { const s = this.get(id); return s.status === 'succeeded' ? { id, status: 'succeeded' as const, result: s.result } : { id, status: s.status as 'failed', error: s.error! }; };
    if (!['queued', 'running'].includes(t.status)) return Promise.resolve(outcome());
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    return new Promise<ReturnType<typeof outcome>>((resolve, reject) => {
      const done = () => resolve(outcome());
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  }
  cancel(id: string): void { this.cancelled.push(id); this.settle(id, { status: 'cancelled', error: { code: 'cancelled', message: 'Cancelled.' } }); }
  succeed(id: string, result: unknown): void { this.settle(id, { status: 'succeeded', result }); }
  fail(id: string, message = 'Model failed.'): void { this.settle(id, { status: 'failed', error: { code: 'run_error', message } }); }
  /** Host disable interrupts unfinished tasks. */
  interruptAll(): void { for (const t of this.tasks.values()) if (['queued', 'running'].includes(t.status)) Object.assign(t, { status: 'interrupted', error: { code: 'interrupted', message: 'Interrupted.' } }); }
  private settle(id: string, patch: Partial<Snapshot>): void {
    const t = this.tasks.get(id)!;
    if (!['queued', 'running'].includes(t.status)) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    for (const done of this.waiters.get(id) ?? []) done();
    this.waiters.delete(id);
  }
}

export interface FakeGraphNode { id: string; name: string; statement: string; aliases?: string[]; provenance?: { chatId: string; messageId: string }[] }
export class FakeHost {
  workers = new FakeWorkers();
  nodes: FakeGraphNode[] = [
    { id: 'n_a', name: 'Alpha', statement: 'Alpha implies beta under assumption A.', provenance: [{ chatId: 'c1', messageId: 'm1' }] },
    { id: 'n_b', name: 'Beta', statement: 'Beta is conserved in closed systems.', provenance: [{ chatId: 'c1', messageId: 'm2' }] },
  ];
  chains: { id: string; premises: string[]; conclusion: string }[] = [];
  catalog = {
    models: [{ provider: 'scratch', id: 'writer', name: 'Writer', contextWindow: 200_000, maxTokens: 32_000, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
      { provider: 'scratch', id: 'free', name: 'Free', contextWindow: null, maxTokens: null, cost: null }],
    providers: [{ id: 'scratch', keyPresent: true }], defaults: null,
    slots: { cheap: null } as { cheap: { model: { provider: string; id: string }; thinkingLevel?: string } | null },
  };
  catalogCalls = 0;
  context(directory: string, controller = new AbortController()) {
    const handlers = new Map<string, (input: unknown) => unknown>();
    const host = this;
    const ctx = {
      dataDirectory: directory, signal: controller.signal,
      handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
      workers: this.workers,
      inference: { catalog: async () => { host.catalogCalls++; return structuredClone(host.catalog); } },
      learning: {
        graph: () => ({ propositions: structuredClone(host.nodes), chains: structuredClone(host.chains) }),
        getSession: (id: string) => id === 'c1' ? { id: 'c1', title: 'Scratch session', messages: [
          { id: 'm1', role: 'assistant', content: 'Teacher explains alpha.' }, { id: 'm2', role: 'assistant', content: 'Teacher explains beta.' }] } : null,
      },
    } as unknown as PluginBackendContext;
    const call = async <T = any>(name: string, input: unknown = {}): Promise<T> => {
      const handler = handlers.get(name); assert(handler, `${name} registered`); return await handler(input) as T;
    };
    return { ctx, handlers, call, controller };
  }
}

export const settle = async (ms = 0) => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, ms)); };
export async function until(check: () => boolean | Promise<boolean>, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Timed out waiting for ${label}`);
}
