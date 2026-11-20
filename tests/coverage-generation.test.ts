import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { GenerationService } from '../src/generation/service.ts';
import { CoverageService, statementHash } from '../src/coverage/service.ts';
import { FakeHost, until } from './fake-host.ts';
import { activate } from '../src/backend.ts';

test('pairing changes invalidate preflight even when all card counts remain zero', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-binding-'));
  const host = new FakeHost(), c = host.context(directory), store = await StateStore.open(directory);
  const delivery = new DeliveryService(store), generation = new GenerationService(c.ctx, store, delivery);
  try {
    await generation.activate();
    await generation.command('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    const p = await generation.command('preflight', { nodeIds: ['n_a'] }) as { preflightId: string };
    await delivery.exclusive(() => delivery.save(s => { s.destination = { url: s.settings.url, profile: 'Throwaway' }; }));
    await assert.rejects(generation.command('generate', { preflightId: p.preflightId }), /stale/);
    assert.equal(host.workers.starts.length, 0);
  } finally { await generation.close(); await delivery.close(); await rm(directory, { recursive: true, force: true }); }
});

test('settings changed and restored cannot revive a captured estimate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-settings-'));
  const host = new FakeHost(), c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('settings', { url: 'http://127.0.0.1:18766/' });
    await c.call('settings', { url: 'http://127.0.0.1:8765/' });
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /expired/);
    assert.equal(host.workers.starts.length, 0);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('schema 3 migration preserves populated flags, settings, applied results and pending recovery tasks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-migration-'));
  const host = new FakeHost(), c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('settings', { apiKey: 'synthetic-key', url: 'http://127.0.0.1:18766/' });
    await c.call('generationSettings', { cardsPerNode: 3, enabledKinds: ['fact'], model: { provider: 'scratch', id: 'writer' } });
    await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Preserve this note' });
    const first = await c.call('preflight', { nodeIds: ['n_a'] }); await c.call('generate', { preflightId: first.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', front: 'Which condition makes this fixture result valid?', back: 'Assumption A.' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const second = await c.call('preflight', { nodeIds: ['n_b'] }); await c.call('generate', { preflightId: second.preflightId });
    await until(() => host.workers.starts.length === 2); await close();
    const file = path.join(directory, 'state.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    const { dismissals: _dismissals, ...old } = saved; const v3 = { ...old, schemaVersion: 3, generationSettings: { cardsPerNode: 3, enabledKinds: ['recall', 'why'], model: old.generationSettings.model } };
    const bytes = JSON.stringify(v3) + '\n\n';
    const backup = path.join(directory, 'state.v3.bak');
    await writeFile(file, bytes);
    await writeFile(backup, 'an older backup', { mode: 0o600 });
    await assert.rejects(StateStore.open(directory), /Move the backup somewhere safe before upgrading/);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(await readFile(backup, 'utf8'), 'an older backup');
    await rm(backup);
    const store = await StateStore.open(directory);
    try {
      assert.equal(await readFile(backup, 'utf8'), bytes);
      if (process.platform !== 'win32') assert.equal((await stat(backup)).mode & 0o777, 0o600);
      assert.deepEqual(store.snapshot(), { ...saved, dismissals: [], generationSettings: { ...saved.generationSettings, enabledKinds: ['fact', 'equation'] } });
      assert.equal(store.snapshot().flags[0].note, 'Preserve this note');
      assert.equal(store.snapshot().generations[0].tasks[0].status, 'applied');
      assert.equal(store.snapshot().generations[1].tasks[0].status, 'running');
      assert.equal(store.snapshot().cards[0].sourceSnapshot?.statement, host.nodes[0].statement);
    } finally { await store.close(); }
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('one writer fence serializes dismissal behind background state commits and preserves both changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-fence-'));
  const host = new FakeHost(), c = host.context(directory), store = await StateStore.open(directory);
  const delivery = new DeliveryService(store), coverage = new CoverageService(c.ctx, store, delivery);
  try {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const background = delivery.exclusive(async () => {
      await pending; await delivery.save(s => { s.settings.lastDeck = 'Background choice'; });
    }, true);
    const dismiss = coverage.command('dismissNode', { nodeId: 'n_a', statementHash: statementHash(host.nodes[0].statement) });
    assert.equal(store.snapshot().dismissals.length, 0); release();
    await background; await dismiss;
    assert.equal(store.snapshot().dismissals.length, 1); assert.equal(store.snapshot().settings.lastDeck, 'Background choice');
  } finally { coverage.close(); await delivery.close(); await rm(directory, { recursive: true, force: true }); }
});
