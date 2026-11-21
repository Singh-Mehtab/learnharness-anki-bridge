import { randomUUID } from 'node:crypto';
import fs, { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultGenerationSettings, fromV072Settings, validateGenerations, validLegacyGenerationSettings, validSource, validV072GenerationSettings } from '../generation/types.ts';
import type { Generation, GenerationSettings, SourceSnapshot } from '../generation/types.ts';
import { DEFAULT_KINDS, isStoredKind } from '../writer/types.ts';
import type { StoredCardKind } from '../writer/types.ts';
import { validateFlags } from '../session/flow.ts';
import type { Flag } from '../session/flow.ts';
import { validateDismissals } from '../coverage/flow.ts';
import type { Dismissal } from '../coverage/flow.ts';

export interface Destination { url: string; profile: string }
export type CardStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'imported' | 'failed' | 'dropped';
export type CardKind = StoredCardKind;
export interface Card {
  id: string;
  nodeId: string;
  statementHash: string;
  sessionId: string;
  nodeName: string;
  sessionName: string;
  kind: CardKind;
  front: string;
  back: string;
  extra: string;
  status: CardStatus;
  deck?: string;
  noteId?: number;
  /** Found by delivery ID; the requested/attempted deck is not proof of the actual deck. */
  existingNote?: true;
  destination?: Destination;
  lastError?: string;
  presence?: 'present' | 'deleted' | 'unknown';
  /** Previous unsent state, retained solely for undoing an imported mark. */
  importPrevious?: { status: 'approved' | 'failed'; deck?: string; destination?: Destination; lastError?: string; presence?: 'present' | 'deleted' | 'unknown' };
  importMarkId?: string;
  sourceSnapshot?: SourceSnapshot;
  generationId?: string;
  requestId?: string;
}
export interface State {
  schemaVersion: 8;
  generationSettings: GenerationSettings;
  generations: Generation[];
  flags: Flag[];
  dismissals: Dismissal[];
  /** tagTemplate and systemTags arrived in 0.7.0; older files omit them. */
  settings: { url: string; apiKey: string; lastDeck: string; tagTemplate?: string; systemTags?: boolean };
  destination: Destination | null;
  cards: Card[];
}
export const initialState = (): State => ({
  schemaVersion: 8,
  generationSettings: defaultGenerationSettings(),
  generations: [],
  flags: [],
  dismissals: [],
  settings: { url: 'http://127.0.0.1:8765/', apiKey: '', lastDeck: '' },
  destination: null,
  cards: [],
});
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
export { sameDestination } from './destination.ts';
function destination(v: unknown): v is Destination {
  return object(v) && text(v.url) && !!v.url && text(v.profile) && !!v.profile;
}
export function validateState(value: unknown): asserts value is State {
  validateStateFormat(value, 8);
}
function validateStateFormat(value: unknown, version: 6 | 7 | 8): void {
  if (!object(value) || value.schemaVersion !== version) throw new Error('Unsupported state format. Keep state.json and use a compatible Anki Bridge version.');
  validateGenerations(value.generationSettings, value.generations);
  validateFlags(value.flags);
  validateDismissals(value.dismissals);
  const settings = value.settings;
  if (!object(settings) || !['url', 'apiKey', 'lastDeck'].every(k => text(settings[k])) || settings.tagTemplate !== undefined && !text(settings.tagTemplate) || settings.systemTags !== undefined && typeof settings.systemTags !== 'boolean' || !(value.destination === null || destination(value.destination)) || !Array.isArray(value.cards)) throw new Error('Invalid Anki Bridge state.');
  const ids = new Set<string>();
  for (const card of value.cards) {
    if (!object(card) || !['id', 'nodeId', 'statementHash', 'sessionId', 'nodeName', 'sessionName', 'front', 'back', 'extra'].every(k => text(card[k])) || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(card.id as string) || ids.has(card.id as string) || !isStoredKind(card.kind) || !(version === 8 ? ['draft', 'approved', 'sending', 'sent', 'imported', 'failed', 'dropped'] : ['draft', 'approved', 'sending', 'sent', 'failed', 'dropped']).includes(card.status as string)) throw new Error('Invalid card state.');
    ids.add(card.id as string);
    if (card.sourceSnapshot !== undefined && !validSource(card.sourceSnapshot) || card.generationId !== undefined && !text(card.generationId) || card.requestId !== undefined && !text(card.requestId)) throw new Error('Invalid generation card metadata.');
    if (card.destination !== undefined && !destination(card.destination)) throw new Error('Invalid card destination.');
    if (card.noteId !== undefined && (!Number.isSafeInteger(card.noteId) || (card.noteId as number) <= 0)) throw new Error('Invalid Anki note ID.');
    const deckMayBeUnknown = version >= 7 && card.status === 'sent' && card.existingNote === true;
    if (['sent', 'sending'].includes(card.status as string) && (!destination(card.destination) || (!deckMayBeUnknown && (!text(card.deck) || !card.deck)))) throw new Error('Missing delivery destination or deck.');
    if (card.existingNote !== undefined && (card.existingNote !== true || card.status !== 'sent')) throw new Error('Invalid existing-note metadata.');
    if (card.status === 'imported' && (!text(card.deck) || !card.deck.trim() || card.noteId !== undefined || card.destination !== undefined || card.existingNote !== undefined || card.presence !== undefined)) throw new Error('Invalid imported card metadata.');
    if (card.importMarkId !== undefined && (version !== 8 || card.status !== 'imported' || !text(card.importMarkId) || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(card.importMarkId))) throw new Error('Invalid import mark ID.');
    if (card.importPrevious !== undefined) {
      const previous = card.importPrevious;
      if (version !== 8 || card.status !== 'imported' || !object(previous) || !['approved', 'failed'].includes(previous.status as string) || previous.deck !== undefined && !text(previous.deck) || previous.destination !== undefined && !destination(previous.destination) || previous.lastError !== undefined && !text(previous.lastError) || previous.presence !== undefined && !['present', 'deleted', 'unknown'].includes(previous.presence as string)) throw new Error('Invalid import undo metadata.');
    }
    if (card.status === 'sent' && card.noteId === undefined) throw new Error('Sent card has no Anki note ID.');
    if (card.deck !== undefined && !text(card.deck) || card.lastError !== undefined && !text(card.lastError) || card.presence !== undefined && !['present', 'deleted', 'unknown'].includes(card.presence as string)) throw new Error('Invalid delivery metadata.');
  }
}

