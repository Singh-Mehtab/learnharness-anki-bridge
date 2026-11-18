import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { mountDrafting } from "../src/drafting-ui.ts";
import { FLAG_SHORTCUT, mountSessionFlow, registerSessionActions, SessionRequests } from "../src/session-ui.ts";

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
    ui: { mountModelPicker: () => ({ dispose() {} }), openDialog: (props: { content: HTMLElement }, options: { signal: AbortSignal }) => {
      const content = props.content;
      window.document.body.append(content as never);
      const dispose = () => { content.remove(); if (dialog?.content === content) dialog = undefined; };
      options.signal.addEventListener("abort", dispose, { once: true });
      dialog = { content, dispose };
      return { dispose, update: () => {} };
    } },
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
    assert.match(content.textContent!, /Reply: Spin is intrinsic angular momentum\./);
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
    assert.match(content.textContent!, /Note: earlier note/);
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
    assert.match(content.textContent!, /Note: I got the sign wrong/);
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

function flowFixture() {
  return {
    session: { id: "s1", title: "Spin", exists: true },
    nodes: [
      { id: "n-spin", name: "Spin", statement: "Spin is intrinsic.", flagged: true, flagNotes: ["sign"], cards: { ...none, sent: 1 } },
      { id: "n-pauli", name: "Pauli", statement: "Pauli matrices.", flagged: false, flagNotes: [], cards: none },
      { id: "n-draft", name: "Drafted", statement: "Has a draft.", flagged: false, flagNotes: [], cards: { ...none, waiting: 2 } },
      { id: "n-else", name: "Elsewhere", statement: "Sent to another profile.", flagged: false, flagNotes: [], cards: { ...none, sentElsewhere: 1 } },
    ],
    flags: [flagView({ status: "matched", nodeIds: ["n-spin"], note: "sign" })],
    cardsPerNode: 2, paired: true,
  };
}

test("make cards opens the view on that session with flagged nodes ticked and carded nodes greyed", async () => {
  const flow = flowFixture();
  const f = setup((name) => name === "sessions"
    ? { sessions: [{ id: "s1", title: "Spin", updatedAt: "", nodeCount: 4, flagCount: 1, waitingCount: 0 }], unresolved: [] }
    : flow);
  try {
    const requests = new SessionRequests();
    registerSessionActions(f.ctx, requests);
    f.actions.get("make-cards")!.run(sessionContext());
    assert.equal(f.opened(), "bridge");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const drafts: unknown[] = [];
    const dispose = mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: (r) => { drafts.push(r); } });
    await tick();
    assert.deepEqual(f.calls.map((c) => c.name), ["sessions", "sessionFlow"]);
    assert.deepEqual(f.calls[1].input, { sessionId: "s1" });
    assert.equal(container.querySelector("select")!.value, "s1");
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]"));
    assert.deepEqual(boxes.map((b) => b.checked), [true, false, false, false]);
    assert.deepEqual(Array.from(container.querySelectorAll(".anki-bridge-carded strong")).map((n) => n.textContent), ["Spin", "Drafted"]);
    assert.match(container.textContent!, /1 sent/);
    assert.match(container.textContent!, /2 not yet sent/);
    assert.match(container.textContent!, /1 sent to another profile/);
    assert.match(container.textContent!, /Note: sign/);
    assert.match(container.textContent!, /1 node selected\. Up to 2 cards\./);
    f.buttonIn(container, "Select all uncarded: 2 ideas, up to 4 cards").click();
    await tick();
    f.buttonIn(container, "Draft cards for selected").click();
    await tick();
    assert.deepEqual(drafts, [{ sessionId: "s1", nodeIds: ["n-pauli", "n-else"], backfillNodeIds: ["n-pauli", "n-else"] }]);
    dispose();
  } finally { await f.close(); }
});

