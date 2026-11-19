import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PluginBackendContext } from '../sdk/index.d.ts';
import { activate } from '../src/backend.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { StateStore, initialState } from '../src/anki/state.ts';
import { FakeHost } from './fake-host.ts';
import { messageFingerprint } from '../src/session/extraction.ts';
import { failedOutputCallIds } from '../src/session/flow.ts';
import { SessionService } from '../src/session/service.ts';
import type { FlagView, SessionFlow, SessionList } from '../src/session/service.ts';

const teachMessages = () => [
  { id: 'u1', role: 'user', content: 'Explain spin' },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Spin is intrinsic angular momentum.' }], stopReason: 'stop' },
  { id: 'u2', role: 'user', content: 'And Pauli?' },
  { id: 'a2', role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'quiz', arguments: {} }], stopReason: 'toolUse' },
  { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'Pauli matrices generate rotations.' }], stopReason: 'stop' },
];

function host() {
  const sessions = new Map<string, { id: string; title: string; kind: string; updatedAt: string; messages: Array<Record<string, unknown>> }>([
    ['s1', { id: 's1', title: 'Spin', kind: 'teach', updatedAt: '2026-11-18T10:00:00Z', messages: teachMessages() }],
    ['s0', { id: 's0', title: 'Older', kind: 'teach', updatedAt: '2026-11-01T10:00:00Z', messages: [] }],
    ['p1', { id: 'p1', title: 'Practice', kind: 'practice', updatedAt: '2026-11-18T11:00:00Z', messages: teachMessages() }],
  ]);
  const graph = {
    propositions: [] as Array<{ id: string; name: string; statement: string; provenance: Array<{ chatId: string; messageId: string }> }>,
    nodeSessions: {} as Record<string, string[]>, sessions: { s1: 'Spin' } as Record<string, string>,
  };
  const coverage: Array<{ chatId: string; fp: string; tokens: number; foldedAt: string }> = [];
  const learning = {
    directory: '/scratch',
    listSessions: () => [...sessions.values()].map(({ messages, ...s }) => ({ ...s, createdAt: s.updatedAt, messageCount: messages.length })),
    getSession: (id: string) => { if (id === 'bad id') throw new Error('Invalid ID'); return structuredClone(sessions.get(id) ?? null); },
    graph: () => structuredClone(graph),
    readGraphFile: (name: string) => { assert.equal(name, 'coverage.jsonl'); return structuredClone(coverage); },
  };
  const addNode = (id: string, name: string, messageId: string, chatId = 's1') => {
    graph.propositions.push({ id, name, statement: `${name} statement`, provenance: [{ chatId, messageId }] });
    graph.nodeSessions[id] = [...new Set([...(graph.nodeSessions[id] ?? []), chatId])];
  };
  const extract = (chatId: string, messageId: string) => {
    const messages = sessions.get(chatId)!.messages, m = messages.find(x => x.id === messageId)!;
    coverage.push({ chatId, fp: messageFingerprint(m, failedOutputCallIds(messages)), tokens: 1, foldedAt: 'now' });
  };
  return { sessions, graph, coverage, learning, addNode, extract };
}

function context(directory: string, learning: unknown, controller = new AbortController()) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const ctx = {
    ...new FakeHost().context(directory, controller).ctx,
    dataDirectory: directory, signal: controller.signal, learning,
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
  } as unknown as PluginBackendContext;
  const call = async <T>(name: string, input: unknown = {}) => { const h = handlers.get(name); assert(h, `${name} registered`); return await h(input) as T; };
  return { ctx, handlers, call, controller };
}
async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anki-session-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const card = (over: Record<string, unknown>) => ({
  id: '11111111-1111-4111-8111-111111111111', nodeId: 'n-spin', statementHash: 'h', sessionId: 's1', nodeName: 'Spin', sessionName: 'Spin',
  kind: 'recall', front: 'F', back: 'B', extra: '', status: 'draft', ...over,
});

