import assert from "node:assert/strict";
import test from "node:test";
import { Window, type HTMLTextAreaElement } from "happy-dom";
import { activate } from "../src/main.ts";
import type { PluginFrontendContext, PluginView } from "../sdk/index.d.ts";

type Call = { name: string; input: unknown };
function fixture() {
  return {
    settings: { url: "http://127.0.0.1:8765", lastDeck: "Scratch", hasApiKey: true },
    destination: null as { url: string; profile: string } | null,
    cards: [] as Array<Record<string, unknown>>,
  };
}
const paired = () => ({ url: "http://127.0.0.1:8765/", profile: "Throwaway" });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function setup(handler?: (name: string, input: unknown) => unknown | Promise<unknown>) {
  const window = new Window();
  // DOM exists only in these mocked frontend tests, never in the backend.
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController(), activation = new AbortController();
  const calls: Call[] = [], cleanups: Array<() => void> = [];
  const state = fixture();
  let view!: PluginView;
  let settings!: PluginView["mount"];
  let openedView = "";
  const actions = new Map<string, { run: (context?: unknown) => void }>();
  const placements: Array<{ actionId: string; location: string }> = [];
  let dialog: HTMLElement | undefined;
  let dialogDisposals = 0;
  const resyncs = new Set<() => void>();
  const ctx = {
    signal: activation.signal,
    cleanup: (fn: () => void) => cleanups.push(fn),
    registerView: (value: PluginView) => { view = value; return () => {}; },
    registerAction: (value: { id: string; run: () => void }) => { actions.set(value.id, value); return () => {}; },
    placeAction: (value: { actionId: string; location: string }) => { placements.push(value); return () => {}; },
    onAppEvent: () => () => {},
    registerSettings: (value: PluginView["mount"]) => { settings = value; return () => {}; },
    onResync: (listener: () => void) => { resyncs.add(listener); return () => { resyncs.delete(listener); }; },
    app: { openView: (id: string) => { openedView = id; } },
    call: async (name: string, input: unknown) => {
      if (name === "coverageContext") return handler?.(name, input) ?? { nodes: [], missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
      if (name === "generationStatus") return { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall"], model: null }, generations: [] };
      // This fixture checks delivery commands, not the session panel's background reads.
      if (name !== "sessions" && name !== "sessionFlow") calls.push({ name, input });
      if (handler) return handler(name, input);
      if (name === "connection") return { profile: "Throwaway <test>", decks: ["Scratch", "New::Deck"] };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      return structuredClone(state);
    },
    ui: { mountModelPicker: () => ({ update: () => {}, dispose: () => {} }), mountMarkdown: (target: HTMLElement, props: { text: string }) => {
      target.textContent = props.text;
      return { update: (next: { text: string }) => { target.textContent = next.text; }, dispose: () => {} };
    }, openDialog: (props: { content: HTMLElement; onClose: () => void }) => {
      dialog = props.content;
      window.document.body.append(dialog as unknown as Parameters<typeof window.document.body.append>[0]);
      return { dispose: () => { dialog?.remove(); dialog = undefined; dialogDisposals++; } };
    } },
  } as unknown as PluginFrontendContext;
  activate(ctx);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const cleanup = await view.mount(container as unknown as HTMLElement, controller.signal);
  await tick();
  const button = (label: string, parent = container) => {
    const found = Array.from(parent.querySelectorAll("button")).find((node) => node.textContent === label);
    assert.ok(found, `button ${label}`);
    return found;
  };
  return {
    window, controller, activation, calls, state, container, button, settings, ctx,
    dialog: () => dialog,
    dialogDisposals: () => dialogDisposals,
    openSidebar: () => {
      assert.deepEqual(placements.map((p) => [p.actionId, p.location]), [["flag-for-anki", "top-bar"], ["make-cards", "top-bar"], ["open-bridge", "sidebar"]]);
      actions.get("open-bridge")?.run(); return openedView;
    },
    resync: () => { for (const listener of resyncs) listener(); },
    dispose: async () => { controller.abort(); if (typeof cleanup === "function") await cleanup(); cleanups.forEach((fn) => fn()); await window.happyDOM.close(); },
  };
}

test("Review waiting cards focuses the exact node, not another card with the same node name", async () => {
  const state = fixture();
  state.cards = ['other:id', 'target:id'].map(nodeId => ({ id: nodeId, nodeId, nodeName: 'Same name', kind: 'recall', status: 'draft', front: nodeId, back: 'Answer', extra: '' }));
  const f = await setup(name => name === 'coverageContext' ? { nodes: [{ id: 'target:id', name: 'Same name', statement: 'Shared text', cards: { waiting: 1, sent: 1, sentElsewhere: 0 } }], missing: [], paired: true, cardsPerNode: 2 }
    : name === 'sessions' ? { sessions: [], unresolved: [] } : state);
  try {
    f.button('Review waiting cards').click();
    assert.equal(f.window.document.activeElement?.getAttribute('data-waiting-node'), 'target:id');
  } finally { await f.dispose(); }
});

test("Review waiting cards fetches a newly visible draft without discarding unsaved input", async () => {
  const state = fixture();
  state.cards = [{ id: 'existing', nodeId: 'other:id', kind: 'recall', status: 'draft', front: 'Original', back: 'Answer', extra: '' }];
  let waiting = 0;
  const f = await setup(name => name === 'coverageContext' ? { nodes: [{ id: 'target:id', name: 'Target', statement: 'Statement', cards: { waiting, sent: 1, sentElsewhere: 0 } }], missing: [], paired: true, cardsPerNode: 2 }
    : name === 'sessions' ? { sessions: [], unresolved: [] } : structuredClone(state));
  try {
    const front = f.container.querySelector<HTMLTextAreaElement>('textarea[data-keep]')!;
    front.value = 'Unsaved front'; front.dispatchEvent(new f.window.Event('input'));
    waiting = 1;
    state.cards.push({ id: 'new', nodeId: 'target:id', kind: 'recall', status: 'draft', front: 'New draft', back: 'Answer', extra: '' });
    f.button('Refresh graph').click(); await tick();
    assert.equal(f.container.querySelector('[data-waiting-node="target:id"]'), null);
    const reads = f.calls.filter(c => c.name === 'snapshot').length;
    f.button('Review waiting cards').click(); await tick();
    assert.equal(f.calls.filter(c => c.name === 'snapshot').length, reads + 1);
    assert.equal(f.window.document.activeElement?.getAttribute('data-waiting-node'), 'target:id');
    assert.equal(f.container.querySelector<HTMLTextAreaElement>('textarea[data-keep]')!.value, 'Unsaved front');
  } finally { await f.dispose(); }
});

test("a background review refresh is retried when a card action finishes as its snapshot arrives", async () => {
  const state = fixture();
  state.destination = paired();
  state.cards = [{ id: 'sent', nodeId: 'target:id', kind: 'recall', status: 'sent', destination: paired(), front: 'Sent card', back: 'Answer', extra: '' }];
  let reads = 0, releaseSnapshot!: (value: typeof state) => void, finishShow!: () => void;
  const heldSnapshot = new Promise<typeof state>(resolve => { releaseSnapshot = resolve; });
  const shown = new Promise<void>(resolve => { finishShow = resolve; });
  const f = await setup(name => {
    if (name === 'sessions') return { sessions: [], unresolved: [] };
    if (name === 'coverageContext') return undefined;
    if (name === 'snapshot') return ++reads === 2 ? heldSnapshot : structuredClone(state);
    if (name === 'show') return shown;
    return undefined;
  });
  try {
    f.button('Refresh generation').click(); await tick();
    assert.equal(reads, 2);
    f.button('Show in Anki').click();
    const older = structuredClone(state);
    state.cards.push({ id: 'new', nodeId: 'target:id', kind: 'recall', status: 'draft', front: 'New draft', back: 'Answer', extra: '' });
    finishShow(); await Promise.resolve(); releaseSnapshot(older); await tick();
    assert.equal(reads, 3, 'the finished card action must see the pending refresh');
    assert.ok(f.container.querySelector('[data-waiting-node="target:id"]'));
  } finally { await f.dispose(); }
});

test("a deferred graph refresh does not overwrite the saved dismissal acknowledgement", async () => {
  const state = fixture();
  state.destination = paired();
  state.cards = [{ id: 'sent', nodeId: 'other:id', kind: 'recall', status: 'sent', destination: paired(), front: 'Sent card', back: 'Answer', extra: '' }];
  let saved = false, failedReads = 0, finishShow!: () => void;
  const shown = new Promise<void>(resolve => { finishShow = resolve; });
  const f = await setup(name => {
    if (name === 'sessions') return { sessions: [], unresolved: [] };
    if (name === 'show') return shown;
    if (name === 'dismissNode') { saved = true; return {}; }
    if (name === 'coverageContext') {
      if (saved) { failedReads++; throw new Error('Graph read failed'); }
      return { nodes: [{ id: 'target:id', name: 'Target', statement: 'Statement', statementHash: 'a'.repeat(64),
        cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: { state: 'no-cards', base: 'no-cards', selectable: true, canDismiss: true } }],
        missing: [], paired: true, cardsPerNode: 2 };
    }
    return structuredClone(state);
  });
  try {
    f.button('Show in Anki').click();
    f.button("Don't card this").click(); await tick();
    assert.equal(failedReads, 1);
    assert.match(f.container.textContent!, /Dismissal saved, but the graph refresh failed: Graph read failed/);
    finishShow(); await tick();
    assert.equal(failedReads, 2, 'the completed review action releases the deferred refresh');
    assert.match(f.container.textContent!, /Dismissal saved, but the graph refresh failed: Graph read failed/);
    assert.match(f.container.textContent!, /Coverage is stale/);
  } finally { finishShow(); await f.dispose(); }
});

test("plugin UI registers sidebar/view/settings, saves password without exposing stored key, and warns about localhost", async () => {
  const f = await setup();
  try {
    assert.equal(f.openSidebar(), "bridge");
    const url = f.container.querySelector('input[data-keep="url"]') as unknown as HTMLInputElement;
    url.value = "http://localhost:8766";
    url.dispatchEvent(new f.window.Event("input") as never);
    assert.match(f.container.textContent!, /IPv6/);
    assert.equal(f.container.querySelector('input[type=password]')!.getAttribute("value"), null);
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "settings", input: { url: "http://localhost:8766" } });
    const key = f.container.querySelector('input[type=password]')! as unknown as HTMLInputElement;
    key.value = "test-only-key";
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "settings", input: { url: f.state.settings.url, apiKey: "test-only-key" } });
    assert.equal((f.container.querySelector('input[type=password]') as unknown as HTMLInputElement).value, "");
    (f.container.querySelector('[data-keep="clear-key"]') as unknown as HTMLInputElement).checked = true;
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "settings", input: { url: f.state.settings.url, apiKey: "" } });
    const settingsContainer = f.window.document.createElement("div");
    const cleanup = await f.settings(settingsContainer as unknown as HTMLElement, f.controller.signal); await tick();
    assert.match(settingsContainer.textContent!, /plain text/);
    assert.doesNotMatch(settingsContainer.textContent!, /Create draft/);
    if (typeof cleanup === "function") await cleanup();
  } finally { await f.dispose(); }
});

