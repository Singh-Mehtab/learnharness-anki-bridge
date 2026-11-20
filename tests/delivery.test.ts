import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StateStore } from '../src/anki/state.ts';
import type { State } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import type { PublicSnapshot, SendResult } from '../src/anki/delivery.ts';

interface Note { noteId: number; fields: Record<string, string>; deckName: string; modelName: string; tags: string[] }
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-unit-'));
  let profile: string | null = 'Throwaway';
  let fields: string[] = [];
  let css = '';
  let nextId = 100;
  let failFront = '';
  let dropAfterAdd = false;
  let switchAfterAdd = false;
  let addGate: Promise<void> | undefined, deckGate: Promise<void> | undefined, versionGate: Promise<void> | undefined;
  let enterAdd!: () => void, finishAdd!: () => void;
  const addEntered = new Promise<void>(r => { enterAdd = r; });
  const addCompleted = new Promise<void>(r => { finishAdd = r; });
  const calls: { action: string; params: any }[] = [];
  const errors = new Map<string, string>();
  const notes: Note[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw), { action, params = {} } = body;
      calls.push({ action, params });
      let result: unknown = null;
      let error: string | null = null;
      if (action === 'version') { if (versionGate) await versionGate; result = 6; }
      else if (action === 'getActiveProfile') result = profile;
      else if (action === 'deckNames') { if (deckGate) await deckGate; result = ['Default']; }
      else if (action === 'modelNames') result = fields.length ? ['LearnHarness Basic'] : [];
      else if (action === 'modelFieldNames') result = fields;
      else if (action === 'modelStyling') result = { css };
      else if (action === 'modelTemplates') result = { 'Card 1': { Front: '{{Front}}', Back: '{{Back}}' } };
      else if (action === 'createModel') { fields = [...params.inOrderFields]; css = params.css; result = { id: 1, name: 'LearnHarness Basic' }; }
      else if (action === 'modelFieldAdd') { fields.push(params.fieldName); }
      else if (action === 'createDeck') result = 1;
      else if (action === 'findNotes') { const id = /LH_ID:([\da-f-]+)/i.exec(params.query)?.[1]; result = notes.filter(n => n.fields.LH_ID === id).map(n => n.noteId); }
      else if (action === 'addNote') {
        enterAdd();
        if (addGate) await addGate;
        const note = params.note;
        // The disk MUST say sending before an addNote ever reaches Anki.
        const disk = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
        assert.equal(disk.cards.find((c: any) => c.id === note.fields.LH_ID).status, 'sending');
        assert.equal(disk.destination.profile, 'Throwaway');
        if (note.fields.Front === failFront || notes.some(n => n.fields.Front === note.fields.Front && n.deckName === note.deckName)) error = 'cannot create note because it is a duplicate';
        else { const saved = { ...note, noteId: nextId++ }; notes.push(saved); result = saved.noteId; }
        finishAdd();
        if (switchAfterAdd) profile = 'Different';
        if (dropAfterAdd) { dropAfterAdd = false; res.destroy(); return; }
      } else if (action === 'notesInfo') result = notes.filter(n => params.notes.includes(n.noteId)).map(n => ({ noteId: n.noteId, fields: n.fields, tags: n.tags, modelName: n.modelName, cards: [n.noteId + 1000] }));
      else if (action === 'guiBrowse') result = notes.filter(n => params.query.includes(`"LH_ID:${n.fields.LH_ID}"`)).map(n => n.noteId + 1000);
      else if (['updateModelStyling', 'updateModelTemplates'].includes(action)) result = null;
      else throw new Error('Unexpected API action: ' + action);
      if (errors.has(action)) { result = null; error = errors.get(action)!; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result, error }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ result: null, error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let store = await StateStore.open(directory);
  let service = new DeliveryService(store, { timeoutMs: 1500 });
  await service.command('settings', { url });
  const snap = () => service.snapshot();
  const draft = async (front = 'What changes?', back = 'Momentum') => {
    const result = await service.command('draft', { front, back, extra: '', nodeId: 'node-1', nodeName: 'Impulse', sessionName: 'Session / one' }) as PublicSnapshot;
    return result.cards.at(-1)!.id;
  };
  const pair = () => service.command('pair', { confirmed: true });
  const approve = (ids: string[]) => service.command('approve', { ids });
  const send = (ids: string[], deck = 'Scratch::New', tags?: string[]) => service.command('send', { ids, deck, tags, expectedDestination: service.snapshot().destination }) as Promise<SendResult>;
  const reopen = async () => { await service.close(); store = await StateStore.open(directory); service = new DeliveryService(store); await service.activate(); };
  const close = async () => { await service.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await rm(directory, { recursive: true, force: true }); };
  return { directory, url, calls, notes, errors, snap, draft, pair, approve, send, reopen, close, addEntered, addCompleted, get service() { return service; }, get store() { return store; },
    setProfile: (v: string | null) => { profile = v; }, setFields: (v: string[]) => { fields = v; }, setCss: (v: string) => { css = v; },
    failFront: (v: string) => { failFront = v; }, dropAfterAdd: () => { dropAfterAdd = true; }, switchAfterAdd: () => { switchAfterAdd = true; }, gate: (v: Promise<void>) => { addGate = v; }, gateDecks: (v: Promise<void>) => { deckGate = v; }, gateVersion: (v: Promise<void>) => { versionGate = v; } };
}