test('version 1 state migrates to flags without losing cards; newer versions are refused unchanged', async () => withDir(async dir => {
  const file = path.join(dir, 'state.json');
  const v1 = { schemaVersion: 1, settings: { url: 'http://127.0.0.1:8765/', apiKey: 'k', lastDeck: 'D' }, destination: null, cards: [card({})] };
  await writeFile(file, JSON.stringify(v1));
  const h = host(), c = context(dir, h.learning), close = await activate(c.ctx);
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.schemaVersion, 4);
    assert.deepEqual(saved.flags, []);
    assert.deepEqual(saved.cards, v1.cards);
    assert.equal(saved.settings.apiKey, 'k');
  } finally { await close(); }
  const future = JSON.stringify({ ...v1, schemaVersion: 5, flags: [] });
  await writeFile(file, future);
  await assert.rejects(activate(context(dir, h.learning).ctx), /Unsupported/);
  assert.equal(await readFile(file, 'utf8'), future);
}));

test('schema 2 migrates through 3 to 4 and preserves generation settings and cards', async () => withDir(async dir => {
  const { flags: _flags, ...base } = initialState();
  const v2 = { ...base, schemaVersion: 2,
    generationSettings: { ...base.generationSettings, cardsPerNode: 4, enabledKinds: ['recall'] }, cards: [card({})] };
  const file = path.join(dir, 'state.json');
  await writeFile(file, JSON.stringify(v2));
  const store = await StateStore.open(dir);
  try {
    assert.deepEqual(store.snapshot(), { ...v2, schemaVersion: 4, flags: [], dismissals: [] });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), store.snapshot());
    const delivery = new DeliveryService(store), h = host();
    const session = new SessionService(h.learning as never, store, delivery);
    const flow = await session.command('sessionFlow', { sessionId: 's1' }) as SessionFlow;
    assert.equal(flow.cardsPerNode, 4);
    await delivery.close();
  } finally { await store.close(); }
}));

test('malformed schema 2 generation and schema 3 flags are refused without touching the file', async () => withDir(async dir => {
  const file = path.join(dir, 'state.json');
  for (const bad of [
    { ...initialState(), schemaVersion: 2, generations: [{ id: 'broken' }] },
    { ...initialState(), flags: [{ id: 'broken' }] },
    { ...initialState(), cards: [card({ sourceSnapshot: { broken: true } })] },
  ]) {
    const raw = JSON.stringify(bad);
    await writeFile(file, raw);
    await assert.rejects(StateStore.open(dir), /Invalid/);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
}));

test('a flag waits for extraction, then reports no nodes or matched nodes, and survives restart', async () => withDir(async dir => {
  const h = host(), c = context(dir, h.learning);
  let close = await activate(c.ctx);
  try {
    assert.equal(c.handlers.size, 29);
    const waiting = await c.call<FlagView>('flag', { sessionId: 's1', messageIds: ['a3'] });
    assert.equal(waiting.status, 'waiting');
    assert.equal((waiting as FlagView & { created: boolean }).created, true);
    assert.equal(waiting.note, '');
    assert.equal(waiting.sessionTitle, 'Spin');
    assert.deepEqual(waiting.nodeIds, []);
    let list = await c.call<SessionList>('sessions');
    assert.deepEqual(list.sessions.map(s => s.id), ['s1', 's0']); // practice excluded, newest first
    assert.equal(list.sessions[0].waitingCount, 1);
    assert.equal(list.unresolved[0].id, waiting.id);

    h.extract('s1', 'a3');
    let flow = await c.call<SessionFlow>('sessionFlow', { sessionId: 's1' });
    assert.equal(flow.flags[0].status, 'no-nodes');

    h.addNode('n-pauli', 'Pauli', 'a3'); h.addNode('n-spin', 'Spin', 'a1'); h.addNode('n-chat', 'Chat level', '');
    flow = await c.call<SessionFlow>('sessionFlow', { sessionId: 's1' });
    assert.equal(flow.flags[0].status, 'matched');
    assert.deepEqual(flow.flags[0].nodeIds, ['n-pauli']);
    assert.deepEqual(flow.nodes.map(n => [n.id, n.flagged]), [['n-spin', false], ['n-pauli', true], ['n-chat', false]]);
    assert.deepEqual(flow.session, { id: 's1', title: 'Spin', exists: true });
    assert.equal(flow.cardsPerNode, 2);
    list = await c.call<SessionList>('sessions');
    assert.equal(list.sessions[0].nodeCount, 3);
    assert.equal(list.unresolved.length, 0);
    await close();
    assert.equal(c.handlers.size, 0); // Disable unregisters both services' operations.

    const next = context(dir, h.learning); close = await activate(next.ctx);
    flow = await next.call<SessionFlow>('sessionFlow', { sessionId: 's1' });
    assert.equal(flow.flags.length, 1);
    assert.equal(flow.flags[0].id, waiting.id);
  } finally { await close(); }
}));

test('re-flagging a turn updates its note instead of duplicating; notes reach the writer map', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    h.addNode('n-pauli', 'Pauli', 'a3');
    const first = await session.command('flag', { sessionId: 's1', messageIds: ['a3'] }) as FlagView;
    const second = await session.command('flag', { sessionId: 's1', messageIds: ['a3'], note: '  sign\nwrong ' }) as FlagView;
    assert.equal(second.id, first.id);
    assert.equal((second as FlagView & { created: boolean }).created, false);
    assert.equal(second.note, 'sign wrong');
    const third = await session.command('flag', { sessionId: 's1', messageIds: ['a3'] }) as FlagView;
    assert.equal(third.note, 'sign wrong'); // omitted note keeps the existing one
    await session.command('flag', { sessionId: 's1', messageIds: ['a3'], note: '' });
    assert.equal(store.snapshot().flags[0].note, '');
    await session.command('flag', { sessionId: 's1', messageIds: ['a3'], note: 'units' });
    assert.equal(store.snapshot().flags.length, 1);
    assert.deepEqual(Object.fromEntries(session.flagNotes()), { 'n-pauli': 'units' });
    // Overlapping turns merge into one flag rather than claiming a message twice.
    await session.command('flag', { sessionId: 's1', messageIds: ['a1'] });
    const merged = await session.command('flag', { sessionId: 's1', messageIds: ['a1', 'a3'] }) as FlagView;
    assert.equal(store.snapshot().flags.length, 1);
    assert.deepEqual(merged.messageIds.sort(), ['a1', 'a3']);
    assert.equal(merged.note, 'units');
    await session.command('unflag', { id: merged.id });
    assert.deepEqual(store.snapshot().flags, []);
    await assert.rejects(session.command('unflag', { id: merged.id }), /not found/);
  } finally { await delivery.close(); await store.close(); }
}));

