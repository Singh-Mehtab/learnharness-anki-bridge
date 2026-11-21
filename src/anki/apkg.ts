// Offline export of approved cards as an Anki package (.apkg), for when AnkiConnect
// isn't available. A download is not a delivery: nothing here changes saved state,
// talks to Anki or marks a card as sent.
//
// Layout: a zip with Anki's legacy collection.anki2 (schema 11) and an empty media map,
// which current and older Anki versions import. The schema 11 table definitions and the
// collection, deck and note type defaults follow genanki by Kerrick Staley (MIT); see
// THIRD_PARTY_NOTICES.md. SQLite itself comes from node:sqlite, which ships with the
// Node runtime LearnHarness 0.6.1 bundles.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { BACK, CSS, FIELDS, FRONT, MODEL_NAME, TEMPLATE_NAME } from './note-type.ts';
import { renderMarkdown } from './render.ts';
import { packageRevision } from './package-revision.ts';
import { expandTagTemplate, systemTags, validateTags } from './tags.ts';
import type { Card, State } from './state.ts';

/** Fixed so every package from this plugin carries the same note type ID. */
export const PACKAGE_MODEL_ID = 1794873600000;
const DEFAULT_DECK_ID = 1;

export interface PackageCard { card: Card; fields: string[]; tags: string[] }
export interface PackageResult {
  fileName: string;
  /** The .apkg bytes, base64-encoded for the JSON call bridge. */
  data: string;
  ids: string[];
  /** Fingerprints bind the acknowledgement to the card contents in this package. */
  fingerprints: string[];
  /** Exact exported card revisions for validating cached download receipts. */
  revisions: string[];
  deck: string;
  /** Every tag the package's notes carry, including the automatic learnharness tags. */
  tags: string[];
}

const htmlText = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Bind imported acknowledgements to all card-derived package fields and tags. */
export function packageFingerprint(card: Card): string {
  return createHash('sha256').update(packageRevision(card)).digest('hex');
}

/** The same field values AnkiConnect delivery sends with addNote, in note type field order. */
export function packageFields(card: Card): string[] {
  const values: Record<(typeof FIELDS)[number], string> = {
    Front: renderMarkdown(card.front), Back: renderMarkdown(card.back), Extra: renderMarkdown(card.extra),
    Source: htmlText(`${card.sessionName} / ${card.nodeName}`), LH_ID: card.id, LH_Node: htmlText(card.nodeId),
  };
  const fields = FIELDS.map(name => values[name]);
  // Anki joins fields with U+001F, so one inside a field would shift every later field.
  if (fields.some(field => field.includes('\x1f'))) throw new Error(`Card "${card.front.slice(0, 60)}" contains a control character. Edit it first.`);
  return fields;
}

/** Tags as delivery adds them: the chosen tags, then the automatic ones unless turned off. */
export const packageTags = (chosen: string[], card: Card, withSystemTags: boolean): string[] =>
  [...new Set([...chosen, ...(withSystemTags ? systemTags(card.kind) : [])])];

function data(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an input object.');
  return value as Record<string, unknown>;
}
function deckInput(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Choose a deck first.');
  const deck = value.trim();
  if (deck.length > 250 || /[\r\n\0]/.test(deck)) throw new Error('Use a one-line deck name under 251 characters.');
  return deck;
}
function idsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) throw new Error('Choose one or more distinct cards.');
  return value;
}