test("plugin UI pairing and destructive styling changes require host dialog confirmation", async () => {
  const f = await setup();
  try {
    assert.equal(f.button("Pair destination").disabled, true);
    f.button("Test connection").click(); await tick();
    assert.match(f.container.textContent!, /Throwaway <test>/);
    assert.equal(f.container.querySelector("test"), null);
    f.button("Pair destination").click(); await tick();
    assert.ok(f.dialog());
    assert.equal(f.calls.some((c) => c.name === "pair"), false);
    f.dialog()!.querySelector("button")!.click(); await tick();
    assert.equal(f.calls.some((c) => c.name === "pair"), false);
    f.button("Pair destination").click(); await tick();
    f.dialog()!.querySelectorAll("button")[1]!.click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "pair", input: { confirmed: true, expectedDestination: { url: f.state.settings.url, profile: "Throwaway <test>" } } });
    f.button("Update note type styling").click(); await tick();
    assert.match(f.dialog()!.textContent!, /template edits will be lost/);
    f.dialog()!.querySelectorAll("button")[1]!.click(); await tick();
    assert.ok(f.calls.some((c) => c.name === "updateStyling" && (c.input as { confirmed: boolean }).confirmed));
    f.button("Add missing fields").click(); await tick();
    assert.match(f.dialog()!.textContent!, /templates are not changed/);
    f.controller.abort(); await tick();
    assert.equal(f.dialog(), undefined);
    assert.equal(f.calls.some((c) => c.name === "repairFields"), false);
  } finally { await f.dispose(); }
});

