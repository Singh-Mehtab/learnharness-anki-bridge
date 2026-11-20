import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { activate } from '../src/backend.ts';
import { FakeHost, until } from './fake-host.ts';
import { initialState, StateStore } from '../src/anki/state.ts';
import { statementHash } from '../src/coverage/service.ts';
import { outputAllowance, pack } from '../src/writer/input.ts';
import type { WriterInput } from '../src/writer/types.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { GenerationService } from '../src/generation/service.ts';

const result = (nodeIds: string[], skip: string[] = []) => ({ targets: nodeIds.map(nodeId => skip.includes(nodeId)
  ? { nodeId, cards: [], skipReason: 'Nothing worth testing beyond the statement.' }
  : { nodeId, cards: [{ kind: 'fact', front: 'Which condition must be satisfied for the first result in this lecture to follow?', back: 'Assumption A.' }] }) });

async function withHost(run: (host: FakeHost, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-generation-'));
  try { await run(new FakeHost(), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const statePath = (directory: string) => path.join(directory, 'state.json');

test('preflight follows the cheap slot unless overridden, needs an available model and starts no model work', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.deepEqual(snap.generationSettings, { cardsPerNode: 2, enabledKinds: ['fact', 'equation'], model: null });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /cheap model/);
    // Default: the host's cheap slot with its thinking level, like core Flashcards.
    (host.catalog.models[0] as { supportedLevels?: string[] }).supportedLevels = ['low', 'medium'];
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' }, thinkingLevel: 'medium' };
    const cheap = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.deepEqual(cheap.model, { provider: 'scratch', id: 'writer', thinkingLevel: 'medium' });
    assert.equal(cheap.followsCheapSlot, true);
    host.catalog.slots.cheap.thinkingLevel = 'high';
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /does not support.*high/);
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'missing' } };
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /cheap model slot is unavailable/);
    host.catalog.slots.cheap = null;
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

test('defaults carry the cheap slot’s thinking through confirmation, worker start and durable history', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    (host.catalog.models[0] as { supportedLevels?: string[] }).supportedLevels = ['low', 'medium'];
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' }, thinkingLevel: 'low' };
    const stale = await c.call('preflight', { nodeIds: ['n_a'] });
    host.catalog.slots.cheap.thinkingLevel = 'medium';
    await assert.rejects(c.call('generate', { preflightId: stale.preflightId }), /stale/);
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.deepEqual(start.model, { provider: 'scratch', id: 'writer', thinkingLevel: 'medium' });
    assert.deepEqual(input.enabledKinds, ['fact', 'equation']);
    assert.deepEqual(input.targets[0].allowedKinds, ['fact', 'equation']);
    assert.equal('constantValues' in input, false, 'new inputs carry no constant-values toggle');
    assert.doesNotMatch(start.prompt, /Constant values/);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'equation', front: 'What is the fixture relation?', back: '$a=b$' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    assert.deepEqual(saved.generations[0].modelSpec, start.model);
    assert.deepEqual(saved.generations[0].tasks[0].input, input);
    assert.equal(saved.cards[0].kind, 'equation');
  } finally { await close(); }
}));

