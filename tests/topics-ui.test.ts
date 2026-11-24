import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { activate } from "../src/main.ts";
import { mountTopics } from "../src/topics-ui.ts";
import { initialState, StateStore } from "../src/anki/state.ts";
import type { State } from "../src/anki/state.ts";
import { REVIEW_READ_ACTIONS } from "../src/anki/review-reader.ts";
import { ReviewService } from "../src/reviews/service.ts";
import type { ReviewCheck } from "../src/reviews/signals.ts";
import type { PluginAction, PluginActionContext, PluginFrontendContext, PluginView } from "../sdk/index.d.ts";
import { fakeAnkiConnect } from "./fake-anki-connect.ts";
import { delayedButtons, fakeUi } from "./fake-ui.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };
const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise<void>(r => setTimeout(r, 5)); };

/** Real ReviewService and a fake AnkiConnect behind a fake host, so the page drives the actual backend. */
async function setup(options: { paired?: boolean; deferSessionButtons?: boolean; duplicateSessionTitles?: boolean; onlyNodes?: string[] } = {}) {
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
  let onlyNodes = options.onlyNodes;
  const graph = () => ({
    propositions: [{ id: "node-r", name: "Nuclear radius", statement: "Nuclear radius varies with mass number." }, { id: "node-f", name: "Femto prefix", statement: "Femto means 10^-15." }].filter(n => !onlyNodes || onlyNodes.includes(n.id)),
    nodeSessions: { "node-r": options.duplicateSessionTitles ? ["chat-1", "chat-3", "chat-4"] : ["chat-1"], "node-f": options.duplicateSessionTitles ? ["chat-5"] : [] },
    sessions: { "chat-1": "Nuclear lecture", "chat-2": options.duplicateSessionTitles ? "Nuclear lecture" : "Prefixes workshop", "chat-3": "Nuclear  lecture" },
  });
  const listSessions = () => [
    { id: "chat-1", createdAt: "2026-11-18T09:00:00Z" },
    { id: "chat-2", createdAt: "2026-11-19T09:00:00Z" },
  ];
  const service = new ReviewService({ graph, listSessions }, store, { timeoutMs: 1500, now: () => NOW });

  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const views = new Map<string, PluginView>();
  const actions = new Map<string, PluginAction>();
  const calls: string[] = [], shown: unknown[] = [], sessions: string[] = [], sessionReads: string[] = [];
  let opened = "", settingsOpened = 0;
  let mountSettings: PluginView["mount"];
  let tagTemplate = "";
  const resyncs: (() => void)[] = [];
  let hold: Promise<void> | undefined, holdPracticeNodes: Promise<void> | undefined;
  const buttons = delayedButtons();
  const ui = fakeUi();
  const mountButton = ui.mountButton as PluginFrontendContext["ui"]["mountButton"];
  if (options.deferSessionButtons) {
    ui.mountButton = ((container, props, options) => (props.label === "Open session" ? buttons.mountButton : mountButton)(container, props, options)) satisfies typeof mountButton;
  }
  const ctx = {
    manifest: { apiVersion: 1, id: "anki-bridge", name: "Anki Bridge", version: "9.8.7", minAppVersion: "0.6.1" },
    signal: new AbortController().signal,
    cleanup: () => {},
    registerView: (v: PluginView) => { views.set(v.id, v); return () => {}; },
    registerAction: (a: PluginAction) => { actions.set(a.id, a); return () => {}; },
    placeAction: () => () => {}, onAppEvent: () => () => {}, onResync: (f: () => void) => { resyncs.push(f); return () => { resyncs.splice(resyncs.indexOf(f), 1); }; },
    registerSettings: (mount: PluginView["mount"]) => { mountSettings = mount; return () => {}; },
    app: { openView: (id: string) => { opened = id; }, openSettings: () => { settingsOpened++; }, openSession: (id: string) => { sessions.push(id); } },
    call: async (name: string, input: any) => {
      calls.push(name);
      if (["checkReviews", "lastReviewCheck", "clearReviewCheck"].includes(name)) return service.command(name, input ?? {});
      if (name === "practiceNodes") {
        const result = service.practiceNodes(input ?? {});
        if (holdPracticeNodes) await holdPracticeNodes;
        return result;
      }
      if (name === "snapshot" || name === "settings") {
        if (name === "settings") tagTemplate = input.tagTemplate;
        const s = store.snapshot(); const wait = hold; if (wait) await wait;
        return { settings: { url: s.settings.url, lastDeck: s.settings.lastDeck, hasApiKey: false, tagTemplate, systemTags: true }, destination: s.destination, cards: s.cards, generationSettings: s.generationSettings, generations: [] };
      }
      if (name === "show") { shown.push(input); return; }
      if (name === "coverageContext") return { nodes: [], missing: [], cardsPerNode: 2, paired: true, pairingKey: "", pairingWarning: false };
      if (name === "generationStatus") return { generationSettings: { cardsPerNode: 2, enabledKinds: ["fact"], constantValues: false, model: null }, generations: [] };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      if (name === "sessionFlow") {
        sessionReads.push(input.sessionId);
        return { session: { id: input.sessionId, title: "Nuclear lecture", exists: true }, nodes: [
          { id: "node-r", name: "Nuclear radius", statement: "Nuclear radius varies with mass number.", flagged: true, cards: { waiting: 0, sent: 0, sentElsewhere: 0 } },
        ], flags: [{ id: "f1", status: "matched", note: "Review the scaling law", flaggedAt: "2026-11-20T08:00:00Z", nodeIds: ["node-r"], pendingNodeIds: ["node-r"] }], cardsPerNode: 2, paired: true };
      }
      if (name === "connection") {
        const profile = store.snapshot().destination?.profile ?? null;
        return { profile, decks: [profile === "Throwaway" ? "Scratch" : `${profile} deck`], tags: ["study"] };
      }
      throw new Error(`unexpected call ${name}`);
    },
    ui,
  } as unknown as PluginFrontendContext;
  activate(ctx);
  const doc = window.document as any;
  const scope = new AbortController();
  const container = doc.createElement("div"); doc.body.append(container);
  const tab = (label: string) => Array.from(container.querySelectorAll('[role="tab"]') as ArrayLike<HTMLButtonElement>).find(b => b.textContent === label)!;
  const panel = (label: string) => doc.getElementById(tab(label).getAttribute("aria-controls")) as HTMLElement;
  const openReviews = async () => { tab("Check Anki reviews").click(); await tick(); };
  const mount = async () => {
    const viewScope = new AbortController();
    const dispose = await views.get("bridge")!.mount(container, AbortSignal.any([scope.signal, viewScope.signal]));
    await tick();
    return () => { viewScope.abort(); dispose?.(); };
  };
  const mountReviews = async () => { const dispose = await mount(); await openReviews(); return dispose; };
  const openSettings = async () => {
    const host = doc.createElement("div") as HTMLElement;
    doc.body.append(host);
    const dispose = await mountSettings(host, scope.signal);
    await tick();
    return { host, dispose: () => { dispose?.(); host.remove(); } };
  };
  const reviewRoot = () => tab("Check Anki reviews") ? panel("Check Anki reviews") : container as HTMLElement;
  const find = (label: string | RegExp) => Array.from(reviewRoot().querySelectorAll("button")).find(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
  const click = async (label: string | RegExp) => { const b = find(label); assert.ok(b, `button ${label}`); assert.equal(b.disabled, false, `button ${label} is enabled`); b.click(); await tick(); };
  const text = () => reviewRoot().textContent!;
  const cleanup = async () => { scope.abort(); service.close(); await store.close(); await anki.close(); await rm(directory, { recursive: true, force: true }); };
  return { setOnlyNodes: (ids: string[]) => { onlyNodes = ids; }, holdPracticeNodes: (p: Promise<void>) => { holdPracticeNodes = p; }, commitButtons: buttons.commitButtons, setHold: (p: Promise<void> | undefined) => { hold = p; }, ctx, scope, resyncs, destination, anki, store, service, views, actions, calls, shown, sessions, sessionReads, opened: () => opened, settingsOpened: () => settingsOpened, doc, container, window, tab, panel, openReviews, openSettings, mount, mountReviews, find, click, text, cleanup };
}

test("Topics to revisit reads nothing until Check Anki reviews, then groups cards by node with evidence and links", async () => {
  const t = await setup({ deferSessionButtons: true });
  try {
    assert.deepEqual([...t.views.keys()], ["bridge"]);
    assert.equal(t.actions.has("open-topics"), false);
    await t.mount();
    assert.equal(t.panel("Make cards").hidden, false);
    assert.equal(t.panel("Check Anki reviews").hidden, true);
    assert.equal(t.anki.state.requests.length, 0, "mounting sends no review read");
    assert.ok(!t.calls.includes("checkReviews"));
    await t.openReviews();
    assert.equal(t.panel("Make cards").hidden, true);
    assert.equal(t.panel("Check Anki reviews").hidden, false);
    assert.match(t.text(), /Not checked yet\./);
    assert.match(t.text(), /Paired profile: "Throwaway"/);
    assert.match(t.text(), /Checks only cards sent by Bridge\./);
    assert.match(t.text(), /Lists cards with 3\+ lapses, 2\+ Again presses in 30 days, or a leech tag/);
    assert.match(t.text(), /Again counts in review and relearning, not initial learning/);
    assert.match(t.text(), /Results are kept in memory only/);
    assert.equal(t.anki.state.requests.length, 0, "switching tabs sends no review read");
    assert.ok(!t.calls.includes("checkReviews"));

    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    const topics = Array.from(t.container.querySelectorAll(".ab-topic") as ArrayLike<HTMLElement>);
    assert.deepEqual(topics.map(n => n.dataset.nodeId), ["node-f", "node-r"]);
    const femto = topics[0]!.textContent!;
    assert.match(femto, /Femto prefix/);
    assert.match(femto, /2 Again in 30 days/);
    assert.match(femto, /tagged leech/);
    assert.match(femto, /What does femto denote\?/);
    assert.match(femto, /suspended in Anki/);
    const radius = topics[1]!.textContent!;
    assert.match(radius, /4 lapses/);
    assert.match(radius, /deck Year 3::Nuclear/);
    assert.match(t.text(), /Skipped 1 card no longer in Anki\./);
    assert.match(t.text(), /Skipped 1 card with a different note type or delivery ID\./);
    assert.match(t.text(), /Checked at .* in "Throwaway"\. 2 cards read\./);

    assert.doesNotMatch(t.text(), /Paired profile:/, "the checked profile already appears in the summary");

    assert.equal(t.find("Open session"), undefined, "the host has not committed these buttons yet");
    t.commitButtons(); await tick();
    for (const [topic, session] of [[topics[1]!, "Nuclear lecture"], [topics[0]!, "Prefixes workshop"]] as const) {
      const row = topic.querySelector(".ab-topic-sessions")!;
      assert.equal(row.querySelector("span")!.textContent, `From ${session}`);
      const open = row.querySelector("button")!;
      assert.equal(open.textContent, "Open session");
      assert.equal(open.getAttribute("aria-label"), `Open session: ${session}`);
      open.click(); await tick();
    }
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
    await t.click("Clear results");
    const confirm = Array.from(t.doc.querySelectorAll(".ab-dialog button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Clear")!;
    confirm.click(); await settle(() => !t.container.querySelector(".ab-topic"));
    assert.match(t.text(), /Not checked yet/);
    assert.equal((await t.service.command("lastReviewCheck")).check, null);
  } finally { await t.cleanup(); }
});

test("asynchronously mounted session buttons distinguish same-title and untitled destinations", async () => {
  const t = await setup({ duplicateSessionTitles: true, deferSessionButtons: true });
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => t.container.querySelectorAll(".ab-topic-sessions").length === 5);
    const rows = Array.from(t.container.querySelectorAll(".ab-topic-sessions") as ArrayLike<HTMLElement>);
    assert.deepEqual(rows.map(row => row.querySelector("span")?.textContent), [
      "From Nuclear lecture", "From Session", "From Nuclear lecture", "From Nuclear  lecture", "From Session",
    ]);
    assert.equal(t.find("Open session"), undefined, "the host has not mounted the actual buttons");
    t.commitButtons(); await tick();
    const buttons = rows.map(row => row.querySelector("button")!);
    const date = (day: number) => new Date(Date.UTC(2026, 10, day, 9)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    assert.deepEqual(buttons.map(b => b.getAttribute("aria-label")), [
      `Open session: Nuclear lecture (created ${date(19)})`, "Open session: Session (ID chat-5)",
      `Open session: Nuclear lecture (created ${date(18)})`, "Open session: Nuclear lecture (ID chat-3)", "Open session: Session (ID chat-4)",
    ]);
    for (const b of buttons) { assert.equal(b.textContent, "Open session"); b.click(); }
    assert.deepEqual(t.sessions, ["chat-2", "chat-5", "chat-1", "chat-3", "chat-4"]);
  } finally { await t.cleanup(); }
});

test("review checks distinguish no signals from all cards skipped", async () => {
  const t = await setup();
  try {
    const [radius, femto] = t.anki.state.notes;
    radius.cards[0].lapses = 0;
    femto.tags = [];
    femto.cards[0].reviews = [];
    const emptyState = () => t.container.querySelector(".ab-topics .ab-empty")?.textContent;
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => emptyState() !== undefined);
    assert.equal(emptyState(), "No review signals found.");
    assert.match(t.text(), /2 cards read\./);

    t.anki.state.notes.splice(0, 2);
    await t.click("Check Anki reviews");
    await settle(() => /0 cards read\./.test(t.text()));
    assert.equal(emptyState(), "No cards could be checked.");
    assert.match(t.text(), /Skipped 3 cards no longer in Anki\./);
    assert.match(t.text(), /Skipped 1 card with a different note type or delivery ID\./);
  } finally { await t.cleanup(); }
});