test("re-pairing in settings refreshes the mounted review view and maintenance names the shown profile", async () => {
  const f = await setup();
  try {
    f.state.destination = paired();
    f.state.cards = [
      { id: "sent", nodeId: "n", kind: "recall", status: "sent", noteId: 1, destination: paired(), front: "Sent", back: "A", extra: "" },
      { id: "failed", nodeId: "n", kind: "recall", status: "failed", destination: paired(), front: "Failed", back: "A", extra: "" },
      { id: "pending", nodeId: "n", kind: "recall", status: "sending", destination: paired(), front: "Pending", back: "A", extra: "" },
    ];
    f.resync(); await tick();
    assert.match(f.container.textContent!, /Last delivery attempt: Throwaway/);
    assert.match(f.container.textContent!, /Delivery unconfirmed: Throwaway/);
    assert.ok(f.button("Show sent cards in Anki"));
    f.button("Update note type styling").click(); await tick();
    assert.match(f.dialog()!.textContent!, /profile Throwaway at http:\/\/127\.0\.0\.1:8765\//);
    f.dialog()!.querySelectorAll("button")[1]!.click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "updateStyling"), { name: "updateStyling", input: { confirmed: true, expectedDestination: paired() } });
    const url = f.container.querySelector('input[type=text]') as unknown as HTMLInputElement;
    url.value = "http://127.0.0.1:8766/"; url.dispatchEvent(new f.window.Event("input") as unknown as Event);
    assert.match(f.container.textContent!, /Saving a different URL clears the saved API key/);
    url.value = "http://127.0.0.1:8765/"; url.dispatchEvent(new f.window.Event("input") as unknown as Event);
    assert.doesNotMatch(f.container.textContent!, /clears the saved API key/);
    url.value = "http://127.0.0.1:9999/"; // unsaved input must survive the peer refresh
    (f.container.querySelector('details[data-keep="manual"]') as unknown as HTMLDetailsElement).open = true;
    (f.container.querySelector('[data-keep="manual-front"]') as unknown as HTMLTextAreaElement).value = "Half-written front";

    const settingsContainer = f.window.document.createElement("div");
    f.window.document.body.append(settingsContainer);
    const cleanup = await f.settings(settingsContainer as unknown as HTMLElement, f.controller.signal); await tick();
    f.button("Test connection", settingsContainer as unknown as typeof f.container).click(); await tick();
    f.button("Re-pair destination", settingsContainer as unknown as typeof f.container).click(); await tick();
    f.state.destination = { url: "http://127.0.0.1:8765/", profile: "Other" };
    f.dialog()!.querySelectorAll("button")[1]!.click(); await tick(); await tick();
    assert.match(f.container.textContent!, /Paired destination: Other/);
    assert.equal((f.container.querySelector('input[type=text]') as unknown as HTMLInputElement).value, "http://127.0.0.1:9999/");
    assert.equal((f.container.querySelector('details[data-keep="manual"]') as unknown as HTMLDetailsElement).open, true);
    assert.equal((f.container.querySelector('[data-keep="manual-front"]') as unknown as HTMLTextAreaElement).value, "Half-written front");
    assert.equal(Array.from(f.container.querySelectorAll("button")).some(b => /^Show/.test(b.textContent!)), false);
    if (typeof cleanup === "function") await cleanup();
  } finally { await f.dispose(); }
});