test("removing a flag clears automatic ticks but preserves explicit checkbox choices", async () => {
  const flow = flowFixture();
  flow.nodes[1].flagged = true;
  const f = setup((name) => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (name === "unflag") { flow.flags = []; flow.nodes.forEach(n => { n.flagged = false; }); return { removed: "f1" }; }
    return flow;
  });
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const drafts: unknown[] = [];
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: r => { drafts.push(r); } });
    await tick();
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]"));
    boxes[1].checked = false; boxes[1].dispatchEvent(new f.window.Event("change") as never);
    boxes[1].checked = true; boxes[1].dispatchEvent(new f.window.Event("change") as never);
    f.buttonIn(container, "Remove flag").click(); await tick();
    assert.deepEqual(Array.from(container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")).map(b => b.checked), [false, true, false, false]);
    f.buttonIn(container, "Draft cards for selected").click(); await tick();
    assert.deepEqual(drafts, [{ sessionId: "s1", nodeIds: ["n-pauli"], backfillNodeIds: [] }]);
  } finally { await f.close(); }
});

test("manual checkbox changes keep Clear selection and Draft enabled state current", async () => {
  const flow = flowFixture(); flow.flags = []; flow.nodes.forEach(n => { n.flagged = false; });
  const f = setup(name => name === "sessions" ? { sessions: [], unresolved: [] } : flow);
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: () => {} }); await tick();
    const box = container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")[1];
    assert.equal(f.buttonIn(container, "Clear selection").disabled, true);
    box.checked = true; box.dispatchEvent(new f.window.Event("change") as never);
    assert.equal(f.buttonIn(container, "Clear selection").disabled, false);
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, false);
    box.checked = false; box.dispatchEvent(new f.window.Event("change") as never);
    assert.equal(f.buttonIn(container, "Clear selection").disabled, true);
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, true);
    box.checked = true; box.dispatchEvent(new f.window.Event("change") as never);
    f.buttonIn(container, "Clear selection").click(); await tick();
    assert.equal(container.querySelectorAll("li input:checked").length, 0);
  } finally { await f.close(); }
});

test("a failed session switch hides the previous session's actionable flow", async () => {
  const f = setup((name, input) => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if ((input as { sessionId: string }).sessionId === "s2") throw new Error("Session load failed");
    return flowFixture();
  });
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: () => {} }); await tick();
    assert.ok(container.querySelector(".anki-bridge-nodes"));
    requests.request("s2"); await tick();
    assert.equal(container.querySelector("select")!.value, "s2");
    assert.match(container.textContent!, /Session load failed/);
    assert.equal(container.querySelector(".anki-bridge-nodes") === null, true);
    assert.equal(container.querySelector(".anki-bridge-flags") === null, true);
    assert.equal([...container.querySelectorAll("button")].some(b => b.textContent === "Draft cards for selected"), false);
  } finally { await f.close(); }
});

test("a Make cards request during a load discards the superseded flow and loads the requested session", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const second = { ...flowFixture(), session: { id: "s2", title: "Optics", exists: true },
    nodes: [{ ...flowFixture().nodes[0], id: "n-optics", name: "Lens", statement: "Lenses focus light." }], flags: [] };
  const f = setup((name, input) => name === "sessions" ? { sessions: [], unresolved: [] }
    : (input as { sessionId: string }).sessionId === "s1" ? gate : second);
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const drafts: unknown[] = [];
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: r => { drafts.push(r); } }); await tick();
    requests.request("s2"); release(flowFixture()); await tick(); await tick();
    assert.equal(container.querySelector("select")!.value, "s2");
    assert.match(container.querySelector(".anki-bridge-nodes")?.textContent ?? "", /Lens/);
    assert.doesNotMatch(container.textContent!, /Spin is intrinsic/);
    f.buttonIn(container, "Draft cards for selected").click(); await tick();
    assert.deepEqual(drafts, [{ sessionId: "s2", nodeIds: ["n-optics"], backfillNodeIds: [] }]);
  } finally { release(flowFixture()); await f.close(); }
});