test("a wrong profile shows a plain error, reads no notes and drops the old result", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
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
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    await t.anki.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    await t.click("Check Anki reviews");
    await settle(() => /out of date/.test(t.text()));
    assert.match(t.text(), /Anki isn't running or AnkiConnect isn't reachable/);
    assert.match(t.text(), /Last checked at .*May be out of date\./);
    assert.equal(t.container.querySelectorAll(".ab-topic").length, 2);
  } finally { await t.cleanup(); }
});

test("without a pairing the check is unavailable and points to settings", async () => {
  const t = await setup({ paired: false });
  try {
    await t.mountReviews();
    assert.equal(t.find("Check Anki reviews")!.disabled, true);
    assert.match(t.text(), /Pair an Anki profile in Settings first/);
    await t.click("Open settings");
    assert.equal(t.settingsOpened(), 1);
    assert.equal(t.anki.state.requests.length, 0);
  } finally { await t.cleanup(); }
});

test("tabs use arrow keys (with wraparound), Home and End with roving focus", async () => {
  const t = await setup();
  try {
    await t.mount();
    const tabs = [t.tab("Make cards"), t.tab("Check Anki reviews")];
    const assertSelected = (index: number) => {
      assert.equal(t.doc.activeElement, tabs[index]);
      tabs.forEach((tab, i) => {
        const selected = i === index;
        const panel = t.panel(tab.textContent!);
        assert.equal(tab.getAttribute("aria-selected"), String(selected));
        assert.equal(tab.tabIndex, selected ? 0 : -1);
        assert.equal(panel.getAttribute("role"), "tabpanel");
        assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
        assert.equal(panel.hidden, !selected);
      });
    };
    assert.equal(t.container.querySelector('[role="tablist"]').getAttribute("aria-label"), "Anki Bridge");
    tabs[0]!.focus(); assertSelected(0);
    for (const [key, index] of [["ArrowLeft", 1], ["ArrowRight", 0], ["End", 1], ["Home", 0], ["ArrowRight", 1], ["ArrowLeft", 0]] as const) {
      const event = new t.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      t.doc.activeElement.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, key);
      assertSelected(index);
    }
    assert.ok(!t.calls.includes("checkReviews"));
    assert.equal(t.anki.state.requests.length, 0);
  } finally { await t.cleanup(); }
});

