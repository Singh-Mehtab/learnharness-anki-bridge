import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initialState, type Card } from '../src/anki/state.ts';
import { activate } from '../src/backend.ts';
import { earlierRepeatSkips } from '../src/earlier-repeats-ui.ts';
import { addEarlierRepeatCandidates, earlierRepeatSimilarity, indexEarlierRepeats, possibleEarlierRepeat } from '../src/generation/earlier-repeats.ts';
import type { WriterInput, WriterTarget } from '../src/writer/types.ts';
import { outputAllowance } from '../src/writer/input.ts';
import { findProblems } from '../src/writer/validate.ts';
import { FakeHost, until } from './fake-host.ts';

const target = (nodeId: string): WriterTarget => ({ nodeId, name: 'Rest energy', statement: 'The rest energy is \\(E_0 = mc^2\\).',
  aliases: [], concludedBy: [], feeds: [], neighbours: [], existingCards: [], allowedKinds: ['equation'] });
const equation = { kind: 'equation' as const, front: 'State the rest energy equation.', back: '$E_{0} = mc^{2}$' };
const row = (patch: Partial<Card> = {}): Card => ({ id: randomUUID(), nodeId: 'other', nodeName: 'Earlier idea', statementHash: 'old',
  sessionId: 'old-session', sessionName: 'Earlier session', extra: '', status: 'draft', ...equation, ...patch });
const sent = { status: 'sent', noteId: 42, deck: 'Other deck', destination: { url: 'http://example.test/', profile: 'Scratch' } } as const;
const base = (targets = [target('n_a')]): WriterInput => ({ version: 1, maxCardsPerNode: 2, enabledKinds: ['equation'], targets });

test('indexEarlierRepeats ranks text and normalised maths across eligible bridge records, not graph IDs or decks', () => {
  const best = row({ ...sent, presence: 'unknown' });
  const earlierDraft = row({ status: 'approved', back: '\\(E_0 = mc^2\\)', front: 'Which formula gives rest energy for a stationary particle?' });
  const unrelated = row({ front: 'What does a mole measure?', back: 'Amount of substance.' });
  const imported = row({ status: 'imported', deck: 'Other deck', front: 'What is the rest energy of a stationary object?', back: '\\(E_0=mc^2\\)' });
  const cards = [row({ nodeId: 'fourth', front: 'Who named the process?', back: 'A researcher.' }),
    best, earlierDraft, unrelated, row({ ...sent, presence: 'deleted' }), row({ status: 'dropped' }),
    imported, row({ status: 'sending' }), row({ generationId: 'now' })];
  const index = indexEarlierRepeats(cards, { generationId: 'now' });
  assert.deepEqual(new Set(index.rank(target('n_a')).map(c => c.id)), new Set([best.id, earlierDraft.id, imported.id]));
  assert.equal(index.possible(equation), best.id);
  assert.ok(!indexEarlierRepeats(cards, { cardId: best.id, generationId: 'now' }).rank(target('n_a')).some(c => c.id === best.id));
  assert.equal(earlierRepeatSimilarity(equation, { ...equation, front: 'State the rest energy relation.', back: '\\(E_0=mc^2\\)' }), 0.75);
  assert.ok(earlierRepeatSimilarity(equation, { ...equation, front: 'How does energy vary with velocity?' }) < 0.5);
});

test('rank and backstop link a Basic equation to a cloze answer fragment', () => {
  const plain = row({ front: 'State the surface area of a sphere of radius \\(r\\).', back: '\\[A = 4\\pi r^2\\]' });
  const cloze = row({ format: 'cloze', front: 'Surface area of a sphere of radius \\(r\\): \\(A = {{blank}}\\)', back: '4\\pi r^2' });
  const differentCue = row({ ...cloze, front: 'Differentiate the enclosed volume with respect to radius: \\(A = {{blank}}\\)' });
  assert.equal(indexEarlierRepeats([differentCue, cloze]).possible(plain), cloze.id);
  assert.equal(indexEarlierRepeats([differentCue]).possible(plain), undefined);
  const earlier = row({ front: 'What is the kinetic energy?', back: '\\[T = mv^2/2\\]' });
  assert.equal(indexEarlierRepeats([earlier]).rank({ name: 'Motion', statement: 'Using T = mv²/2 gives the result.' })[0]?.id, earlier.id);
});

