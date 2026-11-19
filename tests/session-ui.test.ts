import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { mountDrafting } from "../src/drafting-ui.ts";
import { FLAG_SHORTCUT, mountSources, registerSessionActions, SessionRequests } from "../src/session-ui.ts";
import { fakeUi } from "./fake-ui.ts";

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messages = [
  { id: "u1", role: "user", content: "Explain spin" },
  { id: "a1", role: "assistant", content: [{ type: "text", text: "Spin is intrinsic angular momentum." }] },
];
function sessionContext(over: Record<string, unknown> = {}, view: Record<string, unknown> = {}) {
  return { placement: "top-bar", surface: "session", sessionId: "s1", kind: "teaching",
    view: { status: "ready", reconciliation: "ready", messages, ...view }, ...over };
}
const none = { waiting: 0, sent: 0, sentElsewhere: 0 };
const flagView = (over: Record<string, unknown> = {}) => ({ id: "f1", sessionId: "s1", sessionTitle: "Spin", messageIds: ["a1"], note: "", flaggedAt: "2026-11-18T10:00:00.000Z", status: "waiting", nodeIds: [], ...over });

function setup(handler: (name: string, input: unknown) => unknown) {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const activation = new AbortController();
  const calls: Array<{ name: string; input: unknown }> = [];
  const actions = new Map<string, { id: string; shortcut?: unknown; disabled?: (c: unknown) => boolean; run: (c: unknown) => unknown }>();
  const placements: Array<Record<string, unknown>> = [];
  const events: Array<(e: { type: string }) => void> = [];
  let dialog: { content: HTMLElement; dispose: () => void } | undefined;
  let opened = "";
  const ctx = {
    signal: activation.signal,
    cleanup: () => {},
    registerAction: (a: { id: string; run: (c: unknown) => unknown }) => { actions.set(a.id, a); return () => {}; },
    placeAction: (p: Record<string, unknown>) => { placements.push(p); return () => {}; },
    onResync: () => () => {},
    onAppEvent: (listener: (e: { type: string }) => void) => { events.push(listener); return () => {}; },
    app: { openView: (id: string) => { opened = id; } },
    call: async (name: string, input: unknown) => { calls.push({ name, input }); return structuredClone(await handler(name, input)); },
    ui: fakeUi({ openDialog: (props: { content: HTMLElement }, options: { signal: AbortSignal }) => {
      const content = props.content;
      window.document.body.append(content as never);
      const dispose = () => { content.remove(); if (dialog?.content === content) dialog = undefined; };
      options.signal.addEventListener("abort", dispose, { once: true });
      dialog = { content, dispose };
      return { dispose, update: () => {} };
    } }),
  } as unknown as PluginFrontendContext;
  const buttonIn = (parent: ParentNode, label: string | RegExp) => {
    const found = Array.from(parent.querySelectorAll("button")).find((b) => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
    assert.ok(found, `button ${label}`);
    return found as unknown as HTMLButtonElement;
  };
  return { window, ctx, calls, actions, placements, events, dialog: () => dialog, opened: () => opened, buttonIn,
    close: async () => { activation.abort(); await window.happyDOM.close(); } };
}

test("flag and make-cards actions register in the teaching top bar with a shortcut", async () => {
  const f = setup(() => ({}));
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    assert.deepEqual([...f.actions.keys()], ["flag-for-anki", "make-cards"]);
    assert.deepEqual(f.actions.get("flag-for-anki")!.shortcut, { scope: { sessions: ["teaching"] }, defaultBinding: FLAG_SHORTCUT });
    assert.deepEqual(f.placements, [
      { id: "flag-top-bar", actionId: "flag-for-anki", location: "top-bar", sessions: ["teaching"] },
      { id: "make-cards-top-bar", actionId: "make-cards", location: "top-bar", sessions: ["teaching"] },
    ]);
    const disabled = f.actions.get("flag-for-anki")!.disabled!;
    assert.equal(disabled(sessionContext()), false);
    assert.equal(disabled(sessionContext({}, { status: "streaming" })), true);
    assert.equal(disabled(sessionContext({}, { status: "submitted" })), true);
    assert.equal(disabled(sessionContext({}, { reconciliation: "syncing" })), true);
    assert.equal(disabled(sessionContext({ kind: "practice" })), true);
    assert.equal(disabled(sessionContext({}, { messages: [messages[0]] })), true);
    assert.equal(disabled({ placement: "keyboard", surface: "app", pathname: "/" }), true);
    await assert.rejects(Promise.resolve(f.actions.get("flag-for-anki")!.run(sessionContext({}, { status: "streaming" }))), /Wait/);
  } finally { await f.close(); }
});

