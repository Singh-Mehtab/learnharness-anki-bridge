import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { activate } from "../src/main.ts";
import { connectionText } from "../src/settings-ui.ts";
import type { PluginFrontendContext, PluginView } from "../sdk/index.d.ts";
import { chooseMenu, fakeUi } from "./fake-ui.ts";

type Call = { name: string; input: any };
type Card = Record<string, unknown> & { id: string; status: string };
const paired = () => ({ url: "http://127.0.0.1:8765/", profile: "Throwaway" });
const card = (id: string, over: Partial<Card> = {}): Card => ({ id, nodeId: `node-${id}`, statementHash: "h", sessionId: "s1", nodeName: `Idea ${id}`, sessionName: "Session",
  kind: "recall", front: `Question ${id}`, back: "Answer", extra: "", status: "draft", ...over });
function fixture() {
  return {
    settings: { url: "http://127.0.0.1:8765/", lastDeck: "Scratch", hasApiKey: true, tagTemplate: "{deck}::Lecture_01", systemTags: true },
    destination: paired() as { url: string; profile: string } | null,
    cards: [] as Card[],
  };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };

async function setup(options: { handler?: (name: string, input: any) => unknown; state?: ReturnType<typeof fixture>; connection?: () => unknown } = {}) {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController(), activation = new AbortController();
  const calls: Call[] = [], cleanups: Array<() => void> = [];
  const state = options.state ?? fixture();
  let view!: PluginView, settings!: PluginView["mount"], openedView = "", settingsOpened = 0;
  const actions = new Map<string, { run: (context?: unknown) => void }>();
  const placements: Array<{ actionId: string; location: string }> = [];
  const resyncs = new Set<() => void>();
  let coverageReads = 0;
  const ctx = {
    signal: activation.signal,
    cleanup: (fn: () => void) => cleanups.push(fn),
    registerView: (value: PluginView) => { view = value; return () => {}; },
    registerAction: (value: { id: string; run: () => void }) => { actions.set(value.id, value); return () => {}; },
    placeAction: (value: { actionId: string; location: string }) => { placements.push(value); return () => {}; },
    onAppEvent: () => () => {},
    registerSettings: (value: PluginView["mount"]) => { settings = value; return () => {}; },
    onResync: (listener: () => void) => { resyncs.add(listener); return () => { resyncs.delete(listener); }; },
    app: { openView: (id: string) => { openedView = id; }, openSettings: () => { settingsOpened++; } },
    call: async (name: string, input: any) => {
      if (name === "coverageContext") coverageReads++;
      if (name === "coverageContext") return { nodes: [], missing: [], cardsPerNode: 2, paired: true, pairingWarning: false };
      if (name === "generationStatus") return { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall"], model: null }, generations: [] };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      calls.push({ name, input });
      const handled = await options.handler?.(name, input);
      if (handled !== undefined) return handled;
      if (name === "connection") return options.connection ? options.connection() : { profile: "Throwaway", decks: ["Scratch", "New::Deck"] };
      if (name === "settings") Object.assign(state.settings, input.apiKey === undefined ? {} : { hasApiKey: !!input.apiKey }, input.url ? { url: input.url } : {}, input.tagTemplate === undefined ? {} : { tagTemplate: input.tagTemplate }, input.systemTags === undefined ? {} : { systemTags: input.systemTags });
      if (name === "pair") state.destination = input.expectedDestination;
      if (name === "edit") Object.assign(state.cards.find(c => c.id === input.id)!, { front: input.front, back: input.back, extra: input.extra, status: "draft" });
      if (name === "approve") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "approved"; });
      if (name === "drop") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "dropped"; });
      if (name === "draft") state.cards.push(card(`manual-${state.cards.length}`, { front: input.front, back: input.back, extra: input.extra, kind: input.kind, nodeName: "Hand-written card", sessionName: "Manual" }));
      if (name === "send") state.settings.lastDeck = input.deck;
      if (name === "send") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { Object.assign(c, { status: "sent", noteId: 7, deck: input.deck, destination: paired() }); });
      return structuredClone(state);
    },
    ui: fakeUi(),
  } as unknown as PluginFrontendContext;
  activate(ctx);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const cleanup = await view.mount(container as unknown as HTMLElement, controller.signal);
  await tick();
  // happy-dom nodes stand in for lib.dom ones in these tests.
  const doc = window.document as any;
  const find = (label: string | RegExp, parent: any = doc) => Array.from(parent.querySelectorAll("button") as ArrayLike<HTMLButtonElement>).find(node => typeof label === "string" ? node.textContent === label : label.test(node.textContent ?? ""));
  const button = (label: string | RegExp, parent: any = doc) => { const found = find(label, parent); assert.ok(found, `button ${label}`); return found as unknown as HTMLButtonElement; };
  const event = (type: string) => new window.Event(type) as never;
  const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string, kind = "input") => { input.value = value; input.dispatchEvent(event(kind)); };
  const mountSettings = async () => {
    const host = doc.createElement("div"); doc.body.append(host);
    const scope = new AbortController();
    const dispose = await settings(host as unknown as HTMLElement, scope.signal);
    await tick();
    return { host, close: () => { scope.abort(); if (typeof dispose === "function") void dispose(); } };
  };
  return {
    window, doc, calls, state, container, button, find, event, type, mountSettings, ctx,
    dialog: () => doc.querySelector(".ab-dialog"),
    review: () => container.querySelector(".ab-cards")!,
    deck: () => container.querySelector(".ab-send-bar input") as unknown as HTMLInputElement,
    tags: () => container.querySelectorAll(".ab-send-bar input")[1] as unknown as HTMLInputElement,
    status: () => container.querySelector(".ab-send-bar + .ab-status")!.textContent,
    more: async (label: string | RegExp) => { button("More", container).click(); await chooseMenu(label); },
    openSidebar: () => {
      assert.deepEqual(placements.map(p => [p.actionId, p.location]), [["flag-for-anki", "top-bar"], ["make-cards", "top-bar"], ["open-bridge", "sidebar"]]);
      actions.get("open-bridge")?.run(); return openedView;
    },
    settingsOpened: () => settingsOpened,
    coverageReads: () => coverageReads,
    resync: async () => { for (const listener of resyncs) listener(); await tick(); },
    dispose: async () => { controller.abort(); if (typeof cleanup === "function") await cleanup(); cleanups.forEach(fn => fn()); await window.happyDOM.close(); },
  };
}