test('hand-written cards require explicit pairing and durable approval, then add one note at a time', async () => {
  const f = await fixture();
  try {
    const id = await f.draft();
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.send([id]), /Choose a profile for this address in settings first/);
    await f.pair();
    assert.deepEqual(f.calls.map(c => c.action), ['version', 'getActiveProfile', 'deckNames'], 'pairing skips the optional tag lookup while it holds the lock');
    await assert.rejects(f.send([id]), /Approve/);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 0);
    await f.approve([id]);
    await f.send([id]);
    assert.equal(f.snap().cards[0].status, 'sent');
    assert.equal(f.snap().cards[0].noteId, 100);
    assert.deepEqual(f.snap().cards[0].destination, { url: f.url, profile: 'Throwaway' });
    assert.equal(f.snap().settings.lastDeck, 'Scratch::New');
    assert(f.calls.some(c => c.action === 'createDeck'));
    const note = f.notes[0];
    assert.equal(note.fields.LH_ID, id);
    assert.equal(note.fields.LH_Node, 'node-1');
    assert.deepEqual(note.tags, ['learnharness', 'learnharness::kind::fact']);
    const add = f.calls.find(c => c.action === 'addNote')!;
    assert.equal(add.params.note.options.allowDuplicate, false);
    assert.equal(add.params.note.options.duplicateScope, 'deck');
    assert.equal(add.params.note.options.duplicateScopeOptions.checkAllModels, false);
    assert.deepEqual((await f.send([id])).delivery.skipped, [id]);
    assert.equal(f.notes.length, 1);
    assert(!f.calls.some(c => /delete|updateNote|suspend|due/i.test(c.action)));
  } finally { await f.close(); }
});

test('source names and hidden node metadata are escaped as text, not interpreted as HTML', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const state = await f.service.command('draft', { front: 'Prompt', back: 'Answer', nodeId: '<img src=x>', nodeName: '<script>alert(1)</script>', sessionName: 'Names $with dollars$ & symbols' }) as PublicSnapshot;
    const id = state.cards[0].id; await f.approve([id]); await f.send([id]);
    assert.equal(f.notes[0].fields.LH_Node, '&lt;img src=x&gt;');
    assert.equal(f.notes[0].fields.Source, 'Names $with dollars$ &amp; symbols / &lt;script&gt;alert(1)&lt;/script&gt;');
  } finally { await f.close(); }
});

test('a per-card API rejection does not stop the batch and duplicate fronts fail without overwriting', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const a = await f.draft('Same front', 'first'), b = await f.draft('Same front', 'second'), c = await f.draft('Fresh front', 'third');
    await f.approve([a, b, c]); await f.send([a, b, c]);
    assert.deepEqual(f.snap().cards.map(c => c.status), ['sent', 'failed', 'sent']);
    assert.match(f.snap().cards[1].lastError!, /duplicate/);
    assert.equal(f.notes.length, 2);
    assert.equal(f.notes[0].fields.Back.includes('first'), true);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 3);
    assert(f.calls.filter(c => c.action === 'findNotes').length >= 4);
  } finally { await f.close(); }
});

