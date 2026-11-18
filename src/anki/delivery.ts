import { createHash, randomUUID } from 'node:crypto';
import { AnkiClient, AnkiError, normalizeUrl } from './client.ts';
import { ensureNoteType, MODEL_NAME, repairFields, updateStyling } from './note-type.ts';
import { renderMarkdown } from './render.ts';
import { StateStore, sameDestination } from './state.ts';
import type { Card, CardKind, Destination, State } from './state.ts';
import type { Generation, GenerationSettings } from '../generation/types.ts';

export interface PublicSnapshot {
  settings: { url: string; lastDeck: string; hasApiKey: boolean };
  destination: Destination | null;
  cards: (Card & { sourceStatement?: string; sourceChanged?: boolean; sourceMissing?: boolean; sourceUnavailable?: boolean })[];
  generationSettings: GenerationSettings;
  generations: Generation[];
  recoveryError?: string;
}
export interface DraftInput {
  front: string; back: string; extra?: string; kind?: CardKind;
  nodeId?: string; nodeName?: string; sessionId?: string; sessionName?: string; statementHash?: string;
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must not be blank.`);
  if (value.length > 100_000 || value.includes('\0')) throw new Error(`${name} is too large or contains a null character.`);
  return value;
}
function optionalText(value: unknown, name: string, fallback = ''): string {
  return value === undefined ? fallback : value === '' ? '' : requiredText(value, name);
}
function expectDestination(value: unknown, destination: Destination, message: string): void {
  const expected = value === null || value === undefined ? undefined : data(value);
  if (!expected || typeof expected.url !== 'string' || typeof expected.profile !== 'string' || normalizeUrl(expected.url) !== destination.url || expected.profile !== destination.profile) throw new Error(message);
}
function idsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) throw new Error('Choose one or more distinct cards.');
  return value;
}
function noteIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('AnkiConnect returned invalid note IDs. Delivery remains unresolved.');
  return value;
}
function data(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an input object.');
  return value as Record<string, unknown>;
}
// Not limited to the note type name, so a renamed note type cannot hide an earlier add.
const query = (id: string) => `"LH_ID:${id}"`;
const htmlText = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const kinds: CardKind[] = ['recall', 'why', 'compose', 'discriminate'];
const slug = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'manual';

/** No Anki update/delete/scheduling operations. All delivery identities are durable before I/O. */
export class DeliveryService {
  private busy: Promise<unknown> | undefined;
  private readonly lifetime = new AbortController();
  private closed = false;
  private recoveryError?: string;
  sourceStatements?: () => Map<string, string>;
  private readonly store: StateStore;
  private readonly options: { signal?: AbortSignal; timeoutMs?: number };
  constructor(store: StateStore, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    this.store = store; this.options = options;
    if (options.signal?.aborted) this.lifetime.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private abort = () => this.lifetime.abort(this.options.signal?.reason);
  private active(): void {
    if (this.closed || this.lifetime.signal.aborted) throw new Error('Anki Bridge is disabled.');
  }
  private client(): AnkiClient {
    const { url, apiKey } = this.store.snapshot().settings;
    return new AnkiClient({ url, apiKey, timeoutMs: this.options.timeoutMs, signal: this.lifetime.signal });
  }
  private message(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const key = this.store.snapshot().settings.apiKey;
    return key ? message.split(key).join('[API key hidden]') : message;
  }
  reportRecoveryError(error: unknown): void { this.recoveryError = this.message(error); }
  snapshot(includeSource = true): PublicSnapshot {
    const { settings, destination, cards, generationSettings, generations } = this.store.snapshot();
    let current: Map<string, string> | undefined, sourceUnavailable = false;
    // Source warnings are advisory. A graph read must not make a saved write look like a failure.
    if (includeSource && cards.some(card => card.sourceSnapshot)) {
      try { current = this.sourceStatements?.(); } catch { sourceUnavailable = true; }
    }
    const publicCards = cards.map(card => card.sourceSnapshot ? { ...card, sourceStatement: card.sourceSnapshot.statement,
      ...(sourceUnavailable ? { sourceUnavailable } : {
        sourceMissing: current ? !current.has(card.nodeId) : false,
        sourceChanged: current?.has(card.nodeId) ? current.get(card.nodeId) !== card.sourceSnapshot.statement : false,
      }) } : card);
    return { generationSettings, generations, settings: { url: settings.url, lastDeck: settings.lastDeck, hasApiKey: !!settings.apiKey }, destination, cards: publicCards, ...(this.recoveryError ? { recoveryError: this.recoveryError } : {}) };
  }
  private busyOwner: 'user' | 'background' | undefined;
  /** One writer fence. User calls fail fast on another user operation (no double sends),
   * but wait out short background generation commits rather than showing a busy error. */
  async exclusive<T>(operation: () => Promise<T>, background = false): Promise<T> {
    this.active();
    while (this.busy && (background || this.busyOwner === 'background')) { await this.busy.catch(() => undefined); this.active(); }
    if (this.busy) throw new Error('Anki Bridge is busy. Wait for the current operation to finish.');
    // Set the fence before invoking operation, even if it throws synchronously.
    const pending = Promise.resolve().then(operation);
    this.busy = pending; this.busyOwner = background ? 'background' : 'user';
    try { return await pending; }
    catch (error) { throw new Error(this.message(error)); }
    finally { if (this.busy === pending) { this.busy = undefined; this.busyOwner = undefined; } }
  }
  /** Call only inside exclusive: delivery and generation share this one writer fence. */
  async save(mutator: (state: State) => void): Promise<void> {
    this.active();
    const state = this.store.snapshot();
    mutator(state);
    await this.store.replace(state);
  }
  private card(id: unknown): Card {
    if (typeof id !== 'string') throw new Error('Invalid card ID.');
    const card = this.store.snapshot().cards.find(c => c.id === id);
    if (!card) throw new Error('Card not found.');
    return card;
  }
  private async patchCard(id: string, patch: Partial<Card>): Promise<void> {
    await this.save(state => { const index = state.cards.findIndex(c => c.id === id); if (index < 0) throw new Error('Card not found.'); state.cards[index] = { ...state.cards[index], ...patch }; });
  }
  private async destination(client: AnkiClient): Promise<Destination> {
    this.active();
    const state = this.store.snapshot();
    if (!state.destination || state.destination.url !== state.settings.url) throw new Error('Pair Anki Bridge with this URL and profile before sending or reconciling.');
    const profile = await client.call<unknown>('getActiveProfile');
    this.active();
    if (profile === null) throw new Error('Open a profile in Anki. Sending and reconciliation are blocked.');
    if (typeof profile !== 'string' || !profile) throw new Error('AnkiConnect returned an invalid active profile.');
    if (profile !== state.destination.profile) throw new Error(`Destination mismatch. Open the paired Anki profile "${state.destination.profile}" or explicitly re-pair in settings.`);
    return { url: state.settings.url, profile };
  }
  private async find(client: AnkiClient, card: Card, destination: Destination): Promise<number[]> {
    if (card.status === 'sending' && !sameDestination(card.destination, destination)) throw new Error('An unresolved delivery belongs to another destination. Reconnect and pair with its original URL and profile first.');
    await this.destination(client);
    const found = noteIds(await client.call('findNotes', { query: query(card.id) }));
    await this.destination(client);
    return found;
  }
  private async recordFound(id: string, found: number[], destination: Destination, deck?: string): Promise<void> {
    await this.patchCard(id, { status: 'sent', noteId: found[0], destination, ...(deck ? { deck } : {}), presence: 'present', lastError: found.length > 1 ? 'More than one Anki note has this delivery ID. No new note was added.' : undefined });
  }
  private async recover(client: AnkiClient, destination: Destination): Promise<void> {
    for (const card of this.store.snapshot().cards.filter(c => c.status === 'sending')) {
      const found = await this.find(client, card, destination);
      if (found.length) await this.recordFound(card.id, found, destination);
      else await this.patchCard(card.id, { status: 'failed', lastError: 'No note found for the interrupted delivery. You may retry this approved card.' });
    }
    this.recoveryError = undefined;
  }
  async activate(): Promise<void> {
    if (!this.store.snapshot().cards.some(c => c.status === 'sending')) return;
    try { await this.command('reconcile'); }
    catch (error) { this.recoveryError = this.message(error); }
  }
  async command(name: string, input: unknown = {}): Promise<unknown> {
    if (name === 'snapshot') return this.snapshot();
    return this.exclusive(async () => {
      this.active();
      const value = data(input);
      if (name === 'settings') {
        const allowed = new Set(['url', 'apiKey']);
        if (Object.keys(value).some(k => !allowed.has(k))) throw new Error('Unsupported setting.');
        const current = this.store.snapshot().settings;
        const url = value.url === undefined ? current.url : normalizeUrl(requiredText(value.url, 'URL'));
        // A saved key belongs to its endpoint. Never forward it to a changed URL.
        const apiKey = optionalText(value.apiKey, 'API key', url === current.url ? current.apiKey : '');
        await this.save(s => { s.settings.url = url; s.settings.apiKey = apiKey; });
      } else if (name === 'connection') {
        return this.client().connection();
      } else if (name === 'pair') {
        if (value.confirmed !== true) throw new Error('Confirm the destination change before pairing.');
        const connection = await this.client().connection();
        this.active();
        if (!connection.profile) throw new Error('Open a profile in Anki before pairing.');
        const destination = { url: this.store.snapshot().settings.url, profile: connection.profile };
        if (value.expectedDestination !== undefined) expectDestination(value.expectedDestination, destination, 'The destination changed while pairing was being confirmed. Test the connection and confirm again.');
        const unresolved = this.store.snapshot().cards.filter(c => c.status === 'sending');
        if (unresolved.some(c => !sameDestination(c.destination, destination))) throw new Error('Resolve interrupted deliveries in their original Anki profile and URL before re-pairing.');
        await this.save(s => { s.destination = destination; });
        this.recoveryError = undefined;
      } else if (name === 'draft') {
        const front = requiredText(value.front, 'Front');
        const back = requiredText(value.back, 'Back');
        const extra = optionalText(value.extra, 'Extra');
        // Validate rendering before a card can be approved or sent.
        renderMarkdown(front); renderMarkdown(back); renderMarkdown(extra);
        const kind = value.kind ?? 'recall';
        if (!kinds.includes(kind as CardKind)) throw new Error('Invalid card kind.');
        const id = randomUUID();
        const card: Card = { id, front, back, extra, kind: kind as CardKind, status: 'draft',
          nodeId: optionalText(value.nodeId, 'Node ID', `manual:${id}`),
          nodeName: optionalText(value.nodeName, 'Node name', 'Hand-written card'),
          sessionId: optionalText(value.sessionId, 'Session ID', 'manual'),
          sessionName: optionalText(value.sessionName, 'Session name', 'Manual'),
          statementHash: optionalText(value.statementHash, 'Statement hash', createHash('sha256').update(front + '\0' + back).digest('hex')) };
        await this.save(s => { s.cards.push(card); });
      } else if (name === 'edit') {
        const card = this.card(value.id);
        if (card.noteId || ['sent', 'sending', 'dropped'].includes(card.status)) throw new Error('Sent or unresolved cards cannot be edited by Anki Bridge. Edit sent notes in Anki.');
        const front = requiredText(value.front, 'Front'), back = requiredText(value.back, 'Back'), extra = optionalText(value.extra, 'Extra');
        renderMarkdown(front); renderMarkdown(back); renderMarkdown(extra);
        await this.patchCard(card.id, { front, back, extra, status: 'draft', lastError: undefined });
      } else if (name === 'drop') {
        const cards = idsInput(value.ids).map(id => this.card(id));
        if (cards.some(c => c.noteId || ['sending', 'sent', 'dropped'].includes(c.status))) throw new Error('Only unsent editable cards can be dropped.');
        await this.save(s => { for (const card of s.cards) if (cards.some(c => c.id === card.id)) card.status = 'dropped'; });
      } else if (name === 'approve') {
        const cards = idsInput(value.ids).map(id => this.card(id));
        if (cards.some(c => c.noteId || ['sending', 'sent', 'dropped'].includes(c.status))) throw new Error('Only unsent drafts or failed cards can be approved.');
        await this.save(s => { for (const card of s.cards) if (cards.some(c => c.id === card.id)) card.status = 'approved'; });
      } else if (name === 'send') {
        const ids = idsInput(value.ids);
        const deck = requiredText(value.deck, 'Deck').trim();
        if (deck.length > 250 || /[\r\n]/.test(deck)) throw new Error('Use a deck name shorter than 251 characters on one line.');
        for (const id of ids) this.card(id);
        // The settings dialog can re-pair while a review view still shows the old destination.
        const paired = this.store.snapshot().destination;
        if (paired) expectDestination(value.expectedDestination, paired, 'The paired Anki destination changed. Check the destination shown and send again.');
        const client = this.client(), destination = await this.destination(client);
        // Reconcile all interrupted cards first, never against another collection.
        await this.recover(client, destination);
        const cards = ids.map(id => this.card(id)).filter(c => !c.noteId && c.status !== 'sent');
        if (cards.some(c => !['approved', 'failed'].includes(c.status))) throw new Error('Approve every selected draft before sending.');
        if (!cards.length) return this.snapshot();
        await this.destination(client);
        await ensureNoteType(client);
        await this.destination(client);
        await client.call('createDeck', { deck });
        await this.save(s => { s.settings.lastDeck = deck; });
        for (const selected of cards) {
          this.active();
          const card = this.card(selected.id);
          // A retry always looks up its durable UUID before any new addNote.
          const found = await this.find(client, card, destination);
          if (found.length) { await this.recordFound(card.id, found, destination, card.deck ?? deck); continue; }
          await this.destination(client);
          // Model fields may have been edited in Anki while this batch was running.
          await ensureNoteType(client);
          const fields = {
            Front: renderMarkdown(card.front), Back: renderMarkdown(card.back), Extra: renderMarkdown(card.extra),
            Source: htmlText(`${card.sessionName} / ${card.nodeName}`), LH_ID: card.id, LH_Node: htmlText(card.nodeId),
          };
          await this.patchCard(card.id, { status: 'sending', deck, destination, lastError: undefined });
          let result: unknown;
          try {
            await this.destination(client);
            result = await client.call('addNote', { note: { deckName: deck, modelName: MODEL_NAME, fields,
              tags: ['learnharness', `learnharness::kind::${card.kind}`, `learnharness::session::${slug(card.sessionName)}`],
              options: { allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: { deckName: deck, checkChildren: false, checkAllModels: false } } } });
          } catch (error) {
            // API rejections are definite, but still look up the UUID before failing.
            if (error instanceof AnkiError && error.kind === 'api') {
              const existing = await this.find(client, this.card(card.id), destination);
              if (existing.length) await this.recordFound(card.id, existing, destination);
              else await this.patchCard(card.id, { status: 'failed', lastError: this.message(error) });
              continue;
            }
            await this.patchCard(card.id, { lastError: `Delivery outcome is uncertain: ${this.message(error)}. Reconcile before retrying.` });
            this.recoveryError = this.message(error);
            throw error;
          }
          if (!Number.isSafeInteger(result) || (result as number) <= 0) {
            await this.patchCard(card.id, { lastError: 'AnkiConnect returned an invalid addNote result. Reconcile before retrying.' });
            throw new Error('Uncertain addNote result. Reconcile before retrying.');
          }
          // Profile changes during a call leave the UUID unresolved rather than asserting a destination.
          await this.destination(client);
          await this.patchCard(card.id, { status: 'sent', noteId: result as number, presence: 'present' });
        }
      } else if (name === 'reconcile') {
        const client = this.client();
        await this.recover(client, await this.destination(client));
      } else if (name === 'presence') {
        const client = this.client(), destination = await this.destination(client);
        const cards = this.store.snapshot().cards.filter(c => c.noteId && sameDestination(c.destination, destination));
        for (const card of cards) {
          await this.destination(client);
          const result = await client.call<unknown>('notesInfo', { notes: [card.noteId] });
          await this.destination(client);
          if (!Array.isArray(result) || result.length > 1 || result.length === 1 && (typeof result[0] !== 'object' || result[0] === null)) throw new Error('Invalid notesInfo response.');
          const note = result[0] as Record<string, unknown> | undefined;
          if (note && Object.keys(note).length && note.noteId !== card.noteId) throw new Error('notesInfo returned an unexpected note.');
          await this.patchCard(card.id, { presence: note && note.noteId === card.noteId ? 'present' : 'deleted' });
        }
      } else if (name === 'show') {
        const cards = idsInput(value.ids).map(id => this.card(id));
        const client = this.client(), destination = await this.destination(client);
        if (cards.some(c => !c.noteId || !sameDestination(c.destination, destination))) throw new Error('Only notes sent to the paired destination can be shown.');
        await client.call('guiBrowse', { query: cards.map(c => `"LH_ID:${c.id}"`).join(' OR ') });
        return;
      } else if (name === 'repairFields' || name === 'updateStyling') {
        if (name === 'updateStyling' && value.confirmed !== true) throw new Error('Confirm that Anki-side styling and template edits will be replaced.');
        // Same guard as send: a stale view must not change another profile's note type.
        const paired = this.store.snapshot().destination;
        if (paired) expectDestination(value.expectedDestination, paired, 'The paired Anki destination changed. Check the destination shown and confirm again.');
        const client = this.client();
        await this.destination(client);
        if (name === 'repairFields') await repairFields(client); else await updateStyling(client);
      } else throw new Error('Unknown Anki Bridge operation.');
      return this.snapshot();
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    await this.busy?.catch(() => undefined);
    await this.store.close();
  }
}
