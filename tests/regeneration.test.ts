import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import type { PluginFrontendContext } from '../sdk/index.d.ts';
import { activate } from '../src/backend.ts';
import { DeliveryService, type PublicSnapshot } from '../src/anki/delivery.ts';
import { initialState, StateStore, type Card, type State } from '../src/anki/state.ts';
import { GenerationService } from '../src/generation/service.ts';
import { RegenerationService } from '../src/regeneration/service.ts';
import { regenerationRevision } from '../src/regeneration/types.ts';
import { mountReview } from '../src/review-ui.ts';
import type { WriterInput } from '../src/writer/types.ts';
import { FakeHost, until } from './fake-host.ts';
import { fakeUi } from './fake-ui.ts';
import { fakeAnkiConnect } from './fake-anki-connect.ts';

const makeCard = (patch: Partial<Card> = {}): Card => ({
  id: randomUUID(), nodeId: 'n_a', nodeName: 'Alpha', sessionId: 's1', sessionName: 'Synthetic', statementHash: 'hash-a',
  kind: 'fact', front: 'What must be assumed for alpha to imply beta?', back: 'Assumption A.', extra: '', status: 'draft',
  sourceSnapshot: { nodeId: 'n_a', name: 'Alpha', statement: 'Alpha implies beta under assumption A.', statementHash: 'hash-a',
    sessionId: 's1', sessionName: 'Synthetic', source: 'The implication needs assumption A.' }, ...patch,
});
const replacement = { kind: 'fact', front: 'Under which assumption does the implication hold?', back: 'A.', extra: '' };
const result = (cards = [replacement]) => ({ targets: [{ nodeId: 'n_a', cards, ...(!cards.length && { skipReason: 'No distinct card fits the source.' }) }] });
const startInput = (card: Card, instruction?: string) => ({ id: card.id, revision: regenerationRevision(card), instruction });