test("refreshes adopt untouched saved settings and keep typing through a host reconnect", async () => {
  const f = await setup();
  try {
    const viewUrl = () => (f.container.querySelector('input[type=text]') as unknown as HTMLInputElement).value;
    const settingsContainer = f.window.document.createElement("div");
    f.window.document.body.append(settingsContainer);
    const cleanup = await f.settings(settingsContainer as unknown as HTMLElement, f.controller.signal); await tick();
    const viewKey = () => f.container.querySelector('[data-keep="api-key"]') as unknown as HTMLInputElement;
    viewKey().value = "[REDACTED:Generic Password Field]";
    const settingsUrl = settingsContainer.querySelector('input[type=text]') as unknown as HTMLInputElement;
    settingsUrl.value = "http://127.0.0.1:8766/";
    f.state.settings.url = "http://127.0.0.1:8766/";
    f.button("Save connection settings", settingsContainer as unknown as typeof f.container).click(); await tick(); await tick();
    assert.equal(viewUrl(), "http://127.0.0.1:8766/", "an untouched field adopts the newly saved URL");
    assert.equal(viewKey().value, "", "a key typed for the old URL does not follow the new one");
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "settings").at(-1), { name: "settings", input: { url: "http://127.0.0.1:8766/" } });
    if (typeof cleanup === "function") await cleanup();

    (f.container.querySelector('details[data-keep="manual"]') as unknown as HTMLDetailsElement).open = true;
    (f.container.querySelector('[data-keep="manual-front"]') as unknown as HTMLTextAreaElement).value = "Typed before reconnect";
    f.resync(); await tick(); await tick();
    assert.equal((f.container.querySelector('details[data-keep="manual"]') as unknown as HTMLDetailsElement).open, true);
    assert.equal((f.container.querySelector('[data-keep="manual-front"]') as unknown as HTMLTextAreaElement).value, "Typed before reconnect");
  } finally { await f.dispose(); }
});

