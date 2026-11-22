import { systemTags } from "../src/anki/tags.ts";
import { packageRevision } from "../src/anki/package-revision.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { activate } from "../src/main.ts";
import { connectionText } from "../src/settings-ui.ts";
import type { PluginFrontendContext, PluginView } from "../sdk/index.d.ts";
import { chooseMenu, delayedButtons, fakeUi } from "./fake-ui.ts";

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
    generationSettings: { cardsPerNode: 2, enabledKinds: ["fact", "equation"] as string[], model: null },
  };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };

async function setup(options: { handler?: (name: string, input: any) => unknown; coverageGate?: () => Promise<void> | undefined; state?: ReturnType<typeof fixture>; connection?: () => unknown; ui?: Record<string, unknown> } = {}) {
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
    manifest: { apiVersion: 1, id: "anki-bridge", name: "Anki Bridge", version: "9.8.7", minAppVersion: "0.6.1" },
    signal: activation.signal,
    cleanup: (fn: () => void) => cleanups.push(fn),
    registerView: (value: PluginView) => { if (value.id === "bridge") view = value; return () => {}; },
    registerAction: (value: { id: string; run: () => void }) => { actions.set(value.id, value); return () => {}; },
    placeAction: (value: { actionId: string; location: string }) => { placements.push(value); return () => {}; },
    onAppEvent: () => () => {},
    registerSettings: (value: PluginView["mount"]) => { settings = value; return () => {}; },
    onResync: (listener: () => void) => { resyncs.add(listener); return () => { resyncs.delete(listener); }; },
    app: { openView: (id: string) => { openedView = id; }, openSettings: () => { settingsOpened++; } },
    call: async (name: string, input: any) => {
      if (name === "coverageContext") coverageReads++;
      if (name === "coverageContext") await options.coverageGate?.();
      if (name === "coverageContext") return { nodes: [], missing: [], cardsPerNode: 2, paired: true, pairingWarning: false };
      if (name === "generationStatus") return { generationSettings: structuredClone(state.generationSettings), generations: [] };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      calls.push({ name, input });
      const handled = await options.handler?.(name, input);
      if (handled !== undefined) return handled;
      if (name === "connection") return options.connection ? options.connection() : { profile: "Throwaway", decks: ["Scratch", "New::Deck"] };
      if (name === "settings") Object.assign(state.settings, input.apiKey === undefined ? {} : { hasApiKey: !!input.apiKey }, input.url ? { url: input.url } : {}, input.tagTemplate === undefined ? {} : { tagTemplate: input.tagTemplate }, input.systemTags === undefined ? {} : { systemTags: input.systemTags });
      if (name === "pair") state.destination = input.expectedDestination;
      if (name === "generationSettings") {
        const { toggleKind, ...rest } = input;
        Object.assign(state.generationSettings, rest);
        if (toggleKind) state.generationSettings.enabledKinds = ["fact", "equation", "why", "steps", "apply", "discriminate"].filter(k => k === toggleKind.kind ? toggleKind.enabled : state.generationSettings.enabledKinds.includes(k));
      }
      if (name === "edit") Object.assign(state.cards.find(c => c.id === input.id)!, { front: input.front, back: input.back, extra: input.extra, status: "draft" });
      if (name === "approve") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "approved"; });
      if (name === "drop") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "dropped"; });
      if (name === "markImported") { state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "imported"; c.deck = input.deck; }); return structuredClone({ ...state, importMarkId: "test-mark" }); }
      if (name === "unmarkImported") state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "approved"; delete c.deck; });
      if (name === "draft") state.cards.push(card(`manual-${state.cards.length}`, { front: input.front, back: input.back, extra: input.extra, kind: input.kind, nodeName: "Hand-written card", sessionName: "Manual" }));
      if (name === "send") {
        state.settings.lastDeck = input.deck;
        const cards = state.cards.filter(c => input.ids.includes(c.id));
        cards.forEach(c => { Object.assign(c, { status: "sent", noteId: 7, deck: input.deck, destination: paired() }); });
        const tags = [...new Set([...input.tags, ...(state.settings.systemTags ? cards.flatMap(c => systemTags(c.kind as Parameters<typeof systemTags>[0])) : [])])];
        return structuredClone({ ...state, delivery: { added: input.ids, found: [], failed: [], skipped: [], deck: input.deck, tags } });
      }
      return structuredClone(state);
    },
    ui: fakeUi(options.ui),
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
    assert.equal(s.host.querySelector(".ab-settings").firstElementChild.textContent, `Version ${f.ctx.manifest.version}`);
    for (const panel of ["Connect to Anki", "Anki profile", "Tags", "More card types", "Note type"]) assert.match(s.host.textContent!, new RegExp(panel));
    assert.doesNotMatch(f.container.textContent!, /Add missing fields|AnkiConnect address/, "upkeep lives only in settings");
    s.close();
  } finally { await f.dispose(); }
});

test("a Settings refresh from Write cannot overwrite a newer card-type save", async () => {
  const state = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0, hold = false;
  const f = await setup({ state, handler: async name => {
    if (name === "snapshot" && hold) {
      held++;
      const old = structuredClone(state);
      await gate;
      return old;
    }
  } });
  try {
    const s = await f.mountSettings();
    const why = [...f.container.querySelectorAll(".ab-kinds label")].find(label => label.textContent === "Why")!.querySelector("input")!;
    const apply = Array.from(s.host.querySelectorAll("label") as ArrayLike<HTMLLabelElement>).find(label => label.textContent?.startsWith("Apply:"))!.querySelector("input")!;
    assert.equal(apply.checked, false);
    hold = true;
    why.click(); await tick();
    hold = false;
    assert.equal(held, 3, "held the Review, Settings and Anki reviews reloads from Write before saving Apply");
    apply.click(); await tick();
    assert.equal(apply.checked, true);
    assert.ok(state.generationSettings.enabledKinds.includes("apply"));
    release(); await tick();
    assert.equal(apply.checked, true, "older state did not turn Apply back off");
    s.close();
  } finally { release(); await f.dispose(); }
});

