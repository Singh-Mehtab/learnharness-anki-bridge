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
    const flag = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Check the closed-system condition' });
    const flagScopes = [{ id: flag.id, revision: flag.revision, nodeIds: ['n_b'] }];
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
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_b'], backfillNodeIds: [], flagScopes, independentNodeIds: [] });
    assert.match(dialog()!.textContent!, /Up to 12/);
    button('Cancel').click(); await settle();
    button('Select ideas without cards (2)').click(); await settle();
    assert.match(ideas().textContent!, /2 ideas selected/);
    button(/^Write cards for 2 ideas/).click();
    await until(() => !!dialog(), 'second estimate dialog');
    assert.deepEqual(calls.filter(c => c.name === 'preflight').at(-1)?.input, { nodeIds: ['n_a', 'n_b'], backfillNodeIds: ['n_a', 'n_b'], flagScopes, independentNodeIds: ['n_a', 'n_b'] });
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
    f.host.workers.succeed('task-1', { targets: ['n_a', 'n_b'].map(nodeId => ({ nodeId, ...(nodeId === 'n_b' ? { flagMatches: [flag.id] } : {}), cards: [{ kind: 'fact',
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

test('saved drafts handle flag targets across Drop, but not a note edited during writing', async () => {
  const f = await setup();
  const flag = (messageId: string, note?: string) => f.c.call('flag', { sessionId: 'c1', messageIds: [messageId], note });
  const flow = () => f.c.call('sessionFlow', { sessionId: 'c1' });
  try {
    const blank = await flag('m1');
    const note = await flag('m2', 'Original request');
    const p = await f.c.call('preflight', { nodeIds: ['n_a', 'n_b'], independentNodeIds: [],
      flagScopes: [{ id: blank.id, nodeIds: ['n_a'] }, { id: note.id, nodeIds: ['n_b'] }] });
    await f.c.call('generate', { preflightId: p.preflightId });
    await until(() => f.host.workers.starts.length === 1, 'writer started');
    await flag('m2', 'A different request');
    await flag('m2', 'Original request'); // Reverting text still renews the revision.
    f.host.workers.succeed('task-1', { targets: [{ nodeId: 'n_b', flagMatches: [note.id], cards: [{ kind: 'fact',
      front: 'What must the system exchange with its surroundings?', back: 'Nothing.' }] }, { nodeId: 'n_a', cards: [{ kind: 'fact',
      front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] }] });
    await until(async () => (await f.c.call('generationStatus')).generations[0].status !== 'running', 'generation settled');
    const generation = (await f.c.call('generationStatus')).generations[0];
    assert.equal(generation.status, 'completed', JSON.stringify(generation.tasks.map((task: any) => task.error)));
    const before = await flow();
    assert.deepEqual(before.nodes.map((n: any) => [n.id, n.flagged, n.pendingFlag]), [['n_a', true, false], ['n_b', true, true]]);
    const snapshot = await f.c.call('snapshot');
    const draft = snapshot.cards.find((c: any) => c.nodeId === 'n_a');
    await f.c.call('drop', { ids: [draft.id] });
    const after = (await flow()).nodes.find((n: any) => n.id === 'n_a');
    assert.equal(after.coverage.state, 'no-cards');
    assert.equal(after.flagged, true);
    assert.equal(after.pendingFlag, false);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
    assert.equal(saved.flags[0].handledIdeas[0].nodeId, 'n_a');
    assert.equal(saved.flags[1].handledIdeas, undefined);
  } finally { await f.close(); }
});

test('overlapping notes share one request; only an answered note is handled, including exact duplicates', async () => {
  const f = await setup();
  try {
    f.host.nodes[0].provenance!.push({ chatId: 'c1', messageId: 'm2' });
    const a = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Recall why assumption A is needed.' });
    const b = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Recall the condition on exchange.' });
    const selection = { nodeIds: ['n_a', 'n_b'], independentNodeIds: ['n_a'], flagScopes: [{ id: a.id, nodeIds: ['n_a'] }, { id: b.id, nodeIds: ['n_a', 'n_b'] }] };
    await assert.rejects(f.c.call('preflight', { ...selection, flagScopes: [{ id: a.id, nodeIds: ['n_b'] }] }), /flag or its ideas changed/);
    const card = { kind: 'fact', front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' };
    const pending = async () => (await f.c.call('sessionFlow', { sessionId: 'c1' })).flags.map((flag: any) => flag.pendingNodeIds);
    const run = async (number: number, match?: string) => {
      const p = await f.c.call('preflight', selection);
      assert.deepEqual(p.batches.map((batch: any) => batch.nodeIds), [['n_a', 'n_b']]);
      await f.c.call('generate', { preflightId: p.preflightId });
      await until(() => f.host.workers.starts.length === number, 'worker started');
      const start = f.host.workers.starts[number - 1];
      const input = start.input as import('../src/writer/types.ts').WriterInput;
      assert.deepEqual(input.flagRequests, selection.flagScopes.map((scope, i) => ({ ...scope, note: [a.note, b.note][i] })));
      assert.equal(start.prompt.split(b.note).length, 2, 'the shared note appears once in the prompt');
      assert.deepEqual(input.targets.map(t => [t.nodeId, t.noteOnly, t.flagNote]), [['n_a', undefined, undefined], ['n_b', true, undefined]]);
      f.host.workers.succeed(`task-${number}`, { targets: [
        { nodeId: 'n_a', cards: [card], ...(match ? { flagMatches: [match] } : {}) },
        { nodeId: 'n_b', cards: [], skipReason: 'No card answers the request from this source.' },
      ] });
      await until(async () => (await f.c.call('generationStatus')).generations.at(-1).status !== 'running', 'generation settled');
      const status = await f.c.call('generationStatus');
      assert.equal(status.generations.at(-1).status, 'completed');
      return status;
    };
    await run(1); // The ordinary card is not evidence that either note was answered.
    assert.deepEqual(await pending(), [['n_a'], ['n_a', 'n_b']]);
    const status = await run(2, b.id);
    assert.equal(status.cards.length, 1);
    assert.equal(status.generations.at(-1).tasks[0].duplicatesOmitted, 1);
    assert.deepEqual(await pending(), [['n_a'], []]);
  } finally { await f.close(); }
});

for (const recover of [false, true]) test(`a saved note answer handles the unchanged siblings when its source changed (recovery: ${recover})`, async t => {
  const f = await setup();
  const replace = StateStore.prototype.replace;
  let fail = recover;
  t.mock.method(StateStore.prototype, 'replace', async function (this: StateStore, next: ReturnType<StateStore['snapshot']>) {
    if (fail && next.generations[0]?.tasks[0]?.status === 'applied') throw new Error('Synthetic result write failure');
    await replace.call(this, next);
  });
  try {
    f.host.nodes[0].provenance!.push({ chatId: 'c1', messageId: 'm2' });
    const flag = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Recall the required condition.' });
    const nodeIds = ['n_a', 'n_b'];
    const pending = async () => (await f.c.call('sessionFlow', { sessionId: 'c1' })).flags[0].pendingNodeIds;
    const p = await f.c.call('preflight', { nodeIds, independentNodeIds: [], flagScopes: [{ id: flag.id, nodeIds }] });
    await f.c.call('generate', { preflightId: p.preflightId });
    await until(() => f.host.workers.starts.length === 1, 'worker started');
    f.host.nodes[0].statement += ' Revised statement.';
    f.host.workers.succeed('task-1', { targets: [
      { nodeId: 'n_a', flagMatches: [flag.id], cards: [{ kind: 'fact', front: 'Which condition is required for the first result in this lecture to hold?', back: 'Assumption A.' }] },
      { nodeId: 'n_b', cards: [], skipReason: 'Does not answer the note.' },
    ] });
    await until(async () => (await f.c.call('generationStatus')).generations[0].status === (recover ? 'interrupted' : 'completed'));
    if (recover) {
      assert.deepEqual(await pending(), nodeIds);
      fail = false;
      await f.c.call('retryGeneration', { id: p.preflightId });
    }
    assert.deepEqual(await pending(), ['n_a']);
    assert.equal((await f.c.call('generationStatus')).cards.length, 1);
    assert.equal(f.host.workers.starts.length, 1);
  } finally { await f.close(); }
});

test('an oversized noted group is not split and does not block independent writing', async () => {
  const f = await setup();
  try {
    f.host.nodes[0].provenance!.push({ chatId: 'c1', messageId: 'm2' });
    const note = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: 'Focus on the required condition.' });
    const { outputAllowance } = await import('../src/writer/input.ts');
    const nodeIds = ['n_a', 'n_b'], flagScopes = [{ id: note.id, nodeIds }];
    f.host.catalog.models[0].maxTokens = outputAllowance(1, 2) - 1;
    const empty = await f.c.call('preflight', { nodeIds, independentNodeIds: nodeIds, flagScopes });
    assert.deepEqual(empty.batches, []);
    assert.deepEqual(empty.skipped.map((skip: any) => skip.nodeId), nodeIds);
    assert.deepEqual(empty.skippedFlagRequests.map((skip: any) => skip.count), [1]);
    f.host.catalog.models[0].maxTokens = outputAllowance(1, 12);
    const p = await f.c.call('preflight', { nodeIds, independentNodeIds: ['n_a'], flagScopes });
    assert.deepEqual(p.batches.map((batch: any) => batch.nodeIds), [['n_a']]);
    assert.equal(p.maximumCards, 2);
    assert.deepEqual(p.skipped.map((skip: any) => skip.nodeId), ['n_b']);
    assert.match(p.skipped[0].reason, /group cannot fit/);
    assert.deepEqual(p.skippedFlagRequests.map((skip: any) => skip.count), [1]);
    await f.c.call('generate', { preflightId: p.preflightId });
    await until(() => f.host.workers.starts.length === 1, 'independent writer started');
    assert.doesNotMatch(f.host.workers.starts[0].prompt, /Focus on the required condition/);
    await f.c.call('cancelGeneration', { id: p.preflightId });
    const flow = await f.c.call('sessionFlow', { sessionId: 'c1' });
    assert.deepEqual(flow.flags[0].pendingNodeIds, ['n_a', 'n_b']);
  } finally { await f.close(); }
});

test('a failed note result leaves the flag pending and Retry keeps the original scope', async () => {
  const f = await setup();
  try {
    const note = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'What assumption is needed?' });
    const p = await f.c.call('preflight', { nodeIds: ['n_a'], independentNodeIds: [], flagScopes: [{ id: note.id, nodeIds: ['n_a'] }] });
    await f.c.call('generate', { preflightId: p.preflightId });
    await until(() => f.host.workers.starts.length === 1, 'writer started');
    f.host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', front: 'Which condition is required?', back: 'Assumption A.' }] }] });
    await until(async () => (await f.c.call('generationStatus')).generations[0].status === 'failed', 'invalid result rejected');
    assert.deepEqual((await f.c.call('sessionFlow', { sessionId: 'c1' })).flags[0].pendingNodeIds, ['n_a']);
    const retry = await f.c.call('retryGeneration', { id: p.preflightId });
    assert.equal(retry.maximumCards, 12);
    assert.equal(f.host.workers.starts.length, 1);
    await f.c.call('generate', { preflightId: retry.preflightId });
    await until(() => f.host.workers.starts.length === 2, 'retry started');
    assert.deepEqual(f.host.workers.starts[1].input, f.host.workers.starts[0].input);
    await f.c.call('cancelGeneration', { id: retry.preflightId });
    await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'A revised request.' });
    await assert.rejects(f.c.call('retryGeneration', { id: p.preflightId }), /flag changed/);
    assert.equal(f.host.workers.starts.length, 2);
  } finally { await f.close(); }
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
      assert.deepEqual(store.snapshot(), { ...state, schemaVersion: 9, flags: [], dismissals: [] });
      assert.equal(store.snapshot().generations[0].tasks[0].status, 'applied');
      assert.equal(store.snapshot().cards[0].sourceSnapshot?.statement, f.host.nodes[0].statement);
    } finally { await store.close(); }
  } finally { await f.close(); }
});

test('flag notes reach saved writer input and worker prompt; changing a note invalidates preflight', async () => {
  const f = await setup();
  try {
    const flag = await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Remember the sign condition' });
    const selection = { nodeIds: ['n_a'], flagScopes: [{ id: flag.id, nodeIds: ['n_a'] }], independentNodeIds: [] };
    const old = await f.c.call('preflight', selection);
    await f.c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Explain why assumption A is necessary' });
    await assert.rejects(f.c.call('generate', { preflightId: old.preflightId }), /stale/);
    assert.equal(f.host.workers.starts.length, 0);
    await assert.rejects(f.c.call('preflight', { ...selection, flagScopes: [{ ...selection.flagScopes[0], revision: flag.revision }] }), /flag or its ideas changed/);
    const p = await f.c.call('preflight', selection);
    const snapshot = await f.c.call('generate', { preflightId: p.preflightId });
    assert.deepEqual(snapshot.generations[0].tasks[0].input.flagRequests, [{ id: flag.id, note: 'Explain why assumption A is necessary', nodeIds: ['n_a'] }]);
    await until(() => f.host.workers.starts.length === 1, 'worker start');
    assert.match(JSON.stringify(f.host.workers.starts[0]), /Explain why assumption A is necessary/);
    assert.doesNotMatch(JSON.stringify(f.host.workers.starts[0]), /Remember the sign condition/);
    await f.c.call('cancelGeneration', { id: p.preflightId });
    await f.c.call('unflag', { id: flag.id });
    const unflagged = await f.c.call('preflight', { nodeIds: ['n_a'] });
    const cleared = await f.c.call('generate', { preflightId: unflagged.preflightId });
    assert.equal(cleared.generations.at(-1).tasks[0].input.flagRequests, undefined);
    await f.c.call('cancelGeneration', { id: unflagged.preflightId });
  } finally { await f.close(); }
});