test('lost response remains sending and restart recovers by UUID without adding a duplicate', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]); f.dropAfterAdd();
    await assert.rejects(f.send([id]));
    assert.equal(f.snap().cards[0].status, 'sending'); assert.equal(f.notes.length, 1);
    await f.reopen();
    assert.equal(f.snap().cards[0].status, 'sent'); assert.equal(f.snap().cards[0].noteId, 100);
    await f.send([id]); assert.equal(f.notes.length, 1);
  } finally { await f.close(); }
});

test('wrong/null profiles and URL changes block reconciliation without clearing uncertain state', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]); f.dropAfterAdd(); await assert.rejects(f.send([id]));
    f.setProfile(null); const searches = f.calls.filter(c => c.action === 'findNotes').length;
    await f.reopen();
    assert.equal(f.snap().cards[0].status, 'sending'); assert.match(f.snap().recoveryError!, /Open a profile/);
    f.setProfile('Other'); await assert.rejects(f.service.command('reconcile'), /Anki has a different profile open\. Open "Throwaway"/);
    await assert.rejects(f.pair(), /original/);
    assert.equal(f.calls.filter(c => c.action === 'findNotes').length, searches);
    await f.service.command('settings', { url: 'http://127.0.0.1:19999' });
    await assert.rejects(f.service.command('reconcile'), /Choose a profile for this address in settings first/);
    assert.equal(f.snap().cards[0].status, 'sending');
    await f.service.command('settings', { url: f.url }); f.setProfile('Throwaway');
    await f.service.command('reconcile'); assert.equal(f.snap().cards[0].status, 'sent');
  } finally { await f.close(); }
});

test('a profile change during addNote leaves sending and stops subsequent cards', async () => {
  const f = await fixture();
  try {
    await f.pair(); const a = await f.draft(), b = await f.draft('Another front'); await f.approve([a, b]); f.switchAfterAdd();
    await assert.rejects(f.send([a, b]), /Anki has a different profile open\. Open "Throwaway"/);
    assert.equal(f.notes.length, 1); assert.deepEqual(f.snap().cards.map(c => c.status), ['sending', 'approved']);
    f.setProfile('Throwaway'); await f.service.command('reconcile'); assert.equal(f.snap().cards[0].status, 'sent');
  } finally { await f.close(); }
});

test('note fields and ownership are checked on every send, never silently repaired', async () => {
  const f = await fixture();
  try {
    await f.pair(); const a = await f.draft(); await f.approve([a]); await f.send([a]);
    const b = await f.draft('New prompt'); await f.approve([b]);
    f.setFields(['Front', 'Back', 'Extra', 'Source', 'LH_Node']);
    await assert.rejects(f.send([b]), /LH_ID|field/i); assert.equal(f.notes.length, 1);
    await f.service.command('repairFields', { expectedDestination: f.snap().destination }); await f.send([b]); assert.equal(f.notes.length, 2);
    const c = await f.draft('Third prompt'); await f.approve([c]); f.setCss('user model');
    await assert.rejects(f.send([c]), /own|marker|Anki Bridge|LearnHarness/i); assert.equal(f.notes.length, 2);
    await assert.rejects(f.service.command('updateStyling', {}), /Confirm/);
  } finally { await f.close(); }
});

test('deleted Anki notes stay sent/deleted, and Show in Anki uses UUIDs', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]); await f.send([id]);
    await f.service.command('presence'); assert.equal(f.snap().cards[0].presence, 'present');
    await f.service.command('show', { ids: [id] }); assert.equal(f.calls.findLast(c => c.action === 'guiBrowse')!.params.query, `"LH_ID:${id}"`);
    f.notes.splice(0); await f.service.command('presence');
    assert.equal(f.snap().cards[0].presence, 'deleted'); assert.equal(f.snap().cards[0].status, 'sent');
    await assert.rejects(f.service.command('show', { ids: [id] }), /No matching cards found in the paired Anki profile/);
    await f.send([id]); assert.equal(f.notes.length, 0);
    await assert.rejects(f.service.command('edit', { id, front: 'overwrite', back: 'bad' }), /cannot be edited/);
  } finally { await f.close(); }
});

