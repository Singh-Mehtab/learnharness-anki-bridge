import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { activate } from '../src/backend.ts';
import { FakeHost, until } from './fake-host.ts';
import { initialState, StateStore, validateState } from '../src/anki/state.ts';
import { packageFingerprint } from '../src/anki/apkg.ts';
import { statementHash } from '../src/coverage/service.ts';
import { estimateTokens, outputAllowance, pack } from '../src/writer/input.ts';
import { writerNotesSection, writerPrompt } from '../src/writer/prompt.ts';
import { MAX_BATCH_CONTEXT_TOKENS } from '../src/generation/types.ts';
import { batchContext } from '../src/generation/batch-context.ts';
import type { WriterInput } from '../src/writer/types.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { GenerationService } from '../src/generation/service.ts';
import { Window } from 'happy-dom';
import { mountReview } from '../src/review-ui.ts';
import { fakeUi } from './fake-ui.ts';
import type { PluginFrontendContext } from '../sdk/index.d.ts';

const result = (nodeIds: string[], skip: string[] = []) => ({ targets: nodeIds.map(nodeId => skip.includes(nodeId)
  ? { nodeId, cards: [], skipReason: 'Nothing worth testing beyond the statement.' }
  : { nodeId, cards: [{ kind: 'fact', front: 'Which condition must be satisfied for the first result in this lecture to follow?', back: 'Assumption A.' }] }) });

async function withHost(run: (host: FakeHost, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-generation-'));
  try { await run(new FakeHost(), directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const statePath = (directory: string) => path.join(directory, 'state.json');

test('preflight follows the cheap slot unless overridden, needs an available model and starts no model work', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.deepEqual(snap.generationSettings, { cardsPerNode: 2, enabledKinds: ['fact', 'equation'], model: null });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /cheap model/);
    // Default: the host's cheap slot with its thinking level, like core Flashcards.
    (host.catalog.models[0] as { supportedLevels?: string[] }).supportedLevels = ['low', 'medium'];
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' }, thinkingLevel: 'medium' };
    const cheap = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.deepEqual(cheap.model, { provider: 'scratch', id: 'writer', thinkingLevel: 'medium' });
    assert.equal(cheap.followsCheapSlot, true);
    host.catalog.slots.cheap.thinkingLevel = 'high';
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /does not support.*high/);
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'missing' } };
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /cheap model slot is unavailable/);
    host.catalog.slots.cheap = null;
    await assert.rejects(c.call('generationSettings', { cardsPerNode: 5 }), /1–4/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: [] }), /1–4/);
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'missing' } });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /unavailable/);
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 3 });
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a', 'n_a'] }), /distinct/);
    await assert.rejects(c.call('preflight', { nodeIds: ['n_gone'] }), /missing/);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.equal(p.nodeCount, 2); assert.equal(p.maximumCards, 6);
    assert.ok(p.inputTokens > 0 && p.outputTokens > 0);
    assert.equal(typeof p.estimatedCost, 'number');
    assert.deepEqual(p.model, { provider: 'scratch', id: 'writer' });
    assert.equal(host.workers.starts.length, 0);
    host.catalog.providers[0].keyPresent = false;
    await assert.rejects(c.call('preflight', { nodeIds: ['n_a'] }), /unavailable/);
    host.catalog.providers[0].keyPresent = true;
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'free' } });
    assert.equal((await c.call('preflight', { nodeIds: ['n_a'] })).estimatedCost, null);
    assert.equal(host.workers.starts.length, 0);
    const context = await c.call('generationContext');
    assert.deepEqual(context.nodes.map((n: { id: string }) => n.id), ['n_a', 'n_b']);
  } finally { await close(); }
}));

test('a supported pinned reasoning level survives activation and reaches the worker', () => withHost(async (host, directory) => {
  const c = host.context(directory);
  const base = { provider: 'scratch', id: 'writer' };
  const pin = { ...base, thinkingLevel: 'high' };
  (host.catalog.models[0] as { supportedLevels?: string[] }).supportedLevels = ['low', 'high'];
  const close = await activate(c.ctx);
  try {
    assert.deepEqual(await c.call('writerModelLevels', base), ['low', 'high']);
    await assert.rejects(c.call('generationSettings', { model: { ...base, thinkingLevel: 'medium' } }), /does not support/);
    await c.call('generationSettings', { model: base });
    const estimate = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { model: pin });
    await assert.rejects(c.call('generate', { preflightId: estimate.preflightId }), /Preflight expired/);
  } finally { await close(); }
  const reopened = host.context(directory), stop = await activate(reopened.ctx);
  try {
    assert.deepEqual((await reopened.call('generationStatus')).generationSettings.model, pin);
    const estimate = await reopened.call('preflight', { nodeIds: ['n_a'] });
    assert.deepEqual(estimate.model, pin);
    await reopened.call('generate', { preflightId: estimate.preflightId });
    await until(() => host.workers.starts.length === 1);
    assert.deepEqual(host.workers.starts[0].model, pin);
  } finally { await stop(); }
}));

test('defaults carry the cheap slot’s thinking through confirmation, worker start and durable history', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    (host.catalog.models[0] as { supportedLevels?: string[] }).supportedLevels = ['low', 'medium'];
    host.catalog.slots.cheap = { model: { provider: 'scratch', id: 'writer' }, thinkingLevel: 'low' };
    const stale = await c.call('preflight', { nodeIds: ['n_a'] });
    host.catalog.slots.cheap.thinkingLevel = 'medium';
    await assert.rejects(c.call('generate', { preflightId: stale.preflightId }), /stale/);
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.deepEqual(start.model, { provider: 'scratch', id: 'writer', thinkingLevel: 'medium' });
    assert.deepEqual(input.enabledKinds, ['fact', 'equation']);
    assert.deepEqual(input.targets[0].allowedKinds, ['fact', 'equation']);
    assert.equal('constantValues' in input, false, 'new inputs carry no constant-values toggle');
    assert.doesNotMatch(start.prompt, /Constant values/);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'equation', front: 'What is the fixture relation?', back: '$a=b$' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    assert.deepEqual(saved.generations[0].modelSpec, start.model);
    assert.deepEqual(saved.generations[0].tasks[0].input, input);
    assert.equal(saved.cards[0].kind, 'equation');
  } finally { await close(); }
}));

test('overlapping card-type toggles from Write and Settings both survive', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    // Write and Settings save at the same moment: the second toggle waits for the first instead of failing busy.
    await Promise.all([
      c.call('generationSettings', { toggleKind: { kind: 'steps', enabled: true } }),
      c.call('generationSettings', { toggleKind: { kind: 'discriminate', enabled: true } }),
    ]);
    assert.deepEqual((await c.call('generationStatus')).generationSettings.enabledKinds, ['fact', 'equation', 'steps', 'discriminate']);
    await Promise.all(['steps', 'discriminate'].map(kind => c.call('generationSettings', { toggleKind: { kind, enabled: false } })));
    // Write and Settings both last read [fact, equation]. Each sends only its own change, which the backend applies to the saved set.
    await c.call('generationSettings', { toggleKind: { kind: 'apply', enabled: true } });
    await c.call('generationSettings', { toggleKind: { kind: 'why', enabled: true } });
    await c.call('generationSettings', { toggleKind: { kind: 'discriminate', enabled: true } });
    await c.call('generationSettings', { toggleKind: { kind: 'equation', enabled: false } });
    assert.deepEqual((await c.call('generationStatus')).generationSettings.enabledKinds, ['fact', 'why', 'apply', 'discriminate']);
    for (const k of ['why', 'apply', 'discriminate']) await c.call('generationSettings', { toggleKind: { kind: k, enabled: false } });
    await assert.rejects(c.call('generationSettings', { toggleKind: { kind: 'fact', enabled: false } }), /at least one card type/);
    await assert.rejects(c.call('generationSettings', { toggleKind: { kind: 'compose', enabled: true } }), /Unsupported generation input/);
    await assert.rejects(c.call('generationSettings', { toggleKind: { kind: 'why', enabled: 'yes' } }), /Unsupported generation input/);
    await assert.rejects(c.call('generationSettings', { toggleKind: { kind: 'why', enabled: true }, enabledKinds: ['fact'] }), /Unsupported generation input/);
    assert.deepEqual((await c.call('generationStatus')).generationSettings.enabledKinds, ['fact']);
  } finally { await close(); }
}));