test("the plugin registers a sidebar action, the view and a settings page", async () => {
  const f = await setup();
  try {
    assert.equal(f.openSidebar(), "bridge");
    for (const step of ["Choose ideas", "Write cards", "Review and send"]) assert.match(f.container.textContent!, new RegExp(step));
    assert.equal(f.container.querySelector("fieldset"), null, "no raw fieldset forms");
    const s = await f.mountSettings();
    for (const panel of ["Connect to Anki", "Anki profile", "Tags", "Note type"]) assert.match(s.host.textContent!, new RegExp(panel));
    assert.doesNotMatch(f.container.textContent!, /Add missing fields|AnkiConnect address/, "upkeep lives only in settings");
    s.close();
  } finally { await f.dispose(); }
});

test("settings save a key without showing the stored one, warn about localhost and remove a key with a button", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const [url, key] = Array.from(s.host.querySelectorAll("input")) as unknown as HTMLInputElement[];
    assert.equal(key.type, "password"); assert.equal(key.value, "");
    assert.match(key.placeholder, /Saved key/);
    assert.equal(f.button("Save", s.host).disabled, true, "nothing to save yet");
    f.type(url, "http://localhost:8765");
    assert.match(s.host.textContent!, /Use 127\.0\.0\.1 instead of localhost/);
    assert.match(s.host.textContent!, /Saving a different address removes the saved API key/);
    f.type(url, "http://127.0.0.1:8765/"); f.type(key, "secret");
    f.button("Save", s.host).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "settings")!.input, { url: "http://127.0.0.1:8765/", apiKey: "secret" });
    assert.equal(key.value, "", "the typed key is not kept on screen");
    assert.doesNotMatch(s.host.textContent!, /secret/);
    f.button("Remove saved key", s.host).click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "settings").at(-1)!.input, { url: "http://127.0.0.1:8765/", apiKey: "" });
    assert.equal(f.find("Remove saved key", s.host), undefined);
    s.close();
  } finally { await f.dispose(); }
});