test('a send fences competing sends, edits, pairing and settings', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    const gate = new Promise<void>(r => { release = r; }); f.gate(gate);
    const sending = f.send([id]);
    await Promise.race([f.addEntered, sending.then(() => assert.fail('send completed without reaching the gated addNote'))]);
    for (const [name, input] of [['send', { ids: [id], deck: 'Elsewhere' }], ['settings', { apiKey: 'test-secret' }], ['pair', { confirmed: true }], ['edit', { id, front: 'x', back: 'y' }]] as const) await assert.rejects(f.service.command(name, input), /Busy\. Wait for the current action to finish/);
    release(); await sending; assert.equal(f.notes.length, 1);
  } finally { release?.(); await f.close(); }
});

test('edit errors distinguish unconfirmed, confirmed and dropped cards', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const id = await f.draft(); await f.approve([id]);
    const dropped = await f.draft('Another front');
    await f.service.command('drop', { ids: [dropped] });
    const edit = (id: string) => f.service.command('edit', { id, front: 'Overwrite', back: 'New answer' });
    await assert.rejects(edit(dropped), { message: 'Dropped cards cannot be edited.' });

    f.dropAfterAdd(); await assert.rejects(f.send([id]));
    await assert.rejects(edit(id), { message: 'Cards with an unconfirmed send cannot be edited. Check unconfirmed sends first.' });
    await f.service.command('reconcile');
    await assert.rejects(edit(id), { message: 'This card was sent and cannot be edited here. Edit it in Anki.' });
    assert.deepEqual(f.snap().cards.map(c => c.status), ['sent', 'dropped']);
  } finally { await f.close(); }
});

test('editing invalidates approval and API key is not exposed in snapshots', async () => {
  const f = await fixture();
  try {
    await f.service.command('settings', { apiKey: 'private-test-key' });
    assert.equal(f.snap().settings.hasApiKey, true); assert(!JSON.stringify(f.snap()).includes('private-test-key'));
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    await f.service.command('edit', { id, front: 'Changed', back: 'answer' });
    assert.equal(f.snap().cards[0].status, 'draft'); await assert.rejects(f.send([id]), /Approve/);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(f.directory, 'state.json'))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('pairing rejects a profile or endpoint different from the confirmed dialog', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.command('pair', { confirmed: true, expectedDestination: { url: f.url, profile: 'Other' } }), /Destination changed while confirming\. Test the connection and confirm again/);
    assert.equal(f.snap().destination, null);
    await assert.rejects(f.service.command('pair', { confirmed: true, expectedDestination: { url: 'http://127.0.0.1:19999', profile: 'Throwaway' } }), /Destination changed while confirming\. Test the connection and confirm again/);
    assert.equal(f.snap().destination, null);
    await f.service.command('pair', { confirmed: true, expectedDestination: { url: f.url, profile: 'Throwaway' } });
    assert.equal(f.snap().destination?.profile, 'Throwaway');
  } finally { await f.close(); }
});

test('a saved API key stays with its URL and is never sent to a changed endpoint', async () => {
  const f = await fixture();
  try {
    await f.service.command('settings', { url: f.url, apiKey: 'endpoint-key' });
    await f.service.command('settings', { url: f.url });
    assert.equal(f.snap().settings.hasApiKey, true);
    await f.service.command('settings', { url: 'http://127.0.0.1:19999/' });
    assert.equal(f.snap().settings.hasApiKey, false);
    await f.service.command('settings', { url: f.url });
    assert.equal(f.snap().settings.hasApiKey, false);
    await f.service.command('settings', { url: 'http://127.0.0.1:19999/', apiKey: 'new-endpoint-key' });
    assert.equal(f.snap().settings.hasApiKey, true);
  } finally { await f.close(); }
});

test('note type maintenance rejects a view that shows an old or missing pairing before any Anki call', async () => {
  const f = await fixture();
  try {
    // Sending once creates the owned note type in the fake collection.
    await f.pair(); const id = await f.draft(); await f.approve([id]); await f.send([id]);
    const shown = f.snap().destination;
    f.setProfile('Different'); await f.pair();
    const before = f.calls.length;
    for (const [name, extra] of [['repairFields', {}], ['updateStyling', { confirmed: true }]] as const) {
      await assert.rejects(f.service.command(name, { ...extra, expectedDestination: shown }), /destination changed/);
      await assert.rejects(f.service.command(name, { ...extra }), /destination changed/);
    }
    assert.equal(f.calls.length, before);
    await f.service.command('repairFields', { expectedDestination: f.snap().destination });
    assert.ok(f.calls.length > before);
    const styling = f.calls.length;
    await f.service.command('updateStyling', { confirmed: true, expectedDestination: f.snap().destination });
    assert.ok(f.calls.slice(styling).some(c => c.action === 'updateModelStyling'));
  } finally { await f.close(); }
});