test("the shortcut flags at once, confirms briefly, and offers undo", async () => {
  const f = setup((name) => name === "flag" ? flagView({ created: true }) : { removed: "f1" });
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    await f.actions.get("flag-for-anki")!.run(sessionContext({ placement: "keyboard" }));
    assert.deepEqual(f.calls, [{ name: "flag", input: { sessionId: "s1", messageIds: ["a1"] } }]);
    const content = f.dialog()!.content;
    assert.match(content.textContent!, /Flagged for Anki/);
    assert.match(content.querySelector("blockquote")!.textContent!, /^Spin is intrinsic angular momentum\.$/);
    assert.match(content.textContent!, /Waiting for extraction/);
    f.buttonIn(content, "Undo flag").click();
    await tick();
    assert.deepEqual(f.calls.at(-1), { name: "unflag", input: { id: "f1" } });
    assert.equal(f.dialog(), undefined);
  } finally { await f.close(); }
});

test("a shortcut on an already flagged reply never offers to undo the earlier flag", async () => {
  const f = setup(() => flagView({ created: false, note: "earlier note" }));
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    await f.actions.get("flag-for-anki")!.run(sessionContext({ placement: "keyboard" }));
    const content = f.dialog()!.content;
    assert.match(content.textContent!, /Already flagged for Anki/);
    assert.equal(content.querySelector("input")!.value, "earlier note");
    assert.equal(Array.from(content.querySelectorAll("button")).some((b) => b.textContent === "Undo flag"), false);
  } finally { await f.close(); }
});

test("the shortcut confirmation closes itself unless the learner engages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(() => flagView({ status: "matched", nodeIds: ["n1", "n2"] }));
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    await f.actions.get("flag-for-anki")!.run(sessionContext({ placement: "keyboard" }));
    assert.match(f.dialog()!.content.textContent!, /2 ideas from this reply/);
    t.mock.timers.tick(3600);
    assert.equal(f.dialog(), undefined);
    await f.actions.get("flag-for-anki")!.run(sessionContext({ placement: "keyboard" }));
    f.dialog()!.content.dispatchEvent(new f.window.Event("pointerdown") as never);
    t.mock.timers.tick(10_000);
    assert.ok(f.dialog());
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("the top-bar button opens a note dialog before flagging", async () => {
  const f = setup((_name, input) => flagView({ note: (input as { note?: string }).note ?? "" }));
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    await f.actions.get("flag-for-anki")!.run(sessionContext());
    assert.equal(f.calls.length, 0);
    const content = f.dialog()!.content;
    const note = content.querySelector("input")!;
    note.value = "I got the sign wrong";
    f.buttonIn(content, "Flag").click();
    await tick();
    assert.deepEqual(f.calls, [{ name: "flag", input: { sessionId: "s1", messageIds: ["a1"], note: "I got the sign wrong" } }]);
    assert.equal(note.value, "I got the sign wrong");
    assert.match(content.textContent!, /Flagged for Anki/);
    f.buttonIn(content, "Save note");
    f.buttonIn(content, "Close").click();
    assert.equal(f.dialog(), undefined);
  } finally { await f.close(); }
});

