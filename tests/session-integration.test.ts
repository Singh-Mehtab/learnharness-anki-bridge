import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { activate as backend } from '../src/backend.ts';
import { activate as frontend } from '../src/main.ts';
import { StateStore } from '../src/anki/state.ts';
import type { PluginFrontendContext, PluginView } from '../sdk/index.d.ts';
import { FakeHost, settle, until } from './fake-host.ts';

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-session-integration-'));
  const host = new FakeHost(), c = host.context(directory);
  const getSession = c.ctx.learning.getSession;
  Object.assign(c.ctx.learning, {
    getSession: (id: string) => { const s = getSession(id); return s ? { ...s, kind: 'teach', updatedAt: '2026-11-18T10:00:00Z' } : null; },
    listSessions: () => [{ id: 'c1', title: 'Scratch session', kind: 'teach', updatedAt: '2026-11-18T10:00:00Z' }],
    graph: () => ({ propositions: structuredClone(host.nodes), chains: structuredClone(host.chains),
      nodeSessions: { n_a: ['c1'], n_b: ['c1'] }, sessions: { c1: 'Scratch session' } }),
    readGraphFile: () => [],
  });
  const close = await backend(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  return { host, c, directory, closeBackend: close, close: async () => { await close(); await rm(directory, { recursive: true, force: true }); } };
}

test('session selection reaches drafting, clears estimates, and stays current with saved caps and completed drafts', async () => {
  const f = await setup(), window = new Window();
  Object.assign(globalThis, { document: window.document });
  let dispose: void | (() => void | Promise<void>) = undefined;
  const cleanup: Array<() => void> = [];
  try {
    await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Check the closed-system condition' });
    let view!: PluginView;
    const calls: Array<{ name: string; input: any }> = [];
    const widget = () => ({ update() {}, dispose() {} });
    const ctx = {
      signal: f.c.controller.signal, cleanup: (fn: () => void) => cleanup.push(fn),
      registerView: (v: PluginView) => { view = v; return () => {}; },
      registerSettings: () => () => {}, registerAction: () => () => {}, placeAction: () => () => {},
      onResync: () => () => {}, onAppEvent: () => () => {},
      call: async (name: string, input: any) => { calls.push({ name, input }); return f.c.call(name, input); },
      ui: { mountKnowledgePicker: widget, mountModelPicker: widget, mountMarkdown: widget },
    } as unknown as PluginFrontendContext;
    frontend(ctx);
    const container = window.document.createElement('div'); window.document.body.append(container);
    dispose = await view.mount(container as unknown as HTMLElement, f.c.controller.signal);
    await settle();
    const button = (text: string) => {
      const b = [...container.querySelectorAll('button')].find(b => b.textContent === text);
      assert.ok(b, `button ${text}: ${container.textContent}`); return b;
    };
    const picker = container.querySelector('select')!;
    picker.value = 'c1'; picker.dispatchEvent(new window.Event('change')); await settle();
    button('Draft cards for selected').click(); await settle();
    assert.match(container.textContent!, /1 node selected/);
    button('Estimate generation').click();
    await until(() => [...container.querySelectorAll('button')].some(b => b.textContent === 'Confirm and generate'), 'first estimate');
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_b'] });
    assert.ok(button('Confirm and generate'));
    button('Select all uncarded: 2 ideas, about 4 cards').click(); await settle();
    button('Draft cards for selected').click(); await settle();
    assert.match(container.textContent!, /2 nodes selected/);
    assert.equal([...container.querySelectorAll('button')].some(b => b.textContent === 'Confirm and generate'), false);
    button('Estimate generation').click();
    await until(() => calls.filter(c => c.name === 'preflight').length === 2, 'second estimate');
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_a', 'n_b'] });
    assert.equal(calls.some(c => c.name === 'generate'), false);
    assert.equal(f.host.workers.starts.length, 0);
    assert.doesNotMatch(container.textContent!, /connects to the 0\.3\.0/);

    const cap = [...container.querySelectorAll('label')].find(l => l.textContent?.includes('Maximum cards per node'))!.querySelector('input')!;
    cap.value = '4'; cap.dispatchEvent(new window.Event('input'));
    button('Save drafting defaults').click();
    await until(() => container.textContent!.includes('Select all uncarded: 2 ideas, about 8 cards'), 'session cap refresh');
    button('Estimate generation').click();
    await until(() => [...container.querySelectorAll('button')].some(b => b.textContent === 'Confirm and generate'), 'new cap estimate');
    button('Confirm and generate').click();
    await until(() => f.host.workers.starts.length === 1, 'generation start');
    f.host.workers.succeed('task-1', { targets: ['n_a', 'n_b'].map(nodeId => ({ nodeId, cards: [{ kind: 'recall',
      front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] })) });
    await until(async () => {
      await settle(); // Include the panel's normal polling interval, not a manual refresh.
      return container.querySelectorAll('.anki-bridge-session .anki-bridge-carded').length === 2;
    }, 'completed drafts update session counts');
    assert.match(container.querySelector('.anki-bridge-session')!.textContent!, /Select all uncarded: 0 ideas, about 0 cards/);
    assert.equal(container.querySelectorAll('.anki-bridge-session .anki-bridge-badges').length, 2);

    // Extraction can add an idea after both panels have mounted.
    f.host.nodes.push({ id: 'n_new', name: 'Newly extracted idea', statement: 'Fresh metadata after extraction.', provenance: [{ chatId: 'c1', messageId: 'm2' }] });
    button('Refresh').click();
    await until(() => container.querySelector('.anki-bridge-session')!.textContent!.includes('Newly extracted idea'), 'extracted session node');
    const preflights = calls.filter(c => c.name === 'preflight').length;
    button('Draft cards for selected').click();
    const drafting = () => [...container.querySelectorAll('h3')].find(h => h.textContent === 'Draft from graph nodes')!.parentElement!;
    await until(() => drafting().textContent!.includes('Newly extracted idea'), 'fresh drafting metadata');
    assert.match(drafting().textContent!, /Fresh metadata after extraction/);
    assert.doesNotMatch(container.textContent!, /Node no longer exists/);
    assert.equal(calls.filter(c => c.name === 'preflight').length, preflights);
    assert.equal(f.host.workers.starts.length, 1); // Selection alone does not estimate or generate.
  } finally {
    f.c.controller.abort();
    if (typeof dispose === 'function') await dispose();
    cleanup.forEach(fn => fn());
    await f.close(); await window.happyDOM.close();
  }
});

test('schema 2 migration preserves a completed generation, applied result, and generated source snapshot', async () => {
  const f = await setup();
  try {
    const p = await f.c.call('preflight', { nodeIds: ['n_a'] });
    await f.c.call('generate', { preflightId: p.preflightId });
    await until(() => f.host.workers.starts.length === 1, 'generation start');
    f.host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'recall',
      front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] }] });
    await until(async () => (await f.c.call('generationStatus')).generations[0].status === 'completed', 'generation complete');
    await f.closeBackend();
    const file = path.join(f.directory, 'state.json');
    const { flags: _flags, ...state } = JSON.parse(await readFile(file, 'utf8'));
    const v2 = { ...state, schemaVersion: 2 };
    await writeFile(file, JSON.stringify(v2));
    const store = await StateStore.open(f.directory);
    try {
      assert.deepEqual(store.snapshot(), { ...v2, schemaVersion: 3, flags: [] });
      assert.equal(store.snapshot().generations[0].tasks[0].status, 'applied');
      assert.equal(store.snapshot().cards[0].sourceSnapshot?.statement, f.host.nodes[0].statement);
    } finally { await store.close(); }
  } finally { await f.close(); }
});

