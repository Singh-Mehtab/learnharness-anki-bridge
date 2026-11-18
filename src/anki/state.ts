import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultGenerationSettings, validateGenerations, validSource } from '../generation/types.ts';
import type { Generation, GenerationSettings, SourceSnapshot } from '../generation/types.ts';
import { validateFlags } from '../session/flow.ts';
import type { Flag } from '../session/flow.ts';

export interface Destination { url: string; profile: string }
export type CardStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'dropped';
export type CardKind = 'recall' | 'why' | 'compose' | 'discriminate';
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
  destination?: Destination;
  lastError?: string;
  presence?: 'present' | 'deleted' | 'unknown';
  sourceSnapshot?: SourceSnapshot;
  generationId?: string;
  requestId?: string;
}
export interface State {
  schemaVersion: 3;
  generationSettings: GenerationSettings;
  generations: Generation[];
  flags: Flag[];
  settings: { url: string; apiKey: string; lastDeck: string };
  destination: Destination | null;
  cards: Card[];
}
export const initialState = (): State => ({
  schemaVersion: 3,
  generationSettings: defaultGenerationSettings(),
  generations: [],
  flags: [],
  settings: { url: 'http://127.0.0.1:8765/', apiKey: '', lastDeck: '' },
  destination: null,
  cards: [],
});
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
export const sameDestination = (a: Destination | null | undefined, b: Destination | null | undefined): boolean => !!a && !!b && a.url === b.url && a.profile === b.profile;
function destination(v: unknown): v is Destination {
  return object(v) && text(v.url) && !!v.url && text(v.profile) && !!v.profile;
}
export function validateState(value: unknown): asserts value is State {
  if (!object(value) || value.schemaVersion !== 3) throw new Error('Unsupported state format. Keep state.json intact and use a compatible Anki Bridge version.');
  validateGenerations(value.generationSettings, value.generations);
  validateFlags(value.flags);
  const settings = value.settings;
  if (!object(settings) || !['url', 'apiKey', 'lastDeck'].every(k => text(settings[k])) || !(value.destination === null || destination(value.destination)) || !Array.isArray(value.cards)) throw new Error('Invalid Anki Bridge state. The file has not been reset.');
  const ids = new Set<string>();
  for (const card of value.cards) {
    if (!object(card) || !['id', 'nodeId', 'statementHash', 'sessionId', 'nodeName', 'sessionName', 'front', 'back', 'extra'].every(k => text(card[k])) || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(card.id as string) || ids.has(card.id as string) || !['recall', 'why', 'compose', 'discriminate'].includes(card.kind as string) || !['draft', 'approved', 'sending', 'sent', 'failed', 'dropped'].includes(card.status as string)) throw new Error('Invalid card state. The file has not been reset.');
    ids.add(card.id as string);
    if (card.sourceSnapshot !== undefined && !validSource(card.sourceSnapshot) || card.generationId !== undefined && !text(card.generationId) || card.requestId !== undefined && !text(card.requestId)) throw new Error('Invalid generation card metadata.');
    if (card.destination !== undefined && !destination(card.destination)) throw new Error('Invalid card destination.');
    if (card.noteId !== undefined && (!Number.isSafeInteger(card.noteId) || (card.noteId as number) <= 0)) throw new Error('Invalid Anki note ID.');
    if (['sent', 'sending'].includes(card.status as string) && (!destination(card.destination) || !text(card.deck) || !card.deck)) throw new Error('Missing delivery destination or deck.');
    if (card.status === 'sent' && card.noteId === undefined) throw new Error('Sent card has no Anki note ID.');
    if (card.deck !== undefined && !text(card.deck) || card.lastError !== undefined && !text(card.lastError) || card.presence !== undefined && !['present', 'deleted', 'unknown'].includes(card.presence as string)) throw new Error('Invalid delivery metadata.');
  }
}

/** Upgrade older snapshots one step per version (1 -> 2 -> 3), then validate the result.
 * StateStore.open writes only after validation passes, so malformed or newer data is
 * refused and the file is left as it was. */
export function migrateState(raw: unknown): State {
  let value = raw;
  if (object(value) && value.schemaVersion === 1) value = { ...value, schemaVersion: 2, generationSettings: defaultGenerationSettings(), generations: [] };
  if (object(value) && value.schemaVersion === 2) value = { ...value, schemaVersion: 3, flags: [] };
  validateState(value);
  return value;
}

/** One backend owns a data directory. Writes are private, fsynced, atomic snapshots. */
export class StateStore {
  private value: State;
  private closed = false;
  private readonly directory: string;
  private readonly lockToken: string;
  private constructor(directory: string, value: State, lockToken: string) {
    this.directory = directory; this.value = value; this.lockToken = lockToken;
  }
  static async open(directory: string): Promise<StateStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, 'state.lock');
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const file = await open(lock, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); }
        finally { await file.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
        let previous: { pid: number };
        try { previous = JSON.parse(await readFile(lock, 'utf8')); }
        catch { throw new Error('Anki Bridge state lock is unreadable. Do not remove it while a backend might be running.'); }
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid Anki Bridge state lock.');
        try { process.kill(previous.pid, 0); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lock); continue; }
          throw e;
        }
        throw new Error('Another Anki Bridge backend owns this data directory.');
      }
    }
    try {
      let value: State;
      try { const raw: unknown = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); value = migrateState(raw); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; value = initialState(); }
      const store = new StateStore(directory, value, token);
      // Create a durable initial snapshot without overwriting a malformed/newer file.
      await store.replace(value);
      return store;
    } catch (error) { await unlink(lock); throw error; }
  }
  snapshot(): State { return structuredClone(this.value); }
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
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const lock = path.join(this.directory, 'state.lock');
    const owner = JSON.parse(await readFile(lock, 'utf8'));
    if (owner.token !== this.lockToken) throw new Error('State lock ownership changed; refusing to remove it.');
    await unlink(lock);
  }
}
