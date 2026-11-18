import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activate } from '../src/backend.ts';
import { StateStore, initialState, validateState } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { GenerationService } from '../src/generation/service.ts';
import { FakeHost, until } from './fake-host.ts';

const model = { provider: 'scratch', id: 'writer' };
test('backfill intent rejects changed coverage before the first estimate; explicit requests stay available', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-'));
  const host = new FakeHost(), c = host.context(directory), store = await StateStore.open(directory);
  const delivery = new DeliveryService(store), generation = new GenerationService(c.ctx, store, delivery);
  try {
    await generation.activate(); await generation.command('generationSettings', { model });
    const destination = { url: 'http://127.0.0.1:18766/', profile: 'Fixture' };
    await delivery.exclusive(() => delivery.save(s => {
      s.destination = destination;
      s.cards.push({ id: randomUUID(), nodeId: 'n_a', nodeName: 'Alpha', statementHash: 'legacy', sessionId: '', sessionName: '', front: 'Earlier question', back: 'Earlier answer', extra: '', kind: 'recall', status: 'sent', destination, deck: 'Fixture', noteId: 42 });
    }));
    await assert.rejects(generation.command('preflight', { nodeIds: ['n_a'], backfillNodeIds: ['n_a'] }), /Backfill.*no longer uncarded/);
    const explicit = await generation.command('preflight', { nodeIds: ['n_a'] }) as { nodeCount: number; backfillNodeIds: string[] };
    assert.equal(explicit.nodeCount, 1); assert.deepEqual(explicit.backfillNodeIds, []);
    assert.equal(host.workers.starts.length, 0);
  } finally { await generation.close(); await delivery.close(); await rm(directory, { recursive: true, force: true }); }
});

test('confirmation rechecks backfill eligibility when a draft appears after its estimate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-confirm-'));
  const host = new FakeHost(), c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model });
    const p = await c.call('preflight', { nodeIds: ['n_a'], backfillNodeIds: ['n_a'] });
    await c.call('draft', { nodeId: 'n_a', front: 'Another question', back: 'Another answer' });
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /Backfill.*no longer uncarded/);
    assert.equal(host.workers.starts.length, 0);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed backfill intent survives restart and refuses retry when a draft appeared', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-retry-'));
  const host = new FakeHost(), c = host.context(directory); let close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model });
    const p = await c.call('preflight', { nodeIds: ['n_a'], backfillNodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId }); await until(() => host.workers.starts.length === 1);
    host.workers.fail('task-1'); await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed');
    await close();
    const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    assert.deepEqual(saved.generations[0].backfillNodeIds, ['n_a']);
    const next = host.context(directory); close = await activate(next.ctx);
    await next.call('draft', { nodeId: 'n_a', front: 'New independent draft', back: 'A condition' });
    await assert.rejects(next.call('retryGeneration', { id: p.preflightId }), /Backfill.*no longer uncarded/);
    await next.call('preflight', { nodeIds: ['n_a'] });
    assert.equal(host.workers.starts.length, 1);
    await close();
    // An absent field on an older generation means explicit, not inferred backfill.
    const file = path.join(directory, 'state.json'), legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.generations[0].backfillNodeIds; await writeFile(file, JSON.stringify(legacy));
    const old = host.context(directory); close = await activate(old.ctx);
    const retry = await old.call('retryGeneration', { id: p.preflightId }); assert.deepEqual(retry.backfillNodeIds, []);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('a retried generation retains its unfinished backfill targets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-repeat-'));
  const host = new FakeHost(), c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model });
    const first = await c.call('preflight', { nodeIds: ['n_a'], backfillNodeIds: ['n_a'] });
    await c.call('generate', { preflightId: first.preflightId }); await until(() => host.workers.starts.length === 1);
    host.workers.fail('task-1'); await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed');
    const retry = await c.call('retryGeneration', { id: first.preflightId }); assert.deepEqual(retry.backfillNodeIds, ['n_a']);
    await c.call('generate', { preflightId: retry.preflightId }); await until(() => host.workers.starts.length === 2);
    const state = await c.call('snapshot'); assert.deepEqual(state.generations[1].backfillNodeIds, ['n_a']);
    host.workers.fail('task-2'); await until(async () => (await c.call('generationStatus')).generations[1].status === 'failed');
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('backend accepts exactly 1000 targets, refuses 1001, and validates backfill subsets without model calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-cap-'));
  const host = new FakeHost(); host.nodes = Array.from({ length: 1001 }, (_, i) => ({ id: `n_${i}`, name: `Idea ${i}`, statement: `Fixture proposition number ${i}.` }));
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model }); const ids = host.nodes.map(n => n.id);
    await assert.rejects(c.call('preflight', { nodeIds: ids }), /1–1000/);
    for (const backfillNodeIds of [['unknown'], ['n_0', 'n_0'], 'n_0']) await assert.rejects(c.call('preflight', { nodeIds: ['n_0'], backfillNodeIds }), /subset/);
    const p = await c.call('preflight', { nodeIds: ids.slice(0, 1000), backfillNodeIds: ids.slice(0, 1000) });
    assert.equal(p.nodeCount, 1000); assert.equal(p.backfillNodeIds.length, 1000); assert.equal(host.workers.starts.length, 0);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('malformed durable backfill metadata is rejected without changing the state file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-intent-data-'));
  const host = new FakeHost(), c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model }); const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId }); await until(() => host.workers.starts.length === 1);
    host.workers.fail('task-1'); await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed'); await close();
    const file = path.join(directory, 'state.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    for (const backfillNodeIds of [['n_b'], ['n_a', 'n_a'], null]) {
      const bad = structuredClone(saved); bad.generations[0].backfillNodeIds = backfillNodeIds;
      const raw = JSON.stringify(bad); await writeFile(file, raw); await assert.rejects(StateStore.open(directory), /backfill/);
      assert.equal(await readFile(file, 'utf8'), raw);
    }
    validateState(initialState());
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});