/** Validates an export request against saved state. Reads only. */
export function selectPackageCards(state: State, input: unknown): { deck: string; cards: PackageCard[] } {
  const value = data(input);
  const allowed = new Set(['ids', 'deck', 'tags']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unsupported export option.');
  const ids = idsInput(value.ids);
  const deck = deckInput(value.deck);
  const chosen = validateTags(value.tags === undefined ? expandTagTemplate(state.settings.tagTemplate ?? '', deck) : value.tags);
  const withSystemTags = state.settings.systemTags !== false;
  const cards = ids.map(id => {
    const card = state.cards.find(c => c.id === id);
    if (!card) throw new Error('Card not found.');
    // Sent, unconfirmed and dropped cards stay out: a package of them would only duplicate notes.
    if (card.noteId !== undefined || (card.status !== 'approved' && card.status !== 'failed')) throw new Error('Only approved, unsent cards can be downloaded. Approve drafts first.');
    return { card, fields: packageFields(card), tags: packageTags(chosen, card, withSystemTags) };
  });
  return { deck, cards };
}

const SCHEMA = `
CREATE TABLE col (
    id integer primary key, crt integer not null, mod integer not null, scm integer not null,
    ver integer not null, dty integer not null, usn integer not null, ls integer not null,
    conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
    id integer primary key, guid text not null, mid integer not null, mod integer not null,
    usn integer not null, tags text not null, flds text not null, sfld integer not null,
    csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
    id integer primary key, nid integer not null, did integer not null, ord integer not null,
    mod integer not null, usn integer not null, type integer not null, queue integer not null,
    due integer not null, ivl integer not null, factor integer not null, reps integer not null,
    lapses integer not null, left integer not null, odue integer not null, odid integer not null,
    flags integer not null, data text not null
);
CREATE TABLE revlog (
    id integer primary key, cid integer not null, usn integer not null, ease integer not null,
    ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
    type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const LATEX_POST = '\\end{document}';

/** A stable deck ID per name, so downloading the same deck again names the same deck. */
export function packageDeckId(deck: string): number {
  // Anki deck names ignore case, and Default always has ID 1.
  if (deck.toLowerCase() === 'default') return DEFAULT_DECK_ID;
  return 1_000_000_000 + parseInt(createHash('sha256').update(deck).digest('hex').slice(0, 8), 16) % 1_000_000_000;
}

function deckJson(id: number, name: string, mod: number) {
  return { id, name, mod, usn: -1, desc: '', dyn: 0, conf: 1, collapsed: false, browserCollapsed: false,
    extendNew: 0, extendRev: 0, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0] };
}

function modelJson(deckId: number, mod: number) {
  return {
    id: PACKAGE_MODEL_ID, name: MODEL_NAME, type: 0, mod, usn: -1, sortf: 0, did: deckId,
    tmpls: [{ name: TEMPLATE_NAME, ord: 0, qfmt: FRONT, afmt: BACK, bqfmt: '', bafmt: '', bfont: '', bsize: 0, did: null }],
    flds: FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: CSS, latexPre: LATEX_PRE, latexPost: LATEX_POST, latexsvg: false,
    // {{Front}} renders nothing without Front, so Front is required.
    req: [[0, 'all', [0]]], tags: [], vers: [],
  };
}

const DECK_CONFIG = {
  id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
  new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
  rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
  lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Close to Anki's own sort-field text: tags removed, entities decoded. Anki's Check Database recomputes it. */
export function stripHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? match;
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }).trim();
}
const fieldChecksum = (text: string) => parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16);

type SqliteModule = typeof import('node:sqlite');
async function sqlite(): Promise<SqliteModule> {
  try { return await import('node:sqlite'); }
  catch { throw new Error('No built-in SQLite (node:sqlite) in this runtime, so .apkg files cannot be written. Send to Anki instead.'); }
}

/** Writes Anki's schema 11 collection for one deck and returns the database file's bytes. */
export async function buildCollection(deck: string, cards: PackageCard[], now: number): Promise<Buffer> {
  const { DatabaseSync } = await sqlite();
  const seconds = Math.floor(now / 1000), deckId = packageDeckId(deck);
  const conf = { activeDecks: [DEFAULT_DECK_ID], curDeck: DEFAULT_DECK_ID, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true,
    curModel: String(PACKAGE_MODEL_ID), nextPos: cards.length + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, newBury: true };
  const decks = { [DEFAULT_DECK_ID]: deckJson(DEFAULT_DECK_ID, 'Default', seconds), ...(deckId === DEFAULT_DECK_ID ? {} : { [deckId]: deckJson(deckId, deck, seconds) }) };
  const models = { [PACKAGE_MODEL_ID]: modelJson(deckId, seconds) };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-apkg-'));
  try {
    const file = path.join(directory, 'collection.anki2');
    const db = new DatabaseSync(file);
    try {
      db.exec(SCHEMA);
      db.exec('BEGIN');
      db.prepare('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)')
        .run(seconds, now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify({ 1: DECK_CONFIG }), '{}');
      const insertNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, \'\')');
      const insertCard = db.prepare('INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, \'\')');
      cards.forEach(({ card, fields, tags }, index) => {
        const id = now + index, sortText = stripHtml(fields[0]);
        // The note GUID is the card's Bridge ID, the same value as its LH_ID field.
        insertNote.run(id, card.id, PACKAGE_MODEL_ID, seconds, tags.length ? ` ${tags.join(' ')} ` : '', fields.join('\x1f'), sortText, fieldChecksum(sortText));
        // A new card; due is its position, so Anki keeps the review order.
        insertCard.run(id, id, deckId, seconds, index + 1);
      });
      db.exec('COMMIT');
    } finally { db.close(); }
    return await readFile(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A minimal zip writer (deflate, no zip64), enough for a two-file package. */
export function zip(entries: { name: string; data: Uint8Array }[], date: Date): Buffer {
  const year = Math.max(date.getUTCFullYear(), 1980);
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), compressed = deflateRawSync(entry.data), crc = crc32(entry.data);
    if (offset + compressed.length > 0xffff_0000 || entry.data.length > 0xffff_0000) throw new Error('Package too large to download.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Lowercase file name from the deck path; hierarchy separators become dashes. */
export function packageFileName(deck: string): string {
  const slug = deck.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return `anki-bridge-${slug || 'cards'}.apkg`;
}

/** Builds a package for approved, unsent cards. Reads saved state only; never writes it. */
export async function exportPackage(state: State, input: unknown, now = Date.now()): Promise<PackageResult> {
  const { deck, cards } = selectPackageCards(state, input);
  const collection = await buildCollection(deck, cards, now);
  const bytes = zip([{ name: 'collection.anki2', data: collection }, { name: 'media', data: Buffer.from('{}') }], new Date(now));
  return { fileName: packageFileName(deck), data: bytes.toString('base64'), ids: cards.map(c => c.card.id), fingerprints: cards.map(c => packageFingerprint(c.card)), revisions: cards.map(c => packageRevision(c.card)), deck, tags: [...new Set(cards.flatMap(c => c.tags))] };
}