test("changing the address clears a key typed for the previous one", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const [url, key] = Array.from(s.host.querySelectorAll("input")) as unknown as HTMLInputElement[];
    f.type(key, "typed-for-old");
    f.type(url, "http://127.0.0.1:9999");
    assert.equal(key.value, "");
    assert.match(s.host.textContent!, /The key you typed was cleared because the address changed\./);
    f.type(key, "typed-for-new");
    assert.doesNotMatch(s.host.textContent!, /The key you typed was cleared/);
    s.close();
  } finally { await f.dispose(); }
});

test("the connection test reports Anki closed, no profile, or a short success without listing decks", async () => {
  let result: () => unknown = () => { throw new Error("Could not complete the AnkiConnect request."); };
  const f = await setup({ connection: () => result() });
  try {
    const s = await f.mountSettings();
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /Couldn't reach Anki at http:\/\/127\.0\.0\.1:8765\/\. Open Anki, check that AnkiConnect is installed, then test again\./);
    assert.equal(s.host.querySelector('.ab-status[data-tone="error"]') !== null, true);
    result = () => ({ profile: null, decks: [] });
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /no profile is loaded/);
    result = () => ({ profile: "Throwaway", decks: ["Scratch", "New::Deck"] });
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /Connected\. Profile Throwaway is open with 2 decks\./);
    assert.doesNotMatch(s.host.textContent!, /New::Deck/);
    const [url] = Array.from(s.host.querySelectorAll("input")) as unknown as HTMLInputElement[];
    f.type(url, "http://127.0.0.1:9999");
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /Save the new address or key first/);
    assert.equal(connectionText("u", new Error("HTTP 500")).text, "Connection failed: HTTP 500");
    s.close();
  } finally { await f.dispose(); }
});

test("choosing a profile needs dialog confirmation, refuses a closed profile, and refreshes the open page", async () => {
  const state = fixture(); state.destination = null;
  let profile: string | null = null;
  const f = await setup({ state, connection: () => ({ profile, decks: [] }) });
  try {
    assert.match(f.container.textContent!, /Choose an Anki profile in settings before sending/);
    f.button("Open settings", f.container).click(); assert.equal(f.settingsOpened(), 1);
    const s = await f.mountSettings();
    f.button("Use the open profile", s.host).click(); await tick();
    assert.equal(f.dialog(), null, "no dialog without an open profile");
    assert.match(s.host.textContent!, /no profile is loaded/);
    profile = "Throwaway";
    f.button("Use the open profile", s.host).click(); await tick();
    assert.match(f.dialog()!.textContent!, /New cards will go to the Anki profile Throwaway/);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "pair"), false);
    f.button("Use the open profile", s.host).click(); await tick();
    f.button("Use this profile", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "pair")!.input, { confirmed: true, expectedDestination: { url: "http://127.0.0.1:8765/", profile: "Throwaway" } });
    assert.match(s.host.textContent!, /New cards go to profile Throwaway/);
    await tick();
    assert.doesNotMatch(f.container.textContent!, /Choose an Anki profile in settings/, "the open page refreshed after pairing");
    s.close();
  } finally { await f.dispose(); }
});