test("an empty note in the click dialog preserves the saved note through repeated saves", async () => {
  let saved = "kept";
  const f = setup((_name, input) => {
    const note = (input as { note?: string }).note;
    if (note !== undefined) saved = note;
    return flagView({ note: saved });
  });
  try {
    registerSessionActions(f.ctx, new SessionRequests());
    await f.actions.get("flag-for-anki")!.run(sessionContext());
    f.buttonIn(f.dialog()!.content, "Flag").click();
    await tick();
    assert.deepEqual(f.calls[0].input, { sessionId: "s1", messageIds: ["a1"] });
    const note = f.dialog()!.content.querySelector("input")!;
    assert.equal(note.value, "kept");
    f.buttonIn(f.dialog()!.content, "Save note").click(); await tick();
    assert.equal(saved, "kept");
    assert.deepEqual(f.calls.at(-1)?.input, { sessionId: "s1", messageIds: ["a1"], note: "kept" });
    note.value = "";
    f.buttonIn(f.dialog()!.content, "Save note").click(); await tick();
    assert.equal(saved, ""); // Clearing a populated field is still an explicit erase.
  } finally { await f.close(); }
});

function sessionsFixture() {
  return {
    sessions: [
      { id: "s1", title: "Spin", updatedAt: "2026-11-18T10:00:00.000Z", nodeCount: 4, flagCount: 1, waitingCount: 0 },
      { id: "s2", title: "Nuclear", updatedAt: "2026-11-17T10:00:00.000Z", nodeCount: 2, flagCount: 1, waitingCount: 1 },
    ],
    unresolved: [flagView({ id: "f2", sessionId: "s2", sessionTitle: "Nuclear" })],
  };
}
function flowFixture(id = "s1") {
  return {
    session: { id, title: id === "s1" ? "Spin" : "Nuclear", exists: true },
    nodes: [{ id: "n-spin", name: "Spin", statement: "Spin is intrinsic.", flagged: true, flagNotes: ["sign"], cards: none }],
    flags: [flagView({ sessionId: id, status: "matched", nodeIds: ["n-spin"], note: "sign" })],
    cardsPerNode: 2, paired: true,
  };
}
function sources(f: ReturnType<typeof setup>, requests = new SessionRequests()) {
  const scopes: Array<unknown> = [];
  let refreshes = 0;
  const container = f.window.document.createElement("div") as any;
  f.window.document.body.append(container as never);
  const drafting = { setScope: async (scope: unknown, select?: unknown) => { scopes.push(select ? [scope, select] : scope); }, refresh: async () => { refreshes++; } };
  const controller = new AbortController();
  const dispose = mountSources(f.ctx, container as unknown as HTMLElement, controller.signal, { requests, drafting });
  const select = () => container.querySelector("select") as unknown as HTMLSelectElement;
  return { container, scopes, refreshes: () => refreshes, select, requests, dispose };
}
const handler = (name: string, input: unknown) => {
  if (name === "sessions") return sessionsFixture();
  if (name === "sessionFlow") return flowFixture((input as { sessionId: string }).sessionId);
  if (name === "unflag") return { removed: "f1" };
  return {};
};

test("Make cards opens the view scoped to that session and shows its flags", async () => {
  const f = setup(handler);
  try {
    const requests = new SessionRequests();
    registerSessionActions(f.ctx, requests);
    await f.actions.get("make-cards")!.run(sessionContext({ sessionId: "s2" }));
    assert.equal(f.opened(), "bridge");
    const s = sources(f, requests); await tick(); await tick();
    assert.deepEqual(s.scopes, [{ sessionId: "s2" }]);
    assert.equal(s.select().value, "s2");
    assert.match(s.container.textContent!, /You flagged a reply in this session/);
    assert.match(s.container.textContent!, /Note: sign/);
    assert.deepEqual(Array.from(s.select().options).map(o => o.textContent), ["Spin · 4 ideas · 1 flag", "Nuclear · 2 ideas · 1 flag waiting", "All sessions (whole graph)"]);
  } finally { await f.close(); }
});