test('a blank flag increases the real preflight and worker cap; new kinds are opt-ins; constants and compose have no setting', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    const blank = await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: '' });
    const selection = { nodeIds: ['n_a', 'n_b'], flagScopes: [{ id: blank.id, nodeIds: ['n_a'] }], independentNodeIds: ['n_b'] };
    await assert.rejects(c.call('generationSettings', { constantValues: true }), /Unsupported generation input/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: ['recall'] }), /available card types/);
    await assert.rejects(c.call('generationSettings', { enabledKinds: ['fact', 'compose'] }), /available card types/);
    const beforeOptIn = await c.call('preflight', selection);
    await c.call('generationSettings', { enabledKinds: ['fact', 'steps', 'apply'] });
    await assert.rejects(c.call('generate', { preflightId: beforeOptIn.preflightId }), /stale|expired/);
    const p = await c.call('preflight', selection);
    assert.equal(p.maximumCards, 14);
    assert.equal(p.outputTokens, outputAllowance(1, 12) + outputAllowance(1, 2));
    // If the model cannot fit the flag, its 12 cards are not counted as planned output.
    host.catalog.models[0].maxTokens = outputAllowance(1, 2);
    const limited = await c.call('preflight', selection);
    assert.deepEqual(limited.skipped.map((s: { nodeId: string }) => s.nodeId), ['n_a']);
    assert.equal(limited.maximumCards, 2);
    assert.equal(limited.outputTokens, outputAllowance(1, 2));
    host.catalog.models[0].maxTokens = 32_000;
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.equal(input.targets[0].flagged, true);
    assert.equal(input.targets[0].maxCards, 12);
    assert.equal(input.targets[0].flagNote, undefined);
    assert.equal(input.targets[1].maxCards, undefined);
    assert.deepEqual(input.targets[0].allowedKinds, ['fact', 'steps', 'apply']);
    assert.deepEqual(input.enabledKinds, ['fact', 'steps', 'apply']);
    assert.equal('constantValues' in input, false);
    assert.equal(start.options?.maxTokens, p.outputTokens);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: ['First', 'Second', 'Third'].map((ordinal, i) => ({
      kind: 'steps', front: `What is the ${ordinal} stage of the process?`, back: ['Prepare.', 'Execute.', 'Verify.'][i],
    })) }, { nodeId: 'n_b', cards: [], skipReason: 'No additional material.' }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const saved = await c.call('generationStatus');
    assert.deepEqual(saved.generationSettings, { cardsPerNode: 2, enabledKinds: ['fact', 'steps', 'apply'], model: { provider: 'scratch', id: 'writer' } });
    // FI-8: history stores the resolved cloze mode; the active setting stays absent until changed.
    assert.deepEqual(saved.generations[0].settings, { ...saved.generationSettings, cloze: 'auto' });
    assert.equal(saved.cards.length, 3);
  } finally { await close(); }
}));

test('split runs prioritise flagged targets and pass only this run’s earlier drafts to the writer', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const old = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: old.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_b', cards: [{ kind: 'fact', front: 'What did the previous demonstration illustrate?', back: 'Old example.' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');

    const note = await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Recall this equation.' });
    host.catalog.models[0].maxTokens = outputAllowance(1, 12);
    const spacious = await c.call('preflight', { nodeIds: ['n_b', 'n_a'], flagScopes: [{ id: note.id, nodeIds: ['n_a'] }], independentNodeIds: ['n_b'] });
    assert.deepEqual(spacious.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a'], ['n_b']]);
    const second = spacious.batches[1];
    const baseSecond = second.inputTokens - MAX_BATCH_CONTEXT_TOKENS;
    await c.call('generate', { preflightId: spacious.preflightId });
    await until(() => host.workers.starts.length === 2);
    const flagStart = host.workers.starts[1], flagInput = flagStart.input as WriterInput;
    assert.deepEqual(flagInput.flagRequests, [{ id: note.id, note: 'Recall this equation.', nodeIds: ['n_a'] }]);
    assert.equal(flagStart.prompt, writerPrompt(flagInput));
    const card = { kind: 'equation', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}' };
    host.workers.succeed('task-2', { targets: [{ nodeId: 'n_a', cards: [card], flagMatches: [note.id] }] });
    await until(() => host.workers.starts.length === 3);
    const ordinary = host.workers.starts[2], ordinaryInput = ordinary.input as WriterInput;
    const earlier = ordinary.prompt.slice(writerPrompt(ordinaryInput).length);
    assert.match(earlier, /quoted UNTRUSTED JSON/);
    assert.deepEqual(JSON.parse(earlier.split('\n').at(-1)!), [{ nodeName: 'Alpha', flagged: true, format: 'cloze', front: card.front, back: card.back }]);
    assert.doesNotMatch(earlier, /Old example/);
    assert.ok(estimateTokens(earlier) <= second.inputTokens - baseSecond);
    host.workers.succeed('task-3', { targets: [{ nodeId: 'n_b', cards: [], skipReason: 'The Alpha draft already covers the recall task.' }] });
    await until(async () => (await c.call('generationStatus')).generations[1].status === 'completed');
    const disk = JSON.parse(await readFile(statePath(directory), 'utf8'));
    assert.equal(disk.cards.filter((c: { generationId: string }) => c.generationId === spacious.preflightId).length, 1);
    const generation = disk.generations[1], task = generation.tasks[1];
    assert.equal(task.batchContextTokens, MAX_BATCH_CONTEXT_TOKENS);
    assert.match(task.result.targets[0].skipReason, /Alpha draft/);
    const draft = disk.cards.find((c: { generationId: string }) => c.generationId === generation.id);
    assert.match(batchContext(generation, task, [{ ...draft, status: 'approved' }]), /Alpha/);
    assert.equal(batchContext(generation, task, [{ ...draft, status: 'sent', presence: 'deleted' }]), '');
  } finally { await close(); }
}));

for (const mode of ['edit during writing', 'drop before restart'] as const) {
  test(`changed earlier draft makes the dependent request retryable: ${mode}`, () => withHost(async (host, directory) => {
    let c = host.context(directory), close = await activate(c.ctx);
    try {
      await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
      host.catalog.models[0].maxTokens = outputAllowance(1, 1);
      const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
      await c.call('generate', { preflightId: p.preflightId });
      await until(() => host.workers.starts.length === 1);
      host.workers.succeed('task-1', result(['n_a']));
      await until(() => host.workers.starts.length === 2);
      assert.match(host.workers.starts[1].prompt, /Earlier drafts from this run/);
      const draft = (await c.call('generationStatus')).cards[0];
      if (mode === 'edit during writing') {
        await c.call('edit', { id: draft.id, front: 'What was measured during the second experiment?', back: 'Temperature.' });
      } else {
        await c.call('drop', { ids: [draft.id] });
        await close();
        // Recreate a crash after acceptance but before the task ID save.
        const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
        const task = saved.generations[0].tasks[1];
        delete task.taskId; task.status = 'pending';
        await writeFile(statePath(directory), JSON.stringify(saved));
      }
      host.workers.succeed('task-2', { targets: [{ nodeId: 'n_b', cards: [], skipReason: 'The Alpha draft already covers this.' }] });
      if (mode === 'drop before restart') { c = host.context(directory); close = await activate(c.ctx); }
      await until(async () => (await c.call('generationStatus')).generations[0].status !== 'running');
      const snap = await c.call('generationStatus');
      const [first, second] = snap.generations[0].tasks;
      assert.equal(first.status, 'applied');
      assert.equal(second.status, 'failed');
      assert.match(second.error, /earlier draft .*changed/i);
      assert.equal(snap.cards.length, 1);
      assert.deepEqual((await c.call('retryGeneration', { id: p.preflightId })).nodeIds, ['n_b']);
      assert.equal(host.workers.starts.length, 2, 'retry needs a newly confirmed estimate');
    } finally { await close(); }
  }));
}

