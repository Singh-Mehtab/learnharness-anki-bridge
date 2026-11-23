// FI-8: the Anki side of cloze cards. A fake AnkiConnect with several note types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import type { PublicSnapshot, SendResult } from '../src/anki/delivery.ts';
import { CLOZE_CSS, CLOZE_FRONT, CLOZE_MODEL_NAME } from '../src/anki/note-type.ts';
import { clozeTextField } from '../src/writer/cloze.ts';

interface Model { fields: string[]; css: string; isCloze: boolean; templates: Record<string, { Front: string; Back: string }> }
interface Note { noteId: number; fields: Record<string, string>; deckName: string; modelName: string; tags: string[] }

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-cloze-'));
  const models = new Map<string, Model>();
  const notes: Note[] = [];
  const calls: { action: string; params: any }[] = [];
  let nextId = 100;
  let invalidNotesInfo = false, wrongId = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const { action, params = {} } = JSON.parse(raw);
    calls.push({ action, params });
    let result: unknown = null, error: string | null = null;
    const model = (name: string) => { const m = models.get(name); if (!m) throw new Error(`model was not found: ${name}`); return m; };
    try {
      if (action === 'version') result = 6;
      else if (action === 'getActiveProfile') result = 'Throwaway';
      else if (action === 'deckNames') result = ['Default'];
      else if (action === 'modelNames') result = [...models.keys()];
      else if (action === 'createModel') {
        const t = params.cardTemplates[0];
        models.set(params.modelName, { fields: [...params.inOrderFields], css: params.css, isCloze: params.isCloze, templates: { [t.Name]: { Front: t.Front, Back: t.Back } } });
        result = { id: models.size, name: params.modelName };
      } else if (action === 'modelFieldNames') result = model(params.modelName).fields;
      else if (action === 'findModelsByName') result = (params.modelNames as string[]).flatMap(name => {
        const m = models.get(name); return m ? [{ name, type: m.isCloze ? 1 : 0 }] : [];
      });
      else if (action === 'modelStyling') result = { css: model(params.modelName).css };
      else if (action === 'modelTemplates') result = model(params.modelName).templates;
      else if (action === 'modelFieldAdd') model(params.modelName).fields.push(params.fieldName);
      else if (action === 'updateModelStyling') model(params.model.name).css = params.model.css;
      else if (action === 'updateModelTemplates') Object.assign(model(params.model.name).templates, params.model.templates);
      else if (action === 'createDeck') result = 1;
      else if (action === 'findNotes') { const id = /LH_ID:([\da-f-]+)/i.exec(params.query)?.[1]; result = notes.filter(n => n.fields.LH_ID === id).map(n => n.noteId); }
      else if (action === 'notesInfo' && invalidNotesInfo) result = [{}];
      else if (action === 'notesInfo') result = notes.filter(n => params.notes.includes(n.noteId)).map(n => ({ noteId: n.noteId, modelName: n.modelName, tags: n.tags, cards: [n.noteId + 1000],
        fields: Object.fromEntries(Object.entries(n.fields).map(([k, v], order) => [k, { value: wrongId && k === 'LH_ID' ? 'changed' : v, order }])) }));
      else if (action === 'addNote') {
        const m = model(params.note.modelName);
        assert.deepEqual(Object.keys(params.note.fields).sort(), [...m.fields].sort(), 'fields match the note type');
        const saved = { ...params.note, noteId: nextId++ }; notes.push(saved); result = saved.noteId;
      } else throw new Error('Unexpected API action: ' + action);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result, error }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const store = await StateStore.open(directory);
  const service = new DeliveryService(store, { timeoutMs: 1500 });
  try { await service.command('settings', { url }); await service.command('pair', { confirmed: true }); }
  catch (error) { await service.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  const draft = async (input: Record<string, unknown>) => ((await service.command('draft', { extra: '', nodeId: 'node-1', nodeName: 'Units', sessionName: 'Lecture', ...input })) as PublicSnapshot).cards.at(-1)!.id;
  const send = (ids: string[]) => service.command('send', { ids, deck: 'Scratch', tags: [], expectedDestination: service.snapshot().destination }) as Promise<SendResult>;
  const close = async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); };
  return { service, store, models, notes, calls, draft, send, close, invalidNotesInfo: (value: boolean) => { invalidNotesInfo = value; }, wrongId: (value: boolean) => { wrongId = value; } };
}

const HBAR = { kind: 'fact', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}' };