test("switching tabs preserves card filters and review results without another read", async () => {
  const t = await setup();
  try {
    await t.mount();
    const search = t.panel("Make cards").querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "nuclear";
    search.dispatchEvent(new t.window.Event("input", { bubbles: true }) as never);
    await t.openReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    const readCount = t.anki.state.requests.length;
    assert.ok(readCount > 0);
    t.tab("Make cards").click(); await tick();
    assert.equal(t.panel("Make cards").querySelector('input[type="search"]'), search);
    assert.equal(search.value, "nuclear");
    await t.openReviews();
    assert.deepEqual([...t.panel("Check Anki reviews").querySelectorAll<HTMLElement>(".ab-topic")].map(topic => topic.dataset.nodeId), ["node-f", "node-r"]);
    assert.equal(t.calls.filter(call => call === "checkReviews").length, 1);
    assert.equal(t.anki.state.requests.length, readCount);
  } finally { await t.cleanup(); }
});

test("restoring Check Anki reviews defers Make cards' connection reads through resync and Settings saves", async () => {
  const t = await setup();
  const reads = () => t.calls.filter(call => call === "connection").length;
  try {
    const unmountFirst = await t.mountReviews();
    assert.equal(reads(), 1, "the default Make cards tab is initially visible");
    unmountFirst();
    t.calls.length = 0;
    const unmount = await t.mount();
    const cards = t.panel("Make cards");
    assert.equal(cards.hidden, true);
    assert.equal(reads(), 0, "restoring the reviews tab does not read decks or tags");

    const setProfile = (profile: string) => t.store.replace({ ...t.store.snapshot(), destination: { url: t.destination.url, profile } });
    const resyncAs = async (profile: string) => {
      await setProfile(profile);
      for (const resync of t.resyncs) resync();
      await tick();
    };
    await resyncAs("Second");
    assert.match(t.text(), /Paired profile: "Second"/);
    assert.equal(reads(), 0, "hidden resync defers a lookup even when the pairing changes");

    const settings = await t.openSettings();
    await setProfile("Latest");
    const template = [...settings.host.querySelectorAll("label")].find(label => label.textContent?.startsWith("Tags for new cards"))!.querySelector("input")!;
    template.value = "new-tag";
    template.dispatchEvent(new t.window.Event("change", { bubbles: true }) as never);
    await tick();
    assert.ok(t.calls.includes("settings"));
    assert.match(t.text(), /Paired profile: "Latest"/);
    assert.equal(reads(), 0, "a Settings peer refresh also defers the lookup");
    settings.dispose();

    t.tab("Make cards").click(); await tick();
    assert.equal(cards.hidden, false);
    assert.equal(reads(), 1);
    const optionValues = (id: string) => [...cards.querySelectorAll<HTMLOptionElement>(`#${id} option`)].map(o => o.value);
    assert.deepEqual(optionValues("anki-bridge-decks"), ["Latest deck"]);
    const tags = cards.querySelector<HTMLInputElement>('input[list="anki-bridge-tags"]')!;
    tags.value = "stu";
    tags.dispatchEvent(new t.window.Event("input", { bubbles: true }) as never);
    assert.deepEqual(optionValues("anki-bridge-tags"), ["study"]);

    await resyncAs("Third");
    assert.equal(reads(), 2, "a visible resync still refreshes the changed pairing");
    assert.deepEqual(optionValues("anki-bridge-decks"), ["Third deck"]);
    assert.equal(t.anki.state.requests.length, 0, "only mocked connection reads ran");
    unmount();
  } finally { await t.cleanup(); }
});

