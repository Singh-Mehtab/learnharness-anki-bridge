#!/usr/bin/env node
// Opt-in integration test. Never point it at a personal collection.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnkiClient } from '../src/anki/client.ts';
import { MODEL_NAME } from '../src/anki/note-type.ts';
import { StateStore } from '../src/anki/state.ts';
import { DeliveryService } from '../src/anki/delivery.ts';
import { spawn } from 'node:child_process';
import type { PublicSnapshot } from '../src/anki/delivery.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] ?? ''; };
const url = new URL(option('--url'));
const expectedProfile = option('--profile');
if (!args.includes('--confirm-scratch-profile') || !/^Anki Bridge Test(?:[ -].*)?$/.test(expectedProfile) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || ['8765', '8766'].includes(url.port)) throw new Error('Use --confirm-scratch-profile --profile "Anki Bridge Test..." and an isolated 127.0.0.1 port other than 8765/8766.');
const client = new AnkiClient({ url: url.origin, timeoutMs: 15_000 });
const connection = await client.connection();
assert.equal(connection.profile, expectedProfile, 'Refusing to write to an unexpected Anki profile');
const directory = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-live-state-'));
const store = await StateStore.open(directory);
let service = new DeliveryService(store, { timeoutMs: 15_000 });
const run = `${Date.now()}-${process.pid}`;
const deck = `Anki Bridge Test::${run}`;
const evidence: string[] = [];
try {
  await service.command('settings', { url: url.origin });
  await service.command('pair', { confirmed: true });
  assert.equal(service.snapshot().destination?.profile, expectedProfile);
  const expectedDestination = service.snapshot().destination;
  evidence.push('connection, active profile, deck listing and durable pairing');
  async function draft(front: string, back: string) {
    const state = await service.command('draft', { front, back, extra: 'Integration test only.', nodeId: `scratch-${run}`, nodeName: 'Scratch node', sessionName: 'Scratch session' }) as PublicSnapshot;
    return state.cards.at(-1)!.id;
  }
  const front = `Run ${run}: what is conserved in an isolated collision?`;
  const first = await draft(front, 'Momentum.');
  await assert.rejects(service.command('send', { ids: [first], deck, expectedDestination }), /Approve/);
  await service.command('approve', { ids: [first] });
  await service.command('send', { ids: [first], deck, expectedDestination });
  assert.equal(service.snapshot().cards[0].status, 'sent');
  evidence.push('owned note type creation/check, new deck and single-note delivery');
  const second = await draft(front, 'An intentionally duplicate front.');
  const third = await draft(`Run ${run}: evaluate $x_i^2$ for $x_i=3$.\n\n\`\`\`python\nif True:\n    print("<safe>")\n\`\`\``, '$9$');
  await service.command('approve', { ids: [second, third] });
  await service.command('send', { ids: [second, third], deck, expectedDestination });
  assert.equal(service.snapshot().cards[1].status, 'failed');
  assert.equal(service.snapshot().cards[2].status, 'sent');
  evidence.push('real duplicate rejection reported per card while the next card succeeds');
  const notes = await client.call<any[]>('notesInfo', { notes: [service.snapshot().cards[2].noteId] });
  assert.match(notes[0].fields.Front.value, /\\\(x_i\^2\\\)/);
  assert.match(notes[0].fields.Front.value, /    print/);
  assert.match(notes[0].fields.Front.value, /&lt;safe&gt;/);
  evidence.push('stored MathJax delimiters and escaped, indented fenced code');
  // Remove only the hidden metadata field in this confirmed throwaway note type.
  await client.call('modelFieldRemove', { modelName: MODEL_NAME, fieldName: 'LH_ID' });
  const fourth = await draft(`Run ${run}: which metadata identifies a delivery?`, 'A UUID.');
  await service.command('approve', { ids: [fourth] });
  await assert.rejects(service.command('send', { ids: [fourth], deck, expectedDestination }), /LH_ID|field/i);
  await service.command('repairFields', { expectedDestination });
  await service.command('send', { ids: [fourth], deck, expectedDestination });
  assert.equal(service.snapshot().cards[3].status, 'sent');
  evidence.push('real missing-field block and explicit add-only repair');
  // Kill a real bridge process at the write boundary after real Anki accepted addNote.
  const crashId = await draft(`Run ${run}: what survives a process crash?`, 'A durable delivery UUID.');
  await service.command('approve', { ids: [crashId] });
  await service.close();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { StateStore } from ${JSON.stringify(new URL('../src/anki/state.ts', import.meta.url).href)};
    import { DeliveryService } from ${JSON.stringify(new URL('../src/anki/delivery.ts', import.meta.url).href)};
    const store = await StateStore.open(${JSON.stringify(directory)});
    const replace = store.replace.bind(store);
    store.replace = async state => { if (state.cards.some(c => c.id === ${JSON.stringify(crashId)} && c.status === 'sent')) process.kill(process.pid,'SIGKILL'); return replace(state); };
    await new DeliveryService(store).command('send', {ids:[${JSON.stringify(crashId)}],deck:${JSON.stringify(deck)},expectedDestination:${JSON.stringify(expectedDestination)}});
    throw Error('Crash injection was not reached');
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = ''; child.stderr.on('data', chunk => { childError += chunk; });
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => { child.on('error', reject); child.on('exit', (_code, signal) => resolve(signal)); });
  assert.equal(signal, 'SIGKILL', childError);
  const reopened = await StateStore.open(directory);
  service = new DeliveryService(reopened, { timeoutMs: 15_000 });
  await service.activate();
  assert.equal(service.snapshot().cards.find(c => c.id === crashId)!.status, 'sent');
  assert.equal((await client.call<number[]>('findNotes', { query: `note:"${MODEL_NAME}" LH_ID:${crashId}` })).length, 1);
  evidence.push('real process SIGKILL after real addNote, restart recovers one note by UUID');
  // URL mismatch is detected before searching a different endpoint.
  await service.command('settings', { url: 'http://127.0.0.1:19998' });
  await assert.rejects(service.command('reconcile'), /Pair/);
  await service.command('settings', { url: url.origin });
  evidence.push('destination URL mismatch blocks reconciliation');
  await service.command('presence');
  assert.equal(service.snapshot().cards[0].presence, 'present');
  // Current AnkiConnect blocks note-type writes while an affected editor is open.
  await service.command('updateStyling', { confirmed: true });
  evidence.push('explicit owned styling/template update');
  await service.command('show', { ids: [fourth] });
  const browsed = await client.call<number[]>('guiBrowse', { query: `LH_ID:${fourth}` });
  assert(browsed.length > 0, 'Show in Anki must select a real scratch note');
  evidence.push('notesInfo presence and real guiBrowse Show in Anki');
  console.log(JSON.stringify({ profile: expectedProfile, endpoint: url.origin, label: option('--label'), deck, checks: evidence, cards: service.snapshot().cards.map(c => ({ id: c.id, status: c.status, noteId: c.noteId })) }, null, 2));
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
