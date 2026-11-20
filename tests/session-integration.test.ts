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
import { fakeUi } from './fake-ui.ts';

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

test('a session scope reaches writing with flagged and bulk intent, saved caps, and completed drafts', async () => {
  const f = await setup(), window = new Window();
  Object.assign(globalThis, { document: window.document });
  let dispose: void | (() => void | Promise<void>) = undefined;
  const cleanup: Array<() => void> = [];
  try {
    await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Check the closed-system condition' });
    let view!: PluginView;
    const calls: Array<{ name: string; input: any }> = [];
    const ctx = {
      signal: f.c.controller.signal, cleanup: (fn: () => void) => cleanup.push(fn),
      registerView: (v: PluginView) => { if (v.id === "bridge") view = v; return () => {}; },
      registerSettings: () => () => {}, registerAction: () => () => {}, placeAction: () => () => {},
      onResync: () => () => {}, onAppEvent: () => () => {}, app: { openSettings: () => {} },
      call: async (name: string, input: any) => { calls.push({ name, input }); return f.c.call(name, input); },
      ui: fakeUi(),
    } as unknown as PluginFrontendContext;
    frontend(ctx);
    const container = window.document.createElement('div'); window.document.body.append(container);
    dispose = await view.mount(container as unknown as HTMLElement, f.c.controller.signal);
    await settle();
    const buttons = () => [...window.document.querySelectorAll('button')];
    const button = (text: string | RegExp) => {
      const b = buttons().find(b => typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''));
      assert.ok(b, `button ${text}: ${container.textContent}`); return b;
    };
    const ideas = () => container.querySelector('.ab-ideas')!;
    const dialog = () => window.document.querySelector('.ab-dialog');
    await until(() => ideas().textContent!.includes('1 idea selected'), 'session scope preselects the flagged idea');
    assert.equal((container.querySelector('.ab-source-select') as unknown as HTMLSelectElement).value, 'c1');
    button(/^Write cards for 1 idea/).click();
    await until(() => !!dialog(), 'first estimate dialog');
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_b'], backfillNodeIds: [] });
    assert.match(dialog()!.textContent!, /Up to 12/);
    button('Cancel').click(); await settle();
    button('Select ideas without cards (2)').click(); await settle();
    assert.match(ideas().textContent!, /2 ideas selected/);
    button(/^Write cards for 2 ideas/).click();
    await until(() => !!dialog(), 'second estimate dialog');
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_a', 'n_b'], backfillNodeIds: ['n_a', 'n_b'] });
    button('Cancel').click(); await settle();
    assert.equal(calls.some(c => c.name === 'generate'), false);
    assert.equal(f.host.workers.starts.length, 0);

    const cap = container.querySelector('.ab-write-settings select') as unknown as HTMLSelectElement;
    cap.value = '4'; cap.dispatchEvent(new window.Event('change') as unknown as Event);
    await until(async () => (await f.c.call('generationStatus')).generationSettings.cardsPerNode === 4, 'saved cap');
    assert.deepEqual(calls.filter(c => c.name === 'generationSettings').at(-1)?.input, { cardsPerNode: 4 });
    button(/^Write cards for 2 ideas/).click();
    await until(() => !!dialog(), 'new cap estimate');
    assert.match(dialog()!.textContent!, /Up to 16/);
    button('Start writing').click();
    await until(() => f.host.workers.starts.length === 1, 'generation start');
    f.host.workers.succeed('task-1', { targets: ['n_a', 'n_b'].map(nodeId => ({ nodeId, cards: [{ kind: 'fact',
      front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] })) });
    await until(async () => {
      await settle(); // Include the panel's normal polling interval, not a manual refresh.
      return container.querySelectorAll('.ab-card').length === 2;
    }, 'completed drafts reach review');
    await until(() => (ideas().textContent!.match(/1 to review/g) ?? []).length === 2, 'idea rows show waiting cards');
    assert.match(container.textContent!, /Wrote 2 cards for 2 ideas/);
    assert.equal(button('Select ideas without cards (0)').disabled, true);

    // Extraction can add an idea after the page has mounted.
    f.host.nodes.push({ id: 'n_new', name: 'Newly extracted idea', statement: 'Fresh metadata after extraction.', provenance: [{ chatId: 'c1', messageId: 'm2' }] });
    button('Refresh').click();
    await until(() => ideas().textContent!.includes('Newly extracted idea'), 'extracted session node');
    assert.match(ideas().textContent!, /Fresh metadata after extraction/);
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
    f.host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact',
      front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] }] });
    await until(async () => (await f.c.call('generationStatus')).generations[0].status === 'completed', 'generation complete');
    await f.closeBackend();
    const file = path.join(f.directory, 'state.json');
    const { flags: _flags, ...state } = JSON.parse(await readFile(file, 'utf8'));
    const v2 = { ...state, schemaVersion: 2, generationSettings: { cardsPerNode: state.generationSettings.cardsPerNode, enabledKinds: ['recall'], model: state.generationSettings.model } };
    await writeFile(file, JSON.stringify(v2));
    const store = await StateStore.open(f.directory);
    try {
      assert.deepEqual(store.snapshot(), { ...state, schemaVersion: 5, flags: [], dismissals: [] });
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