test("Settings switch Apply and Contrast on for drafting, with examples, and Write shows it", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const panel = Array.from(s.host.querySelectorAll(".ab-panel") as ArrayLike<HTMLElement>).find(p => /More card types/.test(p.textContent!))!;
    assert.ok(panel, "card types panel");
    const boxes = () => Array.from(panel.querySelectorAll("input[type=checkbox]")) as unknown as HTMLInputElement[];
    assert.deepEqual(Array.from(panel.querySelectorAll("label") as ArrayLike<HTMLElement>).map(l => l.textContent), [
      "Apply: pick the rule that fits a new situation.", "Contrast: tell apart two easily confused ideas."]);
    assert.deepEqual(boxes().map(b => b.checked), [false, false], "off by default");
    assert.match(panel.textContent!, /Front: You know an electron beam's momentum.*Front: A proton speeds up/s);
    assert.doesNotMatch(s.host.textContent!, /Compose/);
    const write = () => f.container.querySelector(".ab-kind-help")!.textContent!;
    assert.doesNotMatch(write(), /Also on/);

    // Write changed after Settings loaded; the Settings toggle must keep that change.
    f.state.generationSettings.enabledKinds = ["fact", "equation", "why"];
    boxes()[0]!.checked = true; boxes()[0]!.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").map(c => c.input), [{ toggleKind: { kind: "apply", enabled: true } }]);
    assert.deepEqual(f.state.generationSettings.enabledKinds, ["fact", "equation", "why", "apply"]);
    assert.match(panel.textContent!, /Apply on\./);
    assert.deepEqual(boxes().map(b => b.checked), [true, false]);
    assert.match(write(), /Also on: Apply\./, "the open Write step updates");

    boxes()[0]!.checked = false; boxes()[0]!.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.state.generationSettings.enabledKinds, ["fact", "equation", "why"]);
    assert.doesNotMatch(write(), /Also on/);

    // A Write change reaches an open Settings panel: with Contrast alone it is locked on, until Write turns Fact on.
    f.state.generationSettings.enabledKinds = ["discriminate"];
    const open = await f.mountSettings();
    const contrast = () => Array.from(Array.from(open.host.querySelectorAll(".ab-panel") as ArrayLike<HTMLElement>).find(p => /More card types/.test(p.textContent!))!.querySelectorAll("input[type=checkbox]") as ArrayLike<HTMLInputElement>)[1]!;
    assert.equal(contrast().disabled, true);
    const fact = f.container.querySelector(".ab-chips input[type=checkbox]") as unknown as HTMLInputElement;
    fact.checked = true; fact.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.state.generationSettings.enabledKinds, ["fact", "discriminate"]);
    assert.equal(contrast().disabled, false, "Settings now lets Contrast go off");
    open.close();

    f.state.generationSettings.enabledKinds = ["discriminate"];
    s.close();
    const again = await f.mountSettings();
    const kindsPanel = Array.from(again.host.querySelectorAll(".ab-panel") as ArrayLike<HTMLElement>).find(p => /More card types/.test(p.textContent!))!;
    const checked = Array.from(kindsPanel.querySelectorAll("input[type=checkbox]") as ArrayLike<HTMLInputElement>).filter(b => b.checked);
    assert.equal(checked.length, 1); assert.equal(checked[0]!.disabled, true, "the only remaining type stays on");
    again.close();
  } finally { await f.dispose(); }
});

test("settings save a key without showing the stored one, warn about localhost and remove a key with a button", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const [url, key] = Array.from(s.host.querySelectorAll("input")) as unknown as HTMLInputElement[];
    assert.equal(key.type, "password"); assert.equal(key.value, "");
    assert.match(key.placeholder, /Saved\. Type to replace\./);
    assert.equal(f.button("Save", s.host).disabled, true, "nothing to save yet");
    f.type(url, "http://localhost:8765");
    assert.match(s.host.textContent!, /Use 127\.0\.0\.1, not localhost/);
    assert.match(s.host.textContent!, /Saving a new address removes the saved key/);
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
    assert.match(s.host.textContent!, /Key cleared because the address changed\. Type it again\./);
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
    assert.match(s.host.textContent!, /Couldn't reach Anki at http:\/\/127\.0\.0\.1:8765\/\. Open Anki and check AnkiConnect is installed\./);
    assert.equal(s.host.querySelector('.ab-status[data-tone="error"]') !== null, true);
    result = () => ({ profile: null, decks: [] });
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /No profile loaded\. Open a profile in Anki/);
    result = () => ({ profile: "Throwaway", decks: ["Scratch", "New::Deck"] });
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /Connected\. Profile Throwaway, 2 decks\./);
    assert.doesNotMatch(s.host.textContent!, /New::Deck/);
    const [url] = Array.from(s.host.querySelectorAll("input")) as unknown as HTMLInputElement[];
    f.type(url, "http://127.0.0.1:9999");
    f.button("Test connection", s.host).click(); await tick();
    assert.match(s.host.textContent!, /Save your changes first/);
    assert.equal(connectionText("u", new Error("HTTP 500")).text, "Connection failed: HTTP 500");
    s.close();
  } finally { await f.dispose(); }
});

test("choosing a profile needs dialog confirmation, refuses a closed profile, and refreshes the open page", async () => {
  const state = fixture(); state.destination = null;
  let profile: string | null = null;
  const f = await setup({ state, connection: () => ({ profile, decks: [] }) });
  try {
    assert.match(f.container.textContent!, /Choose an Anki profile to send\. Download \.apkg works without one/);
    f.button("Open settings", f.container).click(); assert.equal(f.settingsOpened(), 1);
    const s = await f.mountSettings();
    f.button("Use the open profile", s.host).click(); await tick();
    assert.equal(f.dialog(), null, "no dialog without an open profile");
    assert.match(s.host.textContent!, /No profile loaded\. Open a profile in Anki/);
    profile = "Throwaway";
    f.button("Use the open profile", s.host).click(); await tick();
    assert.match(f.dialog()!.textContent!, /Send new cards to profile Throwaway at http:\/\/127\.0\.0\.1:8765\//);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "pair"), false);
    f.button("Use the open profile", s.host).click(); await tick();
    f.button("Use this profile", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "pair")!.input, { confirmed: true, expectedDestination: { url: "http://127.0.0.1:8765/", profile: "Throwaway" } });
    assert.match(s.host.textContent!, /New cards go to profile Throwaway/);
    await tick();
    assert.doesNotMatch(f.container.textContent!, /Choose an Anki profile to send/, "the open page refreshed after pairing");
    s.close();
  } finally { await f.dispose(); }
});

test("note type repairs name the shown profile and resetting styling is a confirmed destructive action", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    f.button("Reset styling and templates", s.host).click(); await tick();
    assert.match(f.dialog()!.textContent!, /profile Throwaway.*Your edits to them in Anki are lost/s);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "updateStyling"), false);
    f.button("Reset styling and templates", s.host).click(); await tick();
    f.button("Reset", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "updateStyling")!.input, { noteType: "basic", confirmed: true, expectedDestination: paired() });
    f.button("Add missing fields", s.host).click(); await tick();
    f.button("Add fields", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "repairFields")!.input, { noteType: "basic", expectedDestination: paired() });
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
    assert.match(f.review().textContent!, /Idea changed since this card was written/);
    assert.equal(f.container.querySelector("script"), null);
    assert.match(f.review().querySelector(".ab-card-source")!.textContent!, /<script>Untrusted source<\/script>/);
    assert.equal(f.container.querySelector("iframe"), null, "no raw field formatting preview");
  } finally { await f.dispose(); }
});

test("a missing source warning refers to the graph snapshot without implying deletion", async () => {
  const state = fixture();
  state.cards = [card("a", { sourceMissing: true, sourceStatement: "Saved source statement" })];
  const f = await setup({ state });
  try {
    assert.equal(f.review().querySelector(".ab-card-warning")!.textContent,
      "Source idea wasn't found in this graph snapshot. Check the card before approving.");
    assert.match(f.review().querySelector(".ab-card-source")!.textContent!, /Saved source statement/);
  } finally { await f.dispose(); }
});