test("Bridge restores the chosen tab on remount, but a pending session Make cards request takes precedence", async () => {
  const t = await setup();
  try {
    const unmountFirst = await t.mountReviews();
    unmountFirst();

    const unmountSecond = await t.mount();
    assert.equal(t.tab("Check Anki reviews").getAttribute("aria-selected"), "true");
    assert.equal(t.panel("Check Anki reviews").hidden, false);
    assert.equal(t.panel("Make cards").hidden, true);
    assert.equal(t.anki.state.requests.length, 0, "restoring the tab does not run a check");
    unmountSecond();

    assert.equal(t.sessionReads.length, 0);
    const context = { surface: "session", placement: "top-bar", sessionId: "chat-1", kind: "teaching" } as PluginActionContext;
    await t.actions.get("make-cards")!.run(context);
    assert.equal(t.opened(), "bridge");
    assert.equal(t.sessionReads.length, 0, "the view has not mounted yet");
    t.calls.length = 0;
    const unmountCards = await t.mount();
    assert.equal(t.calls.filter(call => call === "connection").length, 1, "the pending request activates Make cards and loads its deck and tag suggestions");
    assert.equal(t.tab("Make cards").getAttribute("aria-selected"), "true");
    assert.equal(t.panel("Check Anki reviews").hidden, true);
    assert.equal(t.panel("Make cards").querySelector<HTMLSelectElement>('select[aria-label="Ideas from"]')!.value, "chat-1");
    assert.match(t.panel("Make cards").textContent!, /Review the scaling law/);
    unmountCards();
  } finally { await t.cleanup(); }
});

