import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
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
  let action: { run: () => void } | undefined;
  let dialog: HTMLElement | undefined;
  let dialogDisposals = 0;
  let resync: (() => void) | undefined;
  const ctx = {
    signal: activation.signal,
    cleanup: (fn: () => void) => cleanups.push(fn),
    registerView: (value: PluginView) => { view = value; return () => {}; },
    registerAction: (value: { run: () => void }) => { action = value; return () => {}; },
    placeAction: (value: { location: string }) => { assert.equal(value.location, "sidebar"); return () => {}; },
    registerSettings: (value: PluginView["mount"]) => { settings = value; return () => {}; },
    onResync: (listener: () => void) => { resync = listener; return () => { resync = undefined; }; },
    app: { openView: (id: string) => { openedView = id; } },
    call: async (name: string, input: unknown) => {
      calls.push({ name, input });
      if (handler) return handler(name, input);
      if (name === "connection") return { profile: "Throwaway <test>", decks: ["Scratch", "New::Deck"] };
      return structuredClone(state);
    },
    ui: { openDialog: (props: { content: HTMLElement; onClose: () => void }) => {
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
    openSidebar: () => { action?.run(); return openedView; },
    resync: () => resync?.(),
    dispose: async () => { controller.abort(); if (typeof cleanup === "function") await cleanup(); cleanups.forEach((fn) => fn()); await window.happyDOM.close(); },
  };
}

test("plugin UI registers sidebar/view/settings, saves password without exposing stored key, and warns about localhost", async () => {
  const f = await setup();
  try {
    assert.equal(f.openSidebar(), "bridge");
    const url = f.container.querySelector("input")!;
    url.value = "http://localhost:8766";
    url.dispatchEvent(new f.window.Event("input"));
    assert.match(f.container.textContent!, /IPv6/);
    assert.equal(f.container.querySelector('input[type=password]')!.getAttribute("value"), null);
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "settings", input: { url: "http://localhost:8766" } });
    const key = f.container.querySelector('input[type=password]')! as unknown as HTMLInputElement;
    key.value = "test-only-key";
    f.button("Save connection settings").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "settings", input: { url: f.state.settings.url, apiKey: "test-only-key" } });
    assert.equal((f.container.querySelector('input[type=password]') as unknown as HTMLInputElement).value, "");
    (f.container.querySelector('input[type=checkbox]') as unknown as HTMLInputElement).checked = true;
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
    assert.deepEqual(f.calls.at(-1), { name: "pair", input: { confirmed: true } });
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
    assert.equal(f.container.querySelectorAll("article button").length, 2);
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
    assert.deepEqual(f.calls.at(-1), { name: "send", input: { ids: ["test-id"], deck: "Brand new::Deck" } });
    assert.equal(f.container.querySelector("img"), null);
  } finally { await f.dispose(); }
});

test("plugin UI never offers resend for sent, deleted or uncertain cards and exposes recovery operations", async () => {
  const f = await setup();
  try {
    f.state.cards.push(
      { id: "sent", status: "sent", presence: "deleted", noteId: 123, front: "F", back: "B", extra: "", kind: "why" },
      { id: "uncertain", status: "sending", front: "F2", back: "B2", extra: "", kind: "why" },
    );
    f.button("Refresh cards").click(); await tick();
    assert.equal(f.container.querySelectorAll("article button").length, 1);
    assert.match(f.container.textContent!, /Anki presence: deleted/);
    f.button("Show in Anki").click(); await tick();
    assert.deepEqual(f.calls.at(-1), { name: "show", input: { ids: ["sent"] } });
    f.button("Reconcile uncertain sends").click(); await tick();
    assert.equal(f.calls.at(-1)!.name, "reconcile");
    f.button("Check presence in Anki").click(); await tick();
    assert.equal(f.calls.at(-1)!.name, "presence");
    f.resync(); await tick();
    assert.equal(f.calls.at(-1)!.name, "snapshot");
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

test("plugin UI refreshes persisted results after a send error without offering uncertain resend", async () => {
  const state = fixture();
  state.cards.push({ id: "partial", kind: "recall", status: "approved", front: "Question", back: "Answer", extra: "" });
  const f = await setup((name) => {
    if (name === "send") {
      state.cards[0]!.status = "sending";
      throw new Error("Uncertain outcome; reconcile before retrying");
    }
    return structuredClone(state);
  });
  try {
    f.button("Send approved card").click(); await tick();
    assert.match(f.container.textContent!, /Uncertain outcome/);
    assert.match(f.container.textContent!, /recall · sending/);
    assert.equal(f.calls.at(-1)!.name, "snapshot");
    assert.equal(f.container.querySelectorAll("article button").length, 0);
  } finally { await f.dispose(); }
});