test("editing previews live, warns about long cards, keeps typing through a refresh, and saves or cancels", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  const f = await setup({ state });
  try {
    f.button("Edit", f.review().querySelector(".ab-card")!).click(); await tick();
    const front = f.review().querySelector("textarea") as unknown as HTMLTextAreaElement;
    f.type(front, "word ".repeat(32));
    assert.match(f.review().textContent!, /Long front: 32 words/);
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

test("approval and refresh keep the scrolled pane anchored through deferred widget commits", async t => {
  const state = fixture(); state.cards = Array.from({ length: 12 }, (_, i) => card(`card-${i}`, { front: "A line of markdown\n".repeat(23) }));
  // LearnHarness appends a portal target now and mounts its contents later.
  // Control the commit explicitly so the check runs after late layout changes.
  const ui = fakeUi();
  const mount = ui.mountMarkdown as PluginFrontendContext["ui"]["mountMarkdown"];
  const pending = new Set<() => void>();
  ui.mountMarkdown = ((container, initial, options) => {
    const target = container.ownerDocument.createElement("div");
    container.append(target);
    let props = initial, mounted: ReturnType<typeof mount> | undefined;
    const commit = () => { pending.delete(commit); mounted = mount(target, props, options); };
    pending.add(commit);
    const dispose = () => { pending.delete(commit); mounted?.dispose(); target.remove(); };
    options.signal.addEventListener("abort", dispose, { once: true });
    return { update: patch => { props = { ...props, ...patch }; mounted?.update(patch); }, dispose };
  }) satisfies typeof mount;
  const commitWidgets = () => { for (const commit of pending) commit(); };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup({ state, ui, handler: async name => { if (name === "approve") await gate; } });
  try {
    const pane = f.container;
    Object.defineProperty(pane, "clientHeight", { value: 300 });
    const rect = (top: number, height: number) => new f.window.DOMRect(0, top, 600, height);
    // happy-dom has no layout. An empty portal target collapses the card's
    // markdown, shifting all downstream rows when the widget later commits.
    const cardRow = (i: number) => f.review().querySelectorAll("article")[i]!;
    const rowHeight = (row: typeof f.window.Element.prototype) => 100 + 20 * (row.querySelector(".ab-markdown")?.textContent?.split("\n").length ?? 0);
    assert.equal(rowHeight(cardRow(0)), 120);
    commitWidgets();
    assert.equal(rowHeight(cardRow(0)), 580);
    pane.scrollTop = 460 + 3 * rowHeight(cardRow(0)) - 60;
    t.mock.method(f.window.HTMLElement.prototype, "getBoundingClientRect", function (this: typeof pane) {
      if (this === pane) return rect(60, 300);
      const rows = Array.from(f.review().children);
      const i = rows.indexOf(this);
      if (i < 0) return rect(0, 0);
      return rect(460 + rows.slice(0, i).reduce((offset, row) => offset + rowHeight(row), 0) + (f.status() ? 24 : 0) - pane.scrollTop, rowHeight(this));
    });
    const focus = f.window.HTMLElement.prototype.focus;
    const focused = t.mock.method(f.window.HTMLElement.prototype, "focus", function (this: typeof pane, options?: FocusOptions) {
      if (this.matches("article") && !options?.preventScroll) pane.scrollTop = 0;
      focus.call(this);
    });
    const approve = f.button("Approve", cardRow(3));
    approve.focus();
    const originalTop = cardRow(3).getBoundingClientRect().top;
    approve.click(); await tick();
    assert.equal(f.status(), "Working…");
    assert.equal(cardRow(3).getBoundingClientRect().top, originalTop, "the status line must not shift the viewport");
    // Scrolling during the call must not snap back to the original position.
    pane.scrollTop += 54;
    const movedTop = cardRow(3).getBoundingClientRect().top;
    release(); await tick(); commitWidgets();
    assert.equal(cardRow(3).getAttribute("data-status"), "approved");
    assert.equal(cardRow(3).getBoundingClientRect().top, movedTop);
    assert.equal(f.doc.activeElement, cardRow(3));
    assert.deepEqual(focused.mock.calls.at(-1)?.arguments, [{ preventScroll: true }]);
    await f.more("Refresh cards"); await tick(); commitWidgets();
    assert.equal(cardRow(3).getBoundingClientRect().top, movedTop);
    assert.equal(f.doc.activeElement, cardRow(3));
  } finally { release(); await f.dispose(); }
});

test("approval and resync preserve focus moved to the next card's Edit while saving", async () => {
  const state = fixture(); state.cards = [card("a"), card("b")];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup({ state, handler: async name => { if (name === "approve") await gate; } });
  try {
    const first = f.review().querySelector("article")!;
    const second = f.review().querySelectorAll("article")[1]!;
    const approve = f.button("Approve", first);
    const nextEdit = f.button("Edit", second);
    approve.focus(); approve.click(); await tick();
    assert.equal(f.status(), "Working…");
    nextEdit.focus();
    release(); await tick();
    assert.equal(first.getAttribute("data-status"), "approved");
    assert.equal(f.doc.activeElement, nextEdit);
    await f.resync();
    assert.equal(f.doc.activeElement, nextEdit);
    nextEdit.click(); await tick();
    assert.equal(f.doc.activeElement.closest("article").dataset.cardId, "b");
    assert.equal(f.doc.activeElement.tagName, "TEXTAREA");
  } finally { release(); await f.dispose(); }
});

test("an old Approve button cannot send before the host commits its replacement", async () => {
  const state = fixture(); state.cards = [card("a")];
  const { mountButton, commitButtons } = delayedButtons();
  const f = await setup({ state, ui: { mountButton } });
  try {
    commitButtons();
    const row = f.review().querySelector("article")!;
    const approve = f.button("Approve", row);
    approve.click(); await tick();
    assert.equal(row.getAttribute("data-status"), "approved");
    assert.equal(f.find("Send this card", row), undefined, "React has not committed the Send label yet");
    assert.equal(approve.textContent, "Approve");
    approve.click(); await tick(); // The still-visible DOM button pre-fix; an inert reference after disposal.
    assert.deepEqual(f.calls.filter(c => c.name === "approve" || c.name === "send"), [{ name: "approve", input: { ids: ["a"] } }]);
    assert.equal(approve.isConnected, false);
    commitButtons();
    assert.equal(f.review().querySelector("article"), row);
    f.button("Send this card", row).click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "send").map(c => c.input.ids), [["a"]]);
  } finally { await f.dispose(); }
});

for (const sameCount of [false, true]) {
  test(`old bulk send and download are retired when approved IDs ${sameCount ? "change at the same count" : "grow before host commit"}`, async () => {
    const state = fixture(); state.cards = [card("a", { status: "approved" }), card("b")];
    const { mountButton, commitButtons } = delayedButtons();
    const f = await setup({ state, ui: { mountButton }, handler: name => {
      if (name === "exportPackage") throw new Error("Synthetic export (no file)");
    } });
    try {
      commitButtons();
      const before = f.button("Send 1 card to Anki"), oldDownload = f.button("Download .apkg");
      const more = f.button("More"), approve = f.button("Approve all drafts (1)");
      const first = f.review().querySelector("article");
      const focused = sameCount ? before : f.deck();
      focused.focus();
      await f.resync();
      assert.equal(f.button("Send 1 card to Anki"), before, "an unchanged target keeps the mounted button");
      assert.equal(f.doc.activeElement, focused);
      state.cards[1].status = "approved";
      if (sameCount) state.cards[0].status = "draft";
      await f.resync();
      assert.ok(f.doc.activeElement === (sameCount ? f.container.querySelector(".ab-send-actions") : focused));
      assert.equal(f.review().querySelector("article"), first);
      assert.equal(f.button("More"), more);
      assert.equal(f.button("Approve all drafts (1)"), approve);
      assert.equal(before.textContent, "Send 1 card to Anki");
      before.click(); oldDownload.click(); await tick();
      assert.deepEqual(f.calls.filter(c => c.name === "send" || c.name === "exportPackage"), []);
      assert.equal(before.isConnected || oldDownload.isConnected, false);
      commitButtons();
      f.button("Download .apkg").click(); await tick();
      f.button(sameCount ? "Send 1 card to Anki" : "Send 2 cards to Anki").click(); await tick();
      const ids = sameCount ? ["b"] : ["a", "b"];
      assert.deepEqual(f.calls.filter(c => c.name === "send" || c.name === "exportPackage").map(c => [c.name, c.input.ids]),
        [["exportPackage", ids], ["send", ids]]);
    } finally { await f.dispose(); }
  });
}