test('marking an earlier draft imported does not invalidate a running request', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    host.catalog.models[0].maxTokens = outputAllowance(1, 1);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', result(['n_a']));
    await until(() => host.workers.starts.length === 2);
    assert.match(host.workers.starts[1].prompt, /Earlier drafts from this run/);
    const card = (await c.call('generationStatus')).cards[0];
    await c.call('approve', { ids: [card.id] });
    await c.call('markImported', { ids: [card.id], fingerprints: [packageFingerprint(card)], deck: 'Synthetic' });
    host.workers.succeed('task-2', { targets: [{ nodeId: 'n_b', cards: [{ kind: 'fact', front: 'What type of system conserves beta?', back: 'Closed system.' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status !== 'running');
    const snap = await c.call('generationStatus');
    assert.deepEqual(snap.generations[0].tasks.map((task: { status: string }) => task.status), ['applied', 'applied']);
    assert.deepEqual(snap.cards.map((entry: { status: string }) => entry.status), ['imported', 'draft']);
  } finally { await close(); }
}));

test('preflight trims optional context against the full prompt and output budget', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1, writerNotes: 'Prefer direct wording.' });
    const input = { nodeIds: ['n_a'] };
    const baseline = (await c.call('preflight', input)).batches[0];
    await c.call('draft', { nodeId: 'n_a', front: 'What distinguishes this fixture from the previous one? '.repeat(11).trim(), back: 'A narrower condition.' });
    const withContext = (await c.call('preflight', input)).batches[0];
    assert.ok(withContext.inputTokens > baseline.inputTokens + 5);
    const window = baseline.inputTokens + baseline.outputAllowance + 5;
    host.catalog.models[0].contextWindow = window;
    const estimate = await c.call('preflight', input);
    assert.deepEqual(estimate.skipped, []);
    const [batch] = estimate.batches;
    assert.equal(batch.inputTokens, baseline.inputTokens);
    assert.ok(batch.inputTokens + batch.outputAllowance <= window);
    await c.call('generate', { preflightId: estimate.preflightId });
    await until(() => host.workers.starts.length === 1);
    const worker = host.workers.starts[0];
    assert.match(worker.prompt, /Prefer direct wording/);
    assert.deepEqual((worker.input as WriterInput).targets[0].existingCards, []);
  } finally { await close(); }
}));

test('tight preflight preserves the neighbour needed for a Discriminate card', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    host.chains = [{ id: 'link', premises: ['n_a'], conclusion: 'n_b' }];
    host.nodes[1].statement = 'This fixture compares two assumptions. '.repeat(12).trim();
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1, enabledKinds: ['discriminate'] });
    const input = { nodeIds: ['n_a'] };
    const [full] = (await c.call('preflight', input)).batches;
    host.catalog.models[0].contextWindow = full.inputTokens + full.outputAllowance - 30;
    const estimate = await c.call('preflight', input);
    assert.deepEqual(estimate.skipped, []);
    await c.call('generate', { preflightId: estimate.preflightId });
    await until(() => host.workers.starts.length === 1);
    const [target] = (host.workers.starts[0].input as WriterInput).targets;
    assert.deepEqual(target.allowedKinds, ['discriminate']);
    assert.deepEqual(target.neighbours.map(entry => entry.id), ['n_b']);
    assert.deepEqual(target.feeds, []);
  } finally { await close(); }
}));

test('preflight reserves only the context that fits and does not add requests for duplicate checking', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const model = host.catalog.models[0];
    model.maxTokens = outputAllowance(1, 1);
    const spacious = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    const [first, second] = spacious.batches;
    const baseSecond = second.inputTokens - MAX_BATCH_CONTEXT_TOKENS;
    model.contextWindow = Math.max(first.inputTokens + first.outputAllowance, baseSecond + second.outputAllowance) + 80;
    const tight = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.deepEqual(tight.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a'], ['n_b']]);
    assert.equal(tight.batches[1].inputTokens + tight.batches[1].outputAllowance, model.contextWindow);
    assert.deepEqual(tight.skipped, []);
    const reserved = tight.batches[1].inputTokens - baseSecond;
    assert.ok(reserved > 0 && reserved < MAX_BATCH_CONTEXT_TOKENS);
    await c.call('generate', { preflightId: tight.preflightId });
    await until(() => host.workers.starts.length === 1);
    // JSON escapes these characters, so budgeting the raw front isn't enough.
    const front = 'Which quote did the example use? ' + '"'.repeat(reserved * 4);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', front, back: 'Answer.' }] }] });
    await until(() => host.workers.starts.length === 2);
    const next = host.workers.starts[1];
    assert.equal(next.prompt, writerPrompt(next.input as WriterInput), 'oversized earlier draft does not enter the prompt');
    host.workers.succeed('task-2', result(['n_b']));
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    assert.equal((await c.call('generationStatus')).cards.length, 2);
  } finally { await close(); }
}));

test('confirmed generation applies validated results once as editable drafts with source snapshots', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1, enabledKinds: ['fact'] });
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    let snap = await c.call('generate', { preflightId: p.preflightId });
    assert.equal(snap.generations.length, 1); assert.equal(snap.generations[0].id, p.preflightId);
    await until(() => host.workers.starts.length === 1, 'worker start');
    const start = host.workers.starts[0];
    assert.equal(start.purpose, 'user'); assert.equal(start.maxTurns, 3); assert.equal(start.timeoutMs, 180_000);
    assert.deepEqual(start.model, { provider: 'scratch', id: 'writer' });
    assert.equal(start.options?.maxTokens, p.batches[0].outputAllowance);
    // Repeating the same confirmation is idempotent.
    snap = await c.call('generate', { preflightId: p.preflightId });
    assert.equal(snap.generations.length, 1); assert.equal(host.workers.starts.length, 1);
    host.workers.succeed('task-1', result(['n_a', 'n_b'], ['n_b']));
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed', 'completion');
    snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1);
    const card = snap.cards[0];
    assert.equal(card.status, 'draft'); assert.equal(card.nodeId, 'n_a'); assert.equal(card.generationId, p.preflightId);
    assert.equal(card.sourceStatement, host.nodes[0].statement);
    assert.equal(card.sessionName, 'Scratch session');
    assert.equal(card.sourceChanged, false); assert.equal(card.sourceMissing, false);
    assert.equal(snap.generations[0].tasks[0].status, 'applied');
    assert.equal(snap.generations[0].tasks[0].result.targets[1].skipReason, 'Nothing worth testing beyond the statement.');
    // Generated drafts use the normal edit/drop/approve flow.
    await c.call('edit', { id: card.id, front: 'Edited?', back: 'Yes.' });
    host.nodes[0].statement = 'Alpha implies beta under assumption B.';
    snap = await c.call('generationStatus');
    assert.equal(snap.cards[0].sourceChanged, true); assert.equal(snap.cards[0].front, 'Edited?');
    host.nodes = host.nodes.slice(1);
    snap = await c.call('generationStatus');
    assert.equal(snap.cards[0].sourceMissing, true); assert.equal(snap.cards[0].sourceChanged, false);
    await c.call('drop', { ids: [card.id] });
    await assert.rejects(c.call('approve', { ids: [card.id] }), /Only unsent/);
    await assert.rejects(c.call('generate', { preflightId: 'unknown' }), /expired/);
  } finally { await close(); }
}));

test('stale preflights are refused after settings, graph or card changes', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    let p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { cardsPerNode: 3 });
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /stale/);
    p = await c.call('preflight', { nodeIds: ['n_a'] });
    host.nodes[0].statement = 'Changed statement.';
    await assert.rejects(c.call('generate', { preflightId: p.preflightId }), /stale/);
    p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('draft', { front: 'Hand', back: 'Written' });
    // Hand-written cards are not in any selected node's prompt, so this preflight remains valid.
    await c.call('generate', { preflightId: p.preflightId });
    assert.equal((await c.call('generationStatus')).generations.length, 1);
    await assert.rejects(c.call('preflight', { nodeIds: ['n_b'] }).then(q => c.call('generate', { preflightId: q.preflightId })), /already running/);
  } finally { await close(); }
}));

test('invalid worker output fails the task without creating drafts', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_unknown', cards: [] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'failed', 'failure');
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 0); assert.equal(snap.generations[0].tasks[0].status, 'failed');
    const retry = await c.call('retryGeneration', { id: p.preflightId });
    assert.deepEqual(retry.nodeIds, ['n_a']); assert.equal(host.workers.starts.length, 1);
  } finally { await close(); }
}));