test('FI-8: a mixed batch creates LearnHarness Cloze and sends each card with its own note type', async () => {
  const f = await fixture();
  try {
    const basic = await f.draft({ front: 'What is \\(\\hbar c\\) in MeV fm?', back: '\\(197.3\\)' });
    const cloze = await f.draft(HBAR);
    await f.service.command('approve', { ids: [basic, cloze] });
    const result = await f.send([basic, cloze]);
    assert.deepEqual(result.delivery.added, [basic, cloze]);
    const model = f.models.get(CLOZE_MODEL_NAME)!;
    assert.equal(model.isCloze, true);
    assert.deepEqual(model.fields, ['Text', 'Extra', 'Source', 'LH_ID', 'LH_Node']);
    assert.equal(model.css, CLOZE_CSS);
    assert.equal(model.templates.Cloze!.Front, CLOZE_FRONT);
    const sent = f.notes.find(n => n.fields.LH_ID === cloze)!;
    assert.equal(sent.modelName, CLOZE_MODEL_NAME);
    assert.equal(sent.fields.Text, clozeTextField(HBAR.front, HBAR.back));
    assert.ok(sent.fields.Text!.includes('{{c1::'));
    assert.ok(sent.tags.includes('learnharness::format::cloze'));
    const plain = f.notes.find(n => n.fields.LH_ID === basic)!;
    assert.equal(plain.modelName, 'LearnHarness Basic');
    assert.ok(!plain.tags.includes('learnharness::format::cloze'));
  } finally { await f.close(); }
});

test('FI-8: a cloze card whose LH_ID finds a basic note reports a conflict and stays unsent (S22)', async () => {
  const f = await fixture();
  try {
    const card = await f.draft(HBAR);
    await f.service.command('approve', { ids: [card] });
    // A basic package was imported in Anki without Mark as imported, then the card was switched.
    const existing: Note = { noteId: 9, fields: { Front: '<p>old</p>', Back: 'x', LH_ID: card }, deckName: 'Scratch', modelName: 'LearnHarness Basic', tags: [] };
    f.notes.push(structuredClone(existing));
    const result = await f.send([card]);
    assert.deepEqual(result.delivery.failed, [card]);
    assert.deepEqual(result.delivery.found, []);
    const saved = f.store.snapshot().cards[0]!;
    assert.equal(saved.status, 'failed');
    assert.equal(saved.noteId, undefined);
    assert.match(saved.lastError!, /already in Anki as a basic note/);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 0);
    assert.deepEqual(f.notes, [existing]);
    // A matching cloze note is adopted as before.
    f.notes[0] = { ...existing, fields: { Text: 'x', LH_ID: card }, modelName: CLOZE_MODEL_NAME };
    assert.deepEqual((await f.send([card])).delivery.found, [card]);
  } finally { await f.close(); }
});

test('FI-8 (round 1, S1): a note of the other plugin type is refused even with added fields, and recovery checks too', async () => {
  const f = await fixture();
  try {
    const card = await f.draft(HBAR);
    await f.service.command('approve', { ids: [card] });
    // LearnHarness Basic with a Text field added by hand is still a basic note.
    const existing: Note = { noteId: 9, fields: { Front: '<p>old</p>', Back: 'x', Text: '', LH_ID: card }, deckName: 'Scratch', modelName: 'LearnHarness Basic', tags: [] };
    f.notes.push(structuredClone(existing));
    assert.deepEqual((await f.send([card])).delivery.failed, [card]);
    assert.match(f.store.snapshot().cards[0]!.lastError!, /already in Anki as a basic note/);
    f.notes[0]!.modelName = 'Renamed Basic';
    f.models.set('Renamed Basic', { isCloze: false, fields: Object.keys(existing.fields), css: '', templates: {} });
    assert.deepEqual((await f.send([card])).delivery.failed, [card], 'a renamed Basic model must not be adopted as cloze');
    // An interrupted send whose LH_ID now finds the basic note is not marked as delivered.
    const state = structuredClone(f.store.snapshot());
    Object.assign(state.cards[0]!, { status: 'sending', destination: state.destination, deck: 'Scratch', lastError: undefined });
    await f.store.replace(state);
    await f.service.command('reconcile');
    const saved = f.store.snapshot().cards[0]!;
    assert.equal(saved.status, 'failed');
    assert.equal(saved.noteId, undefined);
    assert.match(saved.lastError!, /already in Anki as a basic note/);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 0);
  } finally { await f.close(); }
});

test('an interrupted Cloze delivery reconciles after a note type rename', async () => {
  const f = await fixture();
  try {
    const id = await f.draft(HBAR);
    await f.service.command('approve', { ids: [id] });
    await f.send([id]);
    const state = structuredClone(f.store.snapshot());
    Object.assign(state.cards[0]!, { status: 'sending', noteId: undefined, presence: undefined });
    await f.store.replace(state);
    f.models.set('Renamed Cloze', f.models.get(CLOZE_MODEL_NAME)!);
    f.models.delete(CLOZE_MODEL_NAME);
    f.notes[0]!.modelName = 'Renamed Cloze';
    await f.service.command('reconcile');
    assert.equal(f.store.snapshot().cards[0]!.noteId, f.notes[0]!.noteId);
    assert.equal(f.store.snapshot().cards[0]!.status, 'sent');
    assert.equal(f.notes.length, 1);
  } finally { await f.close(); }
});