test("approval does not steal focus moved outside the list while saving", async () => {
  const state = fixture(); state.cards = [card("a")];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup({ state, handler: async name => { if (name === "approve") await gate; } });
  try {
    const approve = f.button("Approve", f.review());
    approve.focus(); approve.click(); await tick();
    const deck = f.deck(); deck.focus();
    release(); await tick();
    assert.equal(f.review().querySelector("article")?.getAttribute("data-status"), "approved");
    assert.equal(f.doc.activeElement, deck);
  } finally { release(); await f.dispose(); }
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
    assert.equal(f.deck().value, "", "the deck field stays empty after clearing it");
    assert.equal(f.tags().value, "", "no invented deck in the tags");
    assert.match(f.container.textContent!, /Tags fill in after you choose a deck\./);
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
    assert.match(f.container.textContent!, /New deck\./);
    f.type(f.tags(), "YEAR_3::NPP extra");
    f.button("Send 1 card to Anki").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "send")!.input, { ids: ["a"], deck: "Brand new", tags: ["YEAR_3::NPP", "extra"], expectedDestination: paired() });
    const sent = f.container.querySelector(".ab-sent") as unknown as HTMLElement;
    assert.equal(sent.hidden, false, "a send shows the confirmation panel (#32)");
    assert.equal(sent.getAttribute("role"), "status");
    assert.match(sent.textContent!, /1 card sent to Anki/);
    assert.match(sent.textContent!, /Deck Brand new/);
    assert.match(sent.textContent!, /Tags YEAR_3::NPP extra learnharness learnharness::kind::recall/, "lists the automatic tags too");
    f.button("Show in Anki", sent).click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "show", input: { ids: ["a"] } });
    assert.equal(sent.hidden, false, "showing the cards keeps the confirmation");
    f.button("Dismiss", sent).click();
    assert.equal(sent.hidden, true);
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
    assert.match(f.dialog()!.textContent!, /Check the answers before approving these 2 drafts\./);
    assert.match(f.dialog()!.textContent!, /Approving does not send cards to Anki\./);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.calls.some(c => c.name === "approve"), false);
    f.button("Approve all drafts (2)").click(); await tick();
    f.button("Approve", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "approve")!.input, { ids: ["a", "b"] });
    assert.equal(f.calls.some(c => c.name === "send"), false);
    await f.more("Drop all unsent cards (2)"); await tick();
    f.button("Drop cards", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "drop")!.input, { ids: ["a", "b"] });
    assert.match(f.container.textContent!, /Nothing left to review\./, "dropped cards leave only the sent one");
  } finally { await f.dispose(); }
});

test("Drop all unsent from an open More menu confirms the current cards after resync", async () => {
  const state = fixture(); state.cards = [card("a")];
  const f = await setup({ state });
  try {
    f.button("More", f.container).click();
    state.cards.push(card("b"));
    await f.resync();
    assert.match(f.review().textContent!, /Idea b/);
    await chooseMenu("Drop all unsent cards (1)"); await tick();
    assert.match(f.dialog()!.textContent!, /Drop 2 unsent cards/);
    assert.equal(f.calls.some(c => c.name === "drop"), false, "wait for confirmation of the updated count");
    f.button("Drop cards", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "drop").map(c => c.input), [{ ids: ["a", "b"] }]);
  } finally { await f.dispose(); }
});

test("Show sent from an open More menu uses the current paired cards after resync", async () => {
  const state = fixture();
  const sent = (id: string, noteId: number) => card(id, { status: "sent", noteId, destination: paired() });
  state.cards = [sent("old", 1)];
  const f = await setup({ state });
  try {
    f.button("More", f.container).click();
    state.cards = [sent("current", 2)];
    await f.resync();
    await chooseMenu("Show sent cards in Anki"); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "show").map(c => c.input), [{ ids: ["current"] }]);
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
    assert.match(unsure.textContent!, /May not have reached Anki\. Use Check unconfirmed sends/);
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
    const kinds = Array.from(dialog.querySelectorAll("select")[0]!.querySelectorAll("option") as ArrayLike<HTMLOptionElement>).map(o => o.textContent);
    assert.deepEqual(kinds, ["Fact", "Equation", "Why", "Steps", "Apply", "Contrast"], "no Compose for new cards");
    front.value = "Front text"; back.value = "Back text";
    f.button("Add card", dialog).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "draft")!.input, { front: "Front text", back: "Back text", extra: "", kind: "fact", format: "basic" });
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
    assert.match(f.container.textContent!, /Anki isn't reachable\. Open Anki\./);
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

test("a rejected Save unlocks the same editor so its fields can be corrected and retried", async () => {
  const state = fixture(); state.cards = [card("a")];
  let reject!: (error: Error) => void;
  const held = new Promise<never>((_, fail) => { reject = fail; });
  const f = await setup({ state, handler: (name, input) => {
    if (name === "edit" && !input.front) return held;
  } });
  try {
    f.button("Edit", f.review()).click();
    const [front, back, extra] = Array.from(f.review().querySelectorAll("textarea")) as unknown as HTMLTextAreaElement[];
    f.type(front!, ""); f.type(back!, "Keep this revised answer"); f.type(extra!, "Keep this hint");
    const save = f.button("Save", f.review());
    save.click(); await tick();
    assert.ok([front, back, extra].every(a => a!.readOnly));
    reject(new Error("Front is required.")); await tick();
    assert.equal(f.status(), "Front is required.");
    assert.equal(f.review().querySelector("textarea"), front, "no unrelated redraw replaced the editor");
    assert.ok([front, back, extra].every(a => !a!.readOnly), "the retained inputs are editable again");
    f.type(front!, "Corrected question");
    save.click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "edit").map(c => c.input), [
      { id: "a", front: "", back: "Keep this revised answer", extra: "Keep this hint" },
      { id: "a", front: "Corrected question", back: "Keep this revised answer", extra: "Keep this hint" },
    ]);
    assert.equal(f.review().querySelector("textarea"), null);
  } finally { await f.dispose(); }
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
    assert.match(f.container.querySelector(".ab-sent")!.textContent!, /1 card sent to Anki.*Deck Scratch/);
  } finally { release(); await f.dispose(); }
});

test("the send confirmation omits automatic tags when they're off, and adding a card by hand clears it", async () => {
  const state = fixture(); state.settings.systemTags = false; state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state });
  try {
    f.button("Send 1 card to Anki").click(); await tick();
    const sent = f.container.querySelector(".ab-sent") as unknown as HTMLElement;
    assert.equal(sent.hidden, false);
    assert.doesNotMatch(sent.textContent!, /learnharness/);
    await f.more("Write a card by hand"); await tick();
    const dialog = f.dialog()!;
    const [front, back] = Array.from(dialog.querySelectorAll("textarea")) as unknown as HTMLTextAreaElement[];
    front.value = "Front text"; back.value = "Back text";
    f.button("Add card", dialog).click(); await tick();
    assert.equal(sent.hidden, true, "the old confirmation doesn't sit beside the new card");
  } finally { await f.dispose(); }
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
    assert.match(f.container.textContent!, /Address changed\. Choose the profile again in settings\./);
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

