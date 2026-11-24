import assert from 'node:assert/strict';
import { test } from 'node:test';
import { practiceTitle, startPracticeSession } from '../src/reviews/practice-start.ts';

const picks = [{ id: 'n1', name: 'Radius', statement: 'R grows.' }, { id: 'n2', name: 'Femto', statement: '10^-15.' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const saved = (overrides: Record<string, unknown> = {}) => ({ kind: 'practice', messages: [{ role: 'custom', customType: 'graph-context', details: { propositions: picks, chains: [] } }], ...overrides });

function host(responses: { create?: () => Response | Promise<Response>; read?: () => Response }) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchLike = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url === '/api/chats') return (responses.create ?? (() => json({ id: 'chat_9', title: 'x' })))();
    if (url === '/api/chats/chat_9') return (responses.read ?? (() => json(saved())))();
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { requests, fetchLike };
}

test('sends the native Pick nodes request and returns the new session after reading it back', async () => {
  const h = host({});
  assert.equal(await startPracticeSession(picks, h.fetchLike), 'chat_9');
  assert.equal(h.requests[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(h.requests[0]!.init?.body)), { title: 'Practice: Radius, Femto', kind: 'practice', graphContext: { propositions: picks } });
  assert.equal(h.requests[1]!.url, '/api/chats/chat_9');
  assert.equal(practiceTitle([{ id: 'a', name: '  ', statement: '' }]), 'Practice: Idea');
});

test('only id, name and statement are sent', async () => {
  const h = host({});
  await startPracticeSession([{ ...picks[0]!, reason: '4 lapses' } as never], h.fetchLike).catch(() => {});
  assert.deepEqual(JSON.parse(String(h.requests[0]!.init?.body)).graphContext.propositions, [picks[0]]);
});

test('every failure explains the manual fallback and never returns a session', async () => {
  const cases: [string, Parameters<typeof host>[0], RegExp][] = [
    ['network', { create: () => { throw new TypeError('offline'); } }, /Couldn't reach LearnHarness/],
    ['missing route', { create: () => json({ error: 'nope' }, 404) }, /HTTP 404.*may not support/],
    ['bad id', { create: () => json({ id: '../x' }) }, /unexpected way/],
    ['not json', { create: () => new Response('<html>') }, /unexpected way/],
    ['teach session', { read: () => json(saved({ kind: undefined })) }, /couldn't verify/],
    ['no marker', { read: () => json(saved({ messages: [] })) }, /couldn't verify/],
    ['wrong picks', { read: () => json(saved({ messages: [{ customType: 'graph-context', details: { propositions: [picks[0]] } }] })) }, /couldn't verify/],
    ['read fails', { read: () => json({}, 500) }, /couldn't verify/],
  ];
  for (const [name, responses, expected] of cases) {
    await assert.rejects(startPracticeSession(picks, host(responses).fetchLike), (error: Error) => {
      assert.match(error.message, expected, name);
      assert.match(error.message, /Practice → Pick nodes instead/, name);
      return true;
    });
  }
});
