import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnkiClient } from '../src/anki/client.ts';
import { REVIEW_READ_ACTIONS, ReviewReader } from '../src/anki/review-reader.ts';
import { initialState, StateStore } from '../src/anki/state.ts';
import type { Card, State } from '../src/anki/state.ts';
import { ReviewService, REVIEW_BATCH } from '../src/reviews/service.ts';
import { buildTopics, evidence, recentAgain, REVIEW_RULES } from '../src/reviews/signals.ts';
import type { NoteReading, ReviewCheck } from '../src/reviews/signals.ts';
import { fakeAnkiConnect } from './fake-anki-connect.ts';
import type { FakeNote } from './fake-anki-connect.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const ago = (days: number) => NOW - days * DAY;
const WRITES = ['addNote', 'addNotes', 'updateNoteFields', 'updateNote', 'updateNoteTags', 'addTags', 'removeTags', 'deleteNotes', 'suspend', 'unsuspend',
  'answerCards', 'forgetCards', 'relearnCards', 'setDueDate', 'setEaseFactors', 'setSpecificValueOfCard', 'insertReviews', 'createDeck', 'guiBrowse', 'cardReviews', 'getLatestReviewID', 'findNotes', 'findCards'];

type Answer = { check: ReviewCheck | null; running: boolean };
interface Local { node: string; name?: string; session?: string; sessionName?: string; noteId?: number; status?: Card['status']; profile?: string; front?: string }

