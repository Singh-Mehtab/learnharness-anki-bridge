import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { activate } from "../src/main.ts";
import { initialState, StateStore } from "../src/anki/state.ts";
import type { State } from "../src/anki/state.ts";
import { REVIEW_READ_ACTIONS } from "../src/anki/review-reader.ts";
import { ReviewService } from "../src/reviews/service.ts";
import type { PluginFrontendContext, PluginView } from "../sdk/index.d.ts";
import { fakeAnkiConnect } from "./fake-anki-connect.ts";
import { chooseMenu, fakeUi } from "./fake-ui.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };
const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise<void>(r => setTimeout(r, 5)); };

/** Real ReviewService and a fake AnkiConnect behind a fake host, so the page drives the actual backend. */
async function setup(options: { paired?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anki-bridge-topics-ui-"));
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const anki = await fakeAnkiConnect({ notes: [
    { noteId: 1000, lhId: ids[0]!, cards: [{ cardId: 2000, lapses: 4, reps: 10, deckName: "Year 3::Nuclear" }] },
    { noteId: 1001, lhId: ids[1]!, tags: ["leech"], cards: [{ cardId: 2001, lapses: 1, reps: 6, queue: -1, reviews: [{ id: NOW - 2 * DAY, ease: 1, type: 1 }, { id: NOW - 9 * DAY, ease: 1, type: 2 }] }] },
    // 1002 was deleted in Anki; 1003 has a different delivery ID now.
    { noteId: 1003, lhId: randomUUID(), cards: [{ cardId: 2003, lapses: 9, reps: 9 }] },
    // An unrelated note in the same profile that the bridge never sent.
    { noteId: 9000, lhId: randomUUID(), tags: ["leech"], cards: [{ cardId: 9900, lapses: 30, reps: 40 }] },
  ] });
  const store = await StateStore.open(directory);
  const destination = { url: anki.url, profile: "Throwaway" };
  const card = (i: number, nodeId: string, nodeName: string, front: string, sessionId = "chat-1") => ({
    id: ids[i]!, nodeId, nodeName, statementHash: "h", sessionId, sessionName: "Lecture one", kind: "fact" as const,
    front, back: `Answer ${i}`, extra: "", status: "sent" as const, deck: "Scratch", noteId: 1000 + i, destination });
  const state: State = { ...initialState(), settings: { url: anki.url, apiKey: "", lastDeck: "Scratch" }, destination: options.paired === false ? null : destination,
    cards: [card(0, "node-r", "Nuclear radius", "What is $R_0$?"), card(1, "node-f", "Femto prefix", "What does femto denote?", "chat-2"), card(2, "node-x", "Gone", "Deleted"), card(3, "node-y", "Changed", "Edited")] };
  await store.replace(state);
  const graph = () => ({ propositions: [{ id: "node-r" }, { id: "node-f" }], nodeSessions: { "node-r": ["chat-1"] }, sessions: { "chat-1": "Nuclear lecture", "chat-2": "Prefixes workshop" } });
  const service = new ReviewService({ graph }, store, { timeoutMs: 1500, now: () => NOW });

  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const views = new Map<string, PluginView>();
  const actions = new Map<string, { run: () => void }>();
  const calls: string[] = [], shown: unknown[] = [], sessions: string[] = [];
  let opened = "", settingsOpened = 0;
  const ctx = {
    signal: new AbortController().signal,
    cleanup: () => {},
    registerView: (v: PluginView) => { views.set(v.id, v); return () => {}; },
    registerAction: (a: { id: string; run: () => void }) => { actions.set(a.id, a); return () => {}; },
    placeAction: () => () => {}, onAppEvent: () => () => {}, onResync: () => () => {}, registerSettings: () => () => {},
    app: { openView: (id: string) => { opened = id; }, openSettings: () => { settingsOpened++; }, openSession: (id: string) => { sessions.push(id); } },
    call: async (name: string, input: any) => {
      calls.push(name);
      if (["checkReviews", "lastReviewCheck", "clearReviewCheck"].includes(name)) return service.command(name, input ?? {});
      if (name === "snapshot") { const s = store.snapshot(); return { settings: { url: s.settings.url, lastDeck: s.settings.lastDeck, hasApiKey: false, tagTemplate: "", systemTags: true }, destination: s.destination, cards: s.cards, generationSettings: s.generationSettings, generations: [] }; }
      if (name === "show") { shown.push(input); return; }
      if (name === "coverageContext") return { nodes: [], missing: [], cardsPerNode: 2, paired: true, pairingKey: "", pairingWarning: false };
      if (name === "generationStatus") return { generationSettings: { cardsPerNode: 2, enabledKinds: ["fact"], constantValues: false, model: null }, generations: [] };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      if (name === "connection") return { profile: "Throwaway", decks: ["Scratch"], tags: [] };
      throw new Error(`unexpected call ${name}`);
    },
    ui: fakeUi(),
  } as unknown as PluginFrontendContext;
  activate(ctx);
  const doc = window.document as any;
  const scope = new AbortController();
  const container = doc.createElement("div"); doc.body.append(container);
  const mount = async (id = "topics") => { const dispose = await views.get(id)!.mount(container, scope.signal); await tick(); return dispose; };
  const find = (label: string | RegExp) => Array.from(container.querySelectorAll("button") as ArrayLike<HTMLButtonElement>).find(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
  const click = async (label: string | RegExp) => { const b = find(label); assert.ok(b, `button ${label}`); assert.equal(b.disabled, false, `button ${label} is enabled`); b.click(); await tick(); };
  const text = () => container.textContent as string;
  const cleanup = async () => { scope.abort(); service.close(); await store.close(); await anki.close(); await rm(directory, { recursive: true, force: true }); };
  return { anki, store, service, views, actions, calls, shown, sessions, opened: () => opened, settingsOpened: () => settingsOpened, doc, container, mount, find, click, text, cleanup };
}

test("Topics to revisit reads nothing until Check Anki reviews, then groups cards by node with evidence and links", async () => {
  const t = await setup();
  try {
    assert.ok(t.views.has("topics"));
    t.actions.get("open-topics")!.run();
    assert.equal(t.opened(), "topics");
    await t.mount();
    assert.match(t.text(), /Not checked yet\. Nothing has been read from Anki\./);
    assert.match(t.text(), /paired Anki profile "Throwaway"/);
    assert.match(t.text(), /suggestions to look at, not a judgement of what you know/);
    assert.equal(t.anki.state.requests.length, 0, "opening the page sends nothing to Anki");
    assert.ok(!t.calls.includes("checkReviews"));

    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    const topics = Array.from(t.container.querySelectorAll(".ab-topic") as ArrayLike<HTMLElement>);
    assert.deepEqual(topics.map(n => n.dataset.nodeId), ["node-f", "node-r"]);
    const femto = topics[0]!.textContent!;
    assert.match(femto, /Femto prefix/);
    assert.match(femto, /2 Again presses on reviews in the last 30 days\./);
    assert.match(femto, /1 card tagged leech in Anki\./);
    assert.match(femto, /What does femto denote\?/);
    assert.match(femto, /suspended in Anki/);
    const radius = topics[1]!.textContent!;
    assert.match(radius, /4 lapses on 1 card\./);
    assert.match(radius, /deck Year 3::Nuclear/);
    assert.match(t.text(), /1 card no longer in Anki and was skipped\./);
    assert.match(t.text(), /1 card changed in Anki \(different note type or delivery ID\) and was skipped\./);
    assert.match(t.text(), /Checked at .* in profile "Throwaway"\. 2 cards read\./);

    await t.click("Open session: Nuclear lecture");
    await t.click("Open session: Prefixes workshop");
    assert.deepEqual(t.sessions, ["chat-1", "chat-2"]);
    const show = Array.from(topics[1]!.querySelectorAll("button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Show in Anki")!;
    show.click(); await tick();
    assert.equal(t.shown.length, 1);

    // The wording never claims a learning problem.
    for (const word of [/\bgap/i, /\bweak/i, /struggl/i, /don't understand/i, /you don.t know/i]) assert.doesNotMatch(t.text(), word);
    for (const action of t.anki.actions()) assert.ok(REVIEW_READ_ACTIONS.has(action), action);
    assert.deepEqual(t.anki.state.forbidden, []);
    const asked = t.anki.state.requests.filter(r => r.action === "notesInfo").flatMap(r => r.params.notes);
    assert.ok(!asked.includes(9000), "the unrelated note is never requested");
    assert.ok(!t.anki.state.requests.some(r => (r.params.cards ?? []).includes(9900) || (r.params.cards ?? []).includes(2003)));

    // Clear asks first and forgets the in-memory result.
    await t.click("Clear");
    const confirm = Array.from(t.doc.querySelectorAll(".ab-dialog button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Clear")!;
    confirm.click(); await settle(() => !t.container.querySelector(".ab-topic"));
    assert.match(t.text(), /Not checked yet/);
    assert.equal((await t.service.command("lastReviewCheck")).check, null);
  } finally { await t.cleanup(); }
});

test("a wrong profile shows a plain error, reads no notes and drops the old result", async () => {
  const t = await setup();
  try {
    await t.mount();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    t.anki.state.profile = "Someone else";
    t.anki.state.requests.length = 0;
    await t.click("Check Anki reviews");
    await settle(() => !t.container.querySelector(".ab-topic"));
    assert.match(t.text(), /Anki has the profile "Someone else" open\. Open the paired profile "Throwaway" or re-pair in Settings\./);
    assert.match(t.text(), /Not checked yet/);
    assert.deepEqual(t.anki.actions(), ["version", "getActiveProfile"]);
  } finally { await t.cleanup(); }
});

test("Anki closed keeps the earlier result marked as possibly out of date", async () => {
  const t = await setup();
  try {
    await t.mount();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    await t.anki.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    await t.click("Check Anki reviews");
    await settle(() => /out of date/.test(t.text()));
    assert.match(t.text(), /Anki isn't running or AnkiConnect isn't reachable/);
    assert.match(t.text(), /Last checked at .*This result may be out of date\./);
    assert.equal(t.container.querySelectorAll(".ab-topic").length, 2);
  } finally { await t.cleanup(); }
});

test("without a pairing the check is unavailable and points to settings", async () => {
  const t = await setup({ paired: false });
  try {
    await t.mount();
    assert.equal(t.find("Check Anki reviews")!.disabled, true);
    assert.match(t.text(), /Choose an Anki profile in settings first/);
    await t.click("Open settings");
    assert.equal(t.settingsOpened(), 1);
    assert.equal(t.anki.state.requests.length, 0);
  } finally { await t.cleanup(); }
});

test("step 3's More menu opens Topics to revisit without reading Anki", async () => {
  const t = await setup();
  try {
    await t.mount("bridge");
    await settle(() => !!t.find("More"));
    await t.click("More");
    await chooseMenu("Topics to revisit");
    assert.equal(t.opened(), "topics");
    assert.ok(!t.calls.includes("checkReviews"));
    assert.equal(t.anki.state.requests.length, 0);
  } finally { await t.cleanup(); }
});
