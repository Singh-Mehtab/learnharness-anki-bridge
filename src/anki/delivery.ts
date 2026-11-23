import { createHash, randomUUID } from 'node:crypto';
import { AnkiClient, AnkiError, normalizeUrl } from './client.ts';
import { noteFields, packageFingerprint } from './apkg.ts';
import { CLOZE_MODEL_NAME, MODEL_NAME, ensureNoteType, noteTypeFor, noteTypeInput, repairFields, updateStyling } from './note-type.ts';
import { clozeCardProblems } from '../writer/cloze.ts';
import { renderMarkdown } from './render.ts';
import { StateStore, sameDestination } from './state.ts';
import { expandTagTemplate, systemTags, validateTags } from './tags.ts';
import type { Card, CardKind, Destination, State } from './state.ts';
import { isStoredKind } from '../writer/types.ts';
import type { Generation, GenerationSettings } from '../generation/types.ts';

export interface PublicSnapshot {
  settings: { url: string; lastDeck: string; hasApiKey: boolean; tagTemplate: string; systemTags: boolean };
  destination: Destination | null;
  cards: (Card & { sourceStatement?: string; sourceChanged?: boolean; sourceMissing?: boolean; sourceUnavailable?: boolean })[];
  generationSettings: GenerationSettings;
  generations: Generation[];
  recoveryError?: string;
  generationRecoveryError?: string;
}
export interface SendResult extends PublicSnapshot {
  delivery: { added: string[]; found: string[]; skipped: string[]; failed: string[]; deck: string | null; tags: string[] };
}
export interface DraftInput {
  front: string; back: string; extra?: string; kind?: CardKind; format?: 'basic' | 'cloze';
  nodeId?: string; nodeName?: string; sessionId?: string; sessionName?: string; statementHash?: string;
}
/** FI-8: 'cloze' or undefined (basic). */
function formatInput(value: unknown): 'cloze' | undefined {
  if (value === undefined || value === 'basic') return undefined;
  if (value === 'cloze') return 'cloze';
  throw new Error('Invalid card format.');
}
/** Content checks for a hand-written or edited card. Cloze cards get the shared
 *  assembled check (C2-C8); basic cards keep the standalone render checks. */