async function setup(locals: Local[], notes: (ids: string[]) => FakeNote[], options: { profile?: string | null; strictReviews?: boolean; graph?: () => any; paired?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-reviews-'));
  const ids = locals.map(() => randomUUID());
  const anki = await fakeAnkiConnect({ profile: options.profile, notes: notes(ids), strictReviews: options.strictReviews });
  const store = await StateStore.open(directory);
  const destination = { url: anki.url, profile: 'Throwaway' };
  const state: State = { ...initialState(), settings: { url: anki.url, apiKey: '', lastDeck: 'Scratch' }, destination: options.paired === false ? null : destination,
    cards: locals.map((l, i) => ({ id: ids[i]!, nodeId: l.node, nodeName: l.name ?? `Idea ${l.node}`, statementHash: 'h', sessionId: l.session ?? 'chat-1', sessionName: l.sessionName ?? 'Lecture one',
      kind: 'fact', front: l.front ?? `Front ${i}`, back: `Back ${i}`, extra: '', status: l.status ?? 'sent',
      ...((l.status ?? 'sent') === 'sent' ? { deck: 'Scratch', noteId: l.noteId ?? 1000 + i, destination: { url: anki.url, profile: l.profile ?? 'Throwaway' } } : {}) })) };
  await store.replace(state);
  const graph = options.graph ?? (() => ({ propositions: [{ id: 'node-a' }, { id: 'node-b' }, { id: 'node-c' }, { id: 'node-d' }], nodeSessions: { 'node-a': ['chat-1', 'chat-2'] }, sessions: { 'chat-1': 'Lecture one (graph)', 'chat-2': 'Workshop' } }));
  const service = new ReviewService({ graph }, store, { timeoutMs: 1500, now: () => NOW });
  const call = (name: string, input: unknown = {}) => service.command(name, input) as Promise<Answer>;
  const bytes = () => readFile(path.join(directory, 'state.json'));
  const cleanup = async () => { service.close(); await store.close(); await anki.close(); await rm(directory, { recursive: true, force: true }); };
  return { anki, store, service, call, ids, destination, bytes, cleanup };
}

const allowedOnly = (actions: string[]) => {
  for (const action of actions) assert.ok(REVIEW_READ_ACTIONS.has(action), `unexpected action ${action}`);
  for (const write of WRITES) assert.ok(!actions.includes(write), `write action ${write} was sent`);
};

test('a check groups flagged cards by node with evidence and session links, and writes nothing', async () => {
  const t = await setup([
    { node: 'node-a', name: 'Impulse', front: 'What is impulse?' },
    { node: 'node-a', name: 'Impulse', front: 'Unit of impulse?', session: 'chat-3', sessionName: 'Revision' },
    { node: 'node-b', name: 'Momentum' },
    { node: 'node-c', name: 'Energy' },
    { node: 'node-d', name: 'Work' },
    { node: 'node-gone', name: 'Removed idea', session: 'manual', sessionName: 'Manual' },
    { node: 'node-c', name: 'Energy' },
  ], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4, reps: 9 }] },
    { noteId: 1001, lhId: ids[1]!, cards: [{ cardId: 2001, lapses: 1, reps: 5 }] },
    { noteId: 1002, lhId: ids[2]!, cards: [{ cardId: 2002, lapses: 1, reps: 8, reviews: [
      { id: ago(2), ease: 1, type: 1 }, { id: ago(10), ease: 1, type: 2 }, { id: ago(1), ease: 1, type: 0 }, { id: ago(40), ease: 1, type: 1 }, { id: ago(3), ease: 3, type: 1 }] }] },
    { noteId: 1003, lhId: ids[3]!, cards: [{ cardId: 2003, lapses: 2, reps: 6, reviews: [{ id: ago(5), ease: 1, type: 1 }] }] },
    { noteId: 1004, lhId: ids[4]!, tags: ['Leech', 'learnharness'], cards: [{ cardId: 2004, lapses: 0, reps: 3, queue: -1, deckName: 'Year 3::Nuclear' }] },
    { noteId: 1005, lhId: ids[5]!, cards: [{ cardId: 2005, lapses: 3, reps: 4 }] },
    { noteId: 1006, lhId: ids[6]!, cards: [{ cardId: 2006, lapses: 0, reps: 0 }] },
  ]);
  try {
    const before = await t.bytes();
    const { check } = await t.call('checkReviews', { expectedDestination: t.destination });
    assert.ok(check);
    assert.deepEqual(check.topics.map(x => x.nodeName), ['Momentum', 'Impulse', 'Removed idea', 'Work']);
    const momentum = check.topics[0]!;
    assert.equal(momentum.totals.recentAgain, 2);
    assert.equal(momentum.lastAgain, ago(2));
    assert.deepEqual(momentum.cards[0]!.reasons, ['again']);
    const impulse = check.topics.find(x => x.nodeId === 'node-a')!;
    assert.equal(impulse.cards.length, 1, 'only the flagged card of a node is listed');
    assert.equal(impulse.cards[0]!.front, 'What is impulse?');
    assert.equal(impulse.totals.cardsChecked, 2);
    assert.deepEqual(impulse.sessions, [{ id: 'chat-1', name: 'Lecture one (graph)' }, { id: 'chat-3', name: 'Revision' }, { id: 'chat-2', name: 'Workshop' }]);
    const work = check.topics.find(x => x.nodeId === 'node-d')!;
    assert.deepEqual(work.cards[0]!.reasons, ['leech']);
    assert.equal(work.cards[0]!.suspended, true);
    assert.deepEqual(work.cards[0]!.decks, ['Year 3::Nuclear']);
    const removed = check.topics.find(x => x.nodeId === 'node-gone')!;
    assert.equal(removed.inGraph, false);
    assert.deepEqual(removed.sessions, [], 'hand-written cards have no session to open');
    assert.deepEqual(check.counts, { sent: 7, checked: 7, notReviewed: 1, quietTopics: 1, changed: 0, missing: 0 });
    allowedOnly(t.anki.actions());
    assert.deepEqual(t.anki.state.forbidden, []);
    assert.ok((await t.bytes()).equals(before), 'state.json is unchanged by a check');
    assert.deepEqual((await t.call('lastReviewCheck')).check, check);
    await t.call('clearReviewCheck');
    assert.equal((await t.call('lastReviewCheck')).check, null);
  } finally { await t.cleanup(); }
});