test('cancel stops unfinished work and keeps drafts from completed tasks', () => withHost(async (host, directory) => {
  host.nodes.push({ id: 'n_c', name: 'Gamma', statement: 'G'.repeat(10) });
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const snap = await c.call('cancelGeneration', { id: p.preflightId });
    assert.equal(snap.generations[0].status, 'cancelled'); assert.equal(snap.generations[0].tasks[0].status, 'cancelled');
    assert.deepEqual(host.workers.cancelled, ['task-1']);
    // A late success after cancellation never becomes a draft.
    host.workers.tasks.get('task-1')!.status = 'succeeded';
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await c.call('generationStatus')).cards.length, 0);
    // A finished batch can be hidden from the page; the record stays, and the idea can be selected again.
    const hidden = await c.call('dismissGeneration', { id: p.preflightId });
    assert.equal(hidden.generations[0].hidden, true); assert.equal(hidden.generations[0].status, 'cancelled');
    const again = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.deepEqual(again.nodeIds, ['n_a']);
  } finally { await close(); }
}));

test('a running batch cannot be dismissed', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    await assert.rejects(c.call('dismissGeneration', { id: p.preflightId }), /Cancel or finish/);
    await assert.rejects(c.call('dismissGeneration', { id: p.preflightId, extra: 1 }));
  } finally { await close(); }
}));

test('restart applies finished host results exactly once and interrupts unfinished ones without model calls', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  // The result finishes while the plugin is disabled.
  host.workers.succeed('task-1', result(['n_a']));
  c = host.context(directory); close = await activate(c.ctx);
  let snap = await c.call('generationStatus');
  assert.equal(snap.cards.length, 1); assert.equal(snap.generations[0].status, 'completed');
  const id = snap.cards[0].id;
  await c.call('drop', { ids: [id] });
  await close();
  c = host.context(directory); close = await activate(c.ctx);
  snap = await c.call('generationStatus');
  assert.equal(snap.cards.length, 1, 'replay does not recreate a dropped draft'); assert.equal(snap.cards[0].status, 'dropped');
  // An unfinished request becomes interrupted and retry needs a fresh confirmation.
  const q = await c.call('preflight', { nodeIds: ['n_b'] });
  await c.call('generate', { preflightId: q.preflightId });
  await until(() => host.workers.starts.length === 2);
  await close(); host.workers.interruptAll();
  c = host.context(directory); close = await activate(c.ctx);
  try {
    snap = await c.call('generationStatus');
    const g = snap.generations.find((x: { id: string }) => x.id === q.preflightId);
    assert.equal(g.status, 'interrupted'); assert.equal(g.tasks[0].status, 'interrupted');
    assert.equal(host.workers.starts.length, 2, 'activation never starts model work');
    const retry = await c.call('retryGeneration', { id: q.preflightId });
    assert.deepEqual(retry.nodeIds, ['n_b']); assert.equal(host.workers.starts.length, 2);
  } finally { await close(); }
}));

test('restart recovers acceptance saved before the worker task ID was recorded', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  const task = state.generations[0].tasks[0];
  delete task.taskId; task.status = 'pending';
  await writeFile(statePath(directory), JSON.stringify(state));
  host.workers.succeed('task-1', result(['n_a']));
  c = host.context(directory); close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1); assert.equal(snap.generations[0].tasks[0].taskId, 'task-1');
  } finally { await close(); }
}));

test('schema 1 state migrates without losing pairing or cards, and malformed generation data is not reset', () => withHost(async (host, directory) => {
  const v1 = { schemaVersion: 1, settings: { url: 'http://127.0.0.1:18766/', apiKey: '', lastDeck: 'Scratch' }, destination: { url: 'http://127.0.0.1:18766/', profile: 'Throwaway' },
    cards: [{ id: '00000000-0000-4000-8000-000000000001', nodeId: '', nodeName: '', sessionId: '', sessionName: '', statementHash: '', kind: 'recall', front: 'F', back: 'B', extra: '', status: 'draft' }] };
  await writeFile(statePath(directory), JSON.stringify(v1));
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    const snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 1); assert.equal(snap.destination.profile, 'Throwaway'); assert.deepEqual(snap.generations, []);
  } finally { await close(); }
  const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
  assert.equal(saved.schemaVersion, 9);
  saved.generations = [{ id: 'g', bogus: true }];
  const broken = JSON.stringify(saved);
  await writeFile(statePath(directory), broken);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid generation/);
  assert.equal(await readFile(statePath(directory), 'utf8'), broken);
}));

test('disable unregisters the worker definition and operations', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  // FI-8: the basic writer and the cloze writer.
  assert.equal(host.workers.registered, 2);
  await close();
  assert.equal(host.workers.registered, 0); assert.equal(c.handlers.size, 0);
}));

test('a crash between cancelled task saves and the batch save still recovers as cancelled', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  state.generations[0].tasks[0].status = 'cancelled';
  await writeFile(statePath(directory), JSON.stringify(state));
  c = host.context(directory); close = await activate(c.ctx);
  try { assert.equal((await c.call('generationStatus')).generations[0].status, 'cancelled'); }
  finally { await close(); }
}));

test('persisted applied results are shape-checked only, so stricter writer rules never lock old state', () => withHost(async (host, directory) => {
  let c = host.context(directory); let close = await activate(c.ctx);
  await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
  const p = await c.call('preflight', { nodeIds: ['n_a'] });
  await c.call('generate', { preflightId: p.preflightId });
  await until(() => host.workers.starts.length === 1);
  host.workers.succeed('task-1', result(['n_a']));
  await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
  await close();
  const state = JSON.parse(await readFile(statePath(directory), 'utf8'));
  // Content a current writer check would reject (names the idea on the front).
  state.generations[0].tasks[0].result.targets[0].cards[0].front = 'What does Alpha say?';
  await writeFile(statePath(directory), JSON.stringify(state));
  c = host.context(directory); close = await activate(c.ctx);
  await close();
  state.generations[0].tasks[0].result.targets[0].nodeId = 'n_elsewhere';
  const broken = JSON.stringify(state);
  await writeFile(statePath(directory), broken);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid applied generation/);
  assert.equal(await readFile(statePath(directory), 'utf8'), broken);
}));

test('an unexpected driver failure interrupts the batch instead of leaving it running', () => withHost(async (host, directory) => {
  const c = host.context(directory); const close = await activate(c.ctx);
  try {
    host.workers.wait = () => Promise.reject(new Error('Host storage failed.'));
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const p = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'interrupted', 'interrupted');
    const snap = await c.call('generationStatus');
    assert.match(snap.generations[0].tasks[0].error, /Host storage failed/);
    assert.match(snap.generationRecoveryError, /Host storage failed/);
    assert.equal(snap.recoveryError, undefined);
    assert.deepEqual(host.workers.cancelled, ['task-1']);
    // New work is not blocked.
    const q = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: q.preflightId });
  } finally { await close(); }
}));

test('working on an idea independently does not forward its unselected flag note', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'A note for another run' });
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.equal(p.maximumCards, 2);
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const input = host.workers.starts[0].input as WriterInput;
    assert.equal(input.flagRequests, undefined);
    assert.ok(input.targets.every(t => !t.flagged));
    assert.doesNotMatch(host.workers.starts[0].prompt, /A note for another run/);
  } finally { await close(); }
}));