test('a blank flag increases the real preflight and worker cap; new kinds are opt-ins; constants and compose have no setting', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    const stale = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: '' });
    await assert.rejects(c.call('generate', { preflightId: stale.preflightId }), /stale|expired/);
    await assert.rejects(c.call('generationSettings', { constantValues: true }), /Unsupported generation input/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: ['recall'] }), /available card types/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: ['fact', 'compose'] }), /available card types/);
    const beforeOptIn = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    await c.call('generationSettings', { enabledKinds: ['fact', 'steps', 'apply'] });
    await assert.rejects(c.call('generate', { preflightId: beforeOptIn.preflightId }), /stale/);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.equal(p.maximumCards, 14);
    assert.equal(p.outputTokens, outputAllowance(1, 12) + outputAllowance(1, 2));
    // If the model cannot fit the flag, its 12 cards are not counted as planned output.
    host.catalog.models[0].maxTokens = outputAllowance(1, 2);
    const limited = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.deepEqual(limited.skipped.map((s: { nodeId: string }) => s.nodeId), ['n_a']);
    assert.equal(limited.maximumCards, 2);
    assert.equal(limited.outputTokens, outputAllowance(1, 2));
    host.catalog.models[0].maxTokens = 32_000;
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.equal(input.targets[0].flagged, true);
    assert.equal(input.targets[0].maxCards, 12);
    assert.equal(input.targets[0].flagNote, undefined);
    assert.equal(input.targets[1].maxCards, undefined);
    assert.deepEqual(input.targets[0].allowedKinds, ['fact', 'steps', 'apply']);
    assert.deepEqual(input.enabledKinds, ['fact', 'steps', 'apply']);
    assert.equal('constantValues' in input, false);
    assert.equal(start.options?.maxTokens, p.outputTokens);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: ['First', 'Second', 'Third'].map((ordinal, i) => ({
      kind: 'steps', front: `What is the ${ordinal} stage of the process?`, back: ['Prepare.', 'Execute.', 'Verify.'][i],
    })) }, { nodeId: 'n_b', cards: [], skipReason: 'No additional material.' }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const saved = await c.call('generationStatus');
    assert.deepEqual(saved.generationSettings, { cardsPerNode: 2, enabledKinds: ['fact', 'steps', 'apply'], model: { provider: 'scratch', id: 'writer' } });
    assert.deepEqual(saved.generations[0].settings, saved.generationSettings);
    assert.equal(saved.cards.length, 3);
  } finally { await close(); }
}));

test('confirmed generation applies validated results once as editable drafts with source snapshots', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1, enabledKinds: ['fact'] });
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
    // A finished batch can be hidden from the page; the record stays, and the idea can be selected again.
    const hidden = await c.call('dismissGeneration', { id: p.preflightId });
    assert.equal(hidden.generations[0].hidden, true); assert.equal(hidden.generations[0].status, 'cancelled');
    const again = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.deepEqual(again.nodeIds, ['n_a']);
  } finally { await close(); }
}));

test('a running batch cannot be dismissed', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    await assert.rejects(c.call('dismissGeneration', { id: p.preflightId }), /Cancel or finish/);
    await assert.rejects(c.call('dismissGeneration', { id: p.preflightId, extra: 1 }));
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
  assert.equal(saved.schemaVersion, 6);
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

test('a crash between cancelled task saves and the batch save still recovers as cancelled', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  state.generations[0].tasks[0].status = 'cancelled';
  await writeFile(statePath(directory), JSON.stringify(state));
  c = host.context(directory); close = await activate(c.ctx);
  try { assert.equal((await c.call('generationStatus')).generations[0].status, 'cancelled'); }
  finally { await close(); }
}));

test('persisted applied results are shape-checked only, so stricter writer rules never lock old state', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  host.workers.succeed('task-1', result(['n_a']));
  await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  // Content a current writer check would reject (names the idea on the front).
  state.generations[0].tasks[0].result.targets[0].cards[0].front = 'What does Alpha say?';
  await writeFile(statePath(directory), JSON.stringify(state));
  c = host.context(directory); close = await activate(c.ctx);
  await close();
  state.generations[0].tasks[0].result.targets[0].nodeId = 'n_elsewhere';
  const broken = JSON.stringify(state);
  await writeFile(statePath(directory), broken);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid applied generation/);
  assert.equal(await readFile(statePath(directory), 'utf8'), broken);
}));

test('an unexpected driver failure interrupts the batch instead of leaving it running', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    host.workers.wait = () => Promise.reject(new Error('Host storage failed.'));
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'interrupted', 'interrupted');
    const snap = await c.call('generationStatus');
    assert.match(snap.generations[0].tasks[0].error, /Host storage failed/);
    assert.match(snap.recoveryError, /Host storage failed/);
    assert.deepEqual(host.workers.cancelled, ['task-1']);
    // New work is not blocked.
    const q = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: q.preflightId });
  } finally { await close(); }
}));

