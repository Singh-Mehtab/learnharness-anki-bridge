import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSelection, flagNotesByNode, latestTeacherTurn, matchFlag, normalizeNote, sessionNodeIds, teacherProse, uncardedIds, validateFlags,
} from '../src/session/flow.ts';
import type { Flag, GraphLike } from '../src/session/flow.ts';
import { extractedMessageIds, messageFingerprint } from '../src/session/extraction.ts';
import { failedOutputCallIds, plainText } from '../src/session/flow.ts';

const transcript = [
  { id: 'u1', role: 'user', content: 'Explain spin', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '  Spin is $\\frac12$ angular momentum.  ' }, { type: 'toolCall', id: 'c1', name: 'send_to_user', arguments: { message: 'Pauli matrices next.' } }], stopReason: 'toolUse', timestamp: 2 },
  { id: 't1', role: 'toolResult', toolCallId: 'c1', toolName: 'send_to_user', content: [], isError: false, timestamp: 3 },
  { id: 'a2', role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'send_to_user', arguments: { message: 'Lost' } }, { type: 'text', text: 'Kept' }], stopReason: 'aborted', timestamp: 4 },
];
const flag = (over: Partial<Flag> = {}): Flag => ({ id: '00000000-0000-4000-8000-000000000001', sessionId: 's1', sessionTitle: 'Spin', messageIds: ['a1'], note: '', flaggedAt: '2026-11-18T10:00:00.000Z', ...over });

test('fingerprints match LearnHarness 0.6.1 coverage hashes for text, send_to_user and failed calls', () => {
  // Expected values were computed by the host's own messageFingerprint/failedOutputCallIds
  // source (v0.6.1, src/core/coverage.ts and native-messages.ts) on this transcript.
  const expected = {
    u1: '3084ab9589db83c1f078167283d1dfb781f64bb6a05146fc719a13f8a87ca9d7',
    a1: '1115de8cc77f1549e56f740c55c14c95949f716b99fcd43eb84ed5209d1eb60b',
    t1: '1397726aabf3fbe89ba6e07bd21d603785e796d7b5d08acf891b6474f9494193',
    a2: '4faa915fc974b0fe64625fa78c1a03dcf737cdd2d87f91a66c6aebee01340b39',
  };
  const failed = failedOutputCallIds(transcript);
  for (const m of transcript) assert.equal(messageFingerprint(m, failed), expected[m.id as keyof typeof expected], m.id);
  const covered = new Set([expected.a1]);
  assert.deepEqual([...extractedMessageIds(transcript, covered, ['a1', 'a2'])], ['a1']);
});

test('teacher prose keeps text and delivered send_to_user, drops thinking and failed calls', () => {
  const failed = failedOutputCallIds(transcript);
  assert.deepEqual(teacherProse(transcript[1], failed), ['  Spin is $\\frac12$ angular momentum.  ', 'Pauli matrices next.']);
  assert.deepEqual(teacherProse(transcript[3], failed), ['Kept']);
  assert.deepEqual(teacherProse(transcript[0], failed), []);
  const errored = [
    { id: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'send_to_user', arguments: { message: 'Undelivered' } }] },
    { id: 'r', role: 'toolResult', toolCallId: 'x', toolName: 'send_to_user', isError: true, content: [] },
  ];
  assert.deepEqual(teacherProse(errored[0], failedOutputCallIds(errored)), []);
});

test('latest teacher turn spans every prose message after the last learner message', () => {
  const turn = latestTeacherTurn(transcript);
  assert.deepEqual(turn?.messageIds, ['a1', 'a2']);
  assert.match(turn!.excerpt, /^Spin is \$\\frac12\$ angular momentum\. Pauli matrices next\. Kept$/);
  // A learner message with no prose reply yet falls back to the previous teaching turn.
  assert.deepEqual(latestTeacherTurn([...transcript, { id: 'u2', role: 'user', content: 'Thanks' }])?.messageIds, ['a1', 'a2']);
  // A later turn that has prose wins, and tool-only assistant messages are not anchors.
  const later = [...transcript, { id: 'u2', role: 'user', content: 'More' },
    { id: 'a3', role: 'assistant', content: [{ type: 'toolCall', id: 'q', name: 'quiz', arguments: {} }] },
    { id: 'a4', role: 'assistant', content: 'Plain string reply' }];
  assert.deepEqual(latestTeacherTurn(later)?.messageIds, ['a4']);
  assert.equal(latestTeacherTurn([{ id: 'u', role: 'user', content: 'hi' }]), null);
  assert.equal(latestTeacherTurn([]), null);
  assert.equal(latestTeacherTurn([{ role: 'assistant', content: 'no id' }]), null);
  assert.ok(latestTeacherTurn([{ id: 'a', role: 'assistant', content: 'x'.repeat(1000) }])!.excerpt.length <= 240);
});

