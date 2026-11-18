import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { GenerationService } from '../src/generation/service.ts';
import { CoverageService, statementHash } from '../src/coverage/service.ts';
import { FakeHost } from './fake-host.ts';

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