test('flag notes (0.4.0 seam) reach the writer input and are bound into the preflight', () => withHost(async (host, directory) => {
  const { ctx } = host.context(directory);
  const store = await StateStore.open(directory);
  const delivery = new DeliveryService(store, { signal: ctx.signal });
  const generation = new GenerationService(ctx, store, delivery);
  await generation.activate();
  try {
    let notes = new Map([['n_a', 'I got the direction of the implication wrong']]);
    generation.flagNotes = () => notes;
    await generation.command('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await generation.command('preflight', { nodeIds: ['n_a', 'n_b'] }) as { preflightId: string };
    notes = new Map([['n_a', 'A different note']]);
    await assert.rejects(generation.command('generate', { preflightId: p.preflightId }), /stale/);
    const q = await generation.command('preflight', { nodeIds: ['n_a', 'n_b'] }) as { preflightId: string };
    await generation.command('generate', { preflightId: q.preflightId });
    await until(() => host.workers.starts.length === 1);
    const input = host.workers.starts[0].input as { targets: { nodeId: string; flagNote?: string }[] };
    assert.equal(input.targets.find(t => t.nodeId === 'n_a')!.flagNote, 'A different note');
    assert.equal(input.targets.find(t => t.nodeId === 'n_b')!.flagNote, undefined);
  } finally { await generation.close(); await delivery.close(); }
}));

test('v5 (0.7.2) state drops the constants toggle and compose from settings only; history, frozen inputs and compose cards stay readable', () => withHost(async (host, directory) => {
  const oldSettings = { cardsPerNode: 3, enabledKinds: ['fact', 'compose', 'why'], constantValues: true, model: { provider: 'scratch', id: 'writer' } };
  const frozen = { ...pack({ propositions: host.nodes, chains: [] }, ['n_a'], () => ({}), { maxCardsPerNode: 3, enabledKinds: ['fact', 'compose', 'why'] }).batches[0].input, constantValues: true };
  const inputBytes = JSON.stringify(frozen);
  const source = { nodeId: 'n_a', name: 'Alpha', statement: host.nodes[0].statement,
    statementHash: statementHash(host.nodes[0].statement), sessionId: 'c1', sessionName: 'Scratch session' };
  const composeCard = { id: '00000000-0000-4000-8000-000000000002', ...source, nodeName: source.name,
    sourceSnapshot: source, kind: 'compose', front: 'Given A and B, what follows?', back: 'Alpha.', extra: '', status: 'draft' };
  const requestId = 'v5-request';
  const historical = { id: 'v5-generation', nodeIds: ['n_a'], createdAt: '2026-11-19T00:00:00Z', status: 'running', settings: oldSettings,
    modelSpec: oldSettings.model, skipped: [], tasks: [{ status: 'running', requestId, input: frozen, sources: [source], outputAllowance: outputAllowance(1, 3) }] };
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: oldSettings, generations: [historical], cards: [composeCard] });
  await writeFile(statePath(directory), bytes);
  const task = host.workers.start('manual-card-writer', { requestId, input: frozen, model: oldSettings.model,
    prompt: 'Frozen fixture prompt', purpose: 'user', maxTurns: 3, timeoutMs: 180_000 });
  host.workers.succeed(task.id, { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', front: 'What is the fixture condition?', back: 'Assumption A.' }] }] });
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    assert.equal(saved.schemaVersion, 6);
    assert.equal(await readFile(path.join(directory, 'state.v5.bak'), 'utf8'), bytes);
    assert.deepEqual(saved.generationSettings, { cardsPerNode: 3, enabledKinds: ['fact', 'why'], model: oldSettings.model });
    assert.deepEqual(saved.generations[0].settings, oldSettings, 'history keeps what the batch was run with');
    assert.equal(JSON.stringify(saved.generations[0].tasks[0].input), inputBytes);
    assert.equal(saved.generations[0].status, 'completed');
    assert.deepEqual(saved.cards.map((card: { kind: string }) => card.kind), ['compose', 'fact']);
    assert.deepEqual(saved.cards[0], composeCard);
    assert.equal(host.workers.starts.length, 1, 'restart never starts model work');
    // New drafts use the migrated settings: no compose, no constants toggle.
    host.workers.starts.length = 0;
    const p = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const input = host.workers.starts[0].input as WriterInput;
    assert.deepEqual(input.enabledKinds, ['fact', 'why']);
    assert.equal('constantValues' in input, false);
    assert.equal(input.targets[0].existingCards.length, 0);
  } finally { await close(); }
}));