function checkContent(card: { kind: string; format?: 'cloze'; front: string; back: string; extra: string }): void {
  if (card.format === 'cloze') {
    const problems = clozeCardProblems({ kind: card.kind as CardKind, format: 'cloze', front: card.front, back: card.back, extra: card.extra });
    if (problems.length) throw new Error(`Cloze card: ${problems.join('; ')}.`);
    return;
  }
  renderMarkdown(card.front); renderMarkdown(card.back); renderMarkdown(card.extra);
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


/** No Anki update/delete/scheduling operations. All delivery identities are durable before I/O. */
export class DeliveryService {
  private busy: Promise<unknown> | undefined;
  private readonly lifetime = new AbortController();
  private closed = false;
  private recoveryError?: string;
  private generationRecoveryError?: string;
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
  /** Hides the saved key, plus any key a request captured before the saved one changed. */
  private message(error: unknown, ...used: string[]): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const key of new Set([this.store.snapshot().settings.apiKey, ...used])) if (key) message = message.split(key).join('[API key hidden]');
    return message;
  }
  reportGenerationRecoveryError(error: unknown): void { this.generationRecoveryError = this.message(error); }
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
    // A pending-result warning lasts only as long as any result still needs saving.
    const pendingWarning = generations.some(g => g.tasks.some(t => t.resultPending))
      ? 'Stop writing until the finished result can be saved or the unavailable result is abandoned.' : undefined;
    const generationRecoveryError = [this.generationRecoveryError, pendingWarning].filter(Boolean).join(' ');
    return { generationSettings, generations, settings: { url: settings.url, lastDeck: settings.lastDeck, hasApiKey: !!settings.apiKey, tagTemplate: settings.tagTemplate ?? '', systemTags: settings.systemTags ?? true }, destination, cards: publicCards,
      ...(this.recoveryError ? { recoveryError: this.recoveryError } : {}),
      ...(generationRecoveryError ? { generationRecoveryError } : {}) };
  }
  private busyOwner: 'user' | 'background' | undefined;
  /** One writer fence. User calls fail fast on another user operation (no double sends),
   * but wait out short background generation commits rather than showing a busy error. */
  async exclusive<T>(operation: () => Promise<T>, background = false): Promise<T> {
    this.active();
    while (this.busy && (background || this.busyOwner === 'background')) { await this.busy.catch(() => undefined); this.active(); }
    if (this.busy) throw new Error('Busy. Wait for the current action to finish.');
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
    if (!state.destination || state.destination.url !== state.settings.url) throw new Error('Choose a profile for this address in settings first.');
    const profile = await client.call<unknown>('getActiveProfile');
    this.active();
    if (profile === null) throw new Error('Open a profile in Anki.');
    if (typeof profile !== 'string' || !profile) throw new Error('AnkiConnect returned an invalid active profile.');
    if (profile !== state.destination.profile) throw new Error(`Anki has a different profile open. Open "${state.destination.profile}" or choose the profile again in settings.`);
    return { url: state.settings.url, profile };
  }
  private async find(client: AnkiClient, card: Card, destination: Destination): Promise<number[]> {
    if (card.status === 'sending' && !sameDestination(card.destination, destination)) throw new Error('An unconfirmed send belongs to another profile or address. Switch back to it first.');
    await this.destination(client);
    const found = noteIds(await client.call('findNotes', { query: query(card.id) }));
    await this.destination(client);
    return found;
  }
  private async recordFound(id: string, found: number[], destination: Destination): Promise<void> {
    await this.patchCard(id, { status: 'sent', noteId: found[0], destination, existingNote: true, presence: 'present', lastError: found.length > 1 ? 'More than one Anki note has this delivery ID. No new note was added.' : undefined });
  }
  /** FI-8 (S22): a note found by LH_ID must be the card's kind of note. A basic
   *  package imported without Mark as imported leaves the card editable, so it can
   *  be switched to cloze and then find the old basic note. Use Anki's native type
   *  for renamed models; custom fields cannot reliably identify them. */
  private async formatConflict(client: AnkiClient, card: Card, found: number[]): Promise<boolean> {
    await this.destination(client);
    const notes = await client.call<unknown>('notesInfo', { notes: found });
    await this.destination(client);
    if (!Array.isArray(notes)) throw new Error('Invalid notesInfo response.');
    const fields = (n: unknown): object | undefined => typeof n === 'object' && n !== null && typeof (n as { fields?: unknown }).fields === 'object' && (n as { fields: object | null }).fields || undefined;
    const model = (n: unknown) => typeof n === 'object' && n !== null ? (n as { modelName?: unknown }).modelName : undefined;
    // Missing or mismatched metadata is not proof of a conflict: recovery must
    // remain unresolved until Anki provides reliable information (S10).
    if (notes.length !== found.length || notes.some((n, i) =>
      typeof n !== 'object' || n === null || (n as { noteId?: unknown }).noteId !== found[i] ||
      typeof model(n) !== 'string' || !model(n) || !fields(n) ||
      (fields(n) as Record<string, { value?: unknown }>).LH_ID?.value !== card.id)) {
      throw new Error('Cannot verify existing Anki note metadata. Check unconfirmed sends again.');
    }
    const types = new Map<string, number>([[MODEL_NAME, 0], [CLOZE_MODEL_NAME, 1]]);
    const names = notes.map(n => model(n) as string);
    const renamed = [...new Set(names.filter(name => !types.has(name)))];
    if (renamed.length) {
      const models = await client.call<unknown>('findModelsByName', { modelNames: renamed });
      await this.destination(client);
      if (Array.isArray(models)) for (const entry of models) {
        if (entry && renamed.includes(entry.name) && (entry.type === 0 || entry.type === 1)) types.set(entry.name, entry.type);
      }
      if (renamed.some(name => !types.has(name))) throw new Error('Cannot verify the existing Anki note type. Check its note type in Anki and try again.');
    }
    if (names.every(name => types.get(name) === (card.format === 'cloze' ? 1 : 0))) return false;
    const other = card.format === 'cloze' ? 'basic' : 'cloze';
    const message = `This card is already in Anki as a ${other} note. Delete that note in Anki or switch the card back to ${other}.`;
    await this.patchCard(card.id, { status: 'failed', lastError: message });
    return true;
  }
  private async recover(client: AnkiClient, destination: Destination): Promise<string[]> {
    const matched: string[] = [];
    for (const card of this.store.snapshot().cards.filter(c => c.status === 'sending')) {
      const found = await this.find(client, card, destination);
      // Recovery adopts through the same note type check as a send (S1, round 1).
      if (found.length && await this.formatConflict(client, card, found)) continue;
      if (found.length) { await this.recordFound(card.id, found, destination); matched.push(card.id); }
      else await this.patchCard(card.id, { status: 'failed', lastError: 'No note found for the interrupted send. You can retry this card.' });
    }
    this.recoveryError = undefined;
    return matched;
  }
  async activate(): Promise<void> {
    if (!this.store.snapshot().cards.some(c => c.status === 'sending')) return;
    try { await this.command('reconcile'); }
    catch (error) { this.recoveryError = this.message(error); }
  }
  async command(name: string, input: unknown = {}): Promise<unknown> {
    if (name === 'snapshot') return this.snapshot();
    // A read-only Anki query; holding the writer fence here would block approvals while Anki is slow or closed.
    if (name === 'connection') {
      this.active();
      // Settings can change while this runs outside the fence, so the request's own key is redacted too.
      const { url, apiKey } = this.store.snapshot().settings;
      try { return await new AnkiClient({ url, apiKey, timeoutMs: this.options.timeoutMs, signal: this.lifetime.signal }).connection(); }
      catch (error) { throw new Error(this.message(error, apiKey)); }
    }
    return this.exclusive(async () => {
      this.active();
      const value = data(input);
      if (name === 'settings') {
        const allowed = new Set(['url', 'apiKey', 'tagTemplate', 'systemTags']);
        if (Object.keys(value).some(k => !allowed.has(k))) throw new Error('Unsupported setting.');
        const current = this.store.snapshot().settings;
        if (value.tagTemplate !== undefined) {
          if (typeof value.tagTemplate !== 'string' || value.tagTemplate.length > 2000) throw new Error('Use a tag template shorter than 2,000 characters.');
          validateTags(expandTagTemplate(value.tagTemplate, 'Deck'));
        }
        if (value.systemTags !== undefined && typeof value.systemTags !== 'boolean') throw new Error('Invalid system tags setting.');
        const tagTemplate = value.tagTemplate as string | undefined, keepSystemTags = value.systemTags as boolean | undefined;
        if (value.url === undefined && value.apiKey === undefined) {
          await this.save(s => { if (tagTemplate !== undefined) s.settings.tagTemplate = tagTemplate; if (keepSystemTags !== undefined) s.settings.systemTags = keepSystemTags; });
          return this.snapshot();
        }
        const url = value.url === undefined ? current.url : normalizeUrl(requiredText(value.url, 'URL'));
        // A saved key belongs to its endpoint. Never forward it to a changed URL.
        const apiKey = optionalText(value.apiKey, 'API key', url === current.url ? current.apiKey : '');
        await this.save(s => {
          s.settings.url = url; s.settings.apiKey = apiKey;
          if (tagTemplate !== undefined) s.settings.tagTemplate = tagTemplate;
          if (keepSystemTags !== undefined) s.settings.systemTags = keepSystemTags;
        });
      } else if (name === 'pair') {
        if (value.confirmed !== true) throw new Error('Confirm the destination change before pairing.');
        // Pairing holds the writer lock; skip the optional tag lookup so it can't stall other actions.
        const connection = await this.client().connection({ tags: false });
        this.active();
        if (!connection.profile) throw new Error('Open a profile in Anki before pairing.');
        const destination = { url: this.store.snapshot().settings.url, profile: connection.profile };
        if (value.expectedDestination !== undefined) expectDestination(value.expectedDestination, destination, 'Destination changed while confirming. Test the connection and confirm again.');
        const unresolved = this.store.snapshot().cards.filter(c => c.status === 'sending');
        if (unresolved.some(c => !sameDestination(c.destination, destination))) throw new Error('Check unconfirmed sends in their original profile and address before switching.');
        await this.save(s => { s.destination = destination; });
        this.recoveryError = undefined;
      } else if (name === 'draft') {
        const front = requiredText(value.front, 'Front');
        const back = requiredText(value.back, 'Back');
        const extra = optionalText(value.extra, 'Extra');
        const kind = value.kind ?? 'fact';
        if (!isStoredKind(kind)) throw new Error('Invalid card kind.');
        const format = formatInput(value.format);
        // Validate rendering before a card can be approved or sent.
        checkContent({ kind, format, front, back, extra });
        const id = randomUUID();
        const card: Card = { id, front, back, extra, kind, ...(format ? { format } : {}), status: 'draft',
          nodeId: optionalText(value.nodeId, 'Node ID', `manual:${id}`),
          nodeName: optionalText(value.nodeName, 'Node name', 'Hand-written card'),
          sessionId: optionalText(value.sessionId, 'Session ID', 'manual'),
          sessionName: optionalText(value.sessionName, 'Session name', 'Manual'),
          statementHash: optionalText(value.statementHash, 'Statement hash', createHash('sha256').update(front + '\0' + back).digest('hex')) };
        await this.save(s => { s.cards.push(card); });
      } else if (name === 'markImported' || name === 'unmarkImported') {
        const ids = idsInput(value.ids);
        const current = this.store.snapshot().cards;
        const cards = ids.map(id => { const card = current.find(c => c.id === id); if (!card) throw new Error('Card not found.'); return card; });
        const markId = name === 'markImported' ? randomUUID() : requiredText(value.markId, 'Import mark ID');
        let durabilityWarning: string | undefined;
        const packageSave = async (mutator: (state: State) => void) => {
          let committed = false;
          const unsubscribe = this.store.onCommit(() => { committed = true; });
          try { await this.save(mutator); }
          catch (error) { if (!committed) throw error; durabilityWarning = this.message(error); }
          finally { unsubscribe(); }
        };
        if (name === 'markImported') {
          const deck = requiredText(value.deck, 'Deck').trim();
          if (deck.length > 250 || /[\r\n]/.test(deck)) throw new Error('Use a one-line deck name under 251 characters.');
          if (cards.some(c => !['approved', 'failed'].includes(c.status) || c.noteId !== undefined)) throw new Error('Only approved or failed unsent cards can be marked as imported.');
          if (!Array.isArray(value.fingerprints) || value.fingerprints.length !== cards.length || cards.some((c, i) => packageFingerprint(c) !== (value.fingerprints as unknown[])[i])) throw new Error('Cards changed since this package was downloaded. Download a new package.');
          await packageSave(s => { for (const card of s.cards) if (ids.includes(card.id)) {
            card.importPrevious = { status: card.status as 'approved' | 'failed', deck: card.deck, destination: card.destination, presence: card.presence, lastError: card.lastError };
            card.status = 'imported'; card.deck = deck; card.importMarkId = markId;
            delete card.noteId; delete card.destination; delete card.existingNote; delete card.presence; delete card.lastError;
          } });
        } else {
          if (cards.some(c => c.status !== 'imported')) throw new Error('Only imported cards can be unmarked.');
          if (cards.some(c => c.importMarkId !== markId)) throw new Error('This import mark has changed. Refresh the cards.');
          await packageSave(s => { for (const card of s.cards) if (ids.includes(card.id)) {
            const previous = card.importPrevious ?? { status: 'approved' as const };
            card.status = previous.status;
            delete card.deck; delete card.destination; delete card.presence; delete card.lastError; delete card.importPrevious; delete card.importMarkId;
            if (previous.deck !== undefined) card.deck = previous.deck;
            if (previous.destination !== undefined) card.destination = previous.destination;
            if (previous.presence !== undefined) card.presence = previous.presence;
            if (previous.lastError !== undefined) card.lastError = previous.lastError;
          } });
        }
        return { ...this.snapshot(), ...(name === 'markImported' ? { importMarkId: markId } : {}), ...(durabilityWarning ? { durabilityWarning } : {}) };
      } else if (name === 'edit') {
        const card = this.card(value.id);
        if (card.status === 'imported') throw new Error('This card was imported and cannot be edited here. Edit it in Anki.');
        if (card.status === 'sending') throw new Error('Cards with an unconfirmed send cannot be edited. Check unconfirmed sends first.');
        if (card.status === 'dropped') throw new Error('Dropped cards cannot be edited.');
        if (card.status === 'sent' || card.noteId !== undefined) throw new Error('This card was sent and cannot be edited here. Edit it in Anki.');
        const front = requiredText(value.front, 'Front'), back = requiredText(value.back, 'Back'), extra = optionalText(value.extra, 'Extra');
        // FI-8: an edit may switch an unsent draft between basic and cloze. Format and
        // fields change in one write. An edit without format keeps the card's format.
        const format = value.format === undefined ? card.format : formatInput(value.format);
        checkContent({ kind: card.kind, format, front, back, extra });
        await this.save(state => {
          const index = state.cards.findIndex(c => c.id === card.id);
          if (index < 0) throw new Error('Card not found.');
          const next: Card = { ...state.cards[index], front, back, extra, status: 'draft' };
          delete next.lastError; delete next.format;
          if (format) next.format = format;
          state.cards[index] = next;
        });
      } else if (name === 'drop') {
        const cards = idsInput(value.ids).map(id => this.card(id));
        if (cards.some(c => c.status === 'imported')) throw new Error('This card was imported and cannot be edited here. Edit it in Anki.');
        if (cards.some(c => c.noteId || ['sending', 'sent', 'dropped'].includes(c.status))) throw new Error('Only unsent editable cards can be dropped.');
        await this.save(s => { for (const card of s.cards) if (cards.some(c => c.id === card.id)) card.status = 'dropped'; });
      } else if (name === 'approve') {
        const cards = idsInput(value.ids).map(id => this.card(id));
        if (cards.some(c => c.status === 'imported')) throw new Error('This card was imported and cannot be edited here. Edit it in Anki.');
        if (cards.some(c => c.noteId || ['sending', 'sent', 'dropped'].includes(c.status))) throw new Error('Only unsent drafts or failed cards can be approved.');
        await this.save(s => { for (const card of s.cards) if (cards.some(c => c.id === card.id)) card.status = 'approved'; });
      } else if (name === 'send') {
        const ids = idsInput(value.ids);
        const deck = requiredText(value.deck, 'Deck').trim();
        if (deck.length > 250 || /[\r\n]/.test(deck)) throw new Error('Use a one-line deck name under 251 characters.');
        const settings = this.store.snapshot().settings;
        const chosenTags = validateTags(value.tags === undefined ? expandTagTemplate(settings.tagTemplate ?? '', deck) : value.tags);
        const current = this.store.snapshot().cards;
        for (const id of ids) {
          const card = current.find(c => c.id === id);
          if (!card) throw new Error('Card not found.');
          if (card.status === 'imported') throw new Error('Imported cards cannot be sent again.');
        }
        // The settings dialog can re-pair while a review view still shows the old destination.
        const paired = this.store.snapshot().destination;
        if (paired) expectDestination(value.expectedDestination, paired, 'Paired destination changed. Check it and send again.');
        const client = this.client(), destination = await this.destination(client);
        // Reconcile all interrupted cards first, never against another collection.
        const found = (await this.recover(client, destination)).filter(id => ids.includes(id));
        const cards = ids.map(id => this.card(id)).filter(c => !c.noteId && c.status !== 'sent');
        if (cards.some(c => !['approved', 'failed'].includes(c.status))) throw new Error('Approve every selected draft before sending.');
        const skipped = ids.filter(id => !found.includes(id) && !cards.some(c => c.id === id));
        const added: string[] = [], failed: string[] = [], tags = new Set<string>();
        let deckReady = false;
        for (const selected of cards) {
          this.active();
          const card = this.card(selected.id);
          // A retry always looks up its durable UUID before any new addNote.
          const existing = await this.find(client, card, destination);
          if (existing.length) {
            if (await this.formatConflict(client, card, existing)) { failed.push(card.id); continue; }
            await this.recordFound(card.id, existing, destination); found.push(card.id); continue;
          }
          await this.destination(client);
          // Model fields may have been edited in Anki while this batch was running.
          const spec = noteTypeFor(card);
          await ensureNoteType(client, spec);
          if (!deckReady) {
            await this.destination(client);
            await client.call('createDeck', { deck });
            await this.save(s => { s.settings.lastDeck = deck; });
            deckReady = true;
          }
          const noteTags = [...new Set([...chosenTags, ...(settings.systemTags === false ? [] : systemTags(card.kind, card.format))])];
          const fields = noteFields(card);
          await this.patchCard(card.id, { status: 'sending', deck, destination, lastError: undefined });
          let result: unknown;
          try {
            await this.destination(client);
            result = await client.call('addNote', { note: { deckName: deck, modelName: spec.name, fields,
              tags: noteTags,
              options: { allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: { deckName: deck, checkChildren: false, checkAllModels: false } } } });
          } catch (error) {
            // API rejections are definite, but still look up the UUID before failing.
            if (error instanceof AnkiError && error.kind === 'api') {
              const existing = await this.find(client, this.card(card.id), destination);
              if (existing.length && await this.formatConflict(client, this.card(card.id), existing)) failed.push(card.id);
              else if (existing.length) { await this.recordFound(card.id, existing, destination); found.push(card.id); }
              else { await this.patchCard(card.id, { status: 'failed', lastError: this.message(error) }); failed.push(card.id); }
              continue;
            }
            await this.patchCard(card.id, { lastError: `Send unconfirmed: ${this.message(error)}. Use Check unconfirmed sends before retrying.` });
            this.recoveryError = this.message(error);
            throw error;
          }
          if (!Number.isSafeInteger(result) || (result as number) <= 0) {
            await this.patchCard(card.id, { lastError: 'Invalid AnkiConnect result. Use Check unconfirmed sends before retrying.' });
            throw new Error('Unconfirmed send. Use Check unconfirmed sends before retrying.');
          }
          // Profile changes during a call leave the UUID unresolved rather than asserting a destination.
          await this.destination(client);
          await this.patchCard(card.id, { status: 'sent', noteId: result as number, presence: 'present' });
          added.push(card.id);
          for (const tag of noteTags) tags.add(tag);
        }
        return { ...this.snapshot(), delivery: { added, found, skipped, failed, deck: added.length ? deck : null, tags: [...tags] } } satisfies SendResult;
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
        const matches = await client.call<unknown>('guiBrowse', { query: cards.map(c => query(c.id)).join(' OR ') });
        await this.destination(client);
        if (!Array.isArray(matches) || matches.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('AnkiConnect returned an invalid browser result.');
        if (!matches.length) throw new Error('No matching cards found in the paired Anki profile.');
        return;
      } else if (name === 'repairFields' || name === 'updateStyling') {
        if (name === 'updateStyling' && value.confirmed !== true) throw new Error('Confirm that Anki-side styling and template edits will be replaced.');
        // Same guard as send: a stale view must not change another profile's note type.
        const paired = this.store.snapshot().destination;
        if (paired) expectDestination(value.expectedDestination, paired, 'Paired destination changed. Check it and confirm again.');
        const client = this.client();
        await this.destination(client);
        const spec = noteTypeInput(value.noteType);
        if (name === 'repairFields') await repairFields(client, spec); else await updateStyling(client, spec);
      } else throw new Error('Unknown Anki Bridge operation.');
      return this.snapshot();
    });
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.lifetime.abort();
      this.options.signal?.removeEventListener('abort', this.abort);
    }
    await this.busy?.catch(() => undefined);
    await this.store.close();
  }
}