test("a session Make cards action selects the cards tab, transfers focus if needed and scopes the ideas", async () => {
  const t = await setup();
  try {
    await t.mount();
    const cards = t.tab("Make cards"), reviews = t.tab("Check Anki reviews");
    const outside = t.doc.createElement("button");
    t.doc.body.append(outside);
    const context = { surface: "session", placement: "top-bar", sessionId: "chat-1", kind: "teaching" } as PluginActionContext;
    for (const from of [reviews, t.find("Check Anki reviews")!, outside]) {
      await t.openReviews();
      from.focus();
      assert.equal(t.doc.activeElement, from);
      await t.actions.get("make-cards")!.run(context);
      assert.equal(t.doc.activeElement, from === outside ? outside : cards);
      assert.equal(t.opened(), "bridge");
      assert.equal(cards.getAttribute("aria-selected"), "true");
      assert.equal(t.panel("Make cards").hidden, false);
      assert.equal(t.panel("Check Anki reviews").hidden, true);
      await tick();
    }
    const panel = t.panel("Make cards");
    assert.equal(panel.querySelector<HTMLSelectElement>('select[aria-label="Ideas from"]')!.value, "chat-1");
    assert.match(panel.textContent!, /Review the scaling law/);
    const selected = () => panel.querySelector<HTMLInputElement>('input[aria-label="Include flag 1 request"]')!.checked;
    const flagTitle = () => panel.querySelector(".ab-flags-title")!.textContent;
    assert.equal(selected(), true, "the eligible flagged idea is preselected");
    assert.equal(flagTitle(), "1 flagged reply");
    const clear = Array.from(panel.querySelectorAll("button")).find(b => b.textContent === "Clear")!;
    clear.click();
    assert.equal(selected(), false);
    assert.equal(flagTitle(), "1 flagged reply", "the count is independent of selection");
    assert.ok(t.sessionReads.length > 0);
    assert.deepEqual([...new Set(t.sessionReads)], ["chat-1"]);
    assert.ok(!t.calls.includes("checkReviews"));
    assert.equal(t.anki.state.requests.length, 0);
  } finally { await t.cleanup(); }
});

test("S5: after the pairing changes elsewhere, the page re-reads it so the next check uses the new profile", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    await t.store.replace({ ...t.store.snapshot(), destination: { url: t.destination.url, profile: "Second" } });
    await t.click("Check Anki reviews");
    await settle(() => /Paired profile changed/.test(t.text()));
    await settle(() => /profile "Second"/.test(t.text()));
    assert.match(t.text(), /Paired profile: "Second"/);
    assert.equal(t.anki.state.requests.length, 0);
    t.anki.state.profile = "Second";
    await t.click("Check Anki reviews");
    await settle(() => /Checked at/.test(t.text()));
    assert.match(t.text(), /in "Second"/);

    // A host resync also re-reads the pairing.
    await t.store.replace({ ...t.store.snapshot(), destination: { url: t.destination.url, profile: "Third" } });
    for (const f of t.resyncs) f();
    await settle(() => /Paired profile: "Third"/.test(t.text()));
    assert.match(t.text(), /Paired profile: "Third"/);
  } finally { await t.cleanup(); }
});

