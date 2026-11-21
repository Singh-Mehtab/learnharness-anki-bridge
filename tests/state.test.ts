import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, migrateState, validateState, StateStore, syncDirectory } from '../src/anki/state.ts';

test('schema 8 migrates v7 with exact backup and validates imported metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-v8-'));
  const card = { id: '0b6f7c1e-0000-4000-8000-000000000001', nodeId: 'n', statementHash: 'h', sessionId: 's', nodeName: 'N', sessionName: 'S', kind: 'fact', front: 'F', back: 'B', extra: '', status: 'approved' };
  const old = { ...initialState(), schemaVersion: 7, cards: [card] };
  const bytes = JSON.stringify(old, null, 2) + '\n';
  try {
    await writeFile(path.join(root, 'state.json'), bytes);
    const store = await StateStore.open(root);
    assert.deepEqual(store.snapshot(), { ...old, schemaVersion: 8 });
    assert.equal(await readFile(path.join(root, 'state.v7.bak'), 'utf8'), bytes);
    await store.close();
    const imported = { ...card, status: 'imported', deck: 'Deck' };
    validateState({ ...initialState(), cards: [imported] });
    for (const bad of [{ ...imported, deck: '' }, { ...imported, noteId: 1 }, { ...imported, destination: { url: 'x', profile: 'p' } }, { ...imported, presence: 'present' }, { ...imported, existingNote: true }]) {
      assert.throws(() => validateState({ ...initialState(), cards: [bad] }));
    }
    assert.throws(() => migrateState({ ...old, cards: [imported] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('directory sync is skipped on Windows, where fsync on a directory fails with EPERM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-sync-'));
  try {
    const missing = path.join(root, 'missing');
    // A missing directory proves whether the handle is opened at all.
    await syncDirectory(missing, 'win32');
    await assert.rejects(syncDirectory(missing, 'linux'), { code: 'ENOENT' });
    await syncDirectory(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retry after a cleanup failure refuses to unlink a different owner token', async t => {
  const fs = (await import('node:fs/promises')).default;
  const root = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-lock-'));
  const lock = path.join(root, 'state.lock');
  const store = await StateStore.open(root);
  const unlink = fs.unlink;
  const injected = t.mock.method(fs, 'unlink', async (file: Parameters<typeof unlink>[0]) => {
    if (path.basename(String(file)) === 'state.lock') throw Object.assign(new Error('Synthetic sharing failure'), { code: 'EPERM' });
    await unlink(file);
  });
  try {
    await assert.rejects(store.close(), /Synthetic sharing failure/);
    injected.mock.restore();
    const replacement = JSON.stringify({ pid: process.pid, token: 'other-owner' });
    await fs.writeFile(lock, replacement);
    await assert.rejects(store.close(), /ownership changed/);
    await assert.rejects(StateStore.open(root), /owns this data directory/);
    assert.equal(await fs.readFile(lock, 'utf8'), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reloaded backend can retry a relinquished state lock', async t => {
  const fs = (await import('node:fs/promises')).default;
  const root = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-lock-'));
  const store = await StateStore.open(root);
  const unlink = fs.unlink;
  const injected = t.mock.method(fs, 'unlink', async (file: Parameters<typeof unlink>[0]) => {
    if (path.basename(String(file)) === 'state.lock') throw Object.assign(new Error('Synthetic sharing failure'), { code: 'EPERM' });
    await unlink(file);
  });
  try {
    await assert.rejects(store.close(), /Synthetic sharing failure/);
    injected.mock.restore();
    const reloadPath = new URL('../src/anki/state.ts?reload', import.meta.url).href;
    const fresh = await import(reloadPath) as typeof import('../src/anki/state.ts');
    assert.notEqual(fresh.StateStore, StateStore, 'use an independently loaded copy');
    const next = await fresh.StateStore.open(root);
    await next.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