test('flag notes reach saved writer input and worker prompt; changing a note invalidates preflight', async () => {
  const f = await setup();
  try {
    const flag = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Remember the sign condition' });
    const old = await f.c.call('preflight', { nodeIds: ['n_a'] });
    await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Explain why assumption A is necessary' });
    await assert.rejects(f.c.call('generate', { preflightId: old.preflightId }), /stale/);
    assert.equal(f.host.workers.starts.length, 0);
    const p = await f.c.call('preflight', { nodeIds: ['n_a'] });
    const snapshot = await f.c.call('generate', { preflightId: p.preflightId });
    assert.equal(snapshot.generations[0].tasks[0].input.targets[0].flagNote, 'Explain why assumption A is necessary');
    await until(() => f.host.workers.starts.length === 1, 'worker start');
    assert.match(JSON.stringify(f.host.workers.starts[0]), /Explain why assumption A is necessary/);
    assert.doesNotMatch(JSON.stringify(f.host.workers.starts[0]), /Remember the sign condition/);
    await f.c.call('cancelGeneration', { id: p.preflightId });
    await f.c.call('unflag', { id: flag.id });
    const unflagged = await f.c.call('preflight', { nodeIds: ['n_a'] });
    const cleared = await f.c.call('generate', { preflightId: unflagged.preflightId });
    assert.equal(cleared.generations.at(-1).tasks[0].input.targets[0].flagNote, undefined);
    await f.c.call('cancelGeneration', { id: unflagged.preflightId });
  } finally { await f.close(); }
});