test('unrelated notes, other profiles, drafts, changed notes and wrong note types are never counted', async () => {
  const t = await setup([
    { node: 'node-a' },
    { node: 'node-b', profile: 'Other profile', noteId: 1100 },
    { node: 'node-c', status: 'draft' },
    { node: 'node-a', noteId: 1003 },
    { node: 'node-b', noteId: 1004 },
  ], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 5, reps: 9 }] },
    { noteId: 1100, lhId: ids[1]!, cards: [{ cardId: 2100, lapses: 9, reps: 9 }] },
    { noteId: 1003, lhId: randomUUID(), cards: [{ cardId: 2003, lapses: 9, reps: 9 }] },
    { noteId: 1004, lhId: ids[4]!, modelName: 'Basic', cards: [{ cardId: 2004, lapses: 9, reps: 9 }] },
    { noteId: 7777, lhId: randomUUID(), tags: ['leech'], cards: [{ cardId: 8888, lapses: 20, reps: 30 }] },
  ]);
  try {
    const { check } = await t.call('checkReviews', { expectedDestination: t.destination });
    assert.deepEqual(check!.topics.map(x => x.nodeId), ['node-a']);
    assert.equal(check!.topics[0]!.cards.length, 1);
    assert.deepEqual(check!.counts, { sent: 3, checked: 1, notReviewed: 0, quietTopics: 0, changed: 2, missing: 0 });
    const asked = t.anki.state.requests.filter(r => r.action === 'notesInfo').flatMap(r => r.params.notes);
    assert.deepEqual(asked.sort(), [1000, 1003, 1004], 'only notes sent to the paired profile are requested');
    const cards = t.anki.state.requests.filter(r => r.action === 'cardsInfo' || r.action === 'getReviewsOfCards').flatMap(r => r.params.cards);
    assert.deepEqual([...new Set(cards)], [2000], 'cards of changed or unrelated notes are never read');
    allowedOnly(t.anki.actions());
  } finally { await t.cleanup(); }
});

test('deleted notes and missing cards are skipped, and review history is asked only for confirmed cards', async () => {
  const t = await setup([{ node: 'node-a' }, { node: 'node-b' }, { node: 'node-c' }, { node: 'node-d' }], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 3, reps: 5 }] },
    // 1001 was deleted in Anki.
    { noteId: 1002, lhId: ids[2]!, cards: [] },
    { noteId: 1003, lhId: ids[3]!, cards: [{ cardId: 2003, lapses: 9, reps: 9, note: 4242 }] },
  ], { strictReviews: true });
  try {
    // 1001 is gone, 1002 lists a card cardsInfo cannot find, and 1003's card belongs to another note.
    t.anki.state.raw.set('notesInfo', [
      { noteId: 1000, profile: 'Throwaway', modelName: 'LearnHarness Basic', tags: [], fields: { LH_ID: { value: t.ids[0], order: 4 } }, cards: [2000] },
      {},
      { noteId: 1002, profile: 'Throwaway', modelName: 'LearnHarness Basic', tags: [], fields: { LH_ID: { value: t.ids[2], order: 4 } }, cards: [2999] },
      { noteId: 1003, profile: 'Throwaway', modelName: 'LearnHarness Basic', tags: [], fields: { LH_ID: { value: t.ids[3], order: 4 } }, cards: [2003] },
    ]);
    const { check } = await t.call('checkReviews', { expectedDestination: t.destination });
    assert.deepEqual(check!.topics.map(x => x.nodeId), ['node-a']);
    assert.deepEqual(check!.counts, { sent: 4, checked: 1, notReviewed: 0, quietTopics: 0, changed: 0, missing: 3 });
    const reviewed = t.anki.state.requests.filter(r => r.action === 'getReviewsOfCards').flatMap(r => r.params.cards);
    assert.deepEqual(reviewed, [2000]);
    allowedOnly(t.anki.actions());
  } finally { await t.cleanup(); }
});

test('wrong, missing or switched profiles stop the check and drop earlier results', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4, reps: 9 }] }]);
  try {
    assert.ok((await t.call('checkReviews', { expectedDestination: t.destination })).check);
    t.anki.state.profile = 'Someone else';
    t.anki.state.requests.length = 0;
    await assert.rejects(t.call('checkReviews', { expectedDestination: t.destination }), /"Someone else" open\. Open the paired profile "Throwaway"/);
    assert.deepEqual(t.anki.actions(), ['version', 'getActiveProfile'], 'no notes are read from the wrong profile');
    assert.equal((await t.call('lastReviewCheck')).check, null);

    t.anki.state.profile = null;
    await assert.rejects(t.call('checkReviews'), /Open the paired profile "Throwaway" in Anki/);

    t.anki.state.profile = 'Throwaway';
    t.anki.state.after = (action) => { if (action === 'notesInfo') t.anki.state.profile = 'Someone else'; };
    await assert.rejects(t.call('checkReviews'), /Open the paired profile/);
    assert.equal((await t.call('lastReviewCheck')).check, null);

    // A note answered from another profile is refused even if getActiveProfile agrees.
    t.anki.state.after = undefined;
    t.anki.state.profile = 'Throwaway';
    t.anki.state.notes[0]!.profile = 'Other';
    await assert.rejects(t.call('checkReviews'), /answered from the profile "Other"/);
    allowedOnly(t.anki.actions());
  } finally { await t.cleanup(); }
});

