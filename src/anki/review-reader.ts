import type { AnkiClient } from './client.ts';

/** The only AnkiConnect actions a review check may send. All of them read; none
 * writes, schedules, tags, suspends or opens Anki windows (docs/fi-1-weak-spots-design.md). */
export const REVIEW_READ_ACTIONS: ReadonlySet<string> = new Set(['version', 'getActiveProfile', 'notesInfo', 'findModelsByName', 'cardsInfo', 'getReviewsOfCards']);

/** Wraps a client so a review check cannot reach any other action, even by mistake. */
export class ReviewReader {
  private readonly client: Pick<AnkiClient, 'call'>;
  constructor(client: Pick<AnkiClient, 'call'>) { this.client = client; }
  call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!REVIEW_READ_ACTIONS.has(action)) return Promise.reject(new Error(`A review check may not call AnkiConnect action ${action}.`));
    return this.client.call<T>(action, params);
  }
}