test("the first visit opens the most recent session, or the whole graph when there are none", async () => {
  const f = setup(handler);
  try {
    const s = sources(f); await tick(); await tick();
    assert.deepEqual(s.scopes, [{ sessionId: "s1" }]);
    assert.equal(s.select().value, "s1");
  } finally { await f.close(); }
  const g = setup(name => name === "sessions" ? { sessions: [], unresolved: [] } : {});
  try {
    const s = sources(g); await tick(); await tick();
    assert.deepEqual(s.scopes, [undefined]);
    assert.equal(s.select().value, "");
  } finally { await g.close(); }
});

test("choosing the whole graph or another session rescopes the idea list", async () => {
  const f = setup(handler);
  try {
    const s = sources(f); await tick(); await tick();
    s.select().value = ""; s.select().dispatchEvent(new f.window.Event("change") as never); await tick(); await tick();
    assert.deepEqual(s.scopes.at(-1), undefined);
    assert.equal(s.container.querySelector(".ab-flags"), null, "no session flags in graph scope");
    s.select().value = "s2"; s.select().dispatchEvent(new f.window.Event("change") as never); await tick(); await tick();
    assert.deepEqual(s.scopes.at(-1), { sessionId: "s2" });
    assert.deepEqual(f.calls.filter(c => c.name === "sessionFlow").at(-1)!.input, { sessionId: "s2" });
  } finally { await f.close(); }
});

test("removing a flag unflags it and refreshes the idea list", async () => {
  const f = setup(handler);
  try {
    const s = sources(f); await tick(); await tick();
    f.buttonIn(s.container, "Remove flag").click(); await tick(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "unflag")!.input, { id: "f1" });
    assert.ok(s.refreshes() >= 1);
  } finally { await f.close(); }
});

test("flags waiting in other sessions are listed and open that session", async () => {
  const f = setup(handler);
  try {
    const s = sources(f); await tick(); await tick();
    assert.match(s.container.textContent!, /Flags waiting in other sessions/);
    f.buttonIn(s.container, "Nuclear (1)").click(); await tick(); await tick();
    assert.deepEqual(s.scopes.at(-1), { sessionId: "s2" });
    assert.equal(s.select().value, "s2");
    assert.equal(s.container.querySelector(".ab-elsewhere"), null, "the open session is not listed as elsewhere");
  } finally { await f.close(); }
});

test("a Make cards request while the view is open switches the scope", async () => {
  const f = setup(handler);
  try {
    const s = sources(f); await tick(); await tick();
    s.requests.request("s2"); await tick(); await tick();
    assert.deepEqual(s.scopes.at(-1), { sessionId: "s2" });
    assert.equal(s.select().value, "s2");
  } finally { await f.close(); }
});

test("waiting flags re-check on extraction activity and refresh the idea list", async () => {
  let waiting = true;
  const f = setup((name, input) => {
    if (name === "sessions") return { sessions: sessionsFixture().sessions, unresolved: [] };
    if (name === "sessionFlow") { const flow = flowFixture((input as { sessionId: string }).sessionId); if (waiting) { flow.nodes = []; flow.flags = [flagView()]; } return flow; }
    return {};
  });
  try {
    const s = sources(f); await tick(); await tick();
    assert.match(s.container.textContent!, /still extracting ideas/);
    waiting = false;
    for (const listener of f.events) listener({ type: "turn-settled" });
    await tick(1100); await tick(); await tick();
    assert.doesNotMatch(s.container.textContent!, /still extracting/);
    assert.ok(s.refreshes() >= 1);
  } finally { await f.close(); }
});

test("a failed session read shows the error", async () => {
  const f = setup(name => { if (name === "sessions") throw new Error("Sessions unavailable"); return {}; });
  try {
    const s = sources(f); await tick(); await tick();
    assert.match(s.container.textContent!, /Sessions unavailable/);
  } finally { await f.close(); }
});
