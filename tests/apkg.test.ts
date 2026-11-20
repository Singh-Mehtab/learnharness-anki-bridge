// FI-9: offline .apkg export. Synthetic cards only; nothing here talks to a real Anki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32, inflateRawSync } from 'node:zlib';
import { exportPackage, PACKAGE_MODEL_ID, packageDeckId, packageFileName, stripHtml } from '../src/anki/apkg.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { BACK, CSS, FIELDS, FRONT, MODEL_NAME, TEMPLATE_NAME } from '../src/anki/note-type.ts';
import { initialState, StateStore } from '../src/anki/state.ts';
import type { Card, CardStatus, State } from '../src/anki/state.ts';

const NOW = 1_795_000_000_000;
const ids = { fact: '0b6f7c1e-0000-4000-8000-000000000001', equation: '0b6f7c1e-0000-4000-8000-000000000002', draft: '0b6f7c1e-0000-4000-8000-000000000003',
  sent: '0b6f7c1e-0000-4000-8000-000000000004', sending: '0b6f7c1e-0000-4000-8000-000000000005', dropped: '0b6f7c1e-0000-4000-8000-000000000006' };

const throwaway = { url: 'http://127.0.0.1:8765/', profile: 'Throwaway' };
function card(id: string, status: CardStatus, over: Partial<Card> = {}): Card {
  return { id, status, nodeId: `node:${id.slice(-1)}`, statementHash: 'h', sessionId: 's1', nodeName: 'Synthetic idea', sessionName: 'Synthetic session',
    kind: 'fact', front: 'Front', back: 'Back', extra: '', ...over };
}
function syntheticState(): State {
  const state = initialState();
  state.settings.tagTemplate = '{deck}::Lecture_01';
  state.cards.push(
    card(ids.fact, 'approved', { front: 'What does **momentum** conserve when $F_{ext}=0$?', back: 'Total momentum:\n\n```python\ndef p(m, v):\n    return m * v  # <b>not bold</b>\n```',
      extra: 'Holds in every inertial frame.', nodeId: 'node<&>"1"', nodeName: 'Momentum & impulse', sessionName: "Lecture 1 'mechanics'" }),
    card(ids.equation, 'failed', { kind: 'equation', front: 'Kinetic energy?', back: '$$E_k = \\tfrac{1}{2} m v^2$$', lastError: 'Earlier send failed' }),
    card(ids.draft, 'draft'), card(ids.sent, 'sent', { noteId: 77, deck: 'Synthetic', destination: throwaway }), card(ids.sending, 'sending', { deck: 'Synthetic', destination: throwaway }), card(ids.dropped, 'dropped'),
  );
  return state;
}