test("note type repairs name the shown profile and resetting styling is a confirmed destructive action", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    f.button("Reset styling and templates", s.host).click(); await tick();
    assert.match(f.dialog()!.textContent!, /profile Throwaway.*will be lost/s);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "updateStyling"), false);
    f.button("Reset styling and templates", s.host).click(); await tick();
    f.button("Reset", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "updateStyling")!.input, { confirmed: true, expectedDestination: paired() });
    f.button("Add missing fields", s.host).click(); await tick();
    f.button("Add fields", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "repairFields")!.input, { expectedDestination: paired() });
    s.close();
  } finally { await f.dispose(); }
});

test("the tag template and learnharness tags save when changed and prefill the send tags", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state });
  try {
    assert.equal(f.tags().value, "Scratch::Lecture_01", "{deck} expands from the deck name");
    f.type(f.deck(), "Year 3::Nuclear Physics");
    assert.equal(f.tags().value, "Year_3::Nuclear_Physics::Lecture_01");
    const s = await f.mountSettings();
    const template = Array.from(s.host.querySelectorAll("input")).find(i => (i as unknown as HTMLInputElement).placeholder.includes("YEAR_3")) as unknown as HTMLInputElement;
    const system = s.host.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement;
    assert.equal(template.value, "{deck}::Lecture_01"); assert.equal(system.checked, true);
    f.type(template, "YEAR_3::NPP::Lecture_02", "change"); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "settings").at(-1)!.input, { tagTemplate: "YEAR_3::NPP::Lecture_02", systemTags: true });
    system.checked = false; system.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "settings").at(-1)!.input, { tagTemplate: "YEAR_3::NPP::Lecture_02", systemTags: false });
    s.close();
  } finally { await f.dispose(); }
});

test("cards show Front, Back and Extra side by side, and source text stays inert", async () => {
  const state = fixture();
  state.cards = [card("a", { extra: "Hint", sourceStatement: "<script>Untrusted source</script>", sourceChanged: true })];
  const f = await setup({ state });
  try {
    const columns = Array.from(f.review().querySelectorAll(".ab-card-field h4")).map(h => h.textContent);
    assert.deepEqual(columns, ["Front", "Back", "Extra"]);
    assert.match(f.review().textContent!, /The idea has changed since this card was written/);
    assert.equal(f.container.querySelector("script"), null);
    assert.match(f.review().querySelector(".ab-card-source")!.textContent!, /<script>Untrusted source<\/script>/);
    assert.equal(f.container.querySelector("iframe"), null, "no raw field formatting preview");
  } finally { await f.dispose(); }
});

test("editing previews live, warns about long cards, keeps typing through a refresh, and saves or cancels", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  const f = await setup({ state });
  try {
    f.button("Edit", f.review().querySelector(".ab-card")!).click(); await tick();
    const front = f.review().querySelector("textarea") as unknown as HTMLTextAreaElement;
    f.type(front, "word ".repeat(32));
    assert.match(f.review().textContent!, /Long card: 32 words on the front/);
    assert.match(f.review().querySelector(".ab-markdown-preview")!.textContent!, /word word/);
    await f.resync();
    assert.equal((f.review().querySelector("textarea") as unknown as HTMLTextAreaElement).value, "word ".repeat(32), "unsaved text survives a refresh");
    f.button("Save", f.review()).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "edit")!.input, { id: "a", front: "word ".repeat(32), back: "Answer", extra: "" });
    assert.equal(f.review().querySelector("textarea"), null);
    f.button("Edit", f.review().querySelectorAll(".ab-card")[1]!).click(); await tick();
    f.type(f.review().querySelector("textarea") as unknown as HTMLTextAreaElement, "discarded");
    f.button("Cancel", f.review()).click(); await tick();
    assert.match(f.review().textContent!, /Question b/); assert.doesNotMatch(f.review().textContent!, /discarded/);
  } finally { await f.dispose(); }
});