test("unrelated actions keep hand-card typing; Create draft consumes it; untouched card text refreshes", async () => {
  const f = await setup();
  try {
    const manual = () => f.container.querySelector('details[data-keep="manual"]') as unknown as HTMLDetailsElement;
    const front = () => f.container.querySelector('[data-keep="manual-front"]') as unknown as HTMLTextAreaElement;
    manual().open = true; front().value = "Half-written";
    f.state.cards.push({ id: "c", nodeId: "n", kind: "recall", status: "draft", front: "Question", back: "Answer", extra: "" });
    f.button("Refresh cards").click(); await tick();
    assert.equal(manual().open, true); assert.equal(front().value, "Half-written");
    const editor = () => f.container.querySelector('[data-keep="card-c-front"]') as unknown as HTMLTextAreaElement;
    assert.equal(editor().value, "Question");
    f.state.cards[0]!.front = "Changed elsewhere";
    f.resync(); await tick(); await tick();
    assert.equal(editor().value, "Changed elsewhere", "an untouched editor shows the fresh card text");
    (f.container.querySelectorAll("textarea")[1] as unknown as HTMLTextAreaElement).value = "Back";
    f.button("Create draft").click(); await tick();
    assert.equal(front().value, "", "a created draft clears the hand-card form");
  } finally { await f.dispose(); }
});

test("a background snapshot taken before an action cannot overwrite that action's result", async () => {
  const state = fixture();
  state.cards = [{ id: "one", nodeId: "n", kind: "recall", status: "draft", front: "Front", back: "Back", extra: "" }];
  let holding = false, release: (() => void) | undefined;
  const f = await setup((name) => {
    if (name === "coverageContext") return undefined;
    if (name === "connection") return { profile: "Throwaway <test>", decks: ["Scratch"] };
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (name === "approve") state.cards[0]!.status = "approved";
    const snap = structuredClone(state);
    if (name === "snapshot" && holding) return new Promise((resolve) => { release = () => resolve(snap); });
    return snap;
  });
  try {
    holding = true;
    f.resync(); await tick();
    assert.ok(release, "background snapshot is in flight");
    holding = false;
    f.button("Approve card").click(); await tick(); await tick();
    release!(); await tick(); await tick(); await tick();
    assert.equal(Array.from(f.container.querySelectorAll("button")).some((b) => b.textContent === "Approve card"), false);
  } finally { await f.dispose(); }
});

test("plugin UI hand-written draft, saved edits, explicit approval and deck send use named RPCs", async () => {
  const f = await setup();
  try {
    const inputs = f.container.querySelectorAll("textarea");
    inputs[0]!.value = "<img src=x onerror=alert(1)>";
    inputs[1]!.value = "Answer";
    f.button("Create draft").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "draft", input: { front: "<img src=x onerror=alert(1)>", back: "Answer", extra: "", kind: "recall" } });
    const card = { id: "test-id", front: "Question", back: "Answer", extra: "", kind: "recall", status: "draft" };
    f.state.cards.push(card);
    f.button("Refresh cards").click(); await tick();
    assert.equal(f.container.querySelectorAll("article button").length, 3);
    const editor = f.container.querySelector("article textarea")! as unknown as HTMLTextAreaElement;
    editor.value = "Edited";
    f.button("Approve card").click(); await tick();
    assert.match(f.container.textContent!, /Save edits before/);
    assert.equal(editor.value, "Edited");
    assert.equal(f.calls.some((c) => c.name === "approve"), false);
    f.button("Save edits").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "edit", input: { id: "test-id", front: "Edited", back: "Answer", extra: "" } });
    f.button("Approve card").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "approve", input: { ids: ["test-id"] } });
    card.status = "approved";
    f.button("Refresh cards").click(); await tick();
    const deck = f.container.querySelector('input[list]')! as unknown as HTMLInputElement;
    deck.value = "Brand new::Deck"; deck.dispatchEvent(new f.window.Event("input") as unknown as Event);
    f.button("Send approved card").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "send", input: { ids: ["test-id"], deck: "Brand new::Deck", expectedDestination: null } });
    assert.equal(f.container.querySelector("img"), null);
  } finally { await f.dispose(); }
});

