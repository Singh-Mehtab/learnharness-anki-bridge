import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, StateStore, migrateState, validateState } from '../src/anki/state.ts';
import type { Card, State } from '../src/anki/state.ts';
import { projectCoverage, isUncardedNode } from '../src/coverage/flow.ts';
import type { CoverageContext } from '../src/coverage/flow.ts';
import { graphCoverage, statementHash } from '../src/coverage/service.ts';
import { defaultSelection, uncardedIds } from '../src/session/flow.ts';
import { activate } from '../src/backend.ts';
import { FakeHost, until } from './fake-host.ts';

const node = { id: 'n_a', name: 'Alpha', statement: 'Alpha implies beta under assumption A.' };
const source = { ...node, statementHash: statementHash(node.statement) };
const paired = { url: 'http://127.0.0.1:8766/', profile: 'Throwaway' };
const snapshot = { nodeId: node.id, name: node.name, statement: node.statement, statementHash: source.statementHash, sessionId: 'c1', sessionName: 'Scratch' };
function card(patch: Partial<Card> = {}): Card {
  return { id: randomUUID(), nodeId: node.id, nodeName: node.name, sessionId: 'c1', sessionName: 'Scratch', statementHash: source.statementHash,
    sourceSnapshot: snapshot, front: 'A question?', back: 'Answer.', extra: '', kind: 'recall', status: 'draft', ...patch };
}
const sent = (patch: Partial<Card> = {}) => card({ status: 'sent', destination: paired, deck: 'One', noteId: 123, ...patch });
const dismiss = (hash = source.statementHash) => ({ nodeId: node.id, statementHash: hash, dismissedAt: '2026-11-18T00:00:00.000Z' });
function view(cards: Card[] = [], extra: Partial<State> = {}) {
  return projectCoverage([source], { ...initialState(), destination: paired, cards, ...extra }).nodes[0];
}

test('coverage counts waiting, mixed sent/waiting and dropped-only cards without Anki', () => {
  assert.equal(view().coverage.state, 'no-cards');
  for (const status of ['draft', 'approved', 'failed', 'sending'] as const) {
    const n = view([card({ status })]);
    assert.equal(n.coverage.state, 'drafts-waiting'); assert.equal(n.cards.waiting, 1); assert.equal(n.coverage.uncarded, false);
    assert.equal(n.coverage.selectable, status !== 'sending');
  }
  for (const status of ['draft', 'approved', 'failed'] as const) {
    const n = view([card({ status, noteId: 123, sourceSnapshot: undefined })]);
    assert.equal(n.cards.waiting, 0); assert.equal(n.coverage.unknownSourceCards, 0);
    assert.equal(n.coverage.canDismiss, false, 'still an unsent record');
  }
  assert.equal(view([card({ status: 'sending', noteId: 123 })]).coverage.unresolved, 1);
  const mixed = view([sent(), card(), card({ status: 'dropped' })]);
  assert.equal(mixed.coverage.state, 'sent'); assert.deepEqual(mixed.cards, { waiting: 1, sent: 1, sentElsewhere: 0 });
  assert.equal(view([card({ status: 'dropped' })]).coverage.uncarded, true);
});

test('coverage is destination-aware, deck-independent and does not recreate deleted notes', () => {
  assert.equal(view([sent({ deck: 'Another', presence: 'deleted' })]).coverage.state, 'sent');
  assert.equal(view([sent({ presence: 'deleted' })]).coverage.deletedNotes, 1);
  for (const destination of [null, { ...paired, profile: 'Other' }, { ...paired, url: 'http://localhost:8766/' }]) {
    const n = view([sent()], { destination });
    assert.equal(n.coverage.state, 'no-cards'); assert.equal(n.cards.sentElsewhere, 1); assert.equal(n.coverage.uncarded, true);
  }
});