test("approve and send use named calls with deck, tags and destination; an empty deck explains itself", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  const f = await setup({ state });
  try {
    assert.equal(f.button(/^Send to Anki/).disabled, true, "nothing approved yet");
    f.button("Approve", f.review().querySelector(".ab-card")!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "approve")!.input, { ids: ["a"] });
    assert.equal(f.review().querySelector(".ab-card")!.getAttribute("data-status"), "approved", "the approved card stays in place");
    f.type(f.deck(), "");
    assert.match(f.container.textContent!, /Type a deck name/);
    assert.equal(f.tags().value, "", "no invented deck in the tags");
    assert.match(f.container.textContent!, /Tags fill in from your template once you choose a deck\./);
    f.button("Send 1 card to Anki").click(); await tick();
    assert.match(f.status()!, /Choose a deck first\./);
    assert.equal(f.deck().value, "", "the error does not refill the last deck");
    await f.resync();
    assert.equal(f.deck().value, "", "nor does a background refresh");
    f.button("Send 1 card to Anki").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "send"), false, "a second click still sends nothing");
    f.type(f.deck(), "New::Deck");
    assert.match(f.container.textContent!, /Existing deck\./);
    f.type(f.deck(), "Brand new");
    assert.match(f.container.textContent!, /New deck\. Anki Bridge creates it when you send\./);
    f.type(f.tags(), "YEAR_3::NPP extra");
    f.button("Send 1 card to Anki").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "send")!.input, { ids: ["a"], deck: "Brand new", tags: ["YEAR_3::NPP", "extra"], expectedDestination: paired() });
    assert.match(f.status()!, /Sent 1 card to Brand new\./);
    assert.match(f.container.textContent!, /Sent cards \(1\)/);
    assert.equal(f.deck().value, "Brand new", "the deck just used stays");
    f.type(f.deck(), "Other deck");
    assert.equal(f.tags().value, "Other_deck::Lecture_01", "tags typed for one send don't stick to the next");
  } finally { await f.dispose(); }
});

test("approving all drafts and dropping all unsent cards need confirmation", async () => {
  const state = fixture(); state.cards = [card("a"), card("b"), card("c", { status: "sent", noteId: 3, deck: "Scratch", destination: paired() })];
  const f = await setup({ state });
  try {
    f.button("Approve all drafts (2)").click(); await tick();
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "approve"), false);
    f.button("Approve all drafts (2)").click(); await tick();
    f.button("Approve", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "approve")!.input, { ids: ["a", "b"] });
    await f.more("Drop all unsent cards (2)"); await tick();
    f.button("Drop cards", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "drop")!.input, { ids: ["a", "b"] });
    assert.match(f.container.textContent!, /No cards to review/);
  } finally { await f.dispose(); }
});

test("sent and unconfirmed cards offer no resend, and recovery lives in the menu", async () => {
  const state = fixture();
  state.cards = [card("sent", { status: "sent", noteId: 9, deck: "Scratch", destination: paired(), presence: "deleted" }),
    card("old", { status: "sent", noteId: 8, deck: "Scratch", destination: { url: "http://127.0.0.1:1/", profile: "Old" } }),
    card("unsure", { status: "sending", deck: "Scratch", destination: paired(), lastError: "Delivery outcome is uncertain" })];
  const f = await setup({ state });
  try {
    const unsure = f.review().querySelector(".ab-card")!;
    assert.match(unsure.textContent!, /isn't sure this card reached Anki/);
    for (const label of ["Approve", "Edit", "Send this card", "Retry send", "Drop"]) assert.equal(f.find(label, unsure), undefined, label);
    const history = f.container.querySelector(".ab-history") as unknown as HTMLDetailsElement;
    history.open = true; history.dispatchEvent(f.event("toggle"));
    const sent = Array.from(history.querySelectorAll(".ab-card"));
    assert.equal(sent.length, 2);
    assert.ok(sent.some(c => /deleted in Anki/.test(c.textContent!)));
    assert.equal(Array.from(history.querySelectorAll("button")).filter(b => b.textContent === "Show in Anki").length, 1, "only cards at the current profile");
    await f.more("Check unconfirmed sends"); await tick();
    assert.ok(f.calls.some(c => c.name === "reconcile"));
    await f.more("Check which sent cards are still in Anki"); await tick();
    assert.ok(f.calls.some(c => c.name === "presence"));
  } finally { await f.dispose(); }
});

test("a hand-written card is added through a dialog", async () => {
  const f = await setup();
  try {
    await f.more("Write a card by hand"); await tick();
    const dialog = f.dialog()!;
    const [front, back] = Array.from(dialog.querySelectorAll("textarea")) as unknown as HTMLTextAreaElement[];
    front.value = "Front text"; back.value = "Back text";
    f.button("Add card", dialog).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "draft")!.input, { front: "Front text", back: "Back text", extra: "", kind: "recall" });
    assert.equal(f.dialog(), null);
    assert.match(f.review().textContent!, /Front text/);
  } finally { await f.dispose(); }
});