test("a superseded session load error does not remain above the new session", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise((_resolve, no) => { reject = no; });
  const second = { ...flowFixture(), session: { id: "s2", title: "Optics", exists: true } };
  const f = setup((name, input) => name === "sessions" ? { sessions: [], unresolved: [] }
    : (input as { sessionId: string }).sessionId === "s1" ? gate : second);
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests }); await tick();
    requests.request("s2"); reject(new Error("Superseded session load failed")); await tick(); await tick();
    assert.equal(container.querySelector("select")!.value, "s2");
    assert.ok(container.querySelector(".anki-bridge-nodes"));
    assert.doesNotMatch(container.textContent!, /Superseded session load failed/);
  } finally { await f.close(); }
});

test("without a drafting callback the draft button stays disabled", async () => {
  const f = setup((name) => name === "sessions" ? { sessions: [], unresolved: [] } : flowFixture());
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests });
    await tick();
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, true);
    assert.doesNotMatch(container.textContent!, /connects to the 0\.3\.0/);
    // An unlisted session still appears in the picker.
    assert.equal(container.querySelector("select")!.value, "s1");
  } finally { await f.close(); }
});

test("waiting flags refresh on extraction activity and keep the learner's choices", async () => {
  let flow: ReturnType<typeof flowFixture> = { ...flowFixture(), nodes: [{ ...flowFixture().nodes[1] }], flags: [flagView()] };
  const f = setup((name) => name === "sessions" ? { sessions: [], unresolved: [] } : flow);
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests });
    await tick();
    assert.match(container.textContent!, /Waiting for extraction/);
    const box = container.querySelector<HTMLInputElement>("li input[type=checkbox]")!;
    box.checked = true; box.dispatchEvent(new f.window.Event("change") as never);
    // Extraction lands: a flagged node appears. Activity events trigger a re-check.
    flow = { ...flowFixture(), nodes: [flowFixture().nodes[0], flowFixture().nodes[1]] };
    const before = f.calls.length;
    for (const listener of f.events) listener({ type: "jobs-changed" });
    await tick(1100);
    assert.equal(f.calls.length, before);
    for (const listener of f.events) listener({ type: "activity-changed" });
    for (const listener of f.events) listener({ type: "activity-changed" });
    await tick(1100);
    assert.deepEqual(f.calls.slice(before).map((c) => c.name), ["sessions", "sessionFlow"]);
    assert.doesNotMatch(container.textContent!, /Waiting for extraction/);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("li input[type=checkbox]"));
    assert.deepEqual(boxes.map((b) => b.checked), [true, true]); // new flagged node ticked, manual tick kept
  } finally { await f.close(); }
});

test("flags in other sessions stay listed and can be removed or opened", async () => {
  let unresolved = [flagView({ id: "f2", sessionId: "s2", sessionTitle: "Optics", status: "no-nodes", note: "lens" })];
  const f = setup((name, input) => {
    if (name === "sessions") return { sessions: [], unresolved };
    if (name === "unflag") { unresolved = []; return { removed: (input as { id: string }).id }; }
    return { ...flowFixture(), session: { id: "s2", title: "Optics", exists: false }, nodes: [], flags: unresolved };
  });
  try {
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    mountSessionFlow(f.ctx, container, new AbortController().signal, { requests: new SessionRequests() });
    await tick();
    assert.match(container.textContent!, /Unresolved flags in other sessions \(1\)/);
    assert.match(container.textContent!, /Optics/);
    assert.match(container.textContent!, /Note: lens/);
    assert.match(container.textContent!, /no new ideas/);
    f.buttonIn(container, "Open session").click();
    await tick();
    assert.deepEqual(f.calls.at(-1), { name: "sessionFlow", input: { sessionId: "s2" } });
    assert.match(container.textContent!, /no longer saved/);
    f.buttonIn(container, "Remove flag").click();
    await tick();
    assert.deepEqual(f.calls.find((c) => c.name === "unflag")?.input, { id: "f2" });
    assert.doesNotMatch(container.textContent!, /Note: lens/);
  } finally { await f.close(); }
});