test('no pairing, a changed address or a stale view sends no request', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000 }] }], { paired: false });
  try {
    await assert.rejects(t.call('checkReviews'), /Choose a profile for this address in settings first/);
    const state = t.store.snapshot();
    await t.store.replace({ ...state, destination: { url: t.anki.url, profile: 'Throwaway' } });
    await assert.rejects(t.call('checkReviews', { expectedDestination: { url: t.anki.url, profile: 'Old' } }), /Paired profile changed\. Check it and try again/);
    await assert.rejects(t.call('checkReviews', { unexpected: true }), /Unsupported/);
    await t.store.replace({ ...t.store.snapshot(), settings: { ...state.settings, url: 'http://127.0.0.1:9/' } });
    await assert.rejects(t.call('checkReviews'), /Choose a profile for this address in settings first/);
    assert.deepEqual(t.anki.actions(), []);
  } finally { await t.cleanup(); }
});

test('re-pairing or changing the address forgets the last result', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] }]);
  try {
    assert.ok((await t.call('checkReviews')).check);
    const state = t.store.snapshot();
    await t.store.replace({ ...state, destination: { url: t.anki.url, profile: 'Another' } });
    assert.equal((await t.call('lastReviewCheck')).check, null);
  } finally { await t.cleanup(); }
});

test('errors keep or drop results as appropriate and use plain messages', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4, reps: 4 }] }]);
  try {
    const first = (await t.call('checkReviews')).check;
    t.anki.state.errors.set('getReviewsOfCards', 'unsupported action');
    await assert.rejects(t.call('checkReviews'), /cannot return review history\. Upgrade AnkiConnect/);
    t.anki.state.errors.clear();
    t.anki.state.errors.set('cardsInfo', 'Anki is busy: collection is being synced');
    await assert.rejects(t.call('checkReviews'), /Anki is busy/);
    t.anki.state.errors.clear();
    t.anki.state.errorsOnce.set('getReviewsOfCards', 'staleCursor: collection changed');
    assert.ok((await t.call('checkReviews')).check, 'a stale cursor is retried once');
    assert.equal(t.anki.state.requests.filter(r => r.action === 'getReviewsOfCards').length, 4);
    t.anki.state.raw.set('getReviewsOfCards', { '2000': [{ id: 'yesterday', ease: 1, type: 1 }] });
    await assert.rejects(t.call('checkReviews'), /did not answer like AnkiConnect/);
    t.anki.state.raw.clear();
    t.anki.state.raw.set('cardsInfo', [{ cardId: 2000, note: 1000, lapses: -1, reps: 0, queue: 0, deckName: 'x' }]);
    await assert.rejects(t.call('checkReviews'), /did not answer like AnkiConnect/);
    t.anki.state.raw.clear();
    assert.ok((await t.call('lastReviewCheck')).check, 'transient errors keep the earlier result');
    await t.anki.close();
    // Let the HTTP client drop its reset keep-alive socket so the next request opens a new connection.
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(t.call('checkReviews'), /Anki isn't running or AnkiConnect isn't reachable/);
    assert.deepEqual((await t.call('lastReviewCheck')).check?.checkedAt, first!.checkedAt);
  } finally { await t.cleanup(); }
});

test('only one check runs at a time', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000 }] }]);
  try {
    t.anki.state.delay = 60;
    const first = t.call('checkReviews');
    await assert.rejects(t.call('checkReviews'), /already running/);
    assert.equal((await t.call('lastReviewCheck')).running, true);
    await first;
    assert.equal((await t.call('lastReviewCheck')).running, false);
  } finally { await t.cleanup(); }
});