test('flags are refused for unsaved, non-teacher, practice, missing or malformed targets', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['optimistic-1'] }), /not saved/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['u1'] }), /not saved/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['a2'] }), /not saved/); // tool-only message
    await assert.rejects(session.command('flag', { sessionId: 'p1', messageIds: ['a1'] }), /teaching/);
    await assert.rejects(session.command('flag', { sessionId: 'gone', messageIds: ['a1'] }), /not found/);
    await assert.rejects(session.command('flag', { sessionId: 'bad id', messageIds: ['a1'] }), /not found/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: [] }), /distinct/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['a1', 'a1'] }), /distinct/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['a1'], note: 'x'.repeat(301) }), /longer/);
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['a1'], extra: 1 }), /Unsupported/);
    await assert.rejects(session.command('sessionFlow', {}), /Choose a session/);
    await assert.rejects(session.command('nope', {}), /Unknown/);
    assert.deepEqual(store.snapshot().flags, []);
  } finally { await delivery.close(); await store.close(); }
}));

test('flags whose session or message disappears stay visible as missing even with retained graph provenance', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    h.addNode('n-spin', 'Spin', 'a1');
    const flagged = await session.command('flag', { sessionId: 's1', messageIds: ['a1'] }) as FlagView;
    assert.equal(flagged.status, 'matched');
    h.sessions.get('s1')!.messages = h.sessions.get('s1')!.messages.filter(m => m.id !== 'a1');
    let flow = await session.command('sessionFlow', { sessionId: 's1' }) as SessionFlow;
    assert.equal(flow.flags[0].status, 'missing');
    h.sessions.delete('s1');
    flow = await session.command('sessionFlow', { sessionId: 's1' }) as SessionFlow;
    assert.equal(flow.flags[0].status, 'missing');
    assert.equal(flow.session.exists, false);
    assert.equal(flow.session.title, 'Spin');
    const list = await session.command('sessions', {}) as SessionList;
    assert.equal(list.unresolved.length, 1); // still listed although the session is gone
    assert.deepEqual(flow.nodes.map(n => n.id), ['n-spin']); // Kept graph remains usable.
    await session.command('unflag', { id: flagged.id });
    assert.deepEqual((await session.command('sessions', {}) as SessionList).unresolved, []);
  } finally { await delivery.close(); await store.close(); }
}));