test("tags suggest the profile's Anki tags and take their casing from the collection (#31, #28)", async () => {
  const state = fixture(); state.settings.lastDeck = "Year 3::NPP1";
  const f = await setup({ state, connection: () => ({ profile: "Throwaway", decks: ["Year 3::NPP1"], tags: ["YEAR_3::NPP1::Lecture_01", "YEAR_3::QM3", "physics"] }) });
  try {
    const options = () => Array.from(f.container.querySelectorAll("#anki-bridge-tags option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    assert.equal(f.tags().getAttribute("list"), "anki-bridge-tags");
    assert.equal(f.tags().value, "YEAR_3::NPP1::Lecture_01", "the template's {deck} follows the collection's YEAR_3 casing");
    assert.match(f.container.textContent!, /Separate tags with spaces\./);
    f.type(f.tags(), "YEAR_3::NPP1::Lecture_01 ph");
    assert.deepEqual(options(), ["YEAR_3::NPP1::Lecture_01 physics"]);
    f.type(f.tags(), "y");
    assert.deepEqual(options(), ["YEAR_3::NPP1::Lecture_01", "YEAR_3::QM3"]);
  } finally { await f.dispose(); }
});

test("an older deck lookup that finishes last can't replace a newer one's suggestions (#19)", async () => {
  const answers: Array<(value: unknown) => void> = [];
  const f = await setup({ connection: () => new Promise(resolve => answers.push(resolve)) });
  try {
    const options = () => Array.from(f.container.querySelectorAll("#anki-bridge-decks option") as unknown as ArrayLike<HTMLOptionElement>).map(o => o.value);
    answers.shift()!({ profile: "Throwaway", decks: ["First"] }); await tick();
    assert.deepEqual(options(), ["First"]);
    await f.more("Refresh cards"); await tick();
    await f.more("Refresh cards"); await tick();
    assert.equal(answers.length, 2);
    const [older, newer] = answers;
    newer!({ profile: "Throwaway", decks: ["Newer"] }); await tick();
    older!({ profile: "Throwaway", decks: ["Older"] }); await tick();
    assert.deepEqual(options(), ["Newer"]);
  } finally { await f.dispose(); }
});

test("Download .apkg works unpaired, saves the package, keeps cards approved and can save the same file again", async () => {
  const { exportPackage } = await import("../src/anki/apkg.ts");
  const { initialState } = await import("../src/anki/state.ts");
  const state = fixture(); state.destination = null;
  state.cards = [card("0b6f7c1e-0000-4000-8000-00000000000a", { status: "approved", front: "Synthetic **front**" }), card("0b6f7c1e-0000-4000-8000-00000000000b"), card("0b6f7c1e-0000-4000-8000-00000000000c", { status: "failed" })];
  const backend = { ...initialState(), cards: structuredClone(state.cards) } as unknown as Parameters<typeof exportPackage>[0];
  backend.settings.tagTemplate = state.settings.tagTemplate;
  const saved: { name: string; bytes: Buffer }[] = [];
  const blobs = new Map<string, Blob>();
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => { const url = `blob:test/${blobs.size}`; blobs.set(url, blob); return url; };
  URL.revokeObjectURL = () => {};
  let failAfterCommit = false, exportCount = 0;
  let markGate: Promise<void> | undefined, exportGate: Promise<void> | undefined;
  const f = await setup({ state, handler: async (name, input) => {
    if (name === "exportPackage" && exportGate) await exportGate;
    if (name === "exportPackage") return exportPackage(backend, input, 1_795_000_000_000 + 60_000 * exportCount++);
    if (name === "markImported" && markGate) await markGate;
    if (failAfterCommit && (name === "markImported" || name === "unmarkImported")) {
      state.cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = name === "markImported" ? "imported" : "approved"; if (name === "markImported") c.deck = input.deck; else delete c.deck; });
      return structuredClone({ ...state, ...(name === "markImported" ? { importMarkId: "test-mark" } : {}), durabilityWarning: "directory sync failed" });
    }
    return undefined;
  } });
  const pending: Promise<void>[] = [];
  (f.window as any).HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    pending.push(blobs.get(this.href)!.arrayBuffer().then(b => { saved.push({ name: this.download, bytes: Buffer.from(b) }); }));
  };
  // The export writes a real SQLite file, so wait for the save rather than a fixed number of ticks.
  const settle = async (saves = saved.length) => {
    for (let i = 0; i < 400 && pending.length < saves; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await tick(); await Promise.all(pending);
  };
  try {
    assert.equal(f.button(/^Send 2 cards to Anki/).disabled, false);
    assert.match(f.button(/^Send 2 cards/).title, /Choose a profile in settings\./);
    const download = f.button("Download .apkg");
    assert.equal(download.disabled, false, "no profile or running Anki needed");
    f.type(f.deck(), "");
    assert.equal(f.button("Download .apkg").title, "Choose a deck first.");
    f.button("Download .apkg").click(); await settle();
    assert.equal(f.calls.some(c => c.name === "exportPackage"), false);
    assert.match(f.status()!, /Choose a deck first\./);
    f.type(f.deck(), "Synthetic::Deck");
    f.button("Download .apkg").click(); await settle(1);
    assert.deepEqual(f.calls.find(c => c.name === "exportPackage")!.input,
      { ids: ["0b6f7c1e-0000-4000-8000-00000000000a", "0b6f7c1e-0000-4000-8000-00000000000c"], deck: "Synthetic::Deck", tags: ["Synthetic::Deck::Lecture_01"] });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, "anki-bridge-synthetic-deck.apkg");
    assert.equal(saved[0].bytes.readUInt32LE(0), 0x04034b50, "the saved file is the zip package");
    const panel = f.container.querySelector('.ab-sent[data-kind="download"]')!;
    assert.equal(panel.getAttribute("data-kind"), "download");
    assert.match(panel.textContent!, /Download requested: anki-bridge-synthetic-deck\.apkg, 2 cards/);
    assert.match(panel.textContent!, /Downloading does not change card status\. Open the file in Anki to import it/);
    assert.doesNotMatch(panel.textContent!, /\bSaved\b/);
    assert.match(panel.textContent!, /Importing may duplicate cards already in Anki or update notes from an earlier package/);
    assert.doesNotMatch(panel.textContent!, /sent to Anki/);
    assert.equal(f.calls.some(c => c.name === "send"), false, "a download never sends");
    assert.deepEqual(Array.from(f.review().querySelectorAll(".ab-card")).map(c => c.getAttribute("data-status")), ["approved", "draft", "failed"], "nothing marked sent");
    assert.equal(f.button(/^Send 2 cards to Anki/).disabled, false, "the same cards remain available for sending once paired");
    const draftRow = f.review().querySelector('.ab-card[data-card-id="0b6f7c1e-0000-4000-8000-00000000000b"]')!;
    f.button("Approve", draftRow).click(); await tick();
    assert.ok(f.button("Mark as imported", panel), "approving another card preserves the download receipt");
    const first = f.review().querySelector('.ab-card[data-card-id="0b6f7c1e-0000-4000-8000-00000000000a"]')!;
    f.button("Edit", first).click();
    f.type(f.review().querySelector('textarea[aria-label="Front"]') as unknown as HTMLTextAreaElement, "Unsaved change");
    f.button("Mark as imported", panel).click(); await tick();
    assert.match(f.status()!, /Save or cancel your edits/);
    assert.equal(f.calls.some(c => c.name === "markImported"), false);
    // FI-8 (S21): Download again is refused too, so it can't save a package that differs from the editor.
    const exportsBefore = f.calls.filter(c => c.name === "exportPackage").length;
    f.button("Download again", panel).click(); await tick();
    assert.match(f.status()!, /Save or cancel your edits before downloading these cards again/);
    assert.equal(f.calls.filter(c => c.name === "exportPackage").length, exportsBefore);
    assert.equal((f.review().querySelector('textarea[aria-label="Front"]') as unknown as HTMLTextAreaElement).value, "Unsaved change");
    f.button("Cancel", f.review()).click();
    // Round 1 S3: an edit started while Download again's export runs stops the save.
    let releaseExport!: () => void;
    exportGate = new Promise<void>(resolve => { releaseExport = resolve; });
    const savedBefore = saved.length;
    f.button("Download again", panel).click(); await tick();
    f.button("Edit", f.review().querySelector('.ab-card[data-card-id="0b6f7c1e-0000-4000-8000-00000000000a"]')!).click(); await tick();
    releaseExport(); exportGate = undefined;
    // Nothing is saved here, so wait for the message rather than for a file.
    for (let i = 0; i < 400 && !/Save or cancel/.test(f.status() ?? ""); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await settle();
    assert.equal(saved.length, savedBefore, "no file is saved while the card is being edited");
    assert.match(f.status()!, /Save or cancel your edits before downloading these cards again/);
    f.button("Cancel", f.review()).click(); await tick();
    failAfterCommit = true;
    let release!: () => void; markGate = new Promise(resolve => { release = resolve; });
    f.button("Mark as imported", panel).click();
    assert.equal(f.button("Download again", panel).disabled, true, "cannot download while marking");
    f.button("Dismiss", panel).click();
    assert.equal((panel as unknown as HTMLElement).hidden, false, "cannot dismiss while marking");
    release(); markGate = undefined; await tick();
    assert.match(f.status()!, /directory sync failed/);
    const importedPanel = f.container.querySelector('.ab-sent[data-kind="imported"]')!;
    assert.match(importedPanel.textContent!, /2 cards marked as imported/);
    assert.deepEqual(f.state.cards.map(c => c.status), ["imported", "approved", "imported"]);
    const history = f.container.querySelector(".ab-history") as unknown as HTMLDetailsElement;
    history.open = true; history.dispatchEvent(f.event("toggle"));
    assert.match(history.textContent!, /Sent cards \(2\)/);
    assert.match(history.textContent!, /Imported/);
    assert.match(history.textContent!, /Synthetic::Deck/);
    assert.equal(f.find("Show in Anki", history), undefined);
    await f.more("Refresh cards"); await tick();
    assert.ok(f.button("Undo", importedPanel), "refresh preserves Undo");
    await f.more("Write a card by hand"); await tick();
    const manual = f.dialog()!;
    const [front, back] = Array.from(manual.querySelectorAll("textarea")) as unknown as HTMLTextAreaElement[];
    front.value = "Manual front"; back.value = "Manual back";
    f.button("Add card", manual).click(); await tick();
    assert.ok(f.button("Undo", importedPanel), "an unrelated write preserves Undo");
    f.button("Undo", importedPanel).click(); await tick();
    assert.match(f.status()!, /directory sync failed/);
    assert.deepEqual(f.state.cards.map(c => c.status), ["approved", "approved", "approved", "draft"]);
    failAfterCommit = false;
    assert.equal(f.find("Undo", importedPanel), undefined);
    f.button("Download again", panel).click(); await settle(2);
    assert.equal(saved.length, 2);
    // The third export is the successful re-check; the second was stopped by the edit above.
    assert.equal(f.calls.filter(c => c.name === "exportPackage").length, 3, "download again re-checks the cards through the backend");
    const exports = f.calls.filter(c => c.name === "exportPackage");
    assert.deepEqual(exports[2].input, exports[0].input, "the re-check repeats the original request, including the user's tags");
    assert.deepEqual(saved[1], saved[0], "the original bytes are saved again");
    f.button("Download .apkg").click(); await settle();
    assert.equal(saved.length, 2, "a new export cannot replace the outstanding receipt");
    assert.match(f.status()!, /previous download/);
    f.button("Dismiss", panel).click();
    assert.equal((panel as unknown as HTMLElement).hidden, true);
  } finally { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; await f.dispose(); }
});