test("a send error is shown, and saved per-card results are refreshed without offering resend", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state, handler: (name) => {
    if (name === "send") { Object.assign(state.cards[0], { status: "sending", deck: "Scratch", destination: paired() }); throw new Error("Delivery outcome is uncertain: timeout"); }
    return undefined;
  } });
  try {
    f.button("Send 1 card to Anki").click(); await tick();
    assert.match(f.status()!, /Delivery outcome is uncertain: timeout/);
    assert.equal(f.review().querySelector(".ab-card")!.getAttribute("data-status"), "sending");
    assert.equal(f.find("Retry send"), undefined);
  } finally { await f.dispose(); }
});

test("Anki being closed shows a banner on the page and an unknown deck hint", async () => {
  const f = await setup({ connection: () => { throw new Error("Could not complete the AnkiConnect request."); } });
  try {
    assert.match(f.container.textContent!, /Anki isn't reachable\. Open Anki to send cards and see your decks\./);
    assert.match(f.container.textContent!, /Open Anki to check this deck name\./);
  } finally { await f.dispose(); }
});

test("late results after unmount are ignored", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const state = fixture(); state.cards = [card("a")];
  const f = await setup({ state, handler: async (name) => { if (name === "approve") { await gate; throw new Error("late failure"); } return undefined; } });
  const container = f.container;
  f.button("Approve", container).click(); await tick();
  await f.dispose();
  release(); await tick();
  assert.doesNotMatch(container.textContent ?? "", /late failure/);
});

test("a background refresh keeps focus and the caret in the card being edited", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  const f = await setup({ state });
  try {
    f.button("Edit", f.review().querySelector(".ab-card")!).click(); await tick();
    const area = () => f.review().querySelector('[data-keep="card-a-back"]') as unknown as HTMLTextAreaElement;
    area().focus(); f.type(area(), "Answer with more"); area().setSelectionRange(3, 6);
    state.cards.push(card("c"));
    await f.resync();
    assert.match(f.review().textContent!, /Idea c/, "the refresh rendered");
    assert.equal(f.doc.activeElement, area(), "the same editor has focus");
    assert.deepEqual([area().selectionStart, area().selectionEnd], [3, 6]);
    assert.equal(area().value, "Answer with more");
  } finally { await f.dispose(); }
});

test("the editor is read-only while a save is in flight, so late typing can't be lost", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const f = await setup({ state, handler: async name => { if (name === "edit") await held; return undefined; } });
  try {
    f.button("Edit", f.review().querySelector(".ab-card")!).click(); await tick();
    const front = f.review().querySelector('[data-keep="card-a-front"]') as unknown as HTMLTextAreaElement;
    f.type(front, "New question");
    f.button("Save").click(); await tick();
    assert.equal(front.readOnly, true);
    // Opening another editor redraws the list; the saving card must stay locked.
    f.button("Edit", f.review().querySelectorAll(".ab-card")[1]).click(); await tick();
    const redrawn = f.review().querySelector('[data-keep="card-a-front"]') as unknown as HTMLTextAreaElement;
    assert.notEqual(redrawn, front, "the editor was redrawn");
    assert.equal(redrawn.readOnly, true);
    assert.equal(f.button("Cancel", f.review().querySelector(".ab-card")!).disabled, true);
    release(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "edit")!.input, { id: "a", front: "New question", back: "Answer", extra: "" });
  } finally { release(); await f.dispose(); }
});

