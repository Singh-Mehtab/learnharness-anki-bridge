import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { activate } from '../src/backend.ts';
import { FakeHost, until } from './fake-host.ts';

const result = (nodeIds: string[], skip: string[] = []) => ({ targets: nodeIds.map(nodeId => skip.includes(nodeId)
  ? { nodeId, cards: [], skipReason: 'Nothing worth testing beyond the statement.' }
  : { nodeId, cards: [{ kind: 'recall', front: 'Which condition must be satisfied for the first result in this lecture to follow?', back: 'Assumption A.' }] }) });

async function withHost(run: (host: FakeHost, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-generation-'));
  try { await run(new FakeHost(), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const statePath = (directory: string) => path.join(directory, 'state.json');

test('preflight requires an explicit available model and starts no model work', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.deepEqual(snap.generationSettings, { cardsPerNode: 2, enabledKinds: ['recall', 'why', 'compose', 'discriminate'], model: null });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /Choose a model/);
    await assert.rejects(c.call('generationSettings', { cardsPerNode: 5 }), /1–4/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: [] }), /1–4/);
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'missing' } });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /unavailable/);
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 3 });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a', 'n_a'] }), /distinct/);
    await assert.rejects(c.call('preflight', { nodeIds: ['n_gone'] }), /missing/);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.equal(p.nodeCount, 2); assert.equal(p.maximumCards, 6);
    assert.ok(p.inputTokens > 0 && p.outputTokens > 0);
    assert.equal(typeof p.estimatedCost, 'number');
    assert.deepEqual(p.model, { provider: 'scratch', id: 'writer' });
    assert.equal(host.workers.starts.length, 0);
    host.catalog.providers[0].keyPresent = false;
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /unavailable/);
    host.catalog.providers[0].keyPresent = true;
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'free' } });
    assert.equal((await c.call('preflight', { nodeIds: ['n_a'] })).estimatedCost, null);
    assert.equal(host.workers.starts.length, 0);
    const context = await c.call('generationContext');
    assert.deepEqual(context.nodes.map((n: { id: string }) => n.id), ['n_a', 'n_b']);
  } finally { await close(); }
}));

test('confirmed generation applies validated results once as editable drafts with source snapshots', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1, enabledKinds: ['recall'] });
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    let snap = await c.call('generate', { preflightId: p.preflightId });
    assert.equal(snap.generations.length, 1); assert.equal(snap.generations[0].id, p.preflightId);
    await until(() => host.workers.starts.length === 1, 'worker start');
    const start = host.workers.starts[0];
    assert.equal(start.purpose, 'user'); assert.equal(start.maxTurns, 3); assert.equal(start.timeoutMs, 180_000);
    assert.deepEqual(start.model, { provider: 'scratch', id: 'writer' });
    assert.equal(start.options?.maxTokens, p.batches[0].outputAllowance);
    // Repeating the same confirmation is idempotent.
    snap = await c.call('generate', { preflightId: p.preflightId });
    assert.equal(snap.generations.length, 1); assert.equal(host.workers.starts.length, 1);
    host.workers.succeed('task-1', result(['n_a', 'n_b'], ['n_b']));
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed', 'completion');
    snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1);
    const card = snap.cards[0];
    assert.equal(card.status, 'draft'); assert.equal(card.nodeId, 'n_a'); assert.equal(card.generationId, p.preflightId);
    assert.equal(card.sourceStatement, host.nodes[0].statement);
    assert.equal(card.sessionName, 'Scratch session');
    assert.equal(card.sourceChanged, false); assert.equal(card.sourceMissing, false);
    assert.equal(snap.generations[0].tasks[0].status, 'applied');
    assert.equal(snap.generations[0].tasks[0].result.targets[1].skipReason, 'Nothing worth testing beyond the statement.');
    // Generated drafts use the normal edit/drop/approve flow.
    await c.call('edit', { id: card.id, front: 'Edited?', back: 'Yes.' });
    host.nodes[0].statement = 'Alpha implies beta under assumption B.';
    snap = await c.call('generationStatus');
    assert.equal(snap.cards[0].sourceChanged, true); assert.equal(snap.cards[0].front, 'Edited?');
    host.nodes = host.nodes.slice(1);
    snap = await c.call('generationStatus');
    assert.equal(snap.cards[0].sourceMissing, true); assert.equal(snap.cards[0].sourceChanged, false);
    await c.call('drop', { ids: [card.id] });
    await assert.rejects(c.call('approve', { ids: [card.id] }), /Only unsent/);
    await assert.rejects(c.call('generate', { preflightId: 'unknown' }), /expired/);
  } finally { await close(); }
}));