test("undo keeps a newer package receipt", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" }), card("b")];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  const f = await setup({ state, handler: (name, input) => name === "exportPackage" ? { fileName: `${input.ids.join("")}.apkg`, data: "AA==", ids: input.ids, fingerprints: input.ids.map(() => "hash"), revisions: input.ids.map((id: string) => packageRevision(state.cards.find(c => c.id === id) as any)), deck: input.deck, tags: [] } : undefined });
  (f.window as any).HTMLAnchorElement.prototype.click = function () {};
  try {
    f.button("Download .apkg").click(); await tick();
    f.button("Mark as imported", f.container.querySelector('.ab-sent[data-kind="download"]')).click(); await tick();
    f.button("Approve", f.review()).click(); await tick();
    f.button("Download .apkg").click(); await tick();
    const receipt = f.container.querySelector('.ab-sent[data-kind="download"]')!;
    assert.match(receipt.textContent!, /b\.apkg/);
    f.button("Undo", f.container.querySelector('.ab-sent[data-kind="imported"]')).click(); await tick();
    assert.match(receipt.textContent!, /b\.apkg/, "undo must not replace a newer receipt");
    assert.ok(f.button("Mark as imported", receipt));
    state.cards[1].front = "Changed after download";
    await f.more("Refresh cards"); await tick();
    assert.equal(f.button("Download again", receipt).disabled, true);
    state.cards[1].front = "Question b";
    Object.assign(state.cards[1], { status: "sent", noteId: 123, deck: "Scratch", destination: paired() });
    await f.more("Refresh cards"); await tick();
    assert.equal(f.button("Download again", receipt).disabled, true);
    assert.equal(f.button("Mark as imported", receipt).disabled, true);
    assert.match(receipt.textContent!, /no longer eligible/);
    assert.equal(f.button("Dismiss", receipt).disabled, false);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await f.dispose(); }
});

test("a receipt follows the exported revision, not the view's snapshot at download time", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved", front: "Version A" })];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  let saves = 0;
  const f = await setup({ state, handler: (name, input) => name === "exportPackage" ? { fileName: "a.apkg", data: "AA==", ids: input.ids, fingerprints: ["hash"], revisions: input.ids.map((id: string) => packageRevision(state.cards.find(c => c.id === id) as any)), deck: input.deck, tags: [] } : undefined });
  (f.window as any).HTMLAnchorElement.prototype.click = function () { saves++; };
  try {
    // Another view edits and reapproves the card; this view hasn't refreshed yet.
    state.cards[0].front = "Version B";
    f.button("Download .apkg").click(); await tick();
    const receipt = f.container.querySelector('.ab-sent[data-kind="download"]')!;
    assert.equal(f.button("Download again", receipt).disabled, true, "view still shows A, package holds B");
    await f.more("Refresh cards"); await tick();
    assert.equal(f.button("Download again", receipt).disabled, false, "current B matches the package");
    assert.equal(f.button("Mark as imported", receipt).disabled, false);
    state.cards[0].front = "Version A";
    await f.more("Refresh cards"); await tick();
    assert.equal(f.button("Download again", receipt).disabled, true, "returning to A must not serve the cached B bytes");
    const before = saves;
    f.button("Download again", receipt).click();
    assert.equal(saves, before);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await f.dispose(); }
});