test("F5: a Settings save in another pane re-reads the pairing, even during a check", async () => {
  const t = await setup({ paired: false });
  const peers = new Set<() => void>();
  try {
    const dispose = mountTopics(t.ctx, t.container, t.scope.signal, peers);
    await tick();
    assert.equal(t.find("Check Anki reviews")!.disabled, true);
    assert.equal(peers.size, 1, "Topics listens to Settings saves");
    await t.store.replace({ ...t.store.snapshot(), destination: { ...t.destination } });
    for (const peer of peers) peer();
    await settle(() => t.find("Check Anki reviews")?.disabled === false);
    assert.match(t.text(), /Paired profile: "Throwaway"/);

    // A save during a check is held until the check ends, then applied.
    t.anki.state.delay = 40;
    await t.click("Check Anki reviews");
    await t.store.replace({ ...t.store.snapshot(), destination: { url: t.destination.url, profile: "Later" } });
    for (const peer of peers) peer();
    await settle(() => /Paired profile: "Later"/.test(t.text()));
    assert.match(t.text(), /Paired profile: "Later"/);
    dispose();
    assert.equal(peers.size, 0);
  } finally { await t.cleanup(); }
});

test("round 3 S2: an older reload that answers last does not bring back the previous pairing", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    let release!: () => void;
    t.setHold(new Promise<void>(resolve => { release = resolve; }));
    for (const f of t.resyncs) f();            // reload 1 reads profile "Throwaway", then waits
    await tick();
    t.setHold(undefined);
    await t.store.replace({ ...t.store.snapshot(), destination: { url: t.destination.url, profile: "Second" } });
    for (const f of t.resyncs) f();            // reload 2 reads "Second" and answers first
    await settle(() => /Paired profile: "Second"/.test(t.text()));
    release(); await tick();                   // reload 1 answers last
    assert.match(t.text(), /Paired profile: "Second"/);
    assert.doesNotMatch(t.text(), /Paired profile: "Throwaway"/);
  } finally { await t.cleanup(); }
});

test("round 4 S1: a superseded reload that fails does not replace newer feedback", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    let fail!: (e: Error) => void;
    t.setHold(new Promise<void>((_, reject) => { fail = reject; }));
    for (const f of t.resyncs) f();            // reload 1 waits, then fails
    await tick();
    t.setHold(undefined);
    await t.click("Check Anki reviews");
    await settle(() => /topics? to revisit\./.test(t.text()));
    fail(new Error("old reload failed")); await tick();
    assert.doesNotMatch(t.text(), /old reload failed/);
    assert.match(t.text(), /2 topics to revisit\./);
  } finally { await t.cleanup(); }
});

test("Clear cannot report success while a check started in a previous mount is running", async () => {
  const t = await setup();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const dispose = await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    assert.ok(t.find("Clear results"));
    t.anki.state.after = action => action === "version" ? held : undefined;
    await t.click("Check Anki reviews");
    assert.equal((await t.service.command("lastReviewCheck")).running, true);
    dispose();
    await t.mount();
    assert.equal(t.panel("Check Anki reviews").hidden, false);
    assert.ok(t.find("Clear results"), "the prior result is restored from memory");

    const confirmClear = async () => {
      await t.click("Clear results");
      const confirm = Array.from(t.doc.querySelectorAll(".ab-dialog button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Clear")!;
      confirm.click(); await tick();
    };
    await confirmClear();
    assert.match(t.text(), /Wait for the review check to finish\./);
    assert.doesNotMatch(t.text(), /Cleared\./);
    assert.ok((await t.service.command("lastReviewCheck")).check, "nothing was cleared during the check");

    release();
    for (let i = 0; i < 100 && (await t.service.command("lastReviewCheck")).running; i++) await tick();
    assert.equal((await t.service.command("lastReviewCheck")).running, false, "the held check finished");
    await confirmClear();
    assert.match(t.text(), /Cleared\./);
    assert.equal((await t.service.command("lastReviewCheck")).check, null);
  } finally { release(); await t.cleanup(); }
});

test("#52: a rejected Clear does not discard a pending pairing refresh", async () => {
  const t = await setup();
  let releaseCheck!: () => void, releaseRefresh!: () => void;
  const heldCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  try {
    const dispose = await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!topicBox(t, "node-r"));
    t.anki.state.after = action => action === "version" ? heldCheck : undefined;
    await t.click("Check Anki reviews");
    assert.equal((await t.service.command("lastReviewCheck")).running, true);
    dispose();
    await t.mount();
    assert.ok(t.find("Clear results"));

    await t.store.replace({ ...t.store.snapshot(), destination: null });
    t.setHold(new Promise<void>(resolve => { releaseRefresh = resolve; }));
    for (const refresh of t.resyncs) refresh();
    await tick();
    await t.click("Clear results");
    const confirm = Array.from(t.doc.querySelectorAll(".ab-dialog button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Clear")!;
    confirm.click(); await tick();
    assert.match(t.text(), /Wait for the review check to finish/);
    releaseRefresh(); await tick();
    assert.match(t.text(), /Not checked yet/);
    assert.ok(!t.find("Clear results"));
  } finally { releaseRefresh?.(); releaseCheck(); await t.cleanup(); }
});