test('addEarlierRepeatCandidates respects the caller budget without changing groups, and the local backstop sees cards not sent', () => {
  const anchor = row({ ...equation });
  const long = row({ front: `${equation.front} ${'a '.repeat(2000)}` });
  const input = { ...base(), flagRequests: [{ id: 'flag', note: 'Review this', nodeIds: ['n_a'] }] };
  const index = indexEarlierRepeats([anchor, long]);
  const packed = addEarlierRepeatCandidates(input, index, value => JSON.stringify(value).length < 1200);
  assert.deepEqual(packed.flagRequests, input.flagRequests);
  assert.deepEqual(packed.targets[0].earlierRepeatCandidates?.map(c => c.id), [anchor.id]);
  assert.equal(input.targets[0].earlierRepeatCandidates, undefined);
  const noRoom = addEarlierRepeatCandidates(input, index, () => false);
  assert.deepEqual(noRoom, input);
  assert.equal(possibleEarlierRepeat(equation, noRoom.targets[0].earlierRepeatCandidates, index), long.id);
  assert.equal(possibleEarlierRepeat({ ...equation, possibleRepeatOf: anchor.id }, packed.targets[0].earlierRepeatCandidates, index), anchor.id);
});

test('findProblems accepts only the exact earlier repeat card IDs attached to each target and no override skip', () => {
  const earlier = row();
  const input = base([target('n_a'), { ...target('n_b'), earlierRepeatCandidates: [{ id: earlier.id, front: earlier.front, back: earlier.back }] }]);
  const ordinary = { nodeId: 'n_a', cards: [equation] };
  const skip = { nodeId: 'n_b', cards: [], skipReason: 'Already covered.', earlierRepeatOf: earlier.id };
  assert.deepEqual(findProblems({ targets: [ordinary, skip] }, input), []);
  assert.match(findProblems({ targets: [{ ...skip, nodeId: 'n_a' }, skip] }, input).join(), /listed earlier card ID/);
  assert.match(findProblems({ targets: [{ ...ordinary, cards: [{ ...equation, possibleRepeatOf: earlier.id }] }, skip] }, input).join(), /possibleRepeatOf/);
  const possible = { nodeId: 'n_b', cards: [{ ...equation, possibleRepeatOf: earlier.id }] };
  assert.deepEqual(findProblems({ targets: [ordinary, possible] }, input), []);
  assert.match(findProblems({ targets: [ordinary, { ...skip, cards: [equation] }] }, input).join(), /zero-card/);
  assert.match(findProblems({ targets: [skip] }, { ...input, targets: [input.targets[1]], writeAnyway: true }).join(), /override/);
});

async function withEarlierCards(cards: Card[], run: (host: FakeHost, context: ReturnType<FakeHost['context']>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-earlier-repeats-'));
  const host = new FakeHost(); host.nodes[0] = { id: 'n_a', name: target('n_a').name, statement: target('n_a').statement, provenance: host.nodes[0].provenance };
  host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' } };
  const c = host.context(directory);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Historical checks must not read Anki.'); };
  try {
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ ...initialState(), cards }));
    const stop = await activate(c.ctx);
    try { await run(host, c); } finally { await stop(); }
  } finally { globalThis.fetch = realFetch; await rm(directory, { recursive: true, force: true }); }
}

test('GenerationService persists a sure skip, and Write anyway starts exactly one bounded request and still flags the draft', async () => {
  const covering = row({ ...sent }), missing = row({ ...sent, presence: 'deleted' });
  await withEarlierCards([covering, missing], async (host, c) => {
    const flag = await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: '' });
    const p = await c.call('preflight', { nodeIds: ['n_a'], flagScopes: [{ id: flag.id, nodeIds: ['n_a'] }], independentNodeIds: [] });
    assert.equal(host.workers.starts.length, 0);
    assert.equal(p.earlierRepeatCandidateCount, 1);
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0];
    assert.deepEqual((start.input as WriterInput).targets[0].earlierRepeatCandidates?.map(c => c.id), [covering.id]);
    assert.equal((start.input as WriterInput).writeAnyway, undefined);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [], skipReason: 'Already covered.', earlierRepeatOf: covering.id }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const snap = await c.call('snapshot');
    assert.equal(snap.cards.length, 2);
    const skips = earlierRepeatSkips(snap.generations, snap.cards);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].covering.id, covering.id);
    await assert.rejects(c.call('preflightWriteAnyway', { ...skips[0].ref, nodeId: 'n_b' }), /previously skipped idea/);
    const retry = await c.call('preflightWriteAnyway', skips[0].ref);
    assert.equal(retry.batches.length, 1);
    assert.deepEqual(retry.nodeIds, ['n_a']);
    assert.equal(retry.maximumCards, 1);
    assert.equal(retry.outputTokens, outputAllowance(1, 1));
    assert.equal(host.workers.starts.length, 1);
    await c.call('generate', { preflightId: retry.preflightId });
    await c.call('generate', { preflightId: retry.preflightId });
    await until(() => host.workers.starts.length === 2);
    const override = host.workers.starts[1].input as WriterInput;
    assert.equal(override.writeAnyway, true);
    assert.equal(override.maxCardsPerNode, 1);
    assert.equal(override.targets[0].maxCards, 1);
    assert.equal(override.targets[0].flagged, true);
    assert.match(findProblems({ targets: [{ nodeId: 'n_a', cards: [equation, { ...equation, front: 'What is the rest energy relation?' }] }] }, override).join(), /cap is 1/);
    host.workers.succeed('task-2', { targets: [{ nodeId: 'n_a', cards: [], skipReason: 'No useful card fits.' }] });
    await until(async () => (await c.call('generationStatus')).generations[1]?.status === 'completed');
    const empty = await c.call('snapshot');
    assert.deepEqual(earlierRepeatSkips(empty.generations, empty.cards), skips);
    const again = await c.call('preflightWriteAnyway', skips[0].ref);
    await c.call('generate', { preflightId: again.preflightId });
    await until(() => host.workers.starts.length === 3);
    host.workers.succeed('task-3', { targets: [{ nodeId: 'n_a', cards: [equation] }] });
    await until(async () => (await c.call('generationStatus')).generations[2]?.status === 'completed');
    const done = await c.call('snapshot');
    assert.equal(done.cards.length, 3);
    assert.equal(done.cards[2].possibleRepeatOf, covering.id, 'the lexical check flags but does not drop the draft');
    assert.deepEqual(earlierRepeatSkips(done.generations, done.cards), []);
    await assert.rejects(c.call('preflightWriteAnyway', skips[0].ref), /already has a Write anyway result/);
  });
});