test('large collections are read in batches', async () => {
  const locals = Array.from({ length: REVIEW_BATCH.notes + 10 }, (_, i) => ({ node: `node-${i % 7}` }));
  const t = await setup(locals, ids => ids.map((id, i) => ({ noteId: 1000 + i, lhId: id, cards: [{ cardId: 5000 + i, reps: 1 }] })));
  try {
    const { check } = await t.call('checkReviews');
    assert.equal(check!.counts.checked, locals.length);
    const sizes = (action: string) => t.anki.state.requests.filter(r => r.action === action).map(r => r.params.cards?.length ?? r.params.notes.length);
    assert.deepEqual(sizes('notesInfo'), [50, 10]);
    assert.deepEqual(sizes('cardsInfo'), [25, 25, 10]);
    assert.deepEqual(sizes('getReviewsOfCards'), [50, 10]);
  } finally { await t.cleanup(); }
});

test('the graph is optional: a failed read leaves out graph status and graph sessions only', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 3 }] }], { graph: () => { throw new Error('graph down'); } });
  try {
    const topic = (await t.call('checkReviews')).check!.topics[0]!;
    assert.equal(topic.inGraph, null);
    assert.deepEqual(topic.sessions, [{ id: 'chat-1', name: 'Lecture one' }]);
  } finally { await t.cleanup(); }
});

test('the reader refuses every action outside the allowlist before any request', async () => {
  const sent: string[] = [];
  const reader = new ReviewReader({ call: async (action: string) => { sent.push(action); return null as never; } });
  for (const action of ['suspend', 'answerCards', 'cardReviews', 'getLatestReviewID', 'addTags', 'findCards', 'guiBrowse', 'setDueDate']) {
    await assert.rejects(reader.call(action), /may not call/);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual([...REVIEW_READ_ACTIONS].sort(), ['cardsInfo', 'getActiveProfile', 'getReviewsOfCards', 'notesInfo', 'version']);
});

test('signal thresholds and the 30-day window', () => {
  assert.deepEqual(REVIEW_RULES, { lapses: 3, recentAgain: 2, windowDays: 30 });
  const rows = [
    { id: ago(30), ease: 1, type: 1 }, { id: ago(30) - 1, ease: 1, type: 1 }, { id: NOW + 1000, ease: 1, type: 1 },
    { id: ago(1), ease: 1, type: 0 }, { id: ago(1), ease: 1, type: 3 }, { id: ago(1), ease: 1, type: 5 }, { id: ago(1), ease: 2, type: 1 }, { id: ago(4), ease: 1, type: 2 },
  ];
  assert.deepEqual(recentAgain(rows, NOW), [ago(4), ago(30)]);
  const note = (over: Partial<NoteReading>): NoteReading => ({ lhId: 'x', noteId: 1, nodeId: 'n', nodeName: 'N', sessionId: 's', sessionName: 'S', kind: 'fact', front: 'F', back: 'B', tags: [], cards: [], reviews: [], ...over });
  const card = (lapses: number) => ({ cardId: 1, lapses, reps: 5, queue: 2, deckName: 'D' });
  assert.deepEqual(evidence(note({ cards: [card(2)] }), NOW).reasons, []);
  assert.deepEqual(evidence(note({ cards: [card(3)] }), NOW).reasons, ['lapses']);
  assert.deepEqual(evidence(note({ cards: [card(1), card(2)] }), NOW).reasons, ['lapses'], 'lapses are summed across a note');
  assert.deepEqual(evidence(note({ reviews: [{ id: ago(1), ease: 1, type: 1 }] }), NOW).reasons, []);
  assert.deepEqual(evidence(note({ reviews: [{ id: ago(1), ease: 1, type: 1 }, { id: ago(2), ease: 1, type: 2 }] }), NOW).reasons, ['again']);
  assert.deepEqual(evidence(note({ tags: ['LEECH'] }), NOW).reasons, ['leech']);
  assert.deepEqual(evidence(note({ tags: ['leeches'] }), NOW).reasons, []);
  assert.equal(evidence(note({ cards: [{ ...card(0), queue: -1 }] }), NOW).reasons.length, 0, 'suspension alone is not a signal');
  const tie = buildTopics([note({ nodeId: 'b', nodeName: 'Beta', cards: [card(3)] }), note({ nodeId: 'a', nodeName: 'Alpha', cards: [card(3)] }), note({ nodeId: 'c', nodeName: 'Gamma', cards: [card(5)] })], NOW, null);
  assert.deepEqual(tie.topics.map(x => x.nodeName), ['Gamma', 'Alpha', 'Beta']);
});

test('the client rejects malformed review replies as not AnkiConnect', async () => {
  const anki = await fakeAnkiConnect();
  try {
    const client = new AnkiClient({ url: anki.url, timeoutMs: 1500 });
    anki.state.raw.set('cardsInfo', [{ cardId: 1, note: 2, lapses: 0, reps: 0, queue: 0 }]);
    await assert.rejects(client.call('cardsInfo', { cards: [1] }), (e: any) => e.kind === 'not-anki-connect');
    anki.state.raw.set('getReviewsOfCards', { abc: [] });
    await assert.rejects(client.call('getReviewsOfCards', { cards: [1] }), (e: any) => e.kind === 'not-anki-connect');
    anki.state.raw.set('notesInfo', [{ noteId: 1, fields: {}, tags: [], modelName: 'm', cards: [], profile: 5 }]);
    await assert.rejects(client.call('notesInfo', { notes: [1] }), (e: any) => e.kind === 'not-anki-connect');
    anki.state.raw.set('cardsInfo', [{}, { cardId: 1, note: 2, lapses: 0, reps: 0, queue: -1, deckName: 'D' }]);
    assert.equal((await client.call<unknown[]>('cardsInfo', { cards: [9, 1] })).length, 2);
  } finally { await anki.close(); }
});

// Sol review round 1 regressions.

test('S1: a note without a profile, or with a padded LH_ID, never reaches a card read', async () => {
  const t = await setup([{ node: 'node-a' }, { node: 'node-b' }], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] },
    { noteId: 1001, lhId: ids[1]!, cards: [{ cardId: 2001, lapses: 4 }] },
  ]);
  try {
    const note = (i: number, extra: Record<string, unknown>) => ({ noteId: 1000 + i, modelName: 'LearnHarness Basic', tags: [], fields: { LH_ID: { value: t.ids[i], order: 4 } }, cards: [2000 + i], ...extra });
    t.anki.state.raw.set('notesInfo', [note(0, { profile: 'Throwaway' }), note(1, {})]);
    await assert.rejects(t.call('checkReviews'), /answered from the profile "undefined"/);
    t.anki.state.raw.set('notesInfo', [note(0, { profile: 'Throwaway' }), note(1, { profile: 'Throwaway', fields: { LH_ID: { value: ` ${t.ids[1]} `, order: 4 } } })]);
    const { check } = await t.call('checkReviews');
    assert.equal(check!.counts.changed, 1);
    const cards = t.anki.state.requests.filter(r => r.action === 'cardsInfo' || r.action === 'getReviewsOfCards').flatMap(r => r.params.cards);
    assert.ok(!cards.includes(2001), 'neither the profile-less nor the padded note had its cards read');
  } finally { await t.cleanup(); }
});