/** Upgrade older snapshots one step per version, then validate the result.
 * StateStore.open writes only after validation passes, so malformed or newer data is
 * refused and the file is left as it was. */
export function migrateState(raw: unknown): State {
  let value = raw;
  if (object(value) && value.schemaVersion === 1) value = { ...value, schemaVersion: 2, generationSettings: { cardsPerNode: 2, enabledKinds: ['recall', 'why', 'compose', 'discriminate'], model: null }, generations: [] };
  if (object(value) && value.schemaVersion === 2) value = { ...value, schemaVersion: 3, flags: [] };
  if (object(value) && value.schemaVersion === 3) value = { ...value, schemaVersion: 4, dismissals: [] };
  if (object(value) && value.schemaVersion === 4) {
    const old = value.generationSettings;
    if (!validLegacyGenerationSettings(old)) throw new Error('Invalid generation state.');
    // The old kinds were on by default, so they don't represent an opt-in. Leave
    // task inputs and historical settings byte-for-byte equivalent for worker recovery.
    value = { ...value, schemaVersion: 5, generationSettings: { cardsPerNode: old.cardsPerNode, enabledKinds: [...DEFAULT_KINDS], constantValues: false, model: old.model } };
  }
  if (object(value) && value.schemaVersion === 5) {
    const old = value.generationSettings;
    // A batch in a file 0.7.2 wrote has 0.7.2 or older settings; anything else is malformed, not current.
    const history = object(raw) && raw.schemaVersion === 5 && Array.isArray(value.generations) ? value.generations : [];
    if (!validV072GenerationSettings(old) || history.some(g => !object(g) || !(validV072GenerationSettings(g.settings) || validLegacyGenerationSettings(g.settings))))
      throw new Error('Invalid generation state.');
    // #37 removed the constant-values toggle and #38 stopped drafting compose. Only the
    // current settings change; generation history keeps its 0.7.2 settings and inputs.
    value = { ...value, schemaVersion: 6, generationSettings: fromV072Settings(old) };
  }
  if (object(value) && value.schemaVersion === 6) {
    // 0.8.0 requires a deck for every sent card. Validate the old contract
    // before migration so a deckless record cannot become a rollback backup.
    validateStateFormat(value, 6);
    value = { ...value, schemaVersion: 7 };
  }
  if (object(value) && value.schemaVersion === 7) {
    validateStateFormat(value, 7);
    value = { ...value, schemaVersion: 8 };
  }
  validateState(value);
  return value;
}

/** Flush a rename or link to disk. Windows refuses fsync on a directory handle
 * (EPERM), so skip it there, as LearnHarness does for its own stores. */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const dir = await open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/** Keep the original bytes before upgrading. Never replace an earlier backup. */