async function fixture(run: (host: FakeHost, directory: string, state: State) => Promise<void>, cards: Card[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-regeneration-'));
  try {
    const host = new FakeHost(), store = await StateStore.open(directory), state = initialState();
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' } };
    state.cards = cards;
    try { await store.replace(state); } finally { await store.close(); }
    await run(host, directory, state);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const withBackend = (cards: Card[], run: (host: FakeHost, c: ReturnType<FakeHost['context']>) => Promise<void>) => fixture(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try { await run(host, c); } finally { await close(); }
}, cards);
const byId = (snap: PublicSnapshot, id: string) => snap.cards.find(c => c.id === id)!;
const waitForJob = async (c: ReturnType<FakeHost['context']>, id: string, status: string) => {
  await until(async () => byId(await c.call('snapshot'), id).regeneration?.status === status, `${status} rewrite`);
  return byId(await c.call('snapshot'), id).regeneration!;
};
const workerFor = (host: FakeHost, requestId: string) => host.workers.list().find(w => w.requestId === requestId)!;

test('regenerateCard queues one normal worker per card, passes saved edits and source, and waits for Accept or Keep original', async () => {
  const a = makeCard(), b = makeCard({ front: 'What follows from alpha under A?', back: 'Beta.' });
  const unrelated = makeCard({ nodeId: 'n_b', sourceSnapshot: undefined, status: 'approved' });
  await withBackend([a, b, unrelated], async (host, c) => {
    const edited = byId(await c.call('edit', { id: a.id, front: 'Edited cue?', back: 'Edited answer.', extra: 'Edited context.' }), a.id);
    const approved = byId(await c.call('approve', { ids: [a.id] }), a.id);
    host.nodes[0].statement = 'New graph text that was not part of this draft.';
    await assert.rejects(c.call('regenerateCard', startInput(a)), /card changed/);
    await assert.rejects(c.call('regenerateCard', startInput(approved, 'x'.repeat(301))), /at most 300/);
    const first = byId(await c.call('regenerateCard', startInput(approved, '  Make it shorter.  ')), a.id).regeneration!;
    const second = byId(await c.call('regenerateCard', startInput(b)), b.id).regeneration!;
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.equal(start.requestId, first.requestId);
    assert.equal(start.maxTurns, 3);
    assert.equal(start.purpose, 'user');
    assert.equal(input.maxCardsPerNode, 1);
    assert.equal(input.targets[0].statement, a.sourceSnapshot!.statement);
    assert.equal(input.targets[0].source, a.sourceSnapshot!.source);
    assert.deepEqual(input.targets[0].existingCards, [{ kind: b.kind, front: b.front, back: b.back }]);
    assert.ok(start.prompt.includes(edited.front) && start.prompt.includes(edited.back) && start.prompt.includes(edited.extra));
    assert.ok(start.prompt.includes('"Make it shorter."') && !start.prompt.includes(host.nodes[0].statement));
    assert.equal((await waitForJob(c, b.id, 'queued')).requestId, second.requestId);
    for (const card of [a, b]) await assert.rejects(c.call('send', { ids: [card.id], deck: 'Scratch' }), /Accept the replacement/);
    await assert.rejects(c.call('exportPackage', { ids: [a.id], deck: 'Scratch' }), /Accept the replacement/);
    await assert.rejects(c.call('markImported', { ids: [a.id], deck: 'Scratch' }), /Accept the replacement/);
    await assert.rejects(c.call('drop', { ids: [a.id] }), /Accept the replacement/);
    await assert.rejects(c.call('edit', { id: a.id, front: 'A racing edit', back: 'Answer' }), /Accept the replacement/);
    await assert.rejects(c.call('acceptRegeneration', { id: b.id, requestId: second.requestId }), /not ready/);
    assert.equal((await c.call('exportPackage', { ids: [unrelated.id], deck: 'Scratch' })).ids[0], unrelated.id);

    host.workers.succeed(workerFor(host, first.requestId).id, result());
    const ready = await waitForJob(c, a.id, 'ready');
    await until(() => host.workers.starts.length === 2);
    const original = byId(await c.call('snapshot'), a.id);
    assert.equal(original.front, edited.front);
    assert.equal(original.status, 'approved');
    assert.deepEqual(ready.replacement, replacement);
    await assert.rejects(c.call('send', { ids: [a.id], deck: 'Scratch' }), /Accept the replacement/);
    assert.ok(!host.workers.starts[1].prompt.includes('Optional rewrite instruction'));
    const accepted = byId(await c.call('acceptRegeneration', { id: a.id, requestId: first.requestId }), a.id);
    assert.equal(accepted.front, replacement.front);
    assert.equal(accepted.status, 'draft');
    assert.equal(accepted.id, a.id);
    assert.deepEqual(accepted.sourceSnapshot, a.sourceSnapshot);
    assert.equal(accepted.regeneration, undefined);

    await c.call('keepOriginalCard', { id: b.id, requestId: second.requestId });
    assert.deepEqual(byId(await c.call('snapshot'), b.id).front, b.front);
    assert.equal(byId(await c.call('snapshot'), b.id).regeneration, undefined);
    assert.equal(host.workers.starts.length, 2);
  });
});

test('stale Keep and Accept cannot clear a later rewrite, even when the first worker returns late', async () => {
  const card = makeCard({ status: 'approved' });
  await withBackend([card], async (host, c) => {
    const first = byId(await c.call('regenerateCard', startInput(card)), card.id).regeneration!;
    await until(() => !!workerFor(host, first.requestId));
    host.workers.cancel = () => {}; // A task can finish even after the learner keeps the card.
    await c.call('keepOriginalCard', { id: card.id, requestId: first.requestId });
    const second = byId(await c.call('regenerateCard', startInput(card)), card.id).regeneration!;
    host.workers.succeed(workerFor(host, first.requestId).id, result());
    await until(() => !!workerFor(host, second.requestId));
    assert.equal(byId(await c.call('snapshot'), card.id).front, card.front);
    host.workers.succeed(workerFor(host, second.requestId).id, result());
    await waitForJob(c, card.id, 'ready');
    for (const name of ['acceptRegeneration', 'keepOriginalCard']) await assert.rejects(c.call(name, { id: card.id, requestId: first.requestId }), /no longer current/);
    assert.equal(byId(await c.call('snapshot'), card.id).regeneration!.requestId, second.requestId);
    await c.call('keepOriginalCard', { id: card.id, requestId: second.requestId });
    const kept = byId(await c.call('snapshot'), card.id);
    assert.equal(kept.status, 'approved');
    assert.equal(kept.front, card.front);
  });
});

test('per-node duplicate check excludes only the original and rechecks after comparison', async () => {
  const card = makeCard();
  const older = makeCard({ ...replacement, kind: 'fact', status: 'approved' });
  await withBackend([card, older], async (host, c) => {
    const first = byId(await c.call('regenerateCard', startInput(card)), card.id).regeneration!;
    await until(() => !!workerFor(host, first.requestId));
    host.workers.succeed(workerFor(host, first.requestId).id, result());
    const failed = await waitForJob(c, card.id, 'failed');
    assert.match(failed.error!, /duplicates another card/);
    await c.call('keepOriginalCard', { id: card.id, requestId: first.requestId });
    await c.call('drop', { ids: [older.id] });
    const second = byId(await c.call('regenerateCard', startInput(card)), card.id).regeneration!;
    await until(() => !!workerFor(host, second.requestId));
    host.workers.succeed(workerFor(host, second.requestId).id, result([{ kind: card.kind, front: card.front, back: card.back, extra: card.extra }]));
    await waitForJob(c, card.id, 'ready');
    await c.call('draft', { kind: card.kind, nodeId: card.nodeId, front: card.front, back: card.back });
    await assert.rejects(c.call('acceptRegeneration', { id: card.id, requestId: second.requestId }), /duplicates another card/);
    assert.equal(byId(await c.call('snapshot'), card.id).front, card.front);
    await c.call('keepOriginalCard', { id: card.id, requestId: second.requestId });
  });
});

test('failed, skipped and malformed worker results preserve the original and permit a fresh request', async () => {
  const card = makeCard();
  await withBackend([card], async (host, c) => {
    const attempts: { finish: (id: string) => void; error: RegExp }[] = [
      { finish: id => host.workers.fail(id, 'Synthetic worker failure.'), error: /Synthetic worker failure/ },
      { finish: id => host.workers.succeed(id, result([])), error: /No distinct card/ },
      { finish: id => host.workers.succeed(id, result([replacement, { ...replacement, front: 'A second card?' }])), error: /cap is 1/ },
    ];
    for (const { finish, error } of attempts) {
      const r = byId(await c.call('regenerateCard', startInput(card)), card.id).regeneration!;
      await until(() => !!workerFor(host, r.requestId));
      finish(workerFor(host, r.requestId).id);
      assert.match((await waitForJob(c, card.id, 'failed')).error!, error);
      assert.equal(byId(await c.call('snapshot'), card.id).front, card.front);
      await c.call('keepOriginalCard', { id: card.id, requestId: r.requestId });
    }
    assert.equal(host.workers.starts.length, attempts.length);
  });
});

test('a failed result save blocks delivery and retries the same result without another worker', async () => {
  const card = makeCard({ status: 'approved', format: 'cloze', front: 'Alpha implies beta under {{blank}}.', back: 'assumption A' });
  await fixture(async (host, directory) => {
    const store = await StateStore.open(directory), c = host.context(directory), delivery = new DeliveryService(store);
    const generation = new GenerationService(c.ctx, store, delivery), rewrite = new RegenerationService(c.ctx, store, delivery);
    const replace = store.replace.bind(store);
    let fail = true;
    store.replace = async next => {
      if (fail && next.regenerations?.some(r => r.status === 'ready')) { fail = false; throw new Error('Synthetic pre-commit failure'); }
      await replace(next);
    };
    try {
      await generation.activate(); await rewrite.activate();
      const r = byId(await rewrite.command('regenerateCard', startInput(card)), card.id).regeneration!;
      await until(() => !!workerFor(host, r.requestId));
      host.workers.succeed(workerFor(host, r.requestId).id, result());
      await until(() => byId(delivery.snapshot(), card.id).regeneration?.status === 'resultPending');
      await assert.rejects(delivery.command('send', { ids: [card.id], deck: 'Scratch' }), /Accept the replacement/);
      assert.deepEqual(store.snapshot().cards[0], card);
      const ready = byId(await rewrite.command('retryRegenerationResult', { id: card.id, requestId: r.requestId }), card.id);
      assert.equal(ready.regeneration?.status, 'ready');
      assert.equal(ready.format, 'cloze');
      const accepted = byId(await rewrite.command('acceptRegeneration', { id: card.id, requestId: r.requestId }), card.id);
      assert.equal(accepted.format, undefined);
      assert.equal(host.workers.starts.length, 1);
    } finally { await rewrite.close(); await generation.close(); await delivery.close(); }
  }, [card]);
});

test('activation recovers a finished result but does not silently restart queued requests', async () => {
  const a = makeCard(), b = makeCard({ front: 'An independent original?', back: 'A.' });
  await fixture(async (host, directory) => {
    const c = host.context(directory), close = await activate(c.ctx);
    let firstId = '';
    try {
      firstId = byId(await c.call('regenerateCard', startInput(a)), a.id).regeneration!.requestId;
      await c.call('regenerateCard', startInput(b));
      await until(() => !!workerFor(host, firstId));
    } finally { await close(); }
    host.workers.succeed(workerFor(host, firstId).id, result());
    const reloaded = host.context(directory), stop = await activate(reloaded.ctx);
    try {
      const snapshot = await reloaded.call('snapshot');
      assert.equal(byId(snapshot, a.id).regeneration?.status, 'ready');
      assert.equal(byId(snapshot, a.id).front, a.front);
      assert.match(byId(snapshot, b.id).regeneration?.error ?? '', /interrupted/);
      assert.equal(host.workers.starts.length, 1);
    } finally { await stop(); }
  }, [a, b]);
});

test('rewrite eligibility rejects sent, imported, delivery-attempted and source-free cards', async () => {
  const destination = { url: 'http://localhost:1234/', profile: 'Synthetic' };
  const cards = [makeCard({ status: 'sending', destination, deck: 'Scratch' }), makeCard({ status: 'sent', destination, deck: 'Scratch', noteId: 1 }),
    makeCard({ status: 'imported', deck: 'Scratch' }), makeCard({ status: 'approved', destination }), makeCard({ sourceSnapshot: undefined })];
  await fixture(async (host, directory) => {
    const store = await StateStore.open(directory), c = host.context(directory), delivery = new DeliveryService(store);
    const rewrite = new RegenerationService(c.ctx, store, delivery);
    try {
      for (const card of cards) {
        assert.equal(byId(delivery.snapshot(), card.id).canRegenerate, undefined);
        await assert.rejects(rewrite.command('regenerateCard', startInput(card)), /unsent draft with saved source/);
      }
      assert.equal(host.workers.starts.length, 0);
    } finally { await rewrite.close(); await delivery.close(); }
  }, cards);
});

test('regenerateCard cannot queue while a send owns the writer fence', async () => {
  const card = makeCard({ status: 'approved' });
  await fixture(async (host, directory, state) => {
    const anki = await fakeAnkiConnect();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
    let send: Promise<unknown> | undefined, close: (() => Promise<void>) | undefined;
    try {
      const store = await StateStore.open(directory);
      const destination = { url: anki.url, profile: 'Throwaway' };
      try { await store.replace({ ...state, destination, settings: { ...state.settings, url: anki.url } }); } finally { await store.close(); }
      const c = host.context(directory); close = await activate(c.ctx);
      anki.state.errors.set('getActiveProfile', 'Synthetic send interruption');
      anki.state.after = async action => { if (action === 'getActiveProfile') { entered(); await gate; } };
      send = c.call('send', { ids: [card.id], deck: 'Scratch', expectedDestination: destination });
      await reached;
      await assert.rejects(c.call('regenerateCard', startInput(card)), /Busy/);
      assert.equal(byId(await c.call('snapshot'), card.id).regeneration, undefined);
      release();
      await assert.rejects(send, /Synthetic send interruption/);
    } finally { release(); await send?.catch(() => undefined); await close?.(); await anki.close(); }
  }, [card]);
});

test('Review only offers rewrites on eligible cards and polls into a side-by-side decision', async () => {
  const card = makeCard({ status: 'approved' }), imported = makeCard({ status: 'imported', deck: 'Scratch' });
  await withBackend([card, imported], async (host, c) => {
    const window = new Window(); Object.assign(globalThis, { document: window.document });
    const view = window.document.createElement('div'), header = window.document.createElement('div');
    window.document.body.append(view, header);
    const controller = new AbortController();
    const ctx = { call: c.call, signal: controller.signal, ui: fakeUi(), onResync: () => () => {} } as unknown as PluginFrontendContext;
    const rendered = mountReview(ctx, view as unknown as HTMLElement, controller.signal, { peers: new Set(), onChanged: async () => {}, headerAside: header as unknown as HTMLElement });
    const label = (text: string) => [...view.querySelectorAll('button')].find(button => button.textContent === text);
    try {
      await until(() => !!view.querySelector('.ab-rewrite-form'));
      assert.equal(view.querySelectorAll('.ab-rewrite-form').length, 1);
      assert.equal(view.querySelector('.ab-rewrite-form summary')?.textContent, 'Regenerate this card');
      view.querySelector('textarea')!.value = 'Use a shorter cue';
      label('Queue rewrite')!.click();
      await until(() => host.workers.starts.length === 1 && !!label('Keep original'));
      assert.equal(label('Send 1 card to Anki'), undefined);
      assert.equal(label('Send this card'), undefined);
      assert.match(host.workers.starts[0].prompt, /Use a shorter cue/);
      host.workers.succeed(host.workers.list()[0].id, result());
      await new Promise(resolve => setTimeout(resolve, 1250)); // One Review poll, no manual refresh.
      await until(() => !!label('Accept'));
      const comparison = view.querySelector('.ab-rewrite-comparison')!;
      assert.match(comparison.textContent, /Original/);
      assert.match(comparison.textContent, /Replacement/);
      assert.ok(comparison.textContent.includes(card.front) && comparison.textContent.includes(replacement.front));
      label('Accept')!.click();
      await until(() => !!label('Approve') && !label('Accept'));
      assert.equal(byId(await c.call('snapshot'), card.id).status, 'draft');
    } finally { rendered.dispose(); controller.abort(); await window.close(); }
  });
});