test('send rejects a view that shows an old or missing pairing before any Anki call', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    const shown = f.snap().destination;
    f.setProfile('Different'); await f.pair();
    const before = f.calls.length;
    await assert.rejects(f.service.command('send', { ids: [id], deck: 'Scratch', expectedDestination: shown }), /destination changed/);
    await assert.rejects(f.service.command('send', { ids: [id], deck: 'Scratch' }), /destination changed/);
    assert.equal(f.calls.length, before);
    assert.equal(f.snap().cards[0].status, 'approved');
    f.setProfile('Throwaway'); await f.pair();
    await f.send([id]);
    assert.equal(f.notes[0].fields.LH_ID, id);
  } finally { await f.close(); }
});

test('recovery finds an interrupted note by delivery ID even if the note type was renamed', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    f.dropAfterAdd();
    await assert.rejects(f.send([id]));
    f.notes[0].modelName = 'Renamed in Anki';
    await f.send([id]);
    assert.equal(f.notes.length, 1); assert.equal(f.snap().cards[0].status, 'sent');
    const lookups = f.calls.filter(c => c.action === 'findNotes').map(c => c.params.query);
    assert(lookups.length && lookups.every(q => q === `"LH_ID:${id}"`));
  } finally { await f.close(); }
});

test('backend errors do not echo the saved API key into the frontend', async () => {
  const f = await fixture();
  try {
    await f.service.command('settings', { apiKey: 'scratch-key-for-redaction' });
    f.errors.set('version', 'Rejected scratch-key-for-redaction');
    await assert.rejects(f.service.command('connection'), error => error instanceof Error && error.message === 'Rejected [API key hidden]');
  } finally { await f.close(); }
});

test('a connection check hides the key it used even if the saved key changes meanwhile', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await f.service.command('settings', { apiKey: 'first-key-for-redaction' });
    f.errors.set('version', 'Rejected first-key-for-redaction');
    f.gateVersion(new Promise<void>(r => { release = r; }));
    const checking = f.service.command('connection');
    while (!f.calls.some(c => c.action === 'version')) await new Promise(r => setTimeout(r, 5));
    await f.service.command('settings', { apiKey: 'second-key' });
    release();
    await assert.rejects(checking, error => error instanceof Error && error.message === 'Rejected [API key hidden]');
  } finally { release?.(); await f.close(); }
});

test('disable during a send preserves uncertainty and restart reconciles a late accepted note', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    f.gate(new Promise<void>(r => { release = r; }));
    const sending = assert.rejects(f.send([id]), /cancelled|disabled/i);
    await f.addEntered;
    await f.service.close();
    await sending;
    assert.equal(f.snap().cards[0].status, 'sending');
    release(); await f.addCompleted;
    await f.reopen();
    assert.equal(f.snap().cards[0].status, 'sent'); assert.equal(f.notes.length, 1);
  } finally { release?.(); await f.close(); }
});

test('explicit re-pairing preserves old sent history and never inspects it in the new profile', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]); await f.send([id]);
    f.setProfile('Different'); await f.pair();
    assert.equal(f.snap().destination!.profile, 'Different');
    assert.equal(f.snap().cards[0].destination!.profile, 'Throwaway');
    const calls = f.calls.filter(c => c.action === 'notesInfo').length;
    await f.service.command('presence');
    assert.equal(f.calls.filter(c => c.action === 'notesInfo').length, calls);
    await assert.rejects(f.service.command('show', { ids: [id] }), /paired destination/);
  } finally { await f.close(); }
});