test('FI-8: Settings repair and styling actions take an explicit note type', async () => {
  const f = await fixture();
  try {
    const card = await f.draft(HBAR);
    await f.service.command('approve', { ids: [card] });
    await f.send([card]);
    const destination = f.service.snapshot().destination;
    const model = f.models.get(CLOZE_MODEL_NAME)!;
    model.fields = ['Text', 'Extra', 'LH_ID'];
    await f.service.command('repairFields', { noteType: 'cloze', expectedDestination: destination });
    assert.deepEqual(model.fields, ['Text', 'Extra', 'LH_ID', 'Source', 'LH_Node']);
    model.css = `${model.css}\n.card { color: red; }`;
    await f.service.command('updateStyling', { noteType: 'cloze', confirmed: true, expectedDestination: destination });
    assert.equal(model.css, CLOZE_CSS);
    await assert.rejects(f.service.command('repairFields', { noteType: 'reverse', expectedDestination: destination }), /Unknown note type/);
    // Without a note type the actions still mean LearnHarness Basic, which doesn't exist here.
    await assert.rejects(f.service.command('repairFields', { expectedDestination: destination }), /LearnHarness Basic/);
  } finally { await f.close(); }
});

test('FI-8: manual cloze cards and edits use the shared checks; a format-only switch saves', async () => {
  const f = await fixture();
  try {
    const card = await f.draft(HBAR);
    assert.equal(f.store.snapshot().cards[0]!.format, 'cloze');
    await assert.rejects(f.draft({ ...HBAR, kind: 'why' }), /only fact and equation/);
    await assert.rejects(f.draft({ ...HBAR, front: 'Let {{blank}} + y$ denote the total.', back: '$x' }), /splits a maths segment/);
    await assert.rejects(f.draft({ ...HBAR, back: '\\frac{1}{2' }), /balance/);
    await assert.rejects(f.draft({ ...HBAR, format: 'reverse' }), /Invalid card format/);
    // A basic card whose front already reads as a statement switches without a text change.
    const femto = await f.draft({ kind: 'fact', front: 'The prefix femto- means {{blank}}.', back: '\\(10^{-15}\\)' });
    assert.equal(f.store.snapshot().cards[1]!.format, undefined);
    await f.service.command('edit', { id: femto, front: 'The prefix femto- means {{blank}}.', back: '\\(10^{-15}\\)', extra: '', format: 'cloze' });
    assert.equal(f.store.snapshot().cards[1]!.format, 'cloze');
    // An edit without format keeps it; switching back to basic drops it.
    await f.service.command('edit', { id: femto, front: 'The prefix femto- means {{blank}}.', back: '\\(10^{-15}\\)', extra: '' });
    assert.equal(f.store.snapshot().cards[1]!.format, 'cloze');
    await f.service.command('edit', { id: femto, front: 'What does femto- mean?', back: '\\(10^{-15}\\)', extra: '', format: 'basic' });
    assert.equal('format' in f.store.snapshot().cards[1]!, false);
    // A raw-TeX back is valid for a cloze card even though it isn't valid Markdown alone.
    await f.service.command('edit', { id: card, front: 'Generating function: \\(a_n = {{blank}}\\)', back: 'n![z^n](1-z)^{-1}', extra: '' });
    // Sent cards can't switch.
    await f.service.command('approve', { ids: [card] });
    await f.send([card]);
    await assert.rejects(f.service.command('edit', { id: card, front: 'x', back: 'y', extra: '', format: 'basic' }), /sent/);
  } finally { await f.close(); }
});


test('round 3 S9 and S10: ambiguous renamed cloze is not adopted as basic; inconclusive recovery stays sending', async () => {
  const f = await fixture();
  try {
    const card = await f.draft({ kind: 'fact', front: 'Question?', back: 'Answer' });
    await f.service.command('approve', { ids: [card] });
    f.notes.push({ noteId: 9, fields: { Front: 'x', Text: '{{c1::x}}', LH_ID: card }, deckName: 'Scratch', modelName: 'Renamed Cloze', tags: [] });
    await assert.rejects(f.send([card]), /Cannot verify the existing Anki note type/);
    f.models.set('Renamed Cloze', { isCloze: true, fields: ['Front', 'Text', 'LH_ID'], css: '', templates: {} });
    assert.deepEqual((await f.send([card])).delivery.failed, [card]);
    assert.match(f.store.snapshot().cards[0]!.lastError!, /already in Anki as a cloze note/);
    const state = structuredClone(f.store.snapshot());
    Object.assign(state.cards[0]!, { status: 'sending', destination: state.destination, deck: 'Scratch' });
    await f.store.replace(state);
    f.invalidNotesInfo(true);
    await assert.rejects(f.service.command('reconcile'), /verify existing Anki note metadata/);
    assert.equal(f.store.snapshot().cards[0]!.status, 'sending');
    f.invalidNotesInfo(false);
    f.wrongId(true);
    await assert.rejects(f.service.command('reconcile'), /verify existing Anki note metadata/);
    assert.equal(f.store.snapshot().cards[0]!.status, 'sending');
    f.wrongId(false);
    await f.service.command('reconcile');
    assert.equal(f.store.snapshot().cards[0]!.status, 'failed');
  } finally { await f.close(); }
});