test("round 4 S2: a reload begun before Clear cannot bring the cleared result back", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    let release!: () => void;
    t.setHold(new Promise<void>(resolve => { release = resolve; }));
    for (const f of t.resyncs) f();            // reload 1 has the old result and waits on snapshot
    await tick();
    t.setHold(undefined);
    await t.click("Clear results");
    const confirm = Array.from(t.doc.querySelectorAll(".ab-dialog button") as ArrayLike<HTMLButtonElement>).find(b => b.textContent === "Clear")!;
    confirm.click();
    await settle(() => !t.container.querySelector(".ab-topic"));
    release(); await tick();
    assert.equal(t.container.querySelectorAll(".ab-topic").length, 0);
    assert.match(t.text(), /Not checked yet/);
  } finally { await t.cleanup(); }
});

test("#52: Practise selected starts a Practice session with only the ticked ideas and opens it", async () => {
  const t = await setup();
  const original = globalThis.fetch;
  const requests: { url: string; body?: any }[] = [];
  let create = () => new Response(JSON.stringify({ id: "chat_new" }));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/api/chats")) return original(url, init);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/chats") return create();
    const propositions = requests.find(r => r.url === "/api/chats")!.body.graphContext.propositions;
    return new Response(JSON.stringify({ kind: "practice", messages: [{ customType: "graph-context", details: { propositions } }] }));
  }) as typeof fetch;
  try {
    await t.mountReviews();
    assert.equal(t.find(/^Practise selected/), undefined, "nothing to practise before a check");
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    assert.match(t.text(), /Practice gets the ideas, not their review counts/);
    const practise = () => t.find(/^Practise selected/)!;
    assert.equal(practise().disabled, true, "nothing ticked yet");
    const boxes = Array.from(t.container.querySelectorAll('.ab-topic input[type="checkbox"]') as ArrayLike<HTMLInputElement>);
    assert.deepEqual(boxes.map(b => b.getAttribute("aria-label")), ["Select Femto prefix for Practice", "Select Nuclear radius for Practice"]);
    assert.ok(boxes.every(b => !b.checked), "nothing is preselected");
    const ankiBefore = t.anki.state.requests.length;

    // A host refusal keeps the selection and explains the fallback.
    create = () => new Response("{}", { status: 404 });
    boxes[1]!.click(); await tick();
    assert.equal(practise().textContent, "Practise selected (1)");
    await t.click(/^Practise selected/); await tick();
    assert.match(t.text(), /HTTP 404.*Practice → Pick nodes instead/);
    assert.deepEqual(t.sessions, []);
    assert.equal(t.find(/^Practise selected/)!.textContent, "Practise selected (1)");

    create = () => new Response(JSON.stringify({ id: "chat_new" }));
    requests.length = 0;
    await t.click(/^Practise selected/); await settle(() => t.sessions.length > 0);
    assert.deepEqual(requests[0], { url: "/api/chats", body: { title: "Practice: Nuclear radius", kind: "practice",
      graphContext: { propositions: [{ id: "node-r", name: "Nuclear radius", statement: "Nuclear radius varies with mass number." }] } } });
    assert.deepEqual(t.sessions, ["chat_new"]);
    assert.doesNotMatch(JSON.stringify(requests), /lapse|leech|Again|What is/, "no Anki evidence or card text reaches Practice");
    assert.equal(t.anki.state.requests.length, ankiBefore, "starting Practice sends nothing to Anki");
    assert.ok(Array.from(t.container.querySelectorAll('.ab-topic input[type="checkbox"]') as ArrayLike<HTMLInputElement>).every(b => !b.checked), "selection clears after opening");
  } finally { globalThis.fetch = original; await t.cleanup(); }
});

test("#52: Select all skips missing topics and Clear results drops the selection", async () => {
  const t = await setup({ onlyNodes: ["node-f"] });
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!t.container.querySelector(".ab-topic"));
    const radius = t.container.querySelector('[data-node-id="node-r"]') as HTMLElement;
    assert.match(radius.textContent!, /Missing from this graph read/);
    assert.equal(radius.querySelector('input[type="checkbox"]'), null);
    assert.equal(topicBox(t, "node-f")!.checked, false);
    const before = t.calls.length;
    await t.click("Select all topics");
    assert.equal(t.calls.length, before, "selecting topics is local to the view");
    assert.equal(topicBox(t, "node-f")!.checked, true);
    assert.equal(t.find("Select all topics")!.disabled, true);
    assert.equal(t.find(/^Practise selected/)!.textContent, "Practise selected (1)");
    topicBox(t, "node-f")!.click(); await tick();
    assert.equal(t.find("Select all topics")!.disabled, false);
    assert.equal(t.find("Practise selected")!.disabled, true);
    await t.click("Select all topics");
    await t.click("Clear results");
    const dialogConfirm = Array.from(t.doc.querySelectorAll("button") as ArrayLike<HTMLButtonElement>).filter(b => b.textContent === "Clear").pop()!;
    dialogConfirm.click(); await settle(() => /Not checked yet/.test(t.text()));
    assert.equal(t.find(/^Practise selected/), undefined);
    assert.equal(t.find("Select all topics"), undefined);
  } finally { await t.cleanup(); }
});