test('stale preflights are refused after settings, graph or card changes', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    let p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { cardsPerNode: 3 });
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /stale/);
    p = await c.call('preflight', { nodeIds: ['n_a'] });
    host.nodes[0].statement = 'Changed statement.';
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /stale/);
    p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('draft', { front: 'Hand', back: 'Written' });
    // Hand-written cards are not in any selected node's prompt, so this preflight remains valid.
    await c.call('generate', { preflightId: p.preflightId });
    assert.equal((await c.call('generationStatus')).generations.length, 1);
    await assert.rejects(c.call('preflight', { nodeIds: ['n_b'] }).then(q => c.call('generate', { preflightId: q.preflightId })), /already running/);
  } finally { await close(); }
}));

test('invalid worker output fails the task without creating drafts', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_unknown', cards: [] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed', 'failure');
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 0); assert.equal(snap.generations[0].tasks[0].status, 'failed');
    const retry = await c.call('retryGeneration', { id: p.preflightId });
    assert.deepEqual(retry.nodeIds, ['n_a']); assert.equal(host.workers.starts.length, 1);
  } finally { await close(); }
}));

test('cancel stops unfinished work and keeps drafts from completed tasks', () => withHost(async (host, directory) => {
  host.nodes.push({ id: 'n_c', name: 'Gamma', statement: 'G'.repeat(10) });
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const snap = await c.call('cancelGeneration', { id: p.preflightId });
    assert.equal(snap.generations[0].status, 'cancelled'); assert.equal(snap.generations[0].tasks[0].status, 'cancelled');
    assert.deepEqual(host.workers.cancelled, ['task-1']);
    // A late success after cancellation never becomes a draft.
    host.workers.tasks.get('task-1')!.status = 'succeeded';
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await c.call('generationStatus')).cards.length, 0);
  } finally { await close(); }
}));

test('restart applies finished host results exactly once and interrupts unfinished ones without model calls', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  // The result finishes while the plugin is disabled.
  host.workers.succeed('task-1', result(['n_a']));
  c = host.context(directory); close = await activate(c.ctx);
  let snap = await c.call('generationStatus');
  assert.equal(snap.cards.length, 1); assert.equal(snap.generations[0].status, 'completed');
  const id = snap.cards[0].id;
  await c.call('drop', { ids: [id] });
  await close();
  c = host.context(directory); close = await activate(c.ctx);
  snap = await c.call('generationStatus');
  assert.equal(snap.cards.length, 1, 'replay does not recreate a dropped draft'); assert.equal(snap.cards[0].status, 'dropped');
  // An unfinished request becomes interrupted and retry needs a fresh confirmation.
  const q = await c.call('preflight', { nodeIds: ['n_b'] });
  await c.call('generate', { preflightId: q.preflightId });
  await until(() => host.workers.starts.length === 2);
  await close(); host.workers.interruptAll();
  c = host.context(directory); close = await activate(c.ctx);
  try {
    snap = await c.call('generationStatus');
    const g = snap.generations.find((x: { id: string }) => x.id === q.preflightId);
    assert.equal(g.status, 'interrupted'); assert.equal(g.tasks[0].status, 'interrupted');
    assert.equal(host.workers.starts.length, 2, 'activation never starts model work');
    const retry = await c.call('retryGeneration', { id: q.preflightId });
    assert.deepEqual(retry.nodeIds, ['n_b']); assert.equal(host.workers.starts.length, 2);
  } finally { await close(); }
}));

test('restart recovers acceptance saved before the worker task ID was recorded', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  const task = state.generations[0].tasks[0];
  delete task.taskId; task.status = 'pending';
  await writeFile(statePath(directory), JSON.stringify(state));
  host.workers.succeed('task-1', result(['n_a']));
  c = host.context(directory); close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1); assert.equal(snap.generations[0].tasks[0].taskId, 'task-1');
  } finally { await close(); }
}));

test('schema 1 state migrates without losing pairing or cards, and malformed generation data is not reset', () => withHost(async (host, directory) => {
  const v1 = { schemaVersion: 1, settings: { url: 'http://127.0.0.1:18766/', apiKey: '', lastDeck: 'Scratch' }, destination: { url: 'http://127.0.0.1:18766/', profile: 'Throwaway' },
    cards: [{ id: '00000000-0000-4000-8000-000000000001', nodeId: '', nodeName: '', sessionId: '', sessionName: '', statementHash: '', kind: 'recall', front: 'F', back: 'B', extra: '', status: 'draft' }] };
  await writeFile(statePath(directory), JSON.stringify(v1));
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1); assert.equal(snap.destination.profile, 'Throwaway'); assert.deepEqual(snap.generations, []);
  } finally { await close(); }
  const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  saved.generations = [{ id: 'g', bogus: true }];
  const broken = JSON.stringify(saved);
  await writeFile(statePath(directory), broken);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid generation/);
  assert.equal(await readFile(statePath(directory), 'utf8'), broken);
}));

test('disable unregisters the worker definition and operations', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  assert.equal(host.workers.registered, 1);
  await close();
  assert.equal(host.workers.registered, 0); assert.equal(c.handlers.size, 0);
}));
