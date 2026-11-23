// A throwaway AnkiConnect stand-in for review checks. It listens on a random port on
// 127.0.0.1 (never 8765 or 8766), answers with the legacy v6 shapes read from the
// SourceHut add-on, and records every request so tests can prove nothing else was sent.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REVIEW_READ_ACTIONS } from '../src/anki/review-reader.ts';

export interface FakeReview { id: number; ease: number; type: number }
export interface FakeCard { cardId: number; lapses?: number; reps?: number; queue?: number; deckName?: string; reviews?: FakeReview[]; note?: number }
export interface FakeNote { noteId: number; lhId: string; modelName?: string; tags?: string[]; cards: FakeCard[]; profile?: string }

export async function fakeAnkiConnect(options: { profile?: string | null; notes?: FakeNote[]; strictReviews?: boolean } = {}) {
  const state = {
    profile: (options.profile === undefined ? 'Throwaway' : options.profile) as string | null,
    notes: options.notes ?? [],
    models: new Map<string, { type: 0 | 1; css?: string }>([['LearnHarness Basic', { type: 0 }], ['LearnHarness Cloze', { type: 1 }]]),
    /** Errors to return once per action, then cleared. */
    errorsOnce: new Map<string, string>(),
    /** Errors to return for every call to an action. */
    errors: new Map<string, string>(),
    /** Called after each answered request, e.g. to switch profile mid-check. */
    after: undefined as ((action: string, params: any) => void | Promise<void>) | undefined,
    delay: 0,
    requests: [] as { action: string; params: any }[],
    /** Actions outside the read-only allowlist that reached the fake. Must stay empty. */
    forbidden: [] as string[],
    /** Raw result overrides, for malformed replies. */
    raw: new Map<string, unknown>(),
  };
  const cardById = (id: number) => { for (const n of state.notes) for (const c of n.cards) if (c.cardId === id) return { note: n, card: c }; return undefined; };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const { action, params = {} } = JSON.parse(raw);
    state.requests.push({ action, params });
    if (state.delay) await new Promise(r => setTimeout(r, state.delay));
    let result: unknown = null, error: string | null = null;
    if (!REVIEW_READ_ACTIONS.has(action)) { state.forbidden.push(action); error = 'unsupported action'; }
    else if (action === 'version') result = 6;
    else if (action === 'getActiveProfile') result = state.profile;
    else if (action === 'notesInfo') {
      if (params.query !== undefined) { state.forbidden.push('notesInfo:query'); error = 'query not allowed in test'; }
      else result = (params.notes as number[]).map(id => {
        const n = state.notes.find(note => note.noteId === id);
        if (!n) return {};
        return { noteId: n.noteId, profile: n.profile ?? state.profile, modelName: n.modelName ?? 'LearnHarness Basic', tags: n.tags ?? [],
          fields: { Front: { value: 'front', order: 0 }, LH_ID: { value: n.lhId, order: 4 } }, cards: n.cards.map(c => c.cardId), mod: 1 };
      });
    } else if (action === 'findModelsByName') {
      result = (params.modelNames as string[]).flatMap(name => {
        const model = state.models.get(name);
        return model ? [{ name, ...model }] : [];
      });
    } else if (action === 'cardsInfo') {
      result = (params.cards as number[]).map(id => {
        const found = cardById(id);
        if (!found) return {};
        const c = found.card;
        return { cardId: c.cardId, note: c.note ?? found.note.noteId, lapses: c.lapses ?? 0, reps: c.reps ?? 0, queue: c.queue ?? 2, type: 2,
          deckName: c.deckName ?? 'Scratch', due: 10, interval: 3, factor: 2500, mod: 1, question: '<div>q</div>', answer: '<div>a</div>' };
      });
    } else if (action === 'getReviewsOfCards') {
      const out: Record<string, unknown[]> = {};
      for (const id of params.cards as number[]) {
        const found = cardById(id);
        if (!found) { if (options.strictReviews) { error = 'notFound: card was not found'; break; } continue; }
        out[String(id)] = (found.card.reviews ?? []).map(r => ({ ...r, ivl: 1, lastIvl: 0, time: 5000 }));
      }
      if (!error) result = out;
    }
    if (state.errorsOnce.has(action)) { error = state.errorsOnce.get(action)!; state.errorsOnce.delete(action); }
    if (state.errors.has(action)) error = state.errors.get(action)!;
    if (state.raw.has(action) && !error) result = state.raw.get(action);
    if (error) result = null;
    await state.after?.(action, params);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result, error }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    url, state,
    actions: () => state.requests.map(r => r.action),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