test("a refresh that changes the saved address drops a key typed for the old one", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const key = s.host.querySelector('input[type="password"]') as unknown as HTMLInputElement;
    f.type(key, "typed-for-8765");
    f.state.settings.url = "http://127.0.0.1:9999/";
    await f.resync();
    assert.equal((s.host.querySelector('input[type="url"]') as unknown as HTMLInputElement).value, "http://127.0.0.1:9999/");
    assert.equal(key.value, "", "the typed key is not carried to the new address");
    s.close();
  } finally { await f.dispose(); }
});

test("a tag change made while another tag save runs is saved afterwards, not dropped", async () => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let first = true;
  const f = await setup({ handler: async (name, input) => { if (name === "settings" && input.tagTemplate !== undefined && first) { first = false; await held; } return undefined; } });
  try {
    const s = await f.mountSettings();
    const inputs = s.host.querySelectorAll("input");
    const template = Array.from(inputs as ArrayLike<HTMLInputElement>).find(i => i.placeholder?.startsWith("YEAR_3"))!;
    const box = s.host.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement;
    f.type(template, "{deck}::Lecture_02", "change"); await tick();
    box.checked = false; box.dispatchEvent(f.event("change")); await tick();
    release(); await tick();
    const saves = f.calls.filter(c => c.name === "settings").map(c => c.input);
    assert.deepEqual(saves.at(-1), { tagTemplate: "{deck}::Lecture_02", systemTags: false });
    assert.equal(box.checked, false, "the first save's answer doesn't undo the second change");
    s.close();
  } finally { release(); await f.dispose(); }
});