test('GenerationService fits earlier text in the model window without reducing the target or output allowance', async () => {
  const large = row({ front: `${equation.front}${' rest energy '.repeat(400)}` });
  const small = row();
  await withEarlierCards([large, small], async (host, c) => {
    const roomy = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.equal(roomy.earlierRepeatCandidateCount, 2);
    const window = roomy.inputTokens + roomy.outputTokens - 250;
    host.catalog.models[0].contextWindow = window;
    const tight = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.equal(tight.earlierRepeatCandidateCount, 1);
    assert.equal(tight.outputTokens, roomy.outputTokens);
    assert.deepEqual(tight.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a']]);
    assert.ok(tight.inputTokens + tight.outputTokens <= window);
    assert.equal(host.workers.starts.length, 0);
    await c.call('generate', { preflightId: tight.preflightId });
    await until(() => host.workers.starts.length === 1);
    const input = host.workers.starts[0].input as WriterInput;
    assert.deepEqual(input.targets[0].earlierRepeatCandidates?.map(c => c.id), [small.id]);
    const possible = { ...equation, front: 'How is the inertial mass term calculated?', possibleRepeatOf: small.id };
    assert.ok(earlierRepeatSimilarity(possible, small) < 0.5);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [possible] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    assert.equal((await c.call('snapshot')).cards[2].possibleRepeatOf, small.id, 'a validated model flag does not need lexical overlap');
    assert.equal(host.workers.starts.length, 1);
  });
});

test('an exact repeat on a different node in an earlier run stays reviewable, and its warning tracks the covering text', async () => {
  await withEarlierCards([], async (host, c) => {
    host.nodes[1].statement = target('n_a').statement;
    const old = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: old.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_b', cards: [equation] }] });
    await until(async () => (await c.call('snapshot')).generations[0]?.status === 'completed');
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 2);
    const prior = (await c.call('snapshot')).cards[0];
    assert.equal(prior.sessionId, 'c1');
    host.workers.succeed('task-2', { targets: [{ nodeId: 'n_a', cards: [{ ...equation, possibleRepeatOf: prior.id }] }] });
    await until(async () => (await c.call('snapshot')).generations[1]?.status === 'completed');
    assert.equal((await c.call('snapshot')).cards[1]?.possibleRepeatOf, prior.id);
    await c.call('edit', { id: prior.id, front: 'What is the capital of Peru?', back: 'Lima.' });
    assert.equal((await c.call('snapshot')).cards[1].possibleRepeatOf, undefined);
  });
});

test('GenerationService binds earlier cards to preflight and rejects a sure skip after its covering card is dropped', async () => {
  const covering = row();
  await withEarlierCards([covering], async (host, c) => {
    const old = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('edit', { id: covering.id, front: 'State the equation for rest energy.', back: covering.back });
    await assert.rejects(c.call('generate', { preflightId: old.preflightId }), /stale/);
    const fresh = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: fresh.preflightId });
    await until(() => host.workers.starts.length === 1);
    await c.call('drop', { ids: [covering.id] });
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [], skipReason: 'Already covered.', earlierRepeatOf: covering.id }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed');
    const snap = await c.call('snapshot');
    assert.match(snap.generations[0].tasks[0].error, /used to skip writing changed/);
    assert.deepEqual(earlierRepeatSkips(snap.generations, snap.cards), []);
  });
});