test('source alerts ignore dropped and other-destination cards and distinguish unknown snapshots', () => {
  const old = { ...snapshot, statement: 'Old statement', statementHash: statementHash('Old statement') };
  assert.equal(view([sent({ sourceSnapshot: old })]).coverage.state, 'source-changed');
  const mixed = view([sent({ sourceSnapshot: old }), sent()]);
  assert.equal(mixed.coverage.state, 'sent'); assert.equal(mixed.coverage.olderSourceCards, 1);
  assert.equal(view([card({ status: 'dropped', sourceSnapshot: old })]).coverage.state, 'no-cards');
  assert.equal(view([sent({ destination: { ...paired, profile: 'Other' }, sourceSnapshot: old })]).coverage.state, 'no-cards');
  const legacy = view([sent({ sourceSnapshot: undefined, statementHash: 'hash-of-card-text' }), sent({ sourceSnapshot: old })]);
  assert.equal(legacy.coverage.state, 'sent'); assert.equal(legacy.coverage.unknownSourceCards, 1);
});

test('dismissal expires with the statement and current dismissal overrides only stale sent history', () => {
  assert.equal(view([], { dismissals: [dismiss()] }).coverage.state, 'dismissed');
  assert.equal(view([], { dismissals: [dismiss('0'.repeat(64))] }).coverage.state, 'source-changed');
  const old = { ...snapshot, statementHash: '0'.repeat(64) };
  const n = view([sent({ sourceSnapshot: old })], { dismissals: [dismiss()] });
  assert.equal(n.coverage.state, 'dismissed'); assert.equal(n.cards.sent, 1); assert.equal(n.coverage.selectable, false);
  assert.equal(view([sent()], { dismissals: [dismiss()] }).coverage.state, 'sent');
  assert.equal(view([card()]).coverage.canDismiss, false);
  assert.equal(view([sent({ sourceSnapshot: old })]).coverage.canDismiss, true);
});

test('exact IDs never resolve aliases or identical text; missing sources are historical and unselectable', () => {
  const state = { ...initialState(), destination: paired, cards: [sent(), card({ nodeId: 'manual:1', sourceSnapshot: undefined })] };
  const next = graphCoverage({ propositions: [{ ...node, id: 'n_recreated' }] }, state);
  assert.equal(next.nodes[0].coverage.uncarded, true); assert.equal(next.missing.length, 1);
  assert.equal(next.missing[0].id, node.id); assert.equal(next.missing[0].coverage.state, 'source-missing');
  assert.equal(next.missing[0].coverage.selectable, false);
  const onlyDismissal = projectCoverage([], { ...initialState(), dismissals: [dismiss()] });
  assert.equal(onlyDismissal.missing.length, 1);
  assert.equal(onlyDismissal.missing[0].coverage.historicalDismissal, true);
  assert.equal(onlyDismissal.missing[0].coverage.dismissed, false);
  const history = [sent(), card({ status: 'dropped', sourceSnapshot: { ...snapshot, statementHash: '0'.repeat(64) } })];
  for (const cards of [history, [...history].reverse()]) {
    const [row] = projectCoverage([], { ...initialState(), destination: paired, cards }).missing;
    assert.equal(row.cards.sent, 1); assert.equal(row.coverage.olderSourceCards, 0);
  }
  assert.equal(graphCoverage({ propositions: [{ ...node, name: 'New label' }] }, state).nodes[0].coverage.state, 'sent');
});

test('session defaults and bulk selection consume the same coverage eligibility', () => {
  const rows = [view(), view([sent()]), view([], { dismissals: [dismiss()] }), view([card({ status: 'sending' })])]
    .map((n, i) => ({ ...n, id: `id-${i}`, flagged: true }));
  assert.deepEqual(defaultSelection(rows), ['id-0', 'id-1']);
  assert.deepEqual(uncardedIds(rows), ['id-0']);
  assert.deepEqual(rows.filter(isUncardedNode).map(n => n.id), ['id-0']);
});