test('v5 (0.7.2) state drops the constants toggle and compose from settings only; history, frozen inputs and compose cards stay readable', () => withHost(async (host, directory) => {
  const oldSettings = { cardsPerNode: 3, enabledKinds: ['fact', 'compose', 'why'], constantValues: true, model: { provider: 'scratch', id: 'writer' } };
  const frozen = { ...pack({ propositions: host.nodes, chains: [] }, ['n_a'], () => ({}), { maxCardsPerNode: 3, enabledKinds: ['fact', 'compose', 'why'] }).batches[0].input, constantValues: true };
  const inputBytes = JSON.stringify(frozen);
  const source = { nodeId: 'n_a', name: 'Alpha', statement: host.nodes[0].statement,
    statementHash: statementHash(host.nodes[0].statement), sessionId: 'c1', sessionName: 'Scratch session' };
  const composeCard = { id: '00000000-0000-4000-8000-000000000002', ...source, nodeName: source.name,
    sourceSnapshot: source, kind: 'compose', front: 'Given A and B, what follows?', back: 'Alpha.', extra: '', status: 'draft' };
  const requestId = 'v5-request';
  const historical = { id: 'v5-generation', nodeIds: ['n_a'], createdAt: '2026-11-19T00:00:00Z', status: 'running', settings: oldSettings,
    modelSpec: oldSettings.model, skipped: [], tasks: [{ status: 'running', requestId, input: frozen, sources: [source], outputAllowance: outputAllowance(1, 3) }] };
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: oldSettings, generations: [historical], cards: [composeCard] });
  await writeFile(statePath(directory), bytes);
  const task = host.workers.start('manual-card-writer', { requestId, input: frozen, model: oldSettings.model,
    prompt: 'Frozen fixture prompt', purpose: 'user', maxTurns: 3, timeoutMs: 180_000 });
  host.workers.succeed(task.id, { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', front: 'What is the fixture condition?', back: 'Assumption A.' }] }] });
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    assert.equal(saved.schemaVersion, 9);
    assert.equal(await readFile(path.join(directory, 'state.v5.bak'), 'utf8'), bytes);
    assert.deepEqual(saved.generationSettings, { cardsPerNode: 3, enabledKinds: ['fact', 'why'], model: oldSettings.model });
    assert.deepEqual(saved.generations[0].settings, oldSettings, 'history keeps what the batch was run with');
    assert.equal(JSON.stringify(saved.generations[0].tasks[0].input), inputBytes);
    assert.equal(saved.generations[0].status, 'completed');
    assert.deepEqual(saved.cards.map((card: { kind: string }) => card.kind), ['compose', 'fact']);
    assert.deepEqual(saved.cards[0], composeCard);
    assert.equal(host.workers.starts.length, 1, 'restart never starts model work');
    // New drafts use the migrated settings: no compose, no constants toggle.
    host.workers.starts.length = 0;
    const p = await c.call('preflight', { nodeIds: ['n_b'] });
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    const input = host.workers.starts[0].input as WriterInput;
    assert.deepEqual(input.enabledKinds, ['fact', 'why']);
    assert.equal('constantValues' in input, false);
    assert.equal(input.targets[0].existingCards.length, 0);
  } finally { await close(); }
}));

test('v5 settings with only compose fall back to the default card types', () => withHost(async (host, directory) => {
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: { cardsPerNode: 1, enabledKinds: ['compose'], constantValues: false, model: null } });
  await writeFile(statePath(directory), bytes);
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    assert.deepEqual((await c.call('generationStatus')).generationSettings, { cardsPerNode: 1, enabledKinds: ['fact', 'equation'], model: null });
  } finally { await close(); }
  const malformed = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: { cardsPerNode: 1, enabledKinds: ['fact'], model: null } });
  await writeFile(statePath(directory), malformed);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid generation state/);
  assert.equal(await readFile(statePath(directory), 'utf8'), malformed, 'a v5 file without its toggle is refused, not reset');
  // 0.7.2 never wrote a batch without its toggle, so a v6-shaped batch in a v5 file is malformed too.
  const badHistory = JSON.stringify({ ...initialState(), schemaVersion: 5, generationSettings: { cardsPerNode: 1, enabledKinds: ['fact'], constantValues: false, model: null },
    generations: [{ id: 'v5-generation', nodeIds: ['n_a'], createdAt: '2026-11-19T00:00:00Z', status: 'completed', settings: { cardsPerNode: 1, enabledKinds: ['fact'], model: null }, skipped: [], tasks: [] }] });
  await writeFile(statePath(directory), badHistory);
  await assert.rejects(activate(host.context(directory).ctx), /Invalid generation state/);
  assert.equal(await readFile(statePath(directory), 'utf8'), badHistory, 'a v5 batch without its toggle is refused, not reset');
}));

test('v4 backup and restart recover a frozen legacy worker without changing its input or old cards', () => withHost(async (host, directory) => {
  const legacySettings = { cardsPerNode: 3, enabledKinds: ['recall'], model: { provider: 'scratch', id: 'writer' } };
  const legacyInput = pack({ propositions: host.nodes, chains: [] }, ['n_a'], () => ({}), {
    maxCardsPerNode: 3, enabledKinds: ['recall'],
  }).batches[0].input;
  // V4 stored a flag note but didn't yet mark it with the new flag/cap fields.
  legacyInput.targets[0].flagNote = 'Remember this version';
  const inputBytes = JSON.stringify(legacyInput);
  const source = { nodeId: 'n_a', name: 'Alpha', statement: host.nodes[0].statement,
    statementHash: statementHash(host.nodes[0].statement), sessionId: 'c1', sessionName: 'Scratch session' };
  const card = { id: '00000000-0000-4000-8000-000000000001', ...source, nodeName: source.name,
    sourceSnapshot: source, kind: 'recall', front: 'My edited question?', back: 'My answer.', extra: 'User note.', status: 'approved' };
  const requestId = 'legacy-request';
  const historical = { id: 'legacy-generation', nodeIds: ['n_a'], createdAt: '2026-11-19T00:00:00Z',
    status: 'running', settings: legacySettings, skipped: [], tasks: [{ status: 'running', requestId, input: legacyInput,
      sources: [source], outputAllowance: outputAllowance(1, 3) }] };
  const bytes = JSON.stringify({ ...initialState(), schemaVersion: 4, generationSettings: legacySettings, generations: [historical], cards: [card] }) + '\n\n';
  await writeFile(statePath(directory), bytes);
  const task = host.workers.start('manual-card-writer', { requestId, input: legacyInput, model: legacySettings.model,
    prompt: 'Frozen fixture prompt', purpose: 'user', maxTurns: 3, timeoutMs: 180_000 });
  const workerResult = { targets: [{ nodeId: 'n_a', cards: [{ kind: 'recall', front: 'What condition is required to apply this result?', back: 'Assumption A.' }] }] };
  host.workers.succeed(task.id, workerResult);
  for (let i = 0; i < 2; i++) {
    const c = host.context(directory), close = await activate(c.ctx);
    try {
      const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
      assert.equal(saved.schemaVersion, 9);
      assert.equal(await readFile(path.join(directory, 'state.v4.bak'), 'utf8'), bytes);
      assert.deepEqual(saved.generationSettings, { cardsPerNode: 3, enabledKinds: ['fact', 'equation'], model: legacySettings.model });
      assert.deepEqual(saved.generations[0].settings, legacySettings);
      assert.equal(saved.generations[0].status, 'completed');
      const stored = saved.generations[0].tasks[0];
      assert.equal(JSON.stringify(stored.input), inputBytes);
      assert.equal(stored.status, 'applied');
      assert.deepEqual(stored.result, workerResult);
      assert.equal(saved.cards.length, 2);
      assert.deepEqual(saved.cards[0], card);
      assert.equal(saved.cards[1].kind, 'recall');
      assert.equal(host.workers.starts.length, 1, 'restart never starts or retries model work');
    } finally { await close(); }
  }
}));

