// Check Anki reviews: a read-only look at how the notes Anki Bridge sent are doing.
// Runs only when the user presses the button. The result stays in memory; nothing is
// written to state.json, Anki, the graph or a model.
import { AnkiClient, AnkiError, normalizeUrl } from '../anki/client.ts';
import { hasOwnedStyle, nativeTypeMatches, noteTypeFor, readNativeModels } from '../anki/note-type.ts';
import { ReviewReader } from '../anki/review-reader.ts';
import { sameDestination } from '../anki/destination.ts';
import type { Card, Destination, StateStore } from '../anki/state.ts';
import { buildTopics, REVIEW_RULES } from './signals.ts';
import type { CardInfo, GraphInfo, NoteReading, ReviewCheck, ReviewRow } from './signals.ts';

export const REVIEW_OPERATIONS = ['checkReviews', 'lastReviewCheck', 'clearReviewCheck'] as const;
/** Unmeasured guesses. cardsInfo is the heaviest call on 26.10.11.0, which renders each card. */
export const REVIEW_BATCH = { notes: 50, cards: 25, reviews: 50 } as const;

interface GraphSource {
  graph(): { propositions: readonly { id: string }[]; nodeSessions: Record<string, string[]>; sessions: Record<string, string> };
  listSessions?(): readonly { id: string; createdAt: string }[];
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const chunks = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

/** The paired profile is not the open one, so any earlier result no longer applies. */
class ProfileMismatch extends Error {}
const connectionKey = (state: { settings: { url: string; apiKey: string }; destination: Destination | null }) => JSON.stringify([state.settings.url, state.settings.apiKey, state.destination?.url ?? null, state.destination?.profile ?? null]);
const retryable = (error: unknown) => error instanceof AnkiError && error.kind === 'api' && /stale ?cursor|not ?found/i.test(error.message);

export class ReviewService {
  private last: ReviewCheck | undefined;
  /** Advances whenever a commit changes the address, API key or pairing, so A→B→A still counts as a change. */
  private revision = 0;
  private connection: string;
  private readonly unsubscribe: () => void;
  private running = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly learning: GraphSource;
  private readonly store: StateStore;
  private readonly options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number };
  constructor(learning: GraphSource, store: StateStore, options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {}) {
    this.learning = learning; this.store = store; this.options = options;
    this.connection = connectionKey(store.snapshot());
    this.unsubscribe = store.onCommit(state => {
      const key = connectionKey(state);
      if (key !== this.connection) { this.connection = key; this.revision++; this.last = undefined; }
    });
    if (options.signal?.aborted) this.lifetime.abort();
    else options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private abort = () => this.lifetime.abort();
  close(): void {
    this.closed = true; this.last = undefined;
    this.unsubscribe();
    this.lifetime.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
  }
  /** Called by the backend after a pair or a settings change commits, so an A→B→A switch still forgets. */
  forget(): void { this.revision++; this.last = undefined; }
  private active(): void {
    if (this.closed || this.lifetime.signal.aborted) throw new Error('Anki Bridge is disabled.');
  }
  /** The last result, dropped as soon as the pairing or address it was read from changes. */
  private current(): ReviewCheck | null {
    const { destination, settings } = this.store.snapshot();
    if (this.last && (!sameDestination(this.last.destination, destination) || settings.url !== this.last.destination.url)) this.last = undefined;
    return this.last ?? null;
  }
  async command(name: string, input: unknown = {}): Promise<{ check: ReviewCheck | null; running: boolean }> {
    this.active();
    if (!record(input)) throw new Error('Expected an input object.');
    const allowed = name === 'checkReviews' ? ['expectedDestination'] : [];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Unsupported review check input.');
    if (name === 'lastReviewCheck') return { check: this.current(), running: this.running };
    if (name === 'clearReviewCheck') {
      if (this.running) throw new Error('Wait for the review check to finish.');
      this.last = undefined;
      return { check: null, running: false };
    }
    if (name !== 'checkReviews') throw new Error('Unknown review check operation.');
    if (this.running) throw new Error('A review check is already running.');
    this.running = true;
    const apiKey = this.store.snapshot().settings.apiKey;
    try {
      const revision = this.revision;
      const check = await this.check(input.expectedDestination, revision);
      // Last line of defence: nothing is published if the connection changed at any point.
      if (revision !== this.revision) throw new ProfileMismatch('The Anki connection or pairing changed during the check. Nothing was kept. Check again.');
      this.last = check;
      return { check, running: false };
    } catch (error) {
      if (error instanceof ProfileMismatch) this.last = undefined;
      throw new Error(this.message(error, apiKey));
    } finally { this.running = false; }
  }

  private message(error: unknown, ...keys: string[]): string {
    let text: string;
    if (error instanceof AnkiError) {
      if (error.kind === 'refused') text = "Anki isn't running or AnkiConnect isn't reachable. Open Anki and check again.";
      else if (error.kind === 'timeout') text = 'Anki did not answer in time. Try again.';
      else if (error.kind === 'transport') text = 'Could not reach AnkiConnect. Try again.';
      else if (error.kind === 'cancelled') text = 'The review check was cancelled.';
      else if (error.kind === 'key-rejected') text = 'AnkiConnect rejected the API key. Check it in Settings.';
      else if (error.kind === 'not-anki-connect') text = `The address in Settings did not answer like AnkiConnect. ${error.message}`;
      else if (/getActiveProfile/.test(error.message)) text = error.message;
      else if (/unsupported action|unknown action|method not found/i.test(error.message)) text = 'This AnkiConnect build cannot return review history. Upgrade AnkiConnect to 26.10.11.0 or later.';
      else if (/\bbusy\b/i.test(error.message)) text = 'Anki is busy. Try again in a moment.';
      else text = `AnkiConnect could not complete the check: ${error.message}`;
    } else text = error instanceof Error ? error.message : String(error);
    for (const key of new Set([this.store.snapshot().settings.apiKey, ...keys])) if (key) text = text.split(key).join('[API key hidden]');
    return text;
  }

  /** Retry a batch once when the collection changed under a paged read. `before` re-checks the profile first. */
  private async retry<T>(read: () => Promise<T>, before: () => Promise<void>): Promise<T> {
    try { return await read(); }
    catch (error) {
      if (!retryable(error)) throw error;
      await before();
      return read();
    }
  }

  private async check(expected: unknown, revision: number): Promise<ReviewCheck> {
    const state = this.store.snapshot();
    const paired = state.destination;
    if (!paired || paired.url !== state.settings.url) throw new Error('Choose a profile for this address in settings first.');
    if (expected !== undefined) {
      const ok = record(expected) && typeof expected.url === 'string' && typeof expected.profile === 'string' &&
        (() => { try { return normalizeUrl(expected.url as string) === paired.url; } catch { return false; } })() && expected.profile === paired.profile;
      if (!ok) throw new Error('Paired profile changed. Check it and try again.');
    }
    const { apiKey } = state.settings;
    const local = state.cards.filter((c): c is Card & { noteId: number } => c.status === 'sent' && !!c.noteId && sameDestination(c.destination, paired));
    const now = (this.options.now ?? Date.now)();
    const empty = { sent: local.length, checked: 0, notReviewed: 0, quietTopics: 0, changed: 0, missing: 0 };
    if (!local.length) return { checkedAt: now, destination: { ...paired }, rules: REVIEW_RULES, topics: [], counts: empty };

    const reader = new ReviewReader(new AnkiClient({ url: paired.url, apiKey, timeoutMs: this.options.timeoutMs, signal: this.lifetime.signal }));
    const saved = () => {
      this.active();
      const current = this.store.snapshot();
      if (revision !== this.revision || !sameDestination(current.destination, paired) || current.settings.url !== paired.url || current.settings.apiKey !== apiKey) {
        throw new ProfileMismatch('The Anki connection or pairing changed during the check. Nothing was kept. Check again.');
      }
    };
    const guard = async () => {
      saved();
      const profile = await reader.call<string | null>('getActiveProfile');
      // Settings can change while getActiveProfile is in flight.
      saved();
      if (profile === null) throw new ProfileMismatch(`Open the paired profile "${paired.profile}" in Anki, then check again.`);
      if (profile !== paired.profile) throw new ProfileMismatch(`Anki has the profile "${profile}" open. Open the paired profile "${paired.profile}" or re-pair in Settings.`);
    };

    await reader.call('version');
    await guard();

    // Notes: only the IDs saved when the bridge sent them, never a search.
    let changed = 0, missing = 0;
    const owned: { card: Card & { noteId: number }; tags: string[]; cardIds: number[] }[] = [];
    for (const batch of chunks(local, REVIEW_BATCH.notes)) {
      const ids = [...new Set(batch.map(c => c.noteId))];
      const notes = await this.retry(() => reader.call<Record<string, unknown>[]>('notesInfo', { notes: ids }), guard);
      await guard();
      if (notes.length !== ids.length) throw new Error('AnkiConnect returned an unexpected number of notes. Nothing was kept.');
      const byId = new Map<number, Record<string, unknown>>();
      for (const note of notes) {
        if (!Object.keys(note).length) continue;
        if (!ids.includes(note.noteId as number)) throw new Error('AnkiConnect returned a note that was not asked for. Nothing was kept.');
        // Both supported AnkiConnect builds return the profile with each note; a note without one is not trusted.
        if (note.profile !== paired.profile) throw new ProfileMismatch(`AnkiConnect answered from the profile "${String(note.profile)}". Open the paired profile "${paired.profile}" or re-pair in Settings.`);
        byId.set(note.noteId as number, note);
      }
      const matches = batch.flatMap(card => {
        const note = byId.get(card.noteId);
        if (!note) { missing++; return []; }
        const lh = record(note.fields) ? note.fields.LH_ID : undefined;
        if (!record(lh) || lh.value !== card.id || typeof note.modelName !== 'string') { changed++; return []; }
        return [{ card, note, name: note.modelName }];
      });
      const names = [...new Set(matches.map(match => match.name))];
      const models = await this.retry(() => readNativeModels(reader, names), guard);
      if (names.length) await guard();
      for (const { card, note, name } of matches) {
        const spec = noteTypeFor(card), model = models.get(name);
        if (!nativeTypeMatches(model, spec) || (name !== spec.name && !hasOwnedStyle(model, spec))) { changed++; continue; }
        owned.push({ card, tags: note.tags as string[], cardIds: note.cards as number[] });
      }
    }

    // Cards of owned notes only.
    const wanted = [...new Set(owned.flatMap(o => o.cardIds))];
    const owners = new Map<number, Set<number>>();
    for (const o of owned) for (const id of o.cardIds) { const set = owners.get(id) ?? new Set<number>(); set.add(o.card.noteId); owners.set(id, set); }
    /** cardsInfo for one batch, keeping only cards that still exist and belong to the note that listed them. */
    const readCards = async (batch: number[]) => {
      const result = await this.retry(() => reader.call<Record<string, unknown>[]>('cardsInfo', { cards: batch }), guard);
      await guard();
      if (result.length !== batch.length) throw new Error('AnkiConnect returned an unexpected number of cards. Nothing was kept.');
      const found: (CardInfo & { note: number })[] = [];
      for (const info of result) {
        if (!Object.keys(info).length) continue;
        const cardId = info.cardId as number;
        if (!batch.includes(cardId)) throw new Error('AnkiConnect returned a card that was not asked for. Nothing was kept.');
        if (!owners.get(cardId)?.has(info.note as number)) continue;
        found.push({ cardId, note: info.note as number, lapses: info.lapses as number, reps: info.reps as number, queue: info.queue as number, deckName: info.deckName as string });
      }
      return found;
    };
    const infos = new Map<number, CardInfo & { note: number }>();
    for (const batch of chunks(wanted, REVIEW_BATCH.cards)) for (const info of await readCards(batch)) infos.set(info.cardId, info);

    // Review logs, only for cards cardsInfo just confirmed. A card deleted since then (notFound on
    // 26.10.11.0) drops out: re-read cardsInfo for the batch and retry history for what is left.
    const reviews = new Map<number, ReviewRow[]>();
    const confirmed = [...new Set(owned.flatMap(o => o.cardIds.filter(id => infos.has(id))))];
    for (let batch of chunks(confirmed, REVIEW_BATCH.reviews)) {
      let result: Record<string, ReviewRow[]>;
      try { result = await reader.call<Record<string, ReviewRow[]>>('getReviewsOfCards', { cards: batch }); }
      catch (error) {
        if (!retryable(error)) throw error;
        await guard();
        const refreshed = await readCards(batch);
        const still = new Set(refreshed.map(c => c.cardId));
        for (const id of batch) if (!still.has(id)) infos.delete(id);
        // Keep the newer lapse counts, so they match the history read next.
        for (const info of refreshed) infos.set(info.cardId, info);
        batch = batch.filter(id => still.has(id));
        result = batch.length ? await reader.call<Record<string, ReviewRow[]>>('getReviewsOfCards', { cards: batch }) : {};
      }
      await guard();
      for (const [id, rows] of Object.entries(result)) {
        const cardId = Number(id);
        if (!batch.includes(cardId)) throw new Error('AnkiConnect returned reviews for a card that was not asked for. Nothing was kept.');
        reviews.set(cardId, rows.map(r => ({ id: r.id, ease: r.ease, type: r.type })));
      }
    }

    const present = owned.map(o => ({ ...o, cards: o.cardIds.map(id => infos.get(id)).filter((c): c is CardInfo & { note: number } => !!c && c.note === o.card.noteId) }));
    const readable = present.filter(o => o.cards.length);
    missing += present.length - readable.length;

    const readings: NoteReading[] = readable.map(({ card, tags, cards }) => ({
      lhId: card.id, noteId: card.noteId, nodeId: card.nodeId, nodeName: card.nodeName, sessionId: card.sessionId, sessionName: card.sessionName,
      kind: card.kind, ...(card.format ? { format: card.format } : {}), front: card.front, back: card.back, tags,
      cards: cards.map(({ note: _note, ...info }) => info), reviews: cards.flatMap(c => reviews.get(c.cardId) ?? []),
    }));
    let graph: GraphInfo | null = null;
    // The graph only adds session links and "no longer in graph". A failed read leaves them out.
    try {
      const g = this.learning.graph();
      graph = { nodes: new Set(g.propositions.map(n => n.id)), nodeSessions: g.nodeSessions ?? {}, sessions: g.sessions ?? {} };
    } catch { graph = null; }
    const built = buildTopics(readings, now, graph);
    const links = built.topics.flatMap(t => t.sessions);
    const linksByTitle = new Map<string, string>();
    const sameTitle = links.some(({ id, name }) => {
      const title = name.trim().replace(/\s+/g, ' ') || 'Session';
      const previous = linksByTitle.get(title);
      linksByTitle.set(title, id);
      return previous !== undefined && previous !== id;
    });
    if (sameTitle) {
      // Only same-title links need local session dates to avoid relying on raw IDs.
      try {
        const dates = new Map(this.learning.listSessions?.().map(s => [s.id, s.createdAt]));
        for (const link of links) {
          const createdAt = dates.get(link.id);
          if (createdAt) link.createdAt = createdAt;
        }
      } catch { /* Session links still work without dates. */ }
    }
    this.active();
    const destination: Destination = { ...paired };
    return { checkedAt: now, destination, rules: REVIEW_RULES, topics: built.topics,
      counts: { sent: local.length, checked: readings.length, notReviewed: built.notReviewed, quietTopics: built.quietTopics, changed, missing } };
  }
}