test('notes are one trimmed line with a cap; flags validate strictly', () => {
  assert.equal(normalizeNote(undefined), '');
  assert.equal(normalizeNote('  I got\n the sign   wrong '), 'I got the sign wrong');
  assert.throws(() => normalizeNote('x'.repeat(301)), /longer/);
  assert.throws(() => normalizeNote(4), /text/);
  assert.throws(() => normalizeNote('a\0b'), /null/);
  validateFlags([flag(), flag({ id: '00000000-0000-4000-8000-000000000002', messageIds: ['a2'] })]);
  for (const bad of [
    [flag({ id: 'nope' })], [flag({ messageIds: [] })], [flag({ messageIds: ['a', 'a'] })], [flag({ note: 'a\nb' })],
    [flag({ flaggedAt: 'yesterday' })], [flag({ sessionId: '' })], [flag(), flag()],
    [flag(), flag({ id: '00000000-0000-4000-8000-000000000002' })], // same anchor twice
    'flags',
  ]) assert.throws(() => validateFlags(bad), /not been reset/);
});

const graph: GraphLike = {
  propositions: [
    { id: 'n-late', name: 'Zeta', statement: 'z', provenance: [{ chatId: 's1', messageId: 'a2' }] },
    { id: 'n-spin', name: 'Spin', statement: 's', provenance: [{ chatId: 's1', messageId: 'a1' }, { chatId: 's2', messageId: 'b1' }] },
    { id: 'n-pauli', name: 'Pauli', statement: 'p', provenance: [{ chatId: 's1', messageId: 'a1' }] },
    { id: 'n-chat', name: 'Chat level', statement: 'c', provenance: [{ chatId: 's1', messageId: '' }] },
    { id: 'n-other', name: 'Other', statement: 'o', provenance: [{ chatId: 's2', messageId: 'a1' }] },
    { id: 'n-ns', name: 'Only nodeSessions', statement: 'x', provenance: [] },
  ],
  nodeSessions: { 'n-late': ['s1'], 'n-spin': ['s1', 's2'], 'n-pauli': ['s1'], 'n-chat': ['s1'], 'n-other': ['s2'], 'n-ns': ['s1'] },
};

test('matching uses chat and non-empty message ID; session scope and order follow the transcript', () => {
  assert.deepEqual(matchFlag(flag(), graph), ['n-spin', 'n-pauli']);
  assert.deepEqual(matchFlag(flag({ messageIds: [''] }), graph), []);
  assert.deepEqual(matchFlag(flag({ sessionId: 's2' }), graph), ['n-other']);
  assert.deepEqual(matchFlag(flag({ messageIds: ['missing'] }), graph), []);
  assert.deepEqual(sessionNodeIds(graph, 's1', ['u1', 'a1', 't1', 'a2']), ['n-pauli', 'n-spin', 'n-late', 'n-chat', 'n-ns']);
  assert.deepEqual(sessionNodeIds(graph, 's2'), ['n-other', 'n-spin']);
});

test('flag notes reach each matched node once; selection defaults to flagged nodes', () => {
  const notes = flagNotesByNode([
    flag({ note: 'sign error' }),
    flag({ id: '00000000-0000-4000-8000-000000000002', messageIds: ['a2'], note: 'sign error' }),
    flag({ id: '00000000-0000-4000-8000-000000000003', sessionId: 's2', messageIds: ['b1'], note: 'units' }),
    flag({ id: '00000000-0000-4000-8000-000000000004', sessionId: 's2', messageIds: ['a1'] }),
  ], graph);
  assert.deepEqual(Object.fromEntries(notes), { 'n-spin': 'sign error / units', 'n-pauli': 'sign error', 'n-late': 'sign error', 'n-other': '' });
  const none = { waiting: 0, sent: 0, sentElsewhere: 0 };
  const nodes = [
    { id: 'a', flagged: true, cards: { ...none, sent: 2 } },
    { id: 'b', flagged: false, cards: none },
    { id: 'c', flagged: false, cards: { ...none, waiting: 1 } },
    { id: 'd', flagged: false, cards: { ...none, sentElsewhere: 1 } },
  ];
  assert.deepEqual(defaultSelection(nodes), ['a']);
  assert.deepEqual(uncardedIds(nodes), ['b', 'd']);
});

test('flag excerpts drop markdown heading marks, table rules and emphasis', () => {
  assert.equal(plainText('## Overview\n\nSome **bold** and `code`.\n\n| Term | Meaning |\n|---|---|\n| A | mass number |'),
    'Overview.\n\nSome bold and code.\n\nTerm, Meaning.\nA, mass number.');
  assert.equal(plainText('```py\nx = 1\n```\n- item [link](http://x)'), '(code)\nitem link');
});