test('S2: a retry re-checks the profile before reading again', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] }]);
  try {
    t.anki.state.errorsOnce.set('notesInfo', 'staleCursor: collection changed');
    t.anki.state.after = (action) => { if (action === 'notesInfo') t.anki.state.profile = 'Someone else'; };
    await assert.rejects(t.call('checkReviews'), /"Someone else" open/);
    assert.deepEqual(t.anki.actions(), ['version', 'getActiveProfile', 'notesInfo', 'getActiveProfile']);
  } finally { await t.cleanup(); }
});

test('S2: a pairing change during the last profile check is not published', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] }]);
  try {
    let reviewsDone = false;
    t.anki.state.after = async (action) => {
      if (action === 'getReviewsOfCards') reviewsDone = true;
      else if (action === 'getActiveProfile' && reviewsDone) await t.store.replace({ ...t.store.snapshot(), destination: { url: t.anki.url, profile: 'Another' } });
    };
    await assert.rejects(t.call('checkReviews'), /pairing changed during the check/);
    assert.equal((await t.call('lastReviewCheck')).check, null);
  } finally { await t.cleanup(); }
});

test('S3: a card deleted after cardsInfo drops out instead of failing the check', async () => {
  const t = await setup([{ node: 'node-a' }, { node: 'node-b' }], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] },
    { noteId: 1001, lhId: ids[1]!, cards: [{ cardId: 2001, lapses: 5 }] },
  ], { strictReviews: true });
  try {
    let deleted = false;
    t.anki.state.after = (action) => { if (action === 'cardsInfo' && !deleted) { deleted = true; t.anki.state.notes[1]!.cards = []; } };
    const { check } = await t.call('checkReviews');
    assert.deepEqual(check!.topics.map(x => x.nodeId), ['node-a']);
    assert.equal(check!.counts.missing, 1);
    const reviewed = t.anki.state.requests.filter(r => r.action === 'getReviewsOfCards').map(r => r.params.cards);
    assert.deepEqual(reviewed, [[2000, 2001], [2000]]);
    allowedOnly(t.anki.actions());
  } finally { await t.cleanup(); }
});