test("a stale receipt cannot re-download a card imported in another view", async () => {
  const { exportPackage } = await import("../src/anki/apkg.ts");
  const { initialState } = await import("../src/anki/state.ts");
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  let saves = 0;
  const f = await setup({ state, handler: (name, input) => {
    if (name !== "exportPackage") return undefined;
    return exportPackage({ ...initialState(), cards: structuredClone(state.cards) } as unknown as Parameters<typeof exportPackage>[0], input, 1_795_000_000_000);
  } });
  (f.window as any).HTMLAnchorElement.prototype.click = function () { saves++; };
  try {
    const until = async (ok: () => boolean) => { for (let n = 0; n < 200 && !ok(); n++) await new Promise(r => setTimeout(r, 5)); };
    f.button("Download .apkg").click(); await until(() => !!f.container.querySelector('.ab-sent[data-kind="download"]'));
    const receipt = f.container.querySelector('.ab-sent[data-kind="download"]')!;
    f.button("Download again", receipt).click(); await until(() => saves === 2);
    assert.equal(saves, 2, "eligible cards download again");
    // Another window marks the card imported; this view has not refreshed.
    Object.assign(state.cards[0], { status: "imported", deck: "Default" });
    assert.equal(f.button("Download again", receipt).disabled, false);
    f.button("Download again", receipt).click(); await until(() => f.button("Download again", receipt).disabled === true);
    assert.equal(saves, 2, "the backend refuses the stale download");
    assert.match(f.container.textContent!, /already marked imported and cannot be downloaded again/);
    assert.equal(f.button("Download again", receipt).disabled, true, "the view refreshes and disables the receipt");
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await f.dispose(); }
});

test("a resync during Download again is not lost", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  let gate: Promise<void> | undefined;
  const f = await setup({ state, handler: async (name, input) => {
    if (name !== "exportPackage") return undefined;
    if (gate) await gate;
    return { fileName: "a.apkg", data: "AA==", ids: input.ids, fingerprints: ["hash"], revisions: input.ids.map((id: string) => packageRevision(state.cards.find(c => c.id === id) as any)), deck: input.deck, tags: [] };
  } });
  (f.window as any).HTMLAnchorElement.prototype.click = function () {};
  try {
    f.button("Download .apkg").click(); await tick();
    const receipt = f.container.querySelector('.ab-sent[data-kind="download"]')!;
    let release!: () => void; gate = new Promise(r => { release = r; });
    f.button("Download again", receipt).click(); await tick();
    state.cards.push(card("b"));
    const reads = f.calls.filter(c => c.name === "snapshot").length;
    await f.resync();
    release(); gate = undefined; for (let i = 0; i < 6; i++) await tick();
    assert.ok(f.calls.filter(c => c.name === "snapshot").length > reads, "the pending refresh runs after the retry");
    assert.ok(f.review().querySelector('.ab-card[data-card-id="b"]'), "the new card appears");
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await f.dispose(); }
});

test("Undo works while coverage is still refreshing after a mark", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
  let hold: Promise<void> | undefined;
  const f = await setup({ state, coverageGate: () => hold, handler: (name, input) => name === "exportPackage" ? { fileName: "a.apkg", data: "AA==", ids: input.ids, fingerprints: ["hash"], revisions: input.ids.map((id: string) => packageRevision(state.cards.find(c => c.id === id) as any)), deck: input.deck, tags: [] } : undefined });
  (f.window as any).HTMLAnchorElement.prototype.click = function () {};
  try {
    f.button("Download .apkg").click(); await tick();
    let release!: () => void; hold = new Promise(r => { release = r; });
    f.button("Mark as imported", f.container.querySelector('.ab-sent[data-kind="download"]')).click(); await tick(); await tick();
    const imported = f.container.querySelector('.ab-sent[data-kind="imported"]')!;
    assert.ok(imported && !(imported as unknown as HTMLElement).hidden, "the confirmation is showing");
    f.button("Undo", imported).click(); await tick(); await tick();
    assert.ok(f.calls.some(c => c.name === "unmarkImported"), "Undo runs while coverage is held");
    assert.equal(state.cards[0].status, "approved");
    release(); hold = undefined; await tick();
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await f.dispose(); }
});

test("a card imported in another view keeps unsaved edits visible for copying", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state });
  try {
    f.button("Edit", f.review()).click();
    f.type(f.review().querySelector('textarea[aria-label="Front"]') as unknown as HTMLTextAreaElement, "Unsaved work");
    Object.assign(state.cards[0], { status: "imported", deck: "Deck" });
    await f.more("Refresh cards"); await tick();
    assert.match(f.review().textContent!, /marked imported in another view/);
    assert.equal((f.review().querySelector('textarea[aria-label="Front"]') as unknown as HTMLTextAreaElement).value, "Unsaved work");
    assert.equal(f.find("Save", f.review()), undefined);
    f.button("Cancel", f.review()).click();
    assert.equal(f.review().querySelector("textarea"), null);
  } finally { await f.dispose(); }
});

test("a found note is not called newly sent or assigned the requested deck and tags", async () => {
  const state = fixture(); state.cards = [card("a", { status: "approved" })];
  const f = await setup({ state, handler: name => {
    if (name === "show") throw new Error("No matching cards found in the paired Anki profile.");
    if (name !== "send") return;
    Object.assign(state.cards[0], { status: "sent", noteId: 500, existingNote: true, destination: paired() });
    return structuredClone({ ...state, delivery: { added: [], found: ["a"], skipped: [], failed: [], deck: null, tags: [] } });
  } });
  try {
    f.type(f.deck(), "Not the actual deck");
    f.type(f.tags(), "not-applied");
    f.button("Send 1 card to Anki").click(); await tick();
    const sent = f.container.querySelector(".ab-sent") as unknown as HTMLElement;
    assert.equal(sent.hidden, false);
    assert.match(sent.textContent!, /Found 1 existing note in Anki\. Left unchanged/);
    assert.doesNotMatch(sent.textContent!, /sent to Anki|Not the actual deck|not-applied/);
    f.button("Show in Anki", sent).click(); await tick();
    assert.match(f.status()!, /No matching cards found/);
    assert.equal(sent.hidden, false);
  } finally { await f.dispose(); }
});