test('v5 settings with only compose fall back to the default card types', () => withHost(async (host, directory) => {
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: { cardsPerNode: 1, enabledKinds: ['compose'], constantValues: false, model: null } });
  await writeFile(statePath(directory), bytes);
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    assert.deepEqual((await c.call('generationStatus')).generationSettings, { cardsPerNode: 1, enabledKinds: ['fact', 'equation'], model: null });
  } finally { await close(); }
  const malformed = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: { cardsPerNode: 1, enabledKinds: ['fact'], model: null } });
  await writeFile(statePath(directory), malformed);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid generation state/);
  assert.equal(await readFile(statePath(directory), 'utf8'), malformed, 'a v5 file without its toggle is refused, not reset');
}));

test('v4 backup and restart recover a frozen legacy worker without changing its input or old cards', () => withHost(async (host, directory) => {
  const legacySettings = { cardsPerNode: 3, enabledKinds: ['recall'], model: { provider: 'scratch', id: 'writer' } };
  const legacyInput = pack({ propositions: host.nodes, chains: [] }, ['n_a'], () => ({}), {
    maxCardsPerNode: 3, enabledKinds: ['recall'],
  }).batches[0].input;
  // V4 stored a flag note but didn't yet mark it with the new flag/cap fields.
  legacyInput.targets[0].flagNote = 'Remember this version';
  const inputBytes = JSON.stringify(legacyInput);
  const source = { nodeId: 'n_a', name: 'Alpha', statement: host.nodes[0].statement,
    statementHash: statementHash(host.nodes[0].statement), sessionId: 'c1', sessionName: 'Scratch session' };
  const card = { id: '00000000-0000-4000-8000-000000000001', ...source, nodeName: source.name,
    sourceSnapshot: source, kind: 'recall', front: 'My edited question?', back: 'My answer.', extra: 'User note.', status: 'approved' };
  const requestId = 'legacy-request';
  const historical = { id: 'legacy-generation', nodeIds: ['n_a'], createdAt: '2026-11-19T00:00:00Z',
    status: 'running', settings: legacySettings, skipped: [], tasks: [{ status: 'running', requestId, input: legacyInput,
      sources: [source], outputAllowance: outputAllowance(1, 3) }] };
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 4, generationSettings: legacySettings, generations: [historical], cards: [card] }) + '\n\n';
  await writeFile(statePath(directory), bytes);
  const task = host.workers.start('manual-card-writer', { requestId, input: legacyInput, model: legacySettings.model,
    prompt: 'Frozen fixture prompt', purpose: 'user', maxTurns: 3, timeoutMs: 180_000 });
  const workerResult = { targets: [{ nodeId: 'n_a', cards: [{ kind: 'recall', front: 'What condition is required to apply this result?', back: 'Assumption A.' }] }] };
  host.workers.succeed(task.id, workerResult);
  for (let i = 0; i < 2; i++) {
    const c = host.context(directory), close = await activate(c.ctx);
    try {
      const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
      assert.equal(saved.schemaVersion, 6);
      assert.equal(await readFile(path.join(directory, 'state.v4.bak'), 'utf8'), bytes);
      assert.deepEqual(saved.generationSettings, { cardsPerNode: 3, enabledKinds: ['fact', 'equation'], model: legacySettings.model });
      assert.deepEqual(saved.generations[0].settings, legacySettings);
      assert.equal(saved.generations[0].status, 'completed');
      const stored = saved.generations[0].tasks[0];
      assert.equal(JSON.stringify(stored.input), inputBytes);
      assert.equal(stored.status, 'applied');
      assert.deepEqual(stored.result, workerResult);
      assert.equal(saved.cards.length, 2);
      assert.deepEqual(saved.cards[0], card);
      assert.equal(saved.cards[1].kind, 'recall');
      assert.equal(host.workers.starts.length, 1, 'restart never starts or retries model work');
    } finally { await close(); }
  }
}));