// Sol review round 2 regressions.

test('F2: an API key changed and changed back during the last profile check is still not published', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] }]);
  try {
    let reviewsDone = false;
    t.anki.state.after = async (action) => {
      if (action === 'getReviewsOfCards') reviewsDone = true;
      else if (action === 'getActiveProfile' && reviewsDone) {
        const s = t.store.snapshot();
        await t.store.replace({ ...s, settings: { ...s.settings, apiKey: 'B' } });
        await t.store.replace({ ...s, settings: { ...s.settings, apiKey: '' } });
      }
    };
    await assert.rejects(t.call('checkReviews'), /changed during the check/);
    assert.equal((await t.call('lastReviewCheck')).check, null);
  } finally { await t.cleanup(); }
});

test('F4: the result is forgotten at the settings commit, before the save finishes', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4 }] }]);
  try {
    assert.ok((await t.call('checkReviews')).check);
    let seen: Promise<Answer> | undefined;
    // Registered after the service, so it runs after the service's own listener at the same commit point.
    const off = t.store.onCommit(() => { seen ??= t.call('lastReviewCheck'); });
    const s = t.store.snapshot();
    await t.store.replace({ ...s, settings: { ...s.settings, apiKey: 'new' } });
    off();
    assert.equal((await seen!).check, null);
    // A commit that leaves the connection alone keeps the result.
    assert.ok((await t.call('checkReviews')).check);
    await t.store.replace({ ...t.store.snapshot(), settings: { ...t.store.snapshot().settings, lastDeck: 'Other' } });
    assert.ok((await t.call('lastReviewCheck')).check);
  } finally { await t.cleanup(); }
});

test('round 2 S1: a card listed by two notes counts only for the note cardsInfo names', async () => {
  const t = await setup([{ node: 'node-a' }, { node: 'node-b' }], ids => [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 0 }] },
    { noteId: 1001, lhId: ids[1]!, cards: [{ cardId: 2001, lapses: 0 }] },
  ]);
  try {
    const note = (i: number) => ({ noteId: 1000 + i, profile: 'Throwaway', modelName: 'LearnHarness Basic', tags: [], fields: { LH_ID: { value: t.ids[i], order: 4 } }, cards: [2000] });
    t.anki.state.raw.set('notesInfo', [note(0), note(1)]);
    t.anki.state.raw.set('cardsInfo', [{ cardId: 2000, note: 1001, lapses: 5, reps: 9, queue: 2, deckName: 'D' }]);
    const { check } = await t.call('checkReviews');
    assert.deepEqual(check!.topics.map(x => x.nodeId), ['node-b']);
    assert.equal(check!.counts.missing, 1);
    assert.deepEqual(t.anki.state.requests.filter(r => r.action === 'getReviewsOfCards').map(r => r.params.cards), [[2000]]);
  } finally { await t.cleanup(); }
});

test('round 2 S2: a retried history read uses the refreshed lapse count', async () => {
  const t = await setup([{ node: 'node-a' }], ids => [{ noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 2, reps: 5 }] }]);
  try {
    t.anki.state.errorsOnce.set('getReviewsOfCards', 'staleCursor: collection changed');
    let bumped = false;
    t.anki.state.after = (action) => { if (action === 'cardsInfo' && !bumped) { bumped = true; t.anki.state.notes[0]!.cards[0]!.lapses = 3; } };
    const { check } = await t.call('checkReviews');
    assert.deepEqual(check!.topics.map(x => x.nodeId), ['node-a']);
    assert.equal(check!.topics[0]!.cards[0]!.lapses, 3);
  } finally { await t.cleanup(); }
});
