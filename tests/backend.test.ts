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
    assert.equal(c.handlers.size, 28);
    const added = await c.call('draft', { front: 'Prompt', back: 'Answer' });
    assert.equal(added.cards[0].status, 'draft');
    await c.call('approve', { ids: [added.cards[0].id] });
    await assert.rejects(c.call('send', { ids: [added.cards[0].id], deck: 'Scratch' }), /Pair/);
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