async function fixture(fn: (host: FakeHost, c: ReturnType<FakeHost['context']>, directory: string, close: () => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-'));
  const host = new FakeHost(), c = host.context(directory); let close: (() => Promise<void>) | undefined;
  try { close = await activate(c.ctx); await fn(host, c, directory, close); }
  finally { await close?.(); await rm(directory, { recursive: true, force: true }); }
}

test('coverage works without catalog/model/Anki, persists dismissals, and refuses late handlers', () => fixture(async (host, c, directory, close) => {
  c.ctx.inference.catalog = async () => { throw new Error('Catalog unavailable'); };
  const before = await c.call<CoverageContext>('coverageContext');
  assert.equal(host.catalogCalls, 0); assert.equal(before.nodes.length, 2);
  await c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash });
  assert.equal((await c.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, 'dismissed');
  const late = c.handlers.get('coverageContext')!;
  await close(); await assert.rejects(Promise.resolve().then(() => late({})), /disabled/);
  const next = host.context(directory), closeNext = await activate(next.ctx);
  try {
    assert.equal((await next.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, 'dismissed');
    await next.call('restoreNode', { nodeId: node.id, statementHash: source.statementHash });
    assert.equal((await next.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, 'no-cards');
  } finally { await closeNext(); }
}));

test('dismiss and restore acknowledge the commit without another graph read', () => fixture(async (_host, c) => {
  const graph = c.ctx.learning.graph;
  for (const [operation, state] of [['dismissNode', 'dismissed'], ['restoreNode', 'no-cards']] as const) {
    let reads = 0;
    c.ctx.learning.graph = () => { if (++reads > 1) throw new Error('Second graph read unavailable'); return graph(); };
    const updated = await c.call<CoverageContext>(operation, { nodeId: node.id, statementHash: source.statementHash });
    assert.equal(reads, 1); assert.equal(updated.nodes[0].coverage.state, state);
    c.ctx.learning.graph = graph;
    assert.equal((await c.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, state);
  }
}));

test('generation acknowledgement does not read the graph after validation and still starts one worker', () => fixture(async (host, c) => {
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  const original = c.ctx.learning.graph;
  let reads = 0;
  c.ctx.learning.graph = () => { reads++; return original(); };
  const p = await c.call('preflight', { nodeIds: [node.id] });
  const validationReads = reads; reads = 0;
  c.ctx.learning.graph = () => { if (++reads > validationReads) throw new Error('Post-commit graph unavailable'); return original(); };
  const result = await c.call('generate', { preflightId: p.preflightId });
  assert.equal(result.generations[0].id, p.preflightId); assert.equal(reads, validationReads);
  await until(() => host.workers.starts.length === 1);
  assert.equal((await c.call('generate', { preflightId: p.preflightId })).generations.length, 1);
  assert.equal(reads, validationReads); assert.equal(host.workers.starts.length, 1);
}));

test('delivery mutation succeeds when warnings for a saved source cannot be refreshed', () => fixture(async (host, c) => {
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  const p = await c.call('preflight', { nodeIds: [node.id] }); await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  host.workers.succeed('task-1', { targets: [{ nodeId: node.id, cards: [{ kind: 'fact', front: 'Which condition makes this fixture result valid?', back: 'Assumption A.' }] }] });
  await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
  const [generated] = (await c.call('snapshot')).cards;
  c.ctx.learning.graph = () => { throw new Error('Graph unavailable'); };
  const result = await c.call('approve', { ids: [generated.id] });
  for (const [item] of [result.cards, (await c.call('snapshot')).cards]) {
    assert.equal(item.status, 'approved'); assert.equal(item.sourceStatement, node.statement);
    assert.equal(item.sourceUnavailable, true); assert.equal(item.sourceMissing, undefined); assert.equal(item.sourceChanged, undefined);
  }
  await assert.rejects(c.call('coverageContext'), /Graph unavailable/);
}));

test('dismissal rejects malformed, stale and missing sources and never drops waiting cards', () => fixture(async (host, c) => {
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: 'invalid' }), /current source/);
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: '0'.repeat(64) }), /Source changed/);
  await assert.rejects(c.call('dismissNode', { nodeId: 'gone', statementHash: source.statementHash }), /missing/);
  await c.call('draft', { nodeId: node.id, front: 'Question', back: 'Answer' });
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash }), /waiting/);
  assert.equal((await c.call('snapshot')).cards[0].status, 'draft');
  const original = c.ctx.learning.graph;
  c.ctx.learning.graph = () => { throw new Error('Graph unavailable'); };
  await assert.rejects(c.call('coverageContext'), /Graph unavailable/);
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash }), /Graph unavailable/);
  c.ctx.learning.graph = original; assert.equal(host.workers.starts.length, 0);
}));