test('session picker counts the same propositions as the flow, excluding derived node entries', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    h.addNode('n-spin', 'Spin', 'a1'); h.addNode('n-provenance', 'Provenance only', 'a3');
    delete h.graph.nodeSessions['n-provenance'];
    h.graph.nodeSessions['derived-1'] = ['s1']; h.graph.nodeSessions['derived-2'] = ['s1'];
    const list = await session.command('sessions') as SessionList;
    const flow = await session.command('sessionFlow', { sessionId: 's1' }) as SessionFlow;
    assert.equal(flow.nodes.length, 2);
    assert.equal(list.sessions.find(s => s.id === 's1')!.nodeCount, flow.nodes.length);
  } finally { await delivery.close(); await store.close(); }
}));

test('matched flags outside the capped session picker remain accessible', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    h.addNode('n-spin', 'Spin', 'a1');
    const flag = await session.command('flag', { sessionId: 's1', messageIds: ['a1'] }) as FlagView;
    for (let i = 0; i < 200; i++) h.sessions.set(`new-${i}`, { id: `new-${i}`, title: 'Newer', kind: 'teach', updatedAt: '2026-11-19T10:00:00Z', messages: [] });
    const list = await session.command('sessions') as SessionList;
    assert.equal(list.sessions.some(s => s.id === 's1'), false);
    assert.deepEqual(list.unresolved.map(f => [f.id, f.status]), [[flag.id, 'matched']]);
  } finally { await delivery.close(); await store.close(); }
}));

test('flag writes wait for the shared writer fence instead of failing or racing a send', async () => withDir(async dir => {
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const long = delivery.exclusive(async () => { await gate; await delivery.save(s => { s.settings.lastDeck = 'During send'; }); });
    const flagged = session.command('flag', { sessionId: 's1', messageIds: ['a1'] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(store.snapshot().flags, []);
    release();
    await long; await flagged;
    const state = store.snapshot();
    assert.equal(state.settings.lastDeck, 'During send');
    assert.equal(state.flags.length, 1);
  } finally { await delivery.close(); await store.close(); }
}));

test('session nodes count waiting cards and sent cards for the paired destination only', async () => withDir(async dir => {
  const paired = { url: 'http://127.0.0.1:8765/', profile: 'Scratch' };
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({
    ...initialState(), settings: { url: paired.url, apiKey: '', lastDeck: 'D' }, destination: paired,
    cards: [
      card({ id: '11111111-1111-4111-8111-111111111111', status: 'sent', noteId: 1, deck: 'D', destination: paired }),
      card({ id: '22222222-2222-4222-8222-222222222222', status: 'sent', noteId: 2, deck: 'D', destination: { ...paired, profile: 'Other' } }),
      card({ id: '33333333-3333-4333-8333-333333333333', status: 'approved' }),
      card({ id: '44444444-4444-4444-8444-444444444444', status: 'dropped', nodeId: 'n-pauli' }),
    ],
  }));
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery, { cardsPerNode: () => 3 });
  try {
    h.addNode('n-spin', 'Spin', 'a1'); h.addNode('n-pauli', 'Pauli', 'a3');
    const flow = await session.command('sessionFlow', { sessionId: 's1' }) as SessionFlow;
    assert.deepEqual(flow.nodes.map(n => [n.id, n.cards]), [
      ['n-spin', { waiting: 1, sent: 1, sentElsewhere: 1 }],
      ['n-pauli', { waiting: 0, sent: 0, sentElsewhere: 0 }],
    ]);
    assert.equal(flow.cardsPerNode, 3);
    assert.equal(flow.paired, true);
  } finally { await delivery.close(); await store.close(); }
}));

test('the flag cap gives a clear message and leaves state valid', async () => withDir(async dir => {
  const flags = Array.from({ length: 5000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sessionId: 's0', sessionTitle: 'Older', messageIds: [`m${i}`], note: '', flaggedAt: '2026-11-18T10:00:00.000Z' }));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ ...initialState(), flags }));
  const h = host(), store = await StateStore.open(dir), delivery = new DeliveryService(store);
  const session = new SessionService(h.learning as never, store, delivery);
  try {
    await assert.rejects(session.command('flag', { sessionId: 's1', messageIds: ['a1'] }), /holds 5000 flags/);
    assert.equal(store.snapshot().flags.length, 5000);
  } finally { await delivery.close(); await store.close(); }
}));