test("session coverage mutations invalidate drafting immediately and refresh both coverage views with the current hash", async () => {
  const flow: any = flowFixture();
  flow.nodes = [{ ...flow.nodes[1], statementHash: "a".repeat(64), coverage: { state: "no-cards", base: "no-cards", selectable: true,
    uncarded: true, canDismiss: true, dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 } }];
  let invalidated = 0, refreshed = 0;
  const f = setup((name) => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (name === "dismissNode") Object.assign(flow.nodes[0].coverage, { state: "dismissed", base: "dismissed", selectable: false, uncarded: false, canDismiss: false, dismissed: true });
    if (name === "restoreNode") Object.assign(flow.nodes[0].coverage, { state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true, dismissed: false });
    return structuredClone(flow);
  });
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const dispose = mountSessionFlow(f.ctx, container, new AbortController().signal, { requests,
      onInvalidateEstimate: () => { invalidated++; }, onCoverageChanged: async () => { refreshed++; }, onDraft: () => {} });
    await tick(); const before = invalidated, beforeRefresh = refreshed;
    f.buttonIn(container, "Don't card this").click(); assert.ok(invalidated > before); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissNode")!.input, { nodeId: "n-pauli", statementHash: "a".repeat(64) });
    assert.equal(refreshed, beforeRefresh + 1); assert.equal(container.querySelector<HTMLInputElement>('li input[type=checkbox]')!.disabled, true);
    f.buttonIn(container, "Restore").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "restoreNode")!.input, { nodeId: "n-pauli", statementHash: "a".repeat(64) });
    assert.equal(refreshed, beforeRefresh + 2); assert.equal(container.querySelector<HTMLInputElement>('li input[type=checkbox]')!.checked, false);
    dispose();
  } finally { await f.close(); }
});

test("session coverage reports a saved mutation separately from a failed refresh", async () => {
  const flow: any = flowFixture();
  const node = { ...flow.nodes[1], statementHash: "a".repeat(64), coverage: { state: "no-cards", base: "no-cards", selectable: true,
    uncarded: true, canDismiss: true, dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 } };
  flow.nodes = [node];
  let fail = false;
  const f = setup(name => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (name === "dismissNode" || name === "restoreNode") {
      const dismissed = name === "dismissNode";
      Object.assign(node.coverage, { state: dismissed ? "dismissed" : "no-cards", base: dismissed ? "dismissed" : "no-cards",
        selectable: !dismissed, canDismiss: !dismissed, dismissed });
      fail = true;
    } else if (fail) throw new Error("Graph read failed");
    return flow;
  });
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const panel = mountSessionFlow(f.ctx, container, f.ctx.signal, { requests, onDraft: () => {} });
    await tick();
    for (const [action, result] of [["Don't card this", /Dismissal saved/], ["Restore", /Restoration saved/]] as const) {
      f.buttonIn(container, action).click(); await tick();
      assert.match(container.textContent!, result);
      assert.match(container.textContent!, /refresh failed.*Graph read failed/i);
      assert.match(container.textContent!, /Coverage is stale/);
      assert.equal(f.buttonIn(container, action).disabled, true);
      fail = false; await panel.refresh();
      assert.doesNotMatch(container.textContent!, /Coverage is stale/);
    }
    panel();
  } finally { await f.close(); }
});

