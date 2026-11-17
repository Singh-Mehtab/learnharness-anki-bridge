import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PluginBackendContext } from '../sdk/index.d.ts';
import { activate } from '../src/backend.ts';
import type { PublicSnapshot } from '../src/anki/delivery.ts';

function context(directory: string, controller = new AbortController()) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const ctx = {
    dataDirectory: directory, signal: controller.signal,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
  } as unknown as PluginBackendContext;
  const call = async (name: string, input: unknown = {}) => { const handler = handlers.get(name); assert(handler, `${name} registered`); return await handler(input) as PublicSnapshot; };
  return { ctx, handlers, call, controller };
}

test('backend activation registers public operations without graph, model or network access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-backend-'));
  const c = context(directory); const close = await activate(c.ctx);
  try {
    assert.equal(c.handlers.size, 13);
    const added = await c.call('draft', { front: 'Prompt', back: 'Answer' });
    assert.equal(added.cards[0].status, 'draft');
    await c.call('approve', { ids: [added.cards[0].id] });
    await assert.rejects(c.call('send', { ids: [added.cards[0].id], deck: 'Scratch' }), /Pair/);
    await assert.rejects(c.call('settings', { unexpected: 'setting' }), /Unsupported/);
    await close();
    await assert.rejects(c.call('draft', { front: 'Late', back: 'No' }), /disabled/);
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
