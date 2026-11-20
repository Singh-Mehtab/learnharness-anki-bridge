import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PluginBackendContext } from '../sdk/index.d.ts';
import { activate } from '../src/backend.ts';
import type { PublicSnapshot } from '../src/anki/delivery.ts';
import { FakeHost } from './fake-host.ts';

function context(directory: string, controller = new AbortController()) {
  const c = new FakeHost().context(directory, controller);
  return { ...c, call: (name: string, input: unknown = {}) => c.call<PublicSnapshot>(name, input) };
}

test('backend activation registers public operations without graph, model or network access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-backend-'));
  const c = context(directory); const close = await activate(c.ctx);
  try {
    assert.equal(c.handlers.size, 33);
    const added = await c.call('draft', { front: 'Prompt', back: 'Answer' });
    assert.equal(added.cards[0].status, 'draft');
    await c.call('approve', { ids: [added.cards[0].id] });
    await assert.rejects(c.call('send', { ids: [added.cards[0].id], deck: 'Scratch' }), /Pair/);
    // Unpaired and with no Anki at all, a download still works and changes nothing.
    const before = await readFile(path.join(directory, 'state.json'), 'utf8');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('Downloading must not touch the network.'); }) as typeof fetch;
    try {
      const exported = await c.handlers.get('exportPackage')!({ ids: [added.cards[0].id], deck: 'Scratch' }) as { fileName: string; data: string; ids: string[] };
      assert.equal(exported.fileName, 'anki-bridge-scratch.apkg');
      assert.deepEqual(exported.ids, [added.cards[0].id]);
      assert.equal(Buffer.from(exported.data, 'base64').readUInt32LE(0), 0x04034b50, 'a zip file');
    } finally { globalThis.fetch = realFetch; }
    assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), before, 'state is not written');
    assert.equal((await c.call('snapshot')).cards[0].status, 'approved');
    await assert.rejects(c.call('settings', { unexpected: 'setting' }), /Unsupported/);
    const lateDraft = c.handlers.get('draft')!;
    await close();
    assert.equal(c.handlers.size, 0);
    await assert.rejects(Promise.resolve().then(() => lateDraft({ front: 'Late', back: 'No' })), /disabled/);
    const next = context(directory); const closeNext = await activate(next.ctx);
    try { const state = await next.call('snapshot'); assert.equal(state.cards.length, 1); assert.equal(state.cards[0].status, 'approved'); }
    finally { await closeNext(); }
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
});

test('disable fences late calls and an already-aborted activation releases its data lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-backend-'));
  const c = context(directory); c.controller.abort();
  try {
    await assert.rejects(activate(c.ctx), /cancelled/);
    assert.equal(c.handlers.size, 0);
    const next = context(directory), close = await activate(next.ctx);
    try { next.controller.abort(); await assert.rejects(next.call('draft', { front: 'Late', back: 'No' }), /disabled/); }
    finally { await close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backend refuses newer data without resetting it, then allows corrected activation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-backend-'));
  const file = path.join(directory, 'state.json'), future = JSON.stringify({ schemaVersion: 900 });
  try {
    await writeFile(file, future);
    await assert.rejects(activate(context(directory).ctx), /Unsupported/);
    assert.equal(await readFile(file, 'utf8'), future);
    await rm(file);
    const close = await activate(context(directory).ctx); await close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('S4: changing the address or API key forgets the review result, even when changed back', async () => {
  const { randomUUID } = await import('node:crypto');
  const { StateStore, initialState } = await import('../src/anki/state.ts');
  const { fakeAnkiConnect } = await import('./fake-anki-connect.ts');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-backend-reviews-'));
  const id = randomUUID();
  const anki = await fakeAnkiConnect({ notes: [{ noteId: 1000, lhId: id, cards: [{ cardId: 2000, lapses: 4 }] }] });
  const destination = { url: anki.url, profile: 'Throwaway' };
  const seed = await StateStore.open(directory);
  await seed.replace({ ...initialState(), settings: { url: anki.url, apiKey: '', lastDeck: 'Scratch' }, destination,
    cards: [{ id, nodeId: 'n', nodeName: 'N', statementHash: 'h', sessionId: 's', sessionName: 'S', kind: 'fact', front: 'F', back: 'B', extra: '', status: 'sent', deck: 'Scratch', noteId: 1000, destination }] });
  await seed.close();
  const c = context(directory); const close = await activate(c.ctx);
  const last = async () => (await c.call('lastReviewCheck') as unknown as { check: unknown }).check;
  try {
    await c.call('checkReviews');
    assert.ok(await last());
    await c.call('settings', { apiKey: 'new-key' });
    assert.equal(await last(), null, 'a new API key forgets the result');
    await c.call('settings', { apiKey: '' });
    await c.call('checkReviews');
    assert.ok(await last());
    await c.call('settings', { url: 'http://127.0.0.1:9/' });
    await c.call('settings', { url: anki.url });
    assert.equal(await last(), null, 'an address change forgets the result even after switching back');
    await c.call('checkReviews');
    await c.call('settings', { url: anki.url });
    assert.ok(await last(), 'saving the same settings keeps it');
    // Round 3 S1: a pairing attempt that fails before saving changes nothing.
    await assert.rejects(c.call('pair', { confirmed: true, expectedDestination: destination }));
    assert.ok(await last(), 'a failed pairing keeps the result');
  } finally { await close(); await anki.close(); await rm(directory, { recursive: true, force: true }); }
});