test('dismiss/restore cannot revive old confirmation and changed coverage requires a fresh estimate', () => fixture(async (host, c) => {
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  const p = await c.call('preflight', { nodeIds: [node.id] });
  await c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash });
  await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /expired/);
  await c.call('restoreNode', { nodeId: node.id, statementHash: source.statementHash });
  await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /expired/);
  assert.equal(host.workers.starts.length, 0);
  const next = await c.call('preflight', { nodeIds: [node.id] });
  await c.call('draft', { nodeId: node.id, front: 'New prompt', back: 'New answer' });
  await assert.rejects(c.call('generate', { preflightId: next.preflightId }), /stale/);
}));

test('pending generation is activity, blocks bulk selection/dismissal, and zero-card results keep their reason', () => fixture(async (host, c) => {
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  const p = await c.call('preflight', { nodeIds: [node.id] }); await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  let n = (await c.call<CoverageContext>('coverageContext')).nodes[0];
  assert.equal(n.coverage.state, 'no-cards'); assert.equal(n.coverage.generating, true); assert.equal(n.coverage.uncarded, false);
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash }), /settle generation/);
  host.workers.succeed('task-1', { targets: [{ nodeId: node.id, cards: [], skipReason: 'Prior knowledge' }] });
  await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
  n = (await c.call<CoverageContext>('coverageContext')).nodes[0];
  assert.equal(n.coverage.state, 'no-cards'); assert.equal(n.coverage.uncarded, true); assert.equal(n.coverage.skipReason, 'Prior knowledge');
  await c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash });
  assert.equal((await c.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, 'dismissed');
}));

test('dismissal racing a card-producing worker result preserves the draft and refuses dismissal', () => fixture(async (host, c) => {
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
  const p = await c.call('preflight', { nodeIds: [node.id] }); await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  host.workers.succeed('task-1', { targets: [{ nodeId: node.id, cards: [{ kind: 'fact', front: 'Which condition makes this fixture result valid?', back: 'Assumption A.' }] }] });
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash }), /waiting|settle generation/);
  await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
  assert.equal((await c.call('snapshot')).cards.length, 1);
  await assert.rejects(c.call('dismissNode', { nodeId: node.id, statementHash: source.statementHash }), /waiting/);
  assert.equal((await c.call<CoverageContext>('coverageContext')).nodes[0].coverage.state, 'drafts-waiting');
}));

test('migrations from 1/2/3 retain supported data; corrupt and future dismissals never reset a file', async () => {
  for (const version of [1, 2, 3]) {
    const base = initialState(); const { dismissals: _d, ...old } = base;
    const raw = { ...old, schemaVersion: version, generationSettings: { cardsPerNode: 2, enabledKinds: ['recall'], model: null }, cards: [sent()], destination: paired };
    const migrated = migrateState(raw);
    assert.equal(migrated.schemaVersion, 5); assert.deepEqual(migrated.dismissals, []);
    assert.deepEqual(migrated.cards, raw.cards); assert.deepEqual(migrated.destination, paired);
    if (version >= 2) assert.deepEqual(migrated.generationSettings, base.generationSettings);
    if (version >= 3) assert.deepEqual(migrated.flags, raw.flags);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-coverage-state-')), file = path.join(directory, 'state.json');
  try {
    for (const bad of [{ ...initialState(), dismissals: [dismiss(), dismiss()] }, { ...initialState(), dismissals: [dismiss('bad')] },
      { ...initialState(), dismissals: [{ ...dismiss(), dismissedAt: 'not-a-date' }] }, { ...initialState(), schemaVersion: 6 }]) {
      const raw = JSON.stringify(bad); await writeFile(file, raw);
      await assert.rejects(StateStore.open(directory), /Invalid|Unsupported/); assert.equal(await readFile(file, 'utf8'), raw);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.throws(() => validateState({ ...initialState(), dismissals: null }), /Invalid/);
});