test('a stale lock from a dead backend is replaced by exactly one of two concurrent openers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-lock-'));
  try {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise(resolve => child.on('exit', resolve));
    const lock = path.join(directory, 'state.lock');
    await writeFile(lock, JSON.stringify({ pid, token: 'dead-owner' }));
    const results = await Promise.allSettled([StateStore.open(directory), StateStore.open(directory)]);
    const opened = results.filter(r => r.status === 'fulfilled');
    assert.equal(opened.length, 1);
    assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /Another backend is recovering the state lock/);
    const owner = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(owner.pid, process.pid); assert.notEqual(owner.token, 'dead-owner');
    await (opened[0] as PromiseFulfilledResult<StateStore>).value.close();
    await writeFile(lock, JSON.stringify({ pid, token: 'dead-owner' }));
    await writeFile(path.join(directory, 'state.lock.recovery'), '');
    await assert.rejects(StateStore.open(directory), /recovering the state lock/);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'dead-owner');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a second child cannot replace a live child’s state lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-child-lock-'));
  const lock = path.join(directory, 'state.lock');
  const childSource = `
    import { readFile } from 'node:fs/promises';
    import { StateStore } from ${JSON.stringify(new URL('../src/anki/state.ts', import.meta.url).href)};
    let store;
    try { store = await StateStore.open(${JSON.stringify(directory)}); }
    catch (error) {
      if (!process.send && /Another Anki Bridge backend owns/.test(error.message)) process.exit(23);
      throw error;
    }
    if (process.send) {
      const release = new Promise(resolve => process.once('message', resolve));
      process.send(await readFile(${JSON.stringify(lock)}, 'utf8'));
      await release;
      await store.close();
      process.disconnect();
    } else await store.close();
  `;
  const args = ['--input-type=module', '-e', childSource];
  const winner = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const winnerExit = once(winner, 'close');
  const timeout = AbortSignal.timeout(5_000);
  let loser: ReturnType<typeof spawn> | undefined;
  let loserExit: Promise<unknown[]> | undefined;
  try {
    const [owned] = await once(winner, 'message', { signal: timeout });
    assert.equal(typeof owned, 'string');
    assert.equal(JSON.parse(owned).pid, winner.pid);
    assert.ok(JSON.parse(owned).token);
    assert.equal(await readFile(lock, 'utf8'), owned);
    loser = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    loserExit = once(loser, 'close');
    assert.deepEqual(await once(loser, 'close', { signal: timeout }), [23, null]);
    assert.equal(winner.exitCode, null, 'the first child is still holding the lock');
    assert.equal(await readFile(lock, 'utf8'), owned, 'the losing child did not replace the owner token');
    winner.send('release');
    assert.deepEqual(await once(winner, 'close', { signal: timeout }), [0, null]);
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    const reopened = await StateStore.open(directory); await reopened.close();
  } finally {
    if (loser?.exitCode === null && loser.signalCode === null) loser.kill();
    if (winner.exitCode === null && winner.signalCode === null) winner.kill();
    await Promise.allSettled([winnerExit, loserExit]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('state store refuses corrupt/newer snapshots and another active writer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-state-'));
  try {
    const file = path.join(directory, 'state.json');
    await writeFile(file, '{not JSON'); await assert.rejects(StateStore.open(directory)); assert.equal(await readFile(file, 'utf8'), '{not JSON');
    const future = JSON.stringify({ schemaVersion: 99 }); await writeFile(file, future);
    await assert.rejects(StateStore.open(directory), /Unsupported/); assert.equal(await readFile(file, 'utf8'), future);
    await rm(file); const store = await StateStore.open(directory);
    try { await assert.rejects(StateStore.open(directory), /Another/); }
    finally { await store.close(); }
    const reopened = await StateStore.open(directory); await reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual process death after addNote and before state write reconciles on restart', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    await f.service.close();
    // Exit without service/store cleanup at the exact durable-write boundary
    // after the Anki stub accepted addNote. An exit code is portable to Windows.
    const crashCode = 79;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { StateStore } from ${JSON.stringify(new URL('../src/anki/state.ts', import.meta.url).href)};
      import { DeliveryService } from ${JSON.stringify(new URL('../src/anki/delivery.ts', import.meta.url).href)};
      const store = await StateStore.open(${JSON.stringify(f.directory)});
      const replace = store.replace.bind(store);
      store.replace = async state => { if (state.cards.some(c => c.status === 'sent')) process.exit(${crashCode}); return replace(state); };
      const service = new DeliveryService(store);
      await service.command('send', {ids:[${JSON.stringify(id)}],deck:'Crash deck',expectedDestination:service.snapshot().destination});
      throw Error('Crash injection was not reached');
    `], { stdio: ['ignore', 'ignore', 'inherit'] });
    assert.deepEqual(await once(child, 'close'), [crashCode, null]);
    assert.equal(f.notes.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')).cards[0].status, 'sending');
    await f.reopen(); assert.equal(f.snap().cards[0].status, 'sent');
    await f.send([id]); assert.equal(f.notes.length, 1);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 1, 'no second add was attempted');
  } finally { await f.close(); }
});

test('Anki send reconciliation clears only the send warning, not the generation warning', async () => {
  const f = await fixture();
  try {
    await f.pair(); const id = await f.draft(); await f.approve([id]);
    f.service.reportGenerationRecoveryError('Generation result save warning');
    f.dropAfterAdd();
    await assert.rejects(f.send([id]));
    assert.ok(f.snap().recoveryError);
    assert.equal(f.snap().generationRecoveryError, 'Generation result save warning');
    await f.service.command('reconcile');
    assert.equal(f.snap().cards[0].status, 'sent');
    assert.equal(f.snap().recoveryError, undefined);
    assert.equal(f.snap().generationRecoveryError, 'Generation result save warning');
  } finally { await f.close(); }
});

test('tags come from the send, or the saved template, and learnharness tags can be turned off', async () => {
  const f = await fixture();
  try {
    await f.pair();
    await f.service.command('settings', { tagTemplate: '{deck}::Lecture_01 extra', systemTags: true });
    assert.equal(f.snap().settings.tagTemplate, '{deck}::Lecture_01 extra');
    assert.equal(f.snap().settings.url, f.url, 'tag settings leave the address alone');
    await f.service.command('draft', { kind: 'equation', front: 'First?', back: 'Equation.' });
    const first = f.snap().cards.at(-1)!.id;
    await f.approve([first]);
    await f.send([first], 'Year 3::Nuclear Physics');
    assert.deepEqual(f.notes[0].tags, ['Year_3::Nuclear_Physics::Lecture_01', 'extra', 'learnharness', 'learnharness::kind::equation']);
    await f.service.command('settings', { systemTags: false });
    const second = await f.draft('Second?');
    await f.approve([second]);
    await f.service.command('send', { ids: [second], deck: 'Scratch', tags: ['YEAR_3::NPP', 'YEAR_3::NPP'], expectedDestination: f.snap().destination });
    assert.deepEqual(f.notes[1].tags, ['YEAR_3::NPP']);
    const third = await f.draft('Third?');
    await f.approve([third]);
    await assert.rejects(f.service.command('send', { ids: [third], deck: 'Scratch', tags: ['has space'], expectedDestination: f.snap().destination }), /contains a space/);
    assert.equal(f.notes.length, 2);
    await assert.rejects(f.service.command('settings', { systemTags: 'yes' }), /Invalid system tags/);
  } finally { await f.close(); }
});

test('a slow connection check does not hold the writer fence, so approval still works', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    await f.pair(); const id = await f.draft();
    f.gateDecks(new Promise<void>(r => { release = r; }));
    const checking = f.service.command('connection');
    while (!f.calls.some(c => c.action === 'deckNames')) await new Promise(r => setTimeout(r, 5));
    await f.approve([id]);
    assert.equal(f.snap().cards[0].status, 'approved');
    release();
    assert.deepEqual((await checking as { decks: string[] }).decks, ['Default']);
  } finally { release?.(); await f.close(); }
});

// The version and sent/sending deck checks from v0.8.0's state validator.
// Keep these independent of the current validator to catch accidental v6 writes.
function validateV080DeliveryContract(state: { schemaVersion: number; cards: State['cards'] }): void {
  if (state.schemaVersion !== 6) throw new Error('Unsupported state format.');
  for (const card of state.cards) {
    if ((card.status === 'sent' || card.status === 'sending') && (!card.destination?.url || !card.destination.profile || typeof card.deck !== 'string' || !card.deck)) {
      throw new Error('Missing delivery destination or deck.');
    }
  }
}

test('schema 7 records an existing note with unknown deck and preserves a 0.8.0 rollback snapshot', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const sent = await f.draft('Delivered before upgrade');
    const imported = await f.draft('Imported before upgrade');
    await f.approve([sent, imported]);
    await f.send([sent], 'Known Deck');
    const original = JSON.stringify({ ...f.store.snapshot(), schemaVersion: 6 }, null, 2) + '\n';
    const legacy = JSON.parse(original) as Omit<State, 'schemaVersion'> & { schemaVersion: 6 };
    const stateFile = path.join(f.directory, 'state.json');
    const backup = path.join(f.directory, 'state.v6.bak');
    await f.service.close();
    await writeFile(stateFile, original);
    await f.reopen();
    assert.deepEqual(f.store.snapshot(), { ...legacy, schemaVersion: 7 });
    assert.equal(await readFile(backup, 'utf8'), original);

    f.notes.push({ noteId: 500, fields: { LH_ID: imported }, deckName: 'Imported Deck', modelName: 'Imported Type', tags: [] });
    const result = await f.send([imported], 'Requested Deck');
    assert.deepEqual(result.delivery.found, [imported]);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as State;
    assert.equal(persisted.schemaVersion, 7);
    assert.deepEqual(persisted.cards[1], { ...legacy.cards[1], status: 'sent', noteId: 500, existingNote: true, presence: 'present', destination: legacy.destination });
    assert.throws(() => validateV080DeliveryContract(persisted), /Unsupported state format/);
    assert.throws(() => validateV080DeliveryContract({ ...persisted, schemaVersion: 6 }), /Missing delivery destination or deck/);
    assert.equal(f.calls.filter(c => c.action === 'addNote').length, 1, 'no Anki write for the imported note');

    await f.service.close();
    const mislabeled = JSON.stringify({ ...persisted, schemaVersion: 6 });
    await writeFile(stateFile, mislabeled);
    await assert.rejects(StateStore.open(f.directory), /Missing delivery destination or deck/);
    assert.equal(await readFile(stateFile, 'utf8'), mislabeled, 'invalid input is left intact');
    const restored = await readFile(backup, 'utf8');
    await writeFile(stateFile, restored);
    assert.equal(restored, original);
    const rollbackState = JSON.parse(await readFile(stateFile, 'utf8'));
    validateV080DeliveryContract(rollbackState);
    assert.equal(rollbackState.cards[0].deck, 'Known Deck');
    assert.equal(rollbackState.cards[1].status, 'approved');
  } finally { await f.close(); }
});

test('delivery receipt separates a matching imported note, a new add and a definite failure', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const imported = await f.draft('Apparently imported');
    const added = await f.draft('Fresh prompt');
    const failed = await f.draft('Duplicate prompt');
    await f.approve([imported, added, failed]);
    // Model the Anki-side result of importing an .apkg that carried this draft's LH_ID.
    const existing = { noteId: 500, fields: { LH_ID: imported, Front: 'Edited in Anki' }, deckName: 'Imported Deck', modelName: 'Imported Type', tags: ['original'] };
    f.notes.push(structuredClone(existing));
    const before = f.calls.length;
    const foundOnly = await f.send([imported], 'Not the actual deck', ['not-applied']);
    assert.deepEqual(foundOnly.delivery, { added: [], found: [imported], skipped: [], failed: [], deck: null, tags: [] });
    assert.ok(f.calls.slice(before).every(c => ['getActiveProfile', 'findNotes'].includes(c.action)));
    assert.equal(foundOnly.cards[0].deck, undefined);
    assert.equal(foundOnly.cards[0].existingNote, true);
    assert.equal(foundOnly.settings.lastDeck, '');
    f.failFront((await import('../src/anki/render.ts')).renderMarkdown('Duplicate prompt'));
    const mixed = await f.send([imported, added, failed], 'New Deck', ['explicit']);
    assert.deepEqual(mixed.delivery, { added: [added], found: [], skipped: [imported], failed: [failed], deck: 'New Deck', tags: ['explicit', 'learnharness', 'learnharness::kind::fact'] });
    assert.deepEqual(f.notes[0], existing);
    await f.reopen();
    assert.equal(f.snap().cards[0].existingNote, true);
    await f.service.command('show', { ids: [imported] });
  } finally { await f.close(); }
});