test('cross-request omissions use exact live content and preserve distinct cards, edits and complete results', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    const duplicate = { kind: 'fact', front: 'Which prefix is used here?', back: 'Kilo.', extra: 'See the convention.' };
    const distinct = [
      { ...duplicate, back: 'Mili.' }, // Same front, different fact.
      { ...duplicate, front: 'What prefix does the alternate convention use?' }, // Same answer, different cue.
      { ...duplicate, extra: 'A different explanation.' }, // Extra is part of the content.
    ];
    await c.call('generationSettings', { cardsPerNode: 4, model: { provider: 'scratch', id: 'writer' } });
    host.catalog.models[0].maxTokens = outputAllowance(1, 4);
    const p = await c.call('preflight', { nodeIds: ['n_a', 'n_b'] });
    assert.deepEqual(p.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a'], ['n_b']]);
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [duplicate] }] });
    await until(() => host.workers.starts.length === 2);
    const first = (await c.call('generationStatus')).cards[0];
    await c.call('approve', { ids: [first.id] });
    const fullResult = { targets: [{ nodeId: 'n_b', cards: [duplicate, ...distinct] }] };
    host.workers.succeed('task-2', fullResult);
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    let snap = await c.call('generationStatus');
    assert.equal(snap.cards.length, 4);
    assert.equal(snap.cards[0].id, first.id);
    assert.equal(snap.cards[0].status, 'approved');
    assert.equal(snap.cards[0].extra, duplicate.extra);
    assert.deepEqual(snap.cards.slice(1).map(({ kind, front, back, extra }: typeof duplicate) => ({ kind, front, back, extra })), distinct);
    assert.deepEqual(snap.generations[0].tasks[1].result, fullResult);
    assert.equal(snap.generations[0].tasks[1].duplicatesOmitted, 1);

    const again = async (nodeId: string, flagId?: string) => {
      const preflight = await c.call('preflight', { nodeIds: [nodeId], ...(flagId ? { flagScopes: [{ id: flagId, nodeIds: [nodeId] }], independentNodeIds: [] } : {}) });
      const next = host.workers.starts.length + 1;
      await c.call('generate', { preflightId: preflight.preflightId });
      await until(() => host.workers.starts.length === next);
      host.workers.succeed(`task-${next}`, { targets: [{ nodeId, cards: [duplicate] }] });
      await until(async () => (await c.call('generationStatus')).generations.at(-1).status === 'completed');
      return c.call('generationStatus');
    };
    // A flag isn't satisfied by a duplicate attached to a different node.
    host.catalog.models[0].maxTokens = 32_000;
    const blank = await c.call('flag', { sessionId: 'c1', messageIds: ['m2'], note: '' });
    snap = await again('n_b', blank.id);
    assert.equal(snap.cards.length, 5);
    assert.equal(snap.cards.at(-1).nodeId, 'n_b');
    await c.call('drop', { ids: [snap.cards.at(-1).id] });
    await c.call('edit', { id: first.id, front: 'My edited question?', back: duplicate.back, extra: duplicate.extra });
    snap = await again('n_a');
    assert.equal(snap.cards.length, 6, 'edited and dropped originals do not suppress');
    assert.equal(snap.cards[0].front, 'My edited question?');
    assert.equal(snap.cards[4].status, 'dropped');
    assert.deepEqual(snap.generations[0].tasks[1].result, fullResult, 'later edits and drops never rewrite a worker result');
    // Simulate persisted delivery that has only checked the presence of a note ID.
    // Anki may have a different answer now, so the saved fields must not block a draft.
    await close();
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    const destination = { url: saved.settings.url, profile: 'Scratch' };
    saved.destination = destination;
    Object.assign(saved.cards.at(-1), { status: 'sent', presence: 'present', noteId: 123, deck: 'Scratch', destination });
    await writeFile(statePath(directory), JSON.stringify(saved));
    const reopened = await activate(c.ctx);
    try {
      snap = await again('n_a');
      assert.equal(snap.cards.length, 7, 'a previously sent card never suppresses a draft');
      assert.equal(snap.cards.at(-1).status, 'draft');
    } finally { await reopened(); }
  } finally { await close(); }
}));

async function withReviewBanner(call: (name: string) => Promise<unknown>, check: (refresh: () => Promise<string>) => Promise<void>) {
  const window = new Window(), controller = new AbortController();
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: window.document });
  const host = window.document.createElement('div'), header = window.document.createElement('div');
  const ctx = { call: (name: string) => {
    assert.equal(name, 'snapshot', 'unpaired Review does not call Anki');
    return call(name);
  }, signal: controller.signal, onResync: () => () => {}, ui: fakeUi() } as unknown as PluginFrontendContext;
  const review = mountReview(ctx, host as unknown as HTMLElement, controller.signal, {
    headerAside: header as unknown as HTMLElement, peers: new Set(), onChanged: async () => {},
  });
  try {
    const banner = () => host.querySelector('.ab-banners')?.textContent ?? '';
    await until(() => banner().includes('Card generation needs checking:'), 'initial Review generation warning');
    await check(async () => {
      await review.refresh();
      return banner();
    });
  } finally {
    review.dispose(); controller.abort(); await window.happyDOM.close();
    Object.assign(globalThis, { document: previousDocument });
  }
}

for (const mode of ['retry', 'retry with post-commit warning', 'reactivate', 'post-commit', 'interrupted finish commit', 'unavailable result'] as const) {
  test(`a succeeded worker with a result save failure is applied once without starting another worker (${mode})`, t => withHost(async (host, directory) => {
    const replace = StateStore.prototype.replace;
    let fail = true, failFinish = false, postCommit = mode === 'post-commit';
    const injected = t.mock.method(StateStore.prototype, 'replace', async function (this: StateStore, next: ReturnType<StateStore['snapshot']>) {
      if (failFinish && next.generations[0]?.status === 'completed') throw new Error('Synthetic finish write failure');
      if (fail && next.cards.length && next.generations[0].tasks[0].status === 'applied') {
        if (postCommit) {
          await replace.call(this, next);
          fail = false; // Only the result commit reported a failure, not the following finish write.
        }
        throw new Error('Synthetic result write failure');
      }
      await replace.call(this, next);
    });
    const first = host.context(directory);
    let close = await activate(first.ctx);
    try {
      await first.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
      const flag = await first.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Remember the required condition.' });
      const p = await first.call('preflight', { nodeIds: ['n_a'], flagScopes: [{ id: flag.id, nodeIds: ['n_a'] }], independentNodeIds: [] });
      await first.call('generate', { preflightId: p.preflightId });
      await until(() => host.workers.starts.length === 1);
      const output = result(['n_a']);
      host.workers.succeed('task-1', { targets: output.targets.map(row => ({ ...row, flagMatches: [flag.id] })) });
      if (mode === 'post-commit') {
        await until(async () => (await first.call('generationStatus')).generations[0].status === 'completed');
        const snap = await first.call('generationStatus');
        assert.match(snap.generationRecoveryError, /Synthetic result write failure/);
        assert.equal(snap.recoveryError, undefined);
        await withReviewBanner(name => first.call(name), async refresh => {
          const banner = await refresh();
          assert.match(banner, /Card generation needs checking: The result was recorded, but saving reported an error: Synthetic result write failure/);
          assert.doesNotMatch(banner, /An earlier send needs checking/);
        });
      } else {
        await until(async () => (await first.call('generationStatus')).generations[0].status === 'interrupted');
        const pending = JSON.parse(await readFile(statePath(directory), 'utf8'));
        assert.equal(pending.cards.length, 0);
        assert.equal(pending.flags[0].handledIdeas, undefined);
        assert.equal(pending.generations[0].tasks[0].resultPending, true);
        await assert.rejects(first.call('preflight', { nodeIds: ['n_a'] }), /generating/);
        if (mode === 'retry' || mode === 'retry with post-commit warning') {
          await assert.rejects(first.call('dismissNode', { nodeId: 'n_a', statementHash: statementHash(host.nodes[0].statement) }), {
            message: 'Use Retry saving before dismissing this idea. If the result is unavailable, use Abandon unavailable result.',
          });
          await withReviewBanner(name => first.call(name), async refresh => {
            assert.match(await refresh(), /Card generation needs checking: Stop writing/);
            await assert.rejects(first.call('abandonGenerationResult', { id: p.preflightId, confirmed: true }), /No pending result is unavailable/);
            const failed = await first.call('retryGeneration', { id: p.preflightId });
            assert.equal(failed.recovery, true);
            assert.equal(failed.snapshot.generations[0].tasks[0].resultPending, true);
            assert.match(await refresh(), /Card generation needs checking: Stop writing/);
            postCommit = mode === 'retry with post-commit warning';
            fail = postCommit;
            const saved = await first.call('retryGeneration', { id: p.preflightId });
            assert.equal(saved.snapshot.cards.length, 1);
            const banner = await refresh();
            assert.doesNotMatch(banner, /Stop writing/);
            if (postCommit) {
              assert.match(banner, /Card generation needs checking: The result was recorded, but saving reported an error/);
            } else {
              assert.equal(saved.snapshot.generationRecoveryError, undefined);
              assert.doesNotMatch(banner, /Card generation needs checking/);
            }
          });
        }
        if (mode === 'interrupted finish commit') {
          fail = false; failFinish = true;
          await assert.rejects(first.call('retryGeneration', { id: p.preflightId }), /Synthetic finish write failure/);
          const disk = JSON.parse(await readFile(statePath(directory), 'utf8'));
          assert.equal(disk.generations[0].status, 'interrupted');
          assert.equal(disk.generations[0].tasks[0].status, 'applied');
          assert.equal(disk.generations[0].tasks[0].resultPending, undefined);
          assert.equal(disk.cards.length, 1);
          assert.equal(host.workers.starts.length, 1);
        }
        if (mode === 'unavailable result') host.workers.tasks.delete('task-1');
      }
      fail = false;
      await close();
      failFinish = false;
      const next = host.context(directory);
      close = await activate(next.ctx);
      const final = await next.call('generationStatus');
      if (mode === 'unavailable result') {
        const id = p.preflightId;
        assert.equal(final.cards.length, 0);
        assert.equal(final.generations[0].tasks[0].resultPending, true);
        assert.match(final.generationRecoveryError, /Stop writing/);
        assert.equal(next.ctx.workers.list().length, 0);
        const idea = async () => (await next.call('coverageContext')).nodes.find((n: { id: string }) => n.id === 'n_a').coverage;
        assert.equal((await idea()).selectable, false);
        await assert.rejects(next.call('retryGeneration', { id }), /saved worker result is unavailable.*No model call/);
        await assert.rejects(next.call('dismissGeneration', { id }), /Save or abandon/);
        await assert.rejects(next.call('abandonGenerationResult', { id }), /Confirm abandoning/);
        assert.equal((await idea()).selectable, false);
        const abandoned = await next.call('abandonGenerationResult', { id, confirmed: true });
        assert.equal(abandoned.cards.length, 0);
        assert.equal(abandoned.generations[0].status, 'failed');
        assert.equal(abandoned.generations[0].tasks[0].resultPending, undefined);
        assert.match(abandoned.generations[0].tasks[0].error, /was abandoned/);
        assert.equal(abandoned.generationRecoveryError, undefined);
        assert.equal((await idea()).selectable, true);
        await next.call('dismissGeneration', { id });
        const disk = JSON.parse(await readFile(statePath(directory), 'utf8'));
        assert.equal(disk.generations[0].hidden, true);
        assert.equal(disk.generations[0].tasks[0].resultPending, undefined);
        await assert.rejects(next.call('generate', { preflightId: 'not-confirmed' }), /Run preflight again/);
        await next.call('generate', { preflightId: id }); // Replaying the old confirmation is a no-op.
        const fresh = await next.call('retryGeneration', { id });
        assert.notEqual(fresh.preflightId, id);
        assert.equal(fresh.nodeCount, 1);
        assert.equal(host.workers.starts.length, 1, 'abandoning and obtaining a fresh estimate never starts a worker');
        return;
      }
      assert.equal(final.cards.length, 1);
      assert.equal(final.cards[0].requestId, host.workers.starts[0].requestId);
      const disk = JSON.parse(await readFile(statePath(directory), 'utf8'));
      assert.deepEqual(disk.flags[0].handledIdeas, [{ nodeId: 'n_a', statementHash: statementHash(host.nodes[0].statement) }]);
      assert.equal(final.generations[0].status, 'completed');
      assert.equal(final.generations[0].tasks[0].status, 'applied');
      assert.equal(final.generations[0].tasks[0].resultPending, undefined);
      await assert.rejects(next.call('retryGeneration', { id: p.preflightId }), /No unfinished/);
      assert.equal(host.workers.starts.length, 1);
    } finally { injected.mock.restore(); await close(); }
  }));
}