async function backUpBeforeMigration(directory: string, version: number, original: Buffer): Promise<void> {
  const backup = path.join(directory, `state.v${version}.bak`);
  const temporary = path.join(directory, `state.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(original); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, backup); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!original.equals(await readFile(backup))) {
        throw new Error(`state.v${version}.bak differs from state.json. Move the backup somewhere safe before upgrading.`);
      }
    }
    await syncDirectory(directory);
  } finally { await unlink(temporary); }
}

// Only relinquished locks go here, not live owners. Store the retry callbacks on
// the process so they survive the host reloading the backend module on re-enable.
const cleanupKey = Symbol.for('learnharness.anki-bridge.pending-state-lock-cleanup');
const processLocks = process as typeof process & { [cleanupKey]?: Map<string, () => Promise<void>> };
const pendingLockCleanup = processLocks[cleanupKey] ??= new Map();
function lockRelease(lock: string, token: string): () => Promise<void> {
  let released = false;
  let pending: Promise<void> | undefined;
  return () => {
    if (released) return Promise.resolve();
    if (pending) return pending;
    const done = () => {
      released = true;
      pendingLockCleanup.delete(lock);
    };
    pending = (async () => {
      try {
        const owner = JSON.parse(await readFile(lock, 'utf8'));
        if (owner?.pid !== process.pid || owner.token !== token) {
          done();
          throw new Error('State lock ownership changed; refusing to remove it.');
        }
        await fs.unlink(lock);
        done();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        done();
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

/** One backend owns a data directory. Writes are private, fsynced, atomic snapshots. */
export class StateStore {
  private value: State;
  private closed = false;
  private readonly commits = new Set<(state: State) => void>();
  private readonly directory: string;
  private readonly release: () => Promise<void>;
  private constructor(directory: string, value: State, release: () => Promise<void>) {
    this.directory = directory; this.value = value; this.release = release;
  }
  static async open(directory: string): Promise<StateStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directory = await realpath(directory);
    const lock = path.join(directory, 'state.lock');
    await pendingLockCleanup.get(lock)?.();
    const busyLock = 'Another Anki Bridge backend owns this data directory. If LearnHarness is not running, remove state.lock from the plugin data folder and restart.';
    const token = randomUUID();
    const release = lockRelease(lock, token);
    const relinquish = () => {
      pendingLockCleanup.set(lock, release);
      return release();
    };
    let acquired = false;
    const acquire = async () => {
      const file = await open(lock, 'wx', 0o600);
      // Any failure after creating the lock removes it and reports the first error.
      let failure: unknown, written = false;
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); written = true; await file.sync(); } catch (e) { failure = e; }
      try { await file.close(); } catch (e) { failure ??= e; }
      if (failure !== undefined) {
        // A partial write has no usable ownership token for later retry.
        await (written ? relinquish() : fs.unlink(lock)).catch(() => {});
        throw failure;
      }
      acquired = true;
    };
    const owner = async (): Promise<{ pid: number; token?: unknown }> => {
      let previous: { pid: number; token?: unknown };
      let text: string;
      try { text = await readFile(lock, 'utf8'); }
      catch (e) {
        // Missing means another backend is mid-recovery; it will own the lock shortly.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(busyLock);
        throw e;
      }
      // An empty lock was just created by another opener that has not written it yet.
      if (!text) throw new Error(busyLock);
      try { previous = JSON.parse(text); }
      catch { throw new Error('Anki Bridge state lock is unreadable. Do not remove it while a backend might be running.'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid Anki Bridge state lock.');
      return previous;
    };
    try { await acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await owner();
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; }
      // EPERM means another user's live process has that ID; treat it as an owner.
      if (alive) throw new Error(busyLock);
      // The owner is dead. Only one backend may replace its lock, and only if it is
      // still the same stale lock, so two recovering backends cannot both win.
      const recovery = path.join(directory, 'state.lock.recovery');
      let marker;
      try { marker = await open(recovery, 'wx', 0o600); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another backend is recovering the state lock. If none is running, quit LearnHarness and remove state.lock.recovery from the plugin data folder.');
        throw e;
      }
      try {
        try {
          await marker.close();
          const current = await owner();
          if (current.pid !== previous.pid || current.token !== previous.token) throw new Error('Another Anki Bridge backend owns this data directory.');
          await unlink(lock);
          await acquire();
        } catch (error) { await unlink(recovery).catch(() => {}); throw error; }
        await unlink(recovery);
      } catch (error) {
        if (acquired) await relinquish().catch(() => {});
        throw error;
      }
    }
    try {
      const original = await readFile(path.join(directory, 'state.json')).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      const raw: unknown = original === undefined ? undefined : JSON.parse(original.toString('utf8'));
      const value = original === undefined ? initialState() : migrateState(raw);
      if (original !== undefined && object(raw) && raw.schemaVersion !== value.schemaVersion) {
        await backUpBeforeMigration(directory, raw.schemaVersion as number, original);
      }
      const store = new StateStore(directory, value, release);
      // Create a durable initial snapshot without overwriting a malformed/newer file.
      await store.replace(value);
      return store;
    } catch (error) { await relinquish().catch(() => {}); throw error; }
  }
  snapshot(): State { return structuredClone(this.value); }
  /** Runs synchronously at each commit point, before the directory sync. Returns an unsubscribe. */
  onCommit(listener: (state: State) => void): () => void { this.commits.add(listener); return () => { this.commits.delete(listener); }; }
  async replace(value: State): Promise<void> {
    if (this.closed) throw new Error('Anki Bridge state is closed.');
    validateState(value);
    const next = structuredClone(value);
    const temporary = path.join(this.directory, `state.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path.join(this.directory, 'state.json'));
      // Rename is the commit point. Never use the old in-memory state after it.
      this.value = next;
      for (const listener of this.commits) listener(next);
      await syncDirectory(this.directory);
    } finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      pendingLockCleanup.set(path.join(this.directory, 'state.lock'), this.release);
    }
    await this.release();
  }
}