test('cross-request omissions use exact live content and preserve distinct cards, edits and complete results', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    const duplicate = { kind: 'fact', front: 'Which prefix is used here?', back: 'Kilo.', extra: 'See the convention.' };
    const distinct = [
      { ...duplicate, back: 'Mili.' }, // Same front, different fact.
      { ...duplicate, front: 'What prefix does the alternate convention use?' }, // Same answer, different cue.
      { ...duplicate, extra: 'A different explanation.' }, // Extra is part of the content.
    ];
    await c.call('generationSettings', { cardsPerNode: 4, model: { provider: 'scratch', id: 'writer' } });
    host.catalog.models[0].maxTokens = outputAllowance(1, 4);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.deepEqual(p.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a'], ['n_b']]);
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [duplicate] }] });
    await until(() => host.workers.starts.length === 2);
    const first = (await c.call('generationStatus')).cards[0];
    await c.call('approve', { ids: [first.id] });
    const fullResult = { targets: [{ nodeId: 'n_b', cards: [duplicate, ...distinct] }] };
    host.workers.succeed('task-2', fullResult);
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    let snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 4);
    assert.equal(snap.cards[0].id, first.id);
    assert.equal(snap.cards[0].status, 'approved');
    assert.equal(snap.cards[0].extra, duplicate.extra);
    assert.deepEqual(snap.cards.slice(1).map(({ kind, front, back, extra }: typeof duplicate) => ({ kind, front, back, extra })), distinct);
    assert.deepEqual(snap.generations[0].tasks[1].result, fullResult);
    assert.equal(snap.generations[0].tasks[1].duplicatesOmitted, 1);

    const again = async (nodeId: string) => {
      const preflight = await c.call('preflight', { nodeIds: [nodeId] });
      const next = host.workers.starts.length + 1;
      await c.call('generate', { preflightId: preflight.preflightId });
      await until(() => host.workers.starts.length === next);
      host.workers.succeed(`task-${next}`, { targets: [{ nodeId, cards: [duplicate] }] });
      await until(async () => (await c.call('generationStatus')).generations.at(-1).status === 'completed');
      return c.call('generationStatus');
    };
    // A flag isn't satisfied by a duplicate attached to a different node.
    host.catalog.models[0].maxTokens = 32_000;
    await c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: '' });
    snap = await again('n_b');
    assert.equal(snap.cards.length, 5);
    assert.equal(snap.cards.at(-1).nodeId, 'n_b');
    await c.call('drop', { ids: [snap.cards.at(-1).id] });
    await c.call('edit', { id: first.id, front: 'My edited question?', back: duplicate.back, extra: duplicate.extra });
    snap = await again('n_a');
    assert.equal(snap.cards.length, 6, 'edited and dropped originals do not suppress');
    assert.equal(snap.cards[0].front, 'My edited question?');
    assert.equal(snap.cards[4].status, 'dropped');
    assert.deepEqual(snap.generations[0].tasks[1].result, fullResult, 'later edits and drops never rewrite a worker result');
    // Simulate persisted delivery that has only checked the presence of a note ID.
    // Anki may have a different answer now, so the saved fields must not block a draft.
    await close();
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    const destination = { url: saved.settings.url, profile: 'Scratch' };
    saved.destination = destination;
    Object.assign(saved.cards.at(-1), { status: 'sent', presence: 'present', noteId: 123, deck: 'Scratch', destination });
    await writeFile(statePath(directory), JSON.stringify(saved));
    const reopened = await activate(c.ctx);
    try {
      snap = await again('n_a');
      assert.equal(snap.cards.length, 7, 'a previously sent card never suppresses a draft');
      assert.equal(snap.cards.at(-1).status, 'draft');
    } finally { await reopened(); }
  } finally { await close(); }
}));