test('Off uses the basic writer; auto and prefer use the cloze writer and save cloze cards', () => withHost(async (host, directory) => {
  const { writerInstructions } = await import('../src/writer/prompt.ts');
  const { resultSchemaFor } = await import('../src/writer/schema.ts');
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    const basic = host.workers.definitions.get('manual-card-writer')!, cloze = host.workers.definitions.get('manual-card-writer-cloze')!;
    assert.equal(basic.instructions, writerInstructions({ checkBatchDuplicates: true }));
    assert.equal(cloze.instructions, writerInstructions({ cloze: true, checkBatchDuplicates: true }));
    assert.match(basic.instructions, /across targets/);
    for (const { instructions } of [basic, cloze]) {
      assert.match(instructions, /interchangeable cue and recall direction/);
      assert.doesNotMatch(instructions, /One card per fact|one card for each fact|repeat a fact in the other format/);
    }
    assert.match(cloze.instructions, /repeat the same recall task in the other format/);
    assert.match(cloze.instructions, /prefer the clearer card that directly satisfies the flag/);
    assert.deepEqual(basic.resultSchema, resultSchemaFor());
    assert.ok(cloze.instructions.includes('{{blank}}') && !basic.instructions.includes('{{blank}}'));
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' } });
    await assert.rejects(c.call('generationSettings', { cloze: 'always' }), /cloze setting/);
    // The default is auto: the cloze writer, sized from its own instructions.
    const auto = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { cloze: 'off' });
    await assert.rejects(c.call('generate', { preflightId: auto.preflightId }), /stale|expired/);
    // Round 1 S4: switching back doesn't revive the earlier estimate.
    await c.call('generationSettings', { cloze: 'auto' });
    await assert.rejects(c.call('generate', { preflightId: auto.preflightId }), /expired/);
    await c.call('generationSettings', { cloze: 'off' });
    const off = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.ok(auto.inputTokens > off.inputTokens, `${auto.inputTokens} > ${off.inputTokens}`);
    await c.call('generate', { preflightId: off.preflightId });
    await until(() => host.workers.starts.length === 1);
    let task = host.workers.list()[0];
    assert.equal(task.definitionId, 'manual-card-writer');
    assert.equal('cloze' in (task.input as WriterInput), false);
    // A cloze card from the basic writer is rejected (C2a).
    host.workers.succeed(task.id, { targets: [{ nodeId: 'n_a', cards: [{ kind: 'fact', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}' }] }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status !== 'running');
    let saved = await c.call('generationStatus');
    assert.equal(saved.generations[0].tasks[0].status, 'failed');
    assert.equal(saved.generations[0].tasks[0].definitionId, 'manual-card-writer');
    assert.equal(saved.generations[0].settings.cloze, 'off');
    assert.equal(saved.cards.length, 0);
    await c.call('generationSettings', { cloze: 'prefer' });
    const prefer = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: prefer.preflightId });
    await until(() => host.workers.starts.length === 2);
    task = host.workers.list()[1];
    assert.equal(task.definitionId, 'manual-card-writer-cloze');
    assert.equal((task.input as WriterInput).cloze, 'prefer');
    host.workers.succeed(task.id, { targets: [{ nodeId: 'n_a', cards: [
      { kind: 'fact', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}' },
      { kind: 'fact', format: 'cloze', front: 'Generating function: \\(a_n = {{blank}}\\)', back: 'n![z^n](1-z)^{-1}' },
    ] }] });
    await until(async () => (await c.call('generationStatus')).generations[1].status === 'completed');
    saved = await c.call('generationStatus');
    assert.equal(saved.generations[1].tasks[0].definitionId, 'manual-card-writer-cloze');
    assert.deepEqual(saved.cards.map((card: { format?: string; back: string }) => [card.format, card.back]), [['cloze', '\\mathrm{J\\,s}'], ['cloze', 'n![z^n](1-z)^{-1}']]);
    // The next request lists them as existing cards with their format.
    const again = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generate', { preflightId: again.preflightId });
    await until(() => host.workers.starts.length === 3);
    const existing = (host.workers.list()[2].input as WriterInput).targets[0].existingCards;
    assert.ok(existing.some(e => e.format === 'cloze' && e.front.includes('{{blank}}')));
  } finally { await close(); }
}));

test('#54: Writer notes save trimmed, clear when blank, stay within 2,000 characters and survive a restart', () => withHost(async (host, directory) => {
  let c = host.context(directory), close = await activate(c.ctx);
  try {
    assert.equal((await c.call('generationStatus')).generationSettings.writerNotes, undefined);
    let saved = await c.call('generationSettings', { writerNotes: '  Make prefix facts cloze cards.\n' });
    assert.equal(saved.generationSettings.writerNotes, 'Make prefix facts cloze cards.');
    assert.equal(JSON.parse(await readFile(statePath(directory), 'utf8')).generationSettings.writerNotes, 'Make prefix facts cloze cards.');
    // Other settings changes keep the notes.
    saved = await c.call('generationSettings', { cardsPerNode: 3 });
    assert.equal(saved.generationSettings.writerNotes, 'Make prefix facts cloze cards.');
    await assert.rejects(c.call('generationSettings', { writerNotes: 'x'.repeat(2001) }), /at most 2,000 characters/);
    await assert.rejects(c.call('generationSettings', { writerNotes: 42 }), /must be text/);
    // Surrounding space doesn't count against the limit.
    saved = await c.call('generationSettings', { writerNotes: ` ${'x'.repeat(2000)} ` });
    assert.equal(saved.generationSettings.writerNotes.length, 2000);
    saved = await c.call('generationSettings', { writerNotes: 'Name the unit system on units cards.' });
    await close();
    c = host.context(directory); close = await activate(c.ctx);
    assert.equal((await c.call('generationStatus')).generationSettings.writerNotes, 'Name the unit system on units cards.');
    // Blank clears: the field is removed, so settings match a learner who never set notes.
    saved = await c.call('generationSettings', { writerNotes: ' \n ' });
    assert.equal('writerNotes' in saved.generationSettings, false);
    assert.equal('writerNotes' in JSON.parse(await readFile(statePath(directory), 'utf8')).generationSettings, false);
  } finally { await close(); }
}));

test('#54: the estimate counts Writer notes, an edit or clear makes an open estimate stale, and the same notes keep it', () => withHost(async (host, directory) => {
  const c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const notes = 'Name the unit system on units cards.';
    const plain = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { writerNotes: notes });
    await assert.rejects(c.call('generate', { preflightId: plain.preflightId }), /expired/);
    const withNotes = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.equal(withNotes.settings.writerNotes, notes);
    const extra = estimateTokens(`\n\n${writerNotesSection(notes)}`);
    assert.ok(Math.abs(withNotes.inputTokens - plain.inputTokens - extra) <= 1, `${withNotes.inputTokens} - ${plain.inputTokens} ≈ ${extra}`);
    // An edit invalidates the open estimate, and changing back doesn't revive it.
    await c.call('generationSettings', { writerNotes: `${notes} Prefer cloze for prefixes.` });
    await assert.rejects(c.call('generate', { preflightId: withNotes.preflightId }), /expired/);
    await c.call('generationSettings', { writerNotes: notes });
    await assert.rejects(c.call('generate', { preflightId: withNotes.preflightId }), /expired/);
    // Saving the same text, or another setting, leaves what would be sent unchanged.
    const kept = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { writerNotes: ` ${notes}\n` });
    await c.call('generationSettings', { cardsPerNode: 1 });
    await c.call('generate', { preflightId: kept.preflightId });
    await until(() => host.workers.starts.length === 1);
    const start = host.workers.starts[0], input = start.input as WriterInput;
    assert.equal(input.writerNotes, notes);
    assert.equal(start.prompt, writerPrompt(input));
    assert.ok(start.prompt.endsWith(writerNotesSection(notes)));
    host.workers.succeed('task-1', result(['n_a']));
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    const history = JSON.parse(await readFile(statePath(directory), 'utf8')).generations[0];
    assert.equal(history.settings.writerNotes, notes);
    assert.equal(history.tasks[0].input.writerNotes, notes);
    // Clearing also invalidates, and the next request has no notes at all.
    const before = await c.call('preflight', { nodeIds: ['n_a'] });
    await c.call('generationSettings', { writerNotes: '' });
    await assert.rejects(c.call('generate', { preflightId: before.preflightId }), /expired/);
    const cleared = await c.call('preflight', { nodeIds: ['n_a'] });
    assert.ok(cleared.inputTokens < before.inputTokens);
    await c.call('generate', { preflightId: cleared.preflightId });
    await until(() => host.workers.starts.length === 2);
    const plainStart = host.workers.starts[1];
    assert.equal('writerNotes' in (plainStart.input as WriterInput), false);
    assert.equal(plainStart.prompt, writerPrompt(plainStart.input as WriterInput));
    assert.doesNotMatch(plainStart.prompt, /Writer notes/);
  } finally { await close(); }
}));