test("plugin UI never offers resend for sent, deleted or uncertain cards and exposes recovery operations", async () => {
  const f = await setup();
  try {
    f.state.destination = paired();
    f.state.cards.push(
      { id: "sent", status: "sent", presence: "deleted", noteId: 123, destination: paired(), front: "F", back: "B", extra: "", kind: "why" },
      { id: "old", status: "sent", noteId: 99, destination: { url: "http://127.0.0.1:8765/", profile: "Previous" }, front: "F0", back: "B0", extra: "", kind: "why" },
      { id: "uncertain", status: "sending", front: "F2", back: "B2", extra: "", kind: "why" },
    );
    f.button("Refresh cards").click(); await tick();
    // Only the card sent to the current pairing offers Show; older history stays read-only.
    assert.equal(f.container.querySelectorAll("article button").length, 1);
    assert.match(f.container.textContent!, /Anki presence: deleted/);
    assert.match(f.container.textContent!, /Sent destination: Previous/);
    f.button("Show in Anki").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "show", input: { ids: ["sent"] } });
    f.button("Show sent cards in Anki").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "show", input: { ids: ["sent"] } });
    f.button("Reconcile uncertain sends").click(); await tick();
    assert.equal(f.calls.at(-1)!.name, "reconcile");
    f.button("Check presence in Anki").click(); await tick();
    assert.equal(f.calls.at(-1)!.name, "presence");
    const before = f.calls.length;
    f.resync(); await tick();
    assert.ok(f.calls.slice(before).some(c => c.name === "snapshot"));
  } finally { await f.dispose(); }
});

test("plugin UI displays asynchronous errors and ignores late results after unmount", async () => {
  let fail = true;
  let resolve!: (value: unknown) => void;
  const f = await setup(async () => {
    if (fail) throw new Error("Not AnkiConnect");
    return new Promise((done) => { resolve = done; });
  });
  try {
    assert.match(f.container.textContent!, /Not AnkiConnect/);
    fail = false;
    f.button("Retry loading").click(); await tick();
    f.controller.abort();
    const before = f.container.innerHTML;
    resolve(fixture()); await tick();
    assert.equal(f.container.innerHTML, before);
  } finally { await f.dispose(); }
});

test("plugin UI blocks pairing a null profile and removes stale connected status after a failed connection test", async () => {
  let mode = "open";
  const f = await setup((name) => {
    if (name !== "connection") return fixture();
    if (mode === "error") throw new Error("Connection refused");
    return { profile: mode === "null" ? null : "Throwaway", decks: [] };
  });
  try {
    f.button("Test connection").click(); await tick();
    assert.equal(f.button("Pair destination").disabled, false);
    mode = "null";
    f.button("Pair destination").click(); await tick();
    assert.equal(f.dialog(), undefined);
    assert.match(f.container.textContent!, /Open a profile in Anki/);
    assert.equal(f.button("Pair destination").disabled, true);
    mode = "error";
    f.button("Test connection").click(); await tick();
    assert.match(f.container.textContent!, /Connection refused/);
    assert.doesNotMatch(f.container.textContent!, /Connected profile/);
    assert.equal(f.button("Pair destination").disabled, true);
  } finally { await f.dispose(); }
});

test("plugin UI refreshes review and session counts after a send error without offering uncertain resend", async () => {
  const state = fixture();
  let sessionReads = 0;
  state.cards.push({ id: "partial", kind: "recall", status: "approved", front: "Question", back: "Answer", extra: "" });
  const f = await setup((name) => {
    if (name === "sessions") { sessionReads++; return { sessions: [], unresolved: [] }; }
    if (name === "send") {
      state.cards[0]!.status = "sending";
      throw new Error("Uncertain outcome; reconcile before retrying");
    }
    return structuredClone(state);
  });
  try {
    const before = sessionReads;
    f.button("Send approved card").click(); await tick();
    assert.ok(sessionReads > before, "partial-send recovery refreshes session counts");
    assert.match(f.container.textContent!, /Uncertain outcome/);
    assert.match(f.container.textContent!, /recall · sending/);
    assert.equal(f.calls.at(-1)!.name, "snapshot");
    assert.equal(f.container.querySelectorAll("article button").length, 0);
  } finally { await f.dispose(); }
});