test("#52: Select first 64 replaces picks with the first 64 selectable topics in list order", async () => {
  const t = await setup();
  const call = t.ctx.call.bind(t.ctx);
  t.ctx.call = async <T>(name: string, input?: unknown) => {
    if (name !== "checkReviews") return call<T>(name, input);
    const answer = await call<{ check: ReviewCheck; running: boolean }>(name, input);
    const sample = answer.check.topics[0]!;
    return { ...answer, check: { ...answer.check, topics: Array.from({ length: 66 }, (_, i) => ({
      ...sample, nodeId: `n${i}`, inGraph: i !== 0, sessions: [], cards: [],
    })) } } as T;
  };
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!topicBox(t, "n65"));
    topicBox(t, "n65")!.click(); await tick();
    await t.click("Select first 64");
    assert.ok(!topicBox(t, "n0"));
    assert.ok(Array.from({ length: 64 }, (_, i) => topicBox(t, `n${i + 1}`)!.checked).every(Boolean));
    assert.equal(topicBox(t, "n65")!.checked, false);
    assert.equal(t.find("Select first 64")!.disabled, true);
    assert.ok(t.find("Practise selected (64)"));
  } finally { await t.cleanup(); }
});

function topicBox(t: Awaited<ReturnType<typeof setup>>, id: string): HTMLInputElement | null {
  return t.container.querySelector(`[data-node-id="${id}"] input[type="checkbox"]`);
}

test("#52: rechecking updates the Practice count when a selected topic drops out", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!topicBox(t, "node-r"));
    topicBox(t, "node-r")!.click();
    topicBox(t, "node-f")!.click(); await tick();
    assert.ok(t.find("Practise selected (2)"));
    t.anki.state.notes.splice(0, 1);
    await t.click("Check Anki reviews");
    await settle(() => !topicBox(t, "node-r"));
    assert.ok(topicBox(t, "node-f")!.checked);
    assert.ok(t.find("Practise selected (1)"));
  } finally { await t.cleanup(); }
});

test("#52: topics deleted after the check stay untickable until a new check", async () => {
  const t = await setup();
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!topicBox(t, "node-r"));
    topicBox(t, "node-r")!.click();
    topicBox(t, "node-f")!.click(); await tick();
    t.setOnlyNodes(["node-f"]);
    await t.click("Practise selected (2)");
    assert.match(t.text(), /Unticked 1 idea no longer in your graph/);
    assert.ok(!topicBox(t, "node-r"));
    for (const refresh of t.resyncs) refresh();
    await tick();
    assert.ok(!topicBox(t, "node-r"), "reloading the same results does not re-enable a deleted idea");
    assert.ok(topicBox(t, "node-f")!.checked);
    topicBox(t, "node-f")!.click(); await tick();
    assert.equal(t.find("Practise selected")!.disabled, true);
    assert.doesNotMatch(t.text(), /Press Practise selected again/);
    topicBox(t, "node-f")!.click(); await tick();
    t.setOnlyNodes([]);
    await t.click("Practise selected (1)");
    assert.ok(!topicBox(t, "node-f"));
    assert.match(t.text(), /Unticked 1 idea/);
    assert.doesNotMatch(t.text(), /Press Practise selected again/);
    assert.deepEqual(t.sessions, []);
  } finally { await t.cleanup(); }
});

test("#52: Clear and a new check are disabled while the Practice picks are being resolved", async () => {
  const t = await setup();
  const original = globalThis.fetch;
  let release!: () => void;
  try {
    await t.mountReviews();
    await t.click("Check Anki reviews");
    await settle(() => !!topicBox(t, "node-r"));
    topicBox(t, "node-r")!.click(); await tick();
    t.holdPracticeNodes(new Promise<void>(resolve => { release = resolve; }));
    globalThis.fetch = (async (url, init) => url === "/api/chats" ? new Response(null, { status: 404 }) : original(url, init)) as typeof fetch;
    await t.click("Practise selected (1)");
    assert.ok(t.calls.includes("practiceNodes"));
    assert.equal(t.find("Clear results")!.disabled, true);
    assert.equal(t.find("Select all topics")!.disabled, true);
    assert.equal(t.find("Check Anki reviews")!.disabled, true);
    release();
    await settle(() => !t.find("Clear results")!.disabled);
    assert.equal(t.find("Clear results")!.disabled, false);
  } finally { release?.(); globalThis.fetch = original; await t.cleanup(); }
});