/** Reads a zip with a stored or deflated entry per file and checks each CRC. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), size = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, 'local header');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, length, `${name} size`);
    assert.equal(crc32(data), crc, `${name} CRC`);
    files.set(name, Buffer.from(data));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

async function withCollection<T>(apkg: Buffer, read: (db: DatabaseSync, files: Map<string, Buffer>) => T): Promise<T> {
  const files = unzip(apkg);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-apkg-test-'));
  try {
    const file = path.join(directory, 'collection.anki2');
    await writeFile(file, files.get('collection.anki2')!);
    const db = new DatabaseSync(file, { readOnly: true });
    try { return read(db, files); } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
type NoteRow = { id: number; guid: string; mid: number; tags: string; flds: string; sfld: string; csum: number };
type CardRow = { id: number; nid: number; did: number; ord: number; type: number; queue: number; due: number };
const contents = (db: DatabaseSync) => ({
  notes: db.prepare('SELECT id, guid, mid, tags, flds, sfld, csum FROM notes ORDER BY id').all() as unknown as NoteRow[],
  cards: db.prepare('SELECT id, nid, did, ord, type, queue, due FROM cards ORDER BY id').all() as unknown as CardRow[],
  col: db.prepare('SELECT ver, models, decks, dconf, tags FROM col').get() as { ver: number; models: string; decks: string; dconf: string; tags: string },
});

test('a package holds the approved cards with their formatting, fields, tags, note type and Bridge IDs', async () => {
  const result = await exportPackage(syntheticState(), { ids: [ids.fact, ids.equation], deck: 'Synthetic::Deck A' }, NOW);
  assert.equal(result.fileName, 'anki-bridge-synthetic-deck-a.apkg');
  assert.deepEqual(result.ids, [ids.fact, ids.equation]);
  assert.deepEqual(result.tags, ['Synthetic::Deck_A::Lecture_01', 'learnharness', 'learnharness::kind::fact', 'learnharness::kind::equation']);
  const apkg = Buffer.from(result.data, 'base64');
  await withCollection(apkg, (db, files) => {
    assert.deepEqual([...files.keys()], ['collection.anki2', 'media']);
    assert.equal(files.get('media')!.toString(), '{}', 'no media');
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    assert.deepEqual(indexes, ['ix_cards_nid', 'ix_cards_sched', 'ix_cards_usn', 'ix_notes_csum', 'ix_notes_usn', 'ix_revlog_cid', 'ix_revlog_usn']);
    const { notes, cards, col } = contents(db);
    assert.equal(col.ver, 11, 'legacy schema 11 collection');
    assert.equal(col.tags, '{}');
    assert.ok(JSON.parse(col.dconf)['1'], 'default deck options');

    const models = JSON.parse(col.models);
    assert.deepEqual(Object.keys(models), [String(PACKAGE_MODEL_ID)]);
    const model = models[PACKAGE_MODEL_ID];
    assert.equal(model.name, MODEL_NAME);
    assert.equal(model.type, 0);
    assert.deepEqual(model.flds.map((f: { name: string; ord: number }) => [f.name, f.ord]), FIELDS.map((name, ord) => [name, ord]));
    assert.equal(model.css, CSS, 'same owned CSS marker and styling as AnkiConnect delivery');
    assert.deepEqual(model.tmpls.map((t: Record<string, unknown>) => [t.name, t.ord, t.qfmt, t.afmt]), [[TEMPLATE_NAME, 0, FRONT, BACK]]);
    assert.equal(model.sortf, 0);

    const decks = JSON.parse(col.decks);
    const deckId = packageDeckId('Synthetic::Deck A');
    assert.equal(decks[deckId].name, 'Synthetic::Deck A');
    assert.equal(decks[deckId].dyn, 0);

    assert.equal(notes.length, 2);
    assert.deepEqual(notes.map(n => n.guid), [ids.fact, ids.equation], 'the note GUID is the Bridge ID');
    assert.ok(notes.every(n => n.mid === PACKAGE_MODEL_ID));
    const [fact, equation] = notes.map(n => n.flds.split('\x1f'));
    assert.equal(fact.length, FIELDS.length);
    assert.equal(fact[0], '<p>What does <strong>momentum</strong> conserve when \\(F_{ext}=0\\)?</p>');
    assert.match(fact[1], /<pre><code[^>]*>def p\(m, v\):\n {4}return m \* v {2}# &lt;b&gt;not bold&lt;\/b&gt;\n<\/code><\/pre>/, 'code keeps its indentation and is escaped as text');
    assert.equal(fact[2], '<p>Holds in every inertial frame.</p>');
    assert.equal(fact[3], 'Lecture 1 &#39;mechanics&#39; / Momentum &amp; impulse');
    assert.equal(fact[4], ids.fact, 'LH_ID carries the Bridge ID');
    assert.equal(fact[5], 'node&lt;&amp;&gt;&quot;1&quot;');
    assert.match(equation[1], /\\\[E_k = \\tfrac\{1\}\{2\} m v\^2\\\]/, 'display maths uses Anki MathJax delimiters');
    assert.equal(equation[2], '', 'an empty Extra stays empty');
    assert.equal(notes[0].tags, ' Synthetic::Deck_A::Lecture_01 learnharness learnharness::kind::fact ');
    assert.equal(notes[1].tags, ' Synthetic::Deck_A::Lecture_01 learnharness learnharness::kind::equation ');
    assert.equal(notes[0].sfld, 'What does momentum conserve when \\(F_{ext}=0\\)?');
    assert.ok(Number.isSafeInteger(notes[0].csum) && notes[0].csum > 0);

    assert.deepEqual(cards.map(c => [c.nid, c.did, c.ord, c.type, c.queue, c.due]), [[notes[0].id, deckId, 0, 0, 0, 1], [notes[1].id, deckId, 0, 0, 0, 2]], 'new cards in review order');
    assert.equal(db.prepare('SELECT count(*) AS n FROM revlog').get()!.n, 0, 'no review history');
  });
});

test('explicit tags replace the template, and the learnharness tags follow the setting', async () => {
  const state = syntheticState();
  state.settings.systemTags = false;
  const result = await exportPackage(state, { ids: [ids.fact], deck: 'Synthetic', tags: ['Custom::One', 'two'] }, NOW);
  assert.deepEqual(result.tags, ['Custom::One', 'two']);
  await withCollection(Buffer.from(result.data, 'base64'), db => assert.equal(contents(db).notes[0].tags, ' Custom::One two '));
  const none = await exportPackage(state, { ids: [ids.fact], deck: 'Synthetic', tags: [] }, NOW);
  await withCollection(Buffer.from(none.data, 'base64'), db => assert.equal(contents(db).notes[0].tags, ''));
});

test('only approved cards that were never sent can be downloaded, with clear input errors', async () => {
  const state = syntheticState();
  const reject = (input: unknown, pattern: RegExp) => assert.rejects(exportPackage(state, input, NOW), pattern);
  for (const id of [ids.draft, ids.sent, ids.sending, ids.dropped]) await reject({ ids: [id], deck: 'D' }, /Only approved, unsent cards can be downloaded/);
  state.cards.push(card('0b6f7c1e-0000-4000-8000-000000000007', 'failed', { noteId: 9 }));
  await reject({ ids: ['0b6f7c1e-0000-4000-8000-000000000007'], deck: 'D' }, /Only approved, unsent cards can be downloaded/);
  await reject({ ids: [ids.fact, ids.draft], deck: 'D' }, /Only approved, unsent cards can be downloaded/);
  await reject({ ids: ['missing'], deck: 'D' }, /Card not found/);
  await reject({ ids: [], deck: 'D' }, /distinct cards/);
  await reject({ ids: [ids.fact, ids.fact], deck: 'D' }, /distinct cards/);
  await reject({ ids: [ids.fact], deck: '  ' }, /Choose a deck/);
  await reject({ ids: [ids.fact], deck: 'Line\nbreak' }, /one-line deck name under 251 characters/);
  await reject({ ids: [ids.fact], deck: 'x'.repeat(251) }, /one-line deck name under 251 characters/);
  await reject({ ids: [ids.fact], deck: 'D', tags: ['has space'] }, /contains a space/);
  await reject({ ids: [ids.fact], deck: 'D', destination: {} }, /Unsupported export option/);
  await reject(null, /input object/);
  state.cards.push(card('0b6f7c1e-0000-4000-8000-000000000008', 'approved', { back: 'split\x1fhere' }));
  await reject({ ids: ['0b6f7c1e-0000-4000-8000-000000000008'], deck: 'D' }, /control character/);
});

test('a download reads saved state only, and the same batch downloads again with the same notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-apkg-state-'));
  const store = await StateStore.open(directory);
  try {
    await store.replace(syntheticState());
    const before = await readFile(path.join(directory, 'state.json'), 'utf8');
    const input = { ids: [ids.fact, ids.equation], deck: 'Synthetic' };
    const first = await exportPackage(store.snapshot(), input, NOW);
    const again = await exportPackage(store.snapshot(), input, NOW + 60_000);
    assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), before, 'state.json is untouched');
    const statuses = store.snapshot().cards.map(c => [c.id, c.status, c.noteId]);
    assert.deepEqual(statuses, syntheticState().cards.map(c => [c.id, c.status, c.noteId]), 'nothing is marked sent');
    const notes = async (r: { data: string }) => withCollection(Buffer.from(r.data, 'base64'), db => contents(db).notes.map(n => [n.guid, n.flds, n.tags]));
    assert.deepEqual(await notes(again), await notes(first), 'same GUIDs, fields and tags');
    assert.deepEqual(await exportPackage(store.snapshot(), input, NOW), first, 'same time, same bytes');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('package fields and tags match what AnkiConnect delivery sends for the same cards', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-apkg-parity-'));
  const added: { fields: Record<string, string>; tags: string[] }[] = [];
  const realFetch = globalThis.fetch;
  let fields: string[] = [];
  // A fake AnkiConnect on fetch: a throwaway profile, no real Anki.
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const { action, params } = JSON.parse(init.body);
    const results: Record<string, () => unknown> = {
      version: () => 6, getActiveProfile: () => 'Throwaway', deckNames: () => ['Default'], modelNames: () => fields.length ? [MODEL_NAME] : [],
      createModel: () => { fields = [...params.inOrderFields]; return { id: 1, name: MODEL_NAME }; }, modelFieldNames: () => fields, modelStyling: () => ({ css: CSS }),
      createDeck: () => 1, findNotes: () => [], addNote: () => { added.push(params.note); return 1000 + added.length; },
    };
    if (!results[action]) throw new Error(`Unexpected action ${action}`);
    return new Response(JSON.stringify({ result: results[action](), error: null }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const store = await StateStore.open(directory);
  const service = new DeliveryService(store, { timeoutMs: 1000 });
  try {
    const state = syntheticState();
    // Only the cards being compared; an unconfirmed send would make delivery reconcile first.
    state.cards = state.cards.filter(c => c.id === ids.fact || c.id === ids.equation);
    await store.replace(state);
    await service.command('settings', { tagTemplate: '{deck}::Lecture_01' });
    await service.command('pair', { confirmed: true });
    const input = { ids: [ids.fact, ids.equation], deck: 'Synthetic::Deck A' };
    const packaged = await exportPackage(store.snapshot(), input, NOW);
    await service.command('send', { ...input, expectedDestination: store.snapshot().destination });
    assert.equal(added.length, 2);
    await withCollection(Buffer.from(packaged.data, 'base64'), db => {
      const notes = contents(db).notes;
      assert.deepEqual(notes.map(n => n.flds.split('\x1f')), added.map(note => FIELDS.map(name => note.fields[name])));
      assert.deepEqual(notes.map(n => n.tags.trim().split(' ')), added.map(note => note.tags));
    });
  } finally { globalThis.fetch = realFetch; await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('exporting to Default uses Anki\'s own Default deck, not a second deck with the same name', async () => {
  for (const deck of ['Default', 'default']) {
    const result = await exportPackage(syntheticState(), { ids: [ids.fact, ids.equation], deck }, NOW);
    await withCollection(Buffer.from(result.data, 'base64'), db => {
      const decks = Object.values(JSON.parse(contents(db).col.decks)) as { id: number; name: string }[];
      assert.deepEqual(decks.map(d => d.id), [1], `${deck}: one deck`);
      assert.equal(decks[0].name.toLowerCase(), 'default');
      assert.deepEqual([...new Set(contents(db).cards.map(c => c.did))], [1], `${deck}: cards in deck 1`);
    });
  }
});

test('deck IDs and file names are stable, and sort text drops markup', () => {
  assert.equal(packageDeckId('Year 3::Nuclear'), packageDeckId('Year 3::Nuclear'));
  assert.notEqual(packageDeckId('Year 3::Nuclear'), packageDeckId('Year 3::Optics'));
  assert.ok(packageDeckId('Default::Sub') > 1, 'subdecks of Default get their own ID');
  assert.equal(packageFileName('Year 3::Nuclear Physics'), 'anki-bridge-year-3-nuclear-physics.apkg');
  assert.equal(packageFileName('Ångström'), 'anki-bridge-angstrom.apkg');
  assert.equal(packageFileName('::'), 'anki-bridge-cards.apkg');
  assert.equal(stripHtml('<p>A &amp; <b>B</b> &#x3b1; &#946;</p><!-- c -->'), 'A & B α β');
});
