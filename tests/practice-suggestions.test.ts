import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerPracticeSuggestions, summarizePracticeSuggestions } from '../src/reviews/practice-suggestions.ts';
import { REVIEW_RULES } from '../src/reviews/signals.ts';

test('a review check with no flagged nodes is different from no review check', () => {
  const checkedAt = Date.UTC(2026, 10, 21, 9, 41);
  assert.deepEqual(summarizePracticeSuggestions(null), { checkedAt: null, nodes: [] });
  assert.deepEqual(summarizePracticeSuggestions({
    checkedAt, rules: REVIEW_RULES, topics: [], destination: { url: 'http://127.0.0.1:9/', profile: 'Scratch' },
    counts: { sent: 1, checked: 1, notReviewed: 0, quietTopics: 1, changed: 0, missing: 0 },
  }), { checkedAt, nodes: [] });
});

test('activation on older hosts needs no registration or backend request', () => {
  registerPracticeSuggestions({
    call() { assert.fail('older hosts should not call the provider'); },
    cleanup() { assert.fail('nothing was registered'); },
  });
});

test('picker reads the cache on demand and drops results after closing', async () => {
  type Context = Parameters<typeof registerPracticeSuggestions>[0];
  type Provider = Parameters<NonNullable<Context['registerPracticeNodeSuggestions']>>[0];
  let installed: Provider | undefined, dispose: (() => void) | undefined;
  let finishRead: ((result: unknown) => void) | undefined;
  let reads = 0;
  registerPracticeSuggestions({
    registerPracticeNodeSuggestions(provider) { installed = provider; return () => { installed = undefined; }; },
    cleanup(fn) { dispose = fn; },
    call<T>(operation: string, input?: unknown) {
      assert.equal(operation, 'practiceNodeSuggestions');
      assert.equal(input, undefined);
      reads++;
      return new Promise<T>(resolve => { finishRead = result => resolve(result as T); });
    },
  });
  assert.equal(installed?.label, 'From Anki');
  assert.equal(reads, 0);
  const closed = new AbortController();
  closed.abort();
  await assert.rejects(installed!.read(closed.signal), { name: 'AbortError' });
  assert.equal(reads, 0);
  const result = { checkedAt: 123, nodes: [{ nodeId: 'n', reason: '4 lapses' }] };
  const open = new AbortController();
  const read = installed!.read(open.signal);
  finishRead!(result);
  assert.deepEqual(await read, result);
  const pending = installed!.read(open.signal);
  open.abort();
  finishRead!(result);
  await assert.rejects(pending, { name: 'AbortError' });
  dispose!();
  assert.equal(installed, undefined);
});