test("session graph failure retains coverage marked stale and disables drafting until a successful refresh", async () => {
  const flow = flowFixture(); let fail = false;
  const f = setup(name => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (fail) throw new Error("Graph read failed");
    return structuredClone(flow);
  });
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const panel = mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: () => {} });
    await tick(); fail = true; await panel.refresh();
    assert.match(container.textContent!, /Coverage is stale/); assert.match(container.textContent!, /Spin is intrinsic/);
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, true);
    assert.equal(container.querySelector<HTMLInputElement>('li input[type=checkbox]')!.disabled, true);
    fail = false; await panel.refresh();
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, false);
    panel();
  } finally { await f.close(); }
});

test("session missing-source history remains visible without current nodes and has no generation checkbox", async () => {
  const flow: any = flowFixture(); flow.nodes = [];
  flow.missing = [{ id: "gone", name: "Historical source", statement: "Previously extracted.", statementHash: "a".repeat(64),
    cards: { waiting: 1, sent: 0, sentElsewhere: 0 }, coverage: { state: "source-missing", base: "drafts-waiting", selectable: false, uncarded: false,
      canDismiss: false, dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 } }];
  const f = setup(name => name === "sessions" ? { sessions: [], unresolved: [] } : flow);
  try {
    const requests = new SessionRequests(); requests.request("s1");
    const container = f.window.document.createElement("div") as unknown as HTMLElement;
    const panel = mountSessionFlow(f.ctx, container, new AbortController().signal, { requests, onDraft: () => {} });
    await tick(); assert.match(container.textContent!, /Historical source/); assert.match(container.textContent!, /Source missing/);
    assert.equal(container.querySelectorAll('li input[type=checkbox]').length, 0);
    assert.equal(f.buttonIn(container, "Draft cards for selected").disabled, true); panel();
  } finally { await f.close(); }
});

test("session to drafting handoff preserves flagged, bulk and mixed per-target intent into preflight", async () => {
  const flow = flowFixture();
  const state = { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall"], model: { provider: "scratch", id: "writer" } }, generations: [] };
  const f = setup(name => {
    if (name === "sessions") return { sessions: [], unresolved: [] };
    if (name === "sessionFlow" || name === "coverageContext") return flow;
    if (name === "preflight") return { preflightId: "p1", nodeCount: 1, maximumCards: 2, inputTokens: 1, outputTokens: 1, estimatedCost: null, model: state.generationSettings.model, batches: [], skipped: [] };
    return state;
  });
  const sessionHost = f.window.document.createElement("div") as unknown as HTMLElement;
  const draftHost = f.window.document.createElement("div") as unknown as HTMLElement;
  const scope = new AbortController();
  const drafting = mountDrafting(f.ctx, draftHost, scope.signal, async () => {});
  const requests = new SessionRequests(); requests.request("s1");
  const panel = mountSessionFlow(f.ctx, sessionHost, scope.signal, { requests,
    onDraft: ({ nodeIds, backfillNodeIds }) => drafting.select(nodeIds, backfillNodeIds) });
  const estimate = async () => {
    f.buttonIn(sessionHost, "Draft cards for selected").click(); await tick();
    f.buttonIn(draftHost, "Estimate generation").click(); await tick();
    return f.calls.filter(c => c.name === "preflight").at(-1)?.input;
  };
  try {
    await tick();
    assert.deepEqual(await estimate(), { nodeIds: ["n-spin"], backfillNodeIds: [] }, "flagged defaults stay explicit");
    f.buttonIn(sessionHost, /^Select all uncarded/).click();
    assert.deepEqual(await estimate(), { nodeIds: ["n-pauli", "n-else"], backfillNodeIds: ["n-pauli", "n-else"] });
    const spin = sessionHost.querySelector<HTMLInputElement>('[aria-label="Select Spin"]')!;
    spin.checked = true; spin.dispatchEvent(new f.window.Event("change") as never);
    assert.deepEqual(await estimate(), { nodeIds: ["n-pauli", "n-else", "n-spin"], backfillNodeIds: ["n-pauli", "n-else"] }, "manual additions do not promote other bulk choices");
  } finally { panel(); drafting.dispose(); scope.abort(); await f.close(); }
});