test("FI-8: a cloze card previews as a question with [...], and the editor switches format and inserts a blank", async () => {
  const state = fixture();
  state.cards = [
    card("c", { kind: "fact", format: "cloze", front: "In SI units, \\([\\hbar] = {{blank}}\\)", back: "\\mathrm{J\\,s}" }),
    card("f", { kind: "fact", front: "The prefix femto- means {{blank}}.", back: "\\(10^{-15}\\)" }),
    card("w", { kind: "why", front: "Why?", back: "Because." }),
  ];
  const f = await setup({ state, handler: (name, input) => {
    if (name !== "edit") return undefined;
    const target = state.cards.find(c => c.id === input.id)!;
    Object.assign(target, { front: input.front, back: input.back, extra: input.extra, status: "draft" });
    if (input.format === "cloze") target.format = "cloze"; else delete target.format;
    return structuredClone(state);
  } });
  try {
    const rows = () => Array.from(f.review().querySelectorAll(".ab-card")) as any[];
    const [clozeRow, basicRow, whyRow] = rows();
    assert.match(clozeRow.textContent, /Cloze/);
    assert.match(clozeRow.textContent, /Text/); assert.match(clozeRow.textContent, /Hidden part/);
    assert.match(clozeRow.textContent, /\[\.\.\.\]/);
    assert.doesNotMatch(clozeRow.querySelector(".ab-card-field").textContent, /\{\{blank\}\}/, "the question never shows the placeholder");
    assert.doesNotMatch(basicRow.querySelector(".ab-card-title").textContent, /Cloze/);
    // Only fact and equation drafts get the switch.
    f.button("Edit", whyRow).click(); await tick();
    assert.equal(f.find("Switch to cloze", rows()[2]), undefined);
    f.button("Cancel", rows()[2]).click(); await tick();
    // A format-only switch, with no text change, is still saved (S20).
    f.button("Edit", rows()[1]).click(); await tick();
    f.button("Switch to cloze", rows()[1]).click(); await tick();
    assert.ok(rows()[1].querySelector('textarea[aria-label="Text"]'));
    assert.ok(f.find("Insert blank", rows()[1]));
    f.button("Save", rows()[1]).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "edit")!.input, { id: "f", front: "The prefix femto- means {{blank}}.", back: "\\(10^{-15}\\)", extra: "", format: "cloze" });
    assert.equal(state.cards[1]!.format, "cloze");
    // Cloze to basic prefills a question; switching back before saving restores the fields exactly.
    f.button("Edit", rows()[0]).click(); await tick();
    f.button("Switch to basic", rows()[0]).click(); await tick();
    const front = () => rows()[0].querySelector("textarea") as HTMLTextAreaElement;
    assert.equal(front().getAttribute("aria-label"), "Front");
    assert.equal(front().value, "In SI units, \\([\\hbar] = [...]\\)");
    assert.equal((rows()[0].querySelectorAll("textarea")[1] as HTMLTextAreaElement).value, "\\(\\mathrm{J\\,s}\\)");
    f.button("Switch to cloze", rows()[0]).click(); await tick();
    assert.equal(front().value, "In SI units, \\([\\hbar] = {{blank}}\\)");
    assert.equal((rows()[0].querySelectorAll("textarea")[1] as HTMLTextAreaElement).value, "\\mathrm{J\\,s}");
    // Insert blank puts the placeholder at the cursor.
    f.type(front(), "In SI units, [ħ] = ");
    front().setSelectionRange(front().value.length, front().value.length);
    f.button("Insert blank", rows()[0]).click(); await tick();
    assert.equal(front().value, "In SI units, [ħ] = {{blank}}");
    f.button("Cancel", rows()[0]).click(); await tick();
    assert.equal(state.cards[0]!.front, "In SI units, \\([\\hbar] = {{blank}}\\)", "cancel saves nothing");
  } finally { await f.dispose(); }
});

test("FI-8: Settings shows the cloze slider at Writer chooses by default and saves a new stop", async () => {
  const f = await setup();
  try {
    const s = await f.mountSettings();
    const range = s.host.querySelector('input[type="range"]') as HTMLInputElement;
    assert.equal(range.getAttribute("aria-label"), "Cloze cards");
    assert.equal(range.value, "1");
    assert.equal(range.getAttribute("aria-valuetext"), "Writer chooses");
    assert.match(s.host.textContent!, /Cloze where the notation already says what is asked/);
    f.type(range, "2", "input");
    assert.equal(range.getAttribute("aria-valuetext"), "Prefer cloze");
    range.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { cloze: "prefer" });
    // The note type actions can target LearnHarness Cloze and say so.
    const select = s.host.querySelector('select[aria-label="Note type to repair"]') as HTMLSelectElement;
    select.value = "cloze";
    f.button("Add missing fields", s.host).click(); await tick();
    assert.match(f.dialog()!.textContent!, /LearnHarness Cloze/);
    f.button("Add fields", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "repairFields")!.input, { noteType: "cloze", expectedDestination: paired() });
    s.close();
  } finally { await f.dispose(); }
});

test("#54: Settings saves and clears Writer notes, shows an example and the 2,000-character limit, and keeps unsaved edits", async () => {
  // Mimic the backend: trimmed, and blank removes the field.
  const handler = (name: string, input: any) => {
    if (name !== "generationSettings" || input.writerNotes === undefined) return undefined;
    const notes = String(input.writerNotes).trim();
    if (notes) f.state.generationSettings.writerNotes = notes; else delete f.state.generationSettings.writerNotes;
    return structuredClone(f.state);
  };
  const f: Awaited<ReturnType<typeof setup>> & { state: { generationSettings: { writerNotes?: string } } } = await setup({ handler: (n, i) => handler(n, i) }) as never;
  try {
    const s = await f.mountSettings();
    const notes = s.host.querySelector('textarea[aria-label="Writer notes"]') as HTMLTextAreaElement;
    assert.ok(notes, "Writer notes box");
    assert.equal(notes.maxLength, 2000);
    assert.match(notes.placeholder, /femto-/);
    assert.equal(notes.value, "");
    assert.match(s.host.textContent!, /after its built-in rules/);
    assert.match(s.host.textContent!, /0 \/ 2,000 characters/);
    const save = f.button("Save notes", s.host), clear = f.button("Clear", s.host);
    assert.equal(save.disabled, true); assert.equal(clear.disabled, true);
    f.type(notes, "Name the unit system on units cards. ");
    assert.match(s.host.textContent!, /37 \/ 2,000 characters/);
    assert.equal(save.disabled, false);
    save.click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").at(-1)!.input, { writerNotes: "Name the unit system on units cards. " });
    assert.equal(notes.value, "Name the unit system on units cards.");
    assert.match(s.host.textContent!, /Writer notes saved\./);
    assert.equal(save.disabled, true); assert.equal(clear.disabled, false);
    // A refresh from another mount leaves unsaved edits in place.
    f.type(notes, "Unsaved edit");
    const other = await f.mountSettings();
    f.type(other.host.querySelector('input[type="range"]') as HTMLInputElement, "2", "change"); await tick();
    assert.equal(notes.value, "Unsaved edit");
    assert.equal((other.host.querySelector('textarea[aria-label="Writer notes"]') as HTMLTextAreaElement).value, "Name the unit system on units cards.");
    other.close();
    // Clear asks first; cancelling keeps the saved notes.
    clear.click(); await tick();
    assert.match(f.dialog()!.textContent!, /built-in rules only/);
    f.button("Cancel", f.dialog()!).click(); await tick();
    assert.equal(f.state.generationSettings.writerNotes, "Name the unit system on units cards.");
    clear.click(); await tick();
    f.button("Clear notes", f.dialog()!).click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").at(-1)!.input, { writerNotes: "" });
    assert.equal("writerNotes" in f.state.generationSettings, false);
    assert.equal(notes.value, "");
    assert.match(s.host.textContent!, /Writer notes cleared\./);
    assert.equal(clear.disabled, true);
    s.close();
  } finally { await f.dispose(); }
});