test("choosing a profile for the first time loads deck suggestions on the open page", async () => {
  const state = fixture(); state.destination = null;
  const f = await setup({ state });
  try {
    assert.equal(f.calls.some(c => c.name === "connection"), false, "no profile, no deck lookup");
    const s = await f.mountSettings();
    f.button("Use the open profile", s.host).click(); await tick();
    f.button("Use this profile", f.dialog()!).click(); await tick(); await tick();
    const options = Array.from(f.container.querySelectorAll("#anki-bridge-decks option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    assert.deepEqual(options, ["Scratch", "New::Deck"]);
    s.close();
  } finally { await f.dispose(); }
});

test("deck and tags are locked while a send runs", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const f = await setup({ state, handler: async name => { if (name === "send") await held; return undefined; } });
  try {
    f.button("Send 1 card to Anki").click(); await tick();
    assert.equal(f.deck().readOnly, true); assert.equal(f.tags().readOnly, true);
    release(); await tick();
    assert.equal(f.deck().readOnly, false); assert.equal(f.tags().readOnly, false);
    assert.match(f.status()!, /Sent 1 card to Scratch\./);
  } finally { release(); await f.dispose(); }
});

test("switching profiles refreshes step 1 and drops the old profile's decks", async () => {
  const state = fixture();
  let profile = "Throwaway", decks = ["Scratch", "New::Deck"];
  const f = await setup({ state, connection: () => ({ profile, decks }) });
  try {
    const options = () => Array.from(f.container.querySelectorAll("#anki-bridge-decks option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    assert.deepEqual(options(), ["Scratch", "New::Deck"]);
    const s = await f.mountSettings();
    const before = f.coverageReads();
    profile = "Second"; decks = ["Other deck"];
    f.button("Switch to the open profile", s.host).click(); await tick();
    // By the time the page reloads its decks, Anki has the first profile open again.
    profile = "Throwaway"; decks = ["Scratch", "New::Deck"];
    f.button("Use this profile", f.dialog()!).click(); await tick(); await tick();
    assert.deepEqual(state.destination, { url: "http://127.0.0.1:8765/", profile: "Second" });
    assert.ok(f.coverageReads() > before, "ideas in Anki are recounted for the new profile");
    assert.deepEqual(options(), [], "Anki has another profile open, so its decks aren't offered");
    f.type(f.deck(), "Scratch");
    assert.match(f.container.textContent!, /Open the Second profile in Anki to check this deck name\./);
    s.close();
  } finally { await f.dispose(); }
});

test("a refresh asked for during a read gets a newer read, not the old answer", async () => {
  const state = fixture(); state.cards = [card("a")];
  let release: (() => void) | undefined, hold = false;
  const f = await setup({ state, handler: async name => {
    if (name !== "snapshot" || !hold) return undefined;
    hold = false;
    const old = structuredClone(state);
    await new Promise<void>(r => { release = r; });
    return old;
  } });
  try {
    const s = await f.mountSettings();
    const template = Array.from(s.host.querySelectorAll("input") as ArrayLike<HTMLInputElement>).find(i => i.placeholder?.startsWith("YEAR_3"))!;
    const reads = () => f.calls.filter(c => c.name === "snapshot").length;
    hold = true;
    f.type(template, "{deck}::Lecture_02", "change"); await tick();
    const first = reads();
    assert.ok(release, "the page started a read after the settings change");
    state.cards.push(card("b"));
    f.type(template, "{deck}::Lecture_03", "change"); await tick();
    release!(); await tick(); await tick();
    assert.ok(reads() > first, "a second read started after the first finished");
    assert.match(f.review().textContent!, /Idea b/);
    s.close();
  } finally { release?.(); await f.dispose(); }
});

test("a saved address that differs from the pairing offers no decks until it is paired again", async () => {
  const state = fixture();
  const f = await setup({ state, connection: () => ({ profile: "Throwaway", decks: ["From the other Anki"] }) });
  try {
    const options = () => Array.from(f.container.querySelectorAll("#anki-bridge-decks option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    assert.deepEqual(options(), ["From the other Anki"]);
    state.settings.url = "http://127.0.0.1:9999/";
    await f.resync();
    assert.deepEqual(options(), [], "the old address's decks are dropped");
    const asked = f.calls.filter(c => c.name === "connection").length;
    await f.more("Refresh cards"); await tick();
    assert.equal(f.calls.filter(c => c.name === "connection").length, asked, "no lookup at the unpaired address");
    assert.deepEqual(options(), []);
    f.type(f.deck(), "Scratch");
    assert.match(f.container.textContent!, /Choose the profile again in settings to check this deck name at the new address\./);
  } finally { await f.dispose(); }
});

test("saving an unchanged approved card keeps it approved without asking to approve again", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state });
  try {
    f.button("Edit", f.review().querySelector(".ab-card")!).click(); await tick();
    f.button("Save").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "edit"), false);
    assert.doesNotMatch(f.container.textContent!, /approve it again/);
  } finally { await f.dispose(); }
});

test("connection fields are locked while a save runs", async () => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const f = await setup({ handler: async (name, input) => { if (name === "settings" && input.url) await held; return undefined; } });
  try {
    const s = await f.mountSettings();
    const url = s.host.querySelector('input[type="url"]') as unknown as HTMLInputElement;
    const key = s.host.querySelector('input[type="password"]') as unknown as HTMLInputElement;
    f.type(key, "new-key");
    f.button("Save", s.host).click(); await tick();
    assert.equal(url.readOnly, true); assert.equal(key.readOnly, true);
    release(); await tick();
    assert.equal(url.readOnly, false); assert.equal(key.readOnly, false);
    s.close();
  } finally { release(); await f.dispose(); }
});

test("loading again after a failed first load also loads deck suggestions", async () => {
  let fail = true;
  const f = await setup({ handler: name => { if (name === "snapshot" && fail) { fail = false; throw new Error("Not ready"); } return undefined; } });
  try {
    f.button("Try loading again").click(); await tick(); await tick();
    const options = Array.from(f.container.querySelectorAll("#anki-bridge-decks option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    assert.deepEqual(options, ["Scratch", "New::Deck"]);
  } finally { await f.dispose(); }
});