test('#54: split requests share the notes frozen at preflight, alongside earlier drafts and their reserve', () => withHost(async (host, directory) => {
  let c = host.context(directory), close = await activate(c.ctx);
  try {
    await c.call('generationSettings', { model: { provider: 'scratch', id: 'writer' }, cardsPerNode: 1 });
    const note = await c.call('flag', { sessionId: 'c1', messageIds: ['m1'], note: 'Recall this equation.' });
    host.catalog.models[0].maxTokens = outputAllowance(1, 12);
    const selection = { nodeIds: ['n_b', 'n_a'], flagScopes: [{ id: note.id, nodeIds: ['n_a'] }], independentNodeIds: ['n_b'] };
    const notes = 'On units cards, name the unit system, e.g. "In natural units with energy in eV".';
    const plain = await c.call('preflight', selection);
    await c.call('generationSettings', { writerNotes: notes });
    const p = await c.call('preflight', selection);
    assert.deepEqual(p.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [['n_a'], ['n_b']]);
    // Each request counts the notes once; the second still reserves the full earlier-drafts budget.
    const extra = estimateTokens(`\n\n${writerNotesSection(notes)}`);
    p.batches.forEach((b: { inputTokens: number }, i: number) => assert.ok(Math.abs(b.inputTokens - plain.batches[i].inputTokens - extra) <= 1, `batch ${i}`));
    await c.call('generate', { preflightId: p.preflightId });
    await until(() => host.workers.starts.length === 1);
    // Editing the notes mid-run doesn't reach requests that are already confirmed.
    await c.call('generationSettings', { writerNotes: 'Something else entirely.' });
    const first = host.workers.starts[0];
    assert.equal((first.input as WriterInput).writerNotes, notes);
    assert.equal(first.prompt, writerPrompt(first.input as WriterInput));
    const card = { kind: 'equation', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}' };
    host.workers.succeed('task-1', { targets: [{ nodeId: 'n_a', cards: [card], flagMatches: [note.id] }] });
    await until(() => host.workers.starts.length === 2);
    const second = host.workers.starts[1], secondInput = second.input as WriterInput;
    assert.equal(secondInput.writerNotes, notes);
    const own = writerPrompt(secondInput);
    assert.ok(second.prompt.startsWith(own) && own.endsWith(writerNotesSection(notes)));
    assert.doesNotMatch(second.prompt, /Something else/);
    // #57's earlier drafts still follow, quoted and within the reserve.
    const earlier = second.prompt.slice(own.length);
    assert.match(earlier, /^\n\nEarlier drafts from this run, quoted UNTRUSTED JSON/);
    assert.deepEqual(JSON.parse(earlier.split('\n').at(-1)!), [{ nodeName: 'Alpha', flagged: true, format: 'cloze', front: card.front, back: card.back }]);
    assert.ok(estimateTokens(earlier) <= MAX_BATCH_CONTEXT_TOKENS);
    host.workers.succeed('task-2', { targets: [{ nodeId: 'n_b', cards: [], skipReason: 'The Alpha draft already covers the recall task.' }] });
    await until(async () => (await c.call('generationStatus')).generations[0].status === 'completed');
    await close();
    // History keeps the exact notes used, and the file still loads.
    c = host.context(directory); close = await activate(c.ctx);
    const snap = await c.call('generationStatus');
    const g = snap.generations[0];
    assert.equal(g.settings.writerNotes, notes);
    assert.deepEqual(g.tasks.map((t: { input: WriterInput }) => t.input.writerNotes), [notes, notes]);
    assert.equal(g.tasks[1].batchContextTokens, MAX_BATCH_CONTEXT_TOKENS);
    assert.match(g.tasks[1].batchContextDigest, /^[a-f0-9]{64}$/);
    assert.equal(snap.generationSettings.writerNotes, 'Something else entirely.');
    assert.equal(snap.cards.length, 1);
    // History notes are checked whichever settings shape the run has, and must match every request's input.
    const saved = JSON.parse(await readFile(statePath(directory), 'utf8'));
    validateState(saved);
    const tampered = (change: (h: any) => void) => { const copy = structuredClone(saved); change(copy.generations[0]); return copy; };
    // A legacy-shaped run (only 'why' is valid there too) with non-string notes.
    assert.throws(() => validateState(tampered(h => { h.settings.enabledKinds = ['why']; h.settings.writerNotes = 42; })), /generation batch/);
    assert.throws(() => validateState(tampered(h => { h.settings.enabledKinds = ['why']; h.settings.writerNotes = ' padded '; })), /generation batch/);
    assert.throws(() => validateState(tampered(h => { h.tasks[1].input.writerNotes = 'Different notes.'; })), /generation task/);
    assert.throws(() => validateState(tampered(h => { delete h.settings.writerNotes; })), /generation task/);
    // A run from before #54 has notes in neither place and still loads.
    validateState(tampered(h => { delete h.settings.writerNotes; for (const t of h.tasks) delete t.input.writerNotes; }));
    // A build without #54 copies saved notes into the run settings but not into its requests; that run still loads.
    validateState(tampered(h => { for (const t of h.tasks) delete t.input.writerNotes; }));
    // Once any request carried notes, every request must carry the run's notes.
    assert.throws(() => validateState(tampered(h => { delete h.tasks[1].input.writerNotes; })), /generation task/);
  } finally { await close(); }
}));
