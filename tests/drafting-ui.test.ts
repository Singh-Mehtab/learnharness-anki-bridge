import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { mountDrafting, readableError } from "../src/drafting-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { chooseMenu, fakeUi } from "./fake-ui.ts";

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const preflight = { preflightId: "p1", nodeIds: ["n_a"], nodeCount: 1, maximumCards: 2, inputTokens: 900, outputTokens: 1200, estimatedCost: null,
  model: { provider: "scratch", id: "writer" }, settings: {}, batches: [{ nodeIds: ["n_a"], inputTokens: 900, outputAllowance: 1200 }], skipped: [] };
const coverage = () => ({ state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true,
  dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 });

function setup(options: { catalogUnavailable?: boolean; initialGraphFailure?: boolean; model?: boolean } = {}) {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController();
  const calls: Array<{ name: string; input: any }> = [];
  const graph: any = { nodes: [{ id: "n_a", name: "Alpha", statement: "Alpha holds under A.", statementHash: "a".repeat(64),
    cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: coverage() }], missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
  const session: any = { session: { id: "s1", title: "Session one", exists: true }, flags: [], cardsPerNode: 2, paired: false,
    nodes: [{ id: "n_s", name: "Session idea", statement: "Only in the session.", statementHash: "s".repeat(64), cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: coverage(), flagged: true, flagNotes: [] }] };
  const state: any = { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall", "why", "compose", "discriminate"], model: options.model ? { provider: "scratch", id: "writer" } : null }, generations: [] };
  let model: ((v: { provider: string; id: string }) => void | Promise<void>) | undefined;
  let failNextCoverage = options.initialGraphFailure;
  let mutationGate: Promise<void> | undefined, hold: Promise<void> | undefined, graphHold: Promise<void> | undefined;
  let refreshed = 0, modelMounts = 0, knowledgeMounts = 0;
  const ctx = {
    signal: controller.signal, onResync: () => () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "coverageContext") { if (failNextCoverage) { failNextCoverage = false; throw new Error("Initial graph read failed"); } const result = structuredClone(graph); await graphHold; return result; }
      if (name === "sessionFlow") return structuredClone(session);
      if (name === "generationContext") throw new Error("Catalog unavailable");
      if (name === "dismissNode" || name === "restoreNode") {
        await mutationGate;
        const node = graph.nodes.find((n: any) => n.id === input.nodeId);
        const dismissed = name === "dismissNode";
        Object.assign(node.coverage, { dismissed, selectable: !dismissed, uncarded: !dismissed, canDismiss: !dismissed,
          state: dismissed ? "dismissed" : "no-cards", base: dismissed ? "dismissed" : "no-cards" });
        return structuredClone(graph);
      }
      if (name === "generationSettings") Object.assign(state.generationSettings, input);
      if (name === "preflight" || name === "retryGeneration") { await hold; return structuredClone(preflight); }
      if (name === "generate") state.generations.push({ id: "p1", status: "running", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r1", status: "running", input: {}, outputAllowance: 1200, sources: [{ nodeId: "n_a", name: "Alpha" }] }] });
      if (name === "cancelGeneration") { state.generations[0].status = "cancelled"; state.generations[0].tasks[0].status = "cancelled"; }
      if (name === "dismissGeneration") state.generations.find((g: any) => g.id === input.id).hidden = true;
      return structuredClone(state);
    },
    ui: fakeUi({
      mountKnowledgePicker: () => { knowledgeMounts++; throw new Error("Native knowledge picker must not be mounted"); },
      mountModelPicker: (_: HTMLElement, props: { onChange: typeof model }) => {
        if (options.catalogUnavailable) throw new Error("Catalog unavailable");
        modelMounts++; model = props.onChange; return { update: () => {}, dispose: () => {} };
      },
    }),
  } as unknown as PluginFrontendContext;
  const ideas = window.document.createElement("div"), write = window.document.createElement("div");
  window.document.body.append(ideas, write);
  const panel = mountDrafting(ctx, ideas as unknown as HTMLElement, write as unknown as HTMLElement, controller.signal, async () => { refreshed++; });
  const doc = window.document;
  const text = () => `${ideas.textContent} ${write.textContent}`;
  const buttons = () => [...doc.querySelectorAll("button")];
  const button = (label: string | RegExp) => {
    const found = buttons().find(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
    assert.ok(found, `button ${label}`); return found;
  };
  const has = (label: string | RegExp) => buttons().some(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
  const event = (type: string) => new window.Event(type) as unknown as Event;
  const box = () => ideas.querySelector("li input[type=checkbox]") as unknown as HTMLInputElement;
  return { ideas, write, text, calls, state, graph, session, button, has, box, event, panel,
    select: (on: boolean) => { const b = box(); b.checked = on; b.dispatchEvent(event("change")); },
    pickModel: (v: { provider: string; id: string }) => model!(v),
    dialog: () => doc.querySelector(".ab-dialog"),
    holdGraphReload: () => {
      let resolve!: () => void, reject!: (error: Error) => void;
      graphHold = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      return { allowFollowingReads: () => { graphHold = undefined; }, resolve: () => { graphHold = undefined; resolve(); }, reject: () => { graphHold = undefined; reject(new Error("Graph reload failed")); } };
    },
    holdMutation: () => {
      let resolve!: () => void, reject!: (e: Error) => void;
      mutationGate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      return { resolve: () => { mutationGate = undefined; resolve(); }, reject: () => { mutationGate = undefined; reject(new Error("Graph read failed")); } };
    },
    holdEstimates: () => { let release!: () => void; hold = new Promise(r => { release = r; }); return () => { hold = undefined; release(); }; },
    refreshed: () => refreshed, modelMounts: () => modelMounts, knowledgeMounts: () => knowledgeMounts,
    menu: async (label: string) => { (ideas.querySelector("button.ab-icon-button") as unknown as HTMLButtonElement).click(); await chooseMenu(label); },
    close: async () => { panel.dispose(); controller.abort(); await window.happyDOM.close(); } };
}

test("writing needs a selection and a model, confirms the estimate in a dialog, then starts once", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Choose a model first/);
    assert.equal(f.button("Write cards").disabled, true);
    f.select(true); await tick();
    assert.match(f.text(), /1 idea selected, up to 2 cards/);
    assert.equal(f.button("Write cards for 1 idea").disabled, true, "no model yet");
    await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { model: { provider: "scratch", id: "writer" } });
    f.button("Write cards for 1 idea").click(); await tick();
    assert.ok(f.dialog(), "estimate dialog opens");
    assert.match(f.dialog()!.textContent!, /Up to 2.*writer.*1, or up to 3 if answers need fixing.*No estimate for this model/s);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    f.button("Start writing").click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generate").map(c => c.input), [{ preflightId: "p1" }]);
    assert.equal(f.dialog(), null);
    assert.ok(f.refreshed() >= 1);
    assert.match(f.text(), /Writing cards for 1 idea 0 of 1 batch done/);
    assert.equal(f.button("Write cards for 1 idea").disabled, true, "one generation at a time");
    f.button("Cancel").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "cancelGeneration")!.input, { id: "p1" });
    assert.match(f.text(), /Cancelled\. Finished cards are kept/);
    f.button("Try again").click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "retryGeneration").map(c => c.input), [{ id: "p1" }]);
    assert.ok(f.dialog(), "retry confirms its own estimate");
    assert.equal(f.calls.filter(c => c.name === "generate").length, 1);
  } finally { await f.close(); }
});

test("a selection change while the dialog is open blocks the start", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    f.select(false); f.select(true); await tick();
    f.button("Start writing").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.text(), /selection changed while the dialog was open/);
  } finally { await f.close(); }
});

test("an estimate that returns after the selection changed opens no dialog", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    const release = f.holdEstimates();
    f.button("Write cards for 1 idea").click(); await tick();
    f.select(false); f.select(true);
    release(); await tick();
    assert.equal(f.dialog(), null);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.text(), /selection changed/);
  } finally { await f.close(); }
});

test("card types and cap save as soon as they change, and the last type stays on", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const cap = f.write.querySelector(".ab-write-settings select") as unknown as HTMLSelectElement;
    cap.value = "4"; cap.dispatchEvent(f.event("change")); await tick();
    const toggles = () => [...f.write.querySelectorAll(".ab-chips input[type=checkbox]")] as unknown as HTMLInputElement[];
    toggles()[3]!.checked = false; toggles()[3]!.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").map(c => c.input), [{ cardsPerNode: 4 }, { enabledKinds: ["recall", "why", "compose"] }]);
    assert.match(f.text(), /Contrast Tell the idea apart from a similar one/);
    for (const i of [1, 2]) { toggles()[i]!.checked = false; toggles()[i]!.dispatchEvent(f.event("change")); await tick(); }
    assert.equal(toggles()[0]!.disabled, true, "the only remaining type cannot be turned off");
  } finally { await f.close(); }
});

test("polling updates progress without rebuilding the model picker and refreshes cards once on change", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    f.button("Start writing").click(); await tick();
    const mounts = f.modelMounts(), refreshed = f.refreshed();
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.equal(f.modelMounts(), mounts, "unchanged poll does not rebuild pickers");
    f.state.generations[0].status = "completed"; f.state.generations[0].tasks[0].status = "applied";
    f.state.generations[0].tasks[0].result = { targets: [{ nodeId: "n_a", cards: [{}, {}] }] };
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.match(f.text(), /Wrote 2 cards for 1 idea\. Review them in step 3\./);
    assert.equal(f.refreshed(), refreshed + 1);
    assert.equal(f.modelMounts(), mounts);
  } finally { await f.close(); }
});

test("finished batches can be dismissed, and dismissing the latest one empties the panel", async () => {
  const f = setup();
  try {
    const done = (id: string, cards: number) => ({ id, status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: `r-${id}`, status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: Array(cards).fill({}) }] } }] });
    f.state.generations.push(done("old", 1), done("new", 3));
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Wrote 3 cards/); assert.doesNotMatch(f.text(), /Wrote 1 card\b/);
    f.button("Dismiss").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissGeneration")!.input, { id: "new" });
    assert.doesNotMatch(f.text(), /Wrote \d+ cards?\b/, "dismissing the latest result leaves the panel empty");
  } finally { await f.close(); }
});

test("a running batch has the progress panel to itself", async () => {
  const f = setup();
  try {
    f.state.generations.push(
      { id: "old", status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r-old", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [{}] }] } }] },
      { id: "now", status: "running", nodeIds: ["n_b"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r-now", status: "running", input: {}, outputAllowance: 1, sources: [] }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Writing cards for 1 idea/);
    assert.doesNotMatch(f.text(), /Wrote 1 card\b/);
  } finally { await f.close(); }
});

test("the summary counts ideas that got cards, and lists the skipped ones", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "completed", nodeIds: ["n_a", "n_b", "n_c"], skipped: [{ nodeId: "n_c", reason: "Too long" }], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [{}, {}] }, { nodeId: "n_b", cards: [], skipReason: "Couldn't check it" }] } }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Wrote 2 cards for 1 idea\./);
    assert.match(f.text(), /2 ideas skipped/);
  } finally { await f.close(); }
});

test("a run where every idea was skipped says no cards were written", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [], skipReason: "Couldn't check it" }] } }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /No cards written\./);
    assert.doesNotMatch(f.text(), /Wrote 0/);
  } finally { await f.close(); }
});

test("failed batches show the provider message, not raw JSON", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "failed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "failed", input: {}, outputAllowance: 1, sources: [], error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Couldn't write cards\. The model call failed\./);
    assert.match(f.text(), /Invalid x-api-key \(HTTP 401\)\./);
    assert.doesNotMatch(f.text(), /authentication_error/);
    assert.equal(readableError("plain failure"), "plain failure");
  } finally { await f.close(); }
});

test("session scope reads only that session's ideas and preselects flagged ones; the graph scope does not", async () => {
  const f = setup();
  try {
    await f.panel.setScope({ sessionId: "s1" }); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "sessionFlow").map(c => c.input), [{ sessionId: "s1" }]);
    assert.equal(f.calls.some(c => c.name === "coverageContext"), false);
    assert.match(f.text(), /Session idea/); assert.doesNotMatch(f.text(), /Alpha/);
    assert.match(f.text(), /1 idea selected/);
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Alpha/); assert.doesNotMatch(f.text(), /Session idea/);
    assert.match(f.text(), /No ideas selected/);
  } finally { await f.close(); }
});

test("a handoff selection replaces the choice and resets search without starting anything", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const search = f.ideas.querySelector("input[type=search]") as unknown as HTMLInputElement;
    search.value = "unrelated"; search.dispatchEvent(f.event("input"));
    await f.panel.setScope(undefined, { nodeIds: ["n_a", "n_a"], backfillNodeIds: ["n_a"] }); await tick();
    assert.equal(search.value, "");
    assert.match(f.text(), /1 idea selected/);
    assert.equal(f.calls.some(c => c.name === "preflight" || c.name === "generate"), false);
  } finally { await f.close(); }
});

test("idea rows need neither a model nor a catalog, and never mount the native knowledge picker", async () => {
  for (const catalogUnavailable of [false, true]) {
    const f = setup({ catalogUnavailable });
    try {
      await f.panel.setScope(undefined); await tick();
      assert.match(f.text(), /Alpha holds under A/);
      assert.match(f.text(), /No cards/);
      assert.equal(f.knowledgeMounts(), 0);
      assert.equal(f.calls.some(c => c.name === "generationContext" || c.name === "connection"), false);
      assert.equal(f.box().disabled, false); assert.equal(f.box().checked, false);
      f.box().click(); assert.match(f.text(), /1 idea selected/);
    } finally { await f.close(); }
  }
});

test("dismiss and restore send the current hash and refresh eligibility without reticking", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true); await tick();
    await f.menu("Don't make cards for this idea"); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    assert.match(f.text(), /No ideas selected/);
    assert.equal(f.box().disabled, true);
    await f.menu("Make cards for this idea again"); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "restoreNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    assert.equal(f.box().disabled, false); assert.equal(f.box().checked, false);
  } finally { await f.close(); }
});

test("a queued dismissal does not run after the first one marks the list stale", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const mutation = f.holdMutation();
    await f.menu("Don't make cards for this idea"); await f.menu("Don't make cards for this idea"); await tick();
    assert.equal(f.calls.filter(c => c.name === "dismissNode").length, 1);
    mutation.reject(); await tick();
    assert.equal(f.calls.filter(c => c.name === "dismissNode").length, 1);
    assert.match(f.text(), /may be out of date/);
  } finally { await f.close(); }
});

test("a saved dismissal keeps its acknowledgement and refreshes cards when the list read fails", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const mutation = f.holdMutation(), refreshed = f.refreshed();
    await f.menu("Don't make cards for this idea"); await tick();
    const graph = f.holdGraphReload();
    mutation.resolve(); await tick();
    graph.reject(); await tick();
    assert.match(f.text(), /Saved, but the list did not refresh/);
    assert.match(f.text(), /may be out of date/);
    assert.equal(f.refreshed(), refreshed + 1, "cards refresh even if the list does not");
  } finally { await f.close(); }
});

test("older list responses cannot replace a newer view or restore a cleared selection", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true);
    gate = f.holdGraphReload(); const oldRead = f.panel.refresh(); gate.allowFollowingReads();
    f.graph.nodes[0].statement = "Newest graph view."; f.graph.nodes[0].statementHash = "c".repeat(64);
    await f.panel.refresh(); f.button("Clear").click();
    gate.resolve(); await oldRead; await tick();
    assert.match(f.text(), /Newest graph view/);
    assert.doesNotMatch(f.text(), /Alpha holds under A/);
    assert.match(f.text(), /No ideas selected/);
  } finally { gate?.resolve(); await f.close(); }
});

test("a list read failure keeps the last rows as stale and blocks writing until a refresh", async () => {
  const f = setup({ model: true }); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true); await tick();
    gate = f.holdGraphReload(); const reading = f.panel.refresh();
    gate.reject(); await reading; await tick();
    assert.match(f.text(), /may be out of date/); assert.match(f.text(), /Alpha holds under A/);
    assert.equal(f.box().disabled, true);
    assert.equal(f.button("Write cards for 1 idea").disabled, true);
    await f.panel.refresh(); await tick();
    assert.equal(f.box().disabled, false);
    assert.equal(f.button("Write cards for 1 idea").disabled, false);
  } finally { gate?.resolve(); await f.close(); }
});

test("an initial list failure recovers on refresh without a model catalog", async () => {
  const f = setup({ initialGraphFailure: true, catalogUnavailable: true });
  try {
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /may be out of date/);
    await f.panel.refresh(); await tick();
    assert.match(f.text(), /Alpha holds under A/);
    assert.doesNotMatch(f.text(), /may be out of date/);
    assert.equal(f.calls.some(c => c.name === "generationContext"), false);
  } finally { await f.close(); }
});

test("backfill intent travels through handoff and bulk selection; a manual tick is explicit", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] }); await tick();
    const write = async () => { f.button(/^Write cards for/).click(); await tick(); f.button("Cancel").click(); await tick(); };
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] });
    f.select(false); f.select(true); await tick();
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: [] });
    f.button(/^Select ideas without cards/).click(); await tick();
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] });
  } finally { await f.close(); }
});

test("a programmatic handoff accepts 1000 ideas and refuses 1001 with a warning", async () => {
  const f = setup();
  try {
    const template = f.graph.nodes[0];
    f.graph.nodes = Array.from({ length: 1001 }, (_, i) => ({ ...template, id: `node-${i}`, name: `Node ${i}` }));
    const ids = f.graph.nodes.map((n: { id: string }) => n.id);
    await f.panel.setScope(undefined, { nodeIds: ids.slice(0, 1000), backfillNodeIds: ids.slice(0, 1000) }); await tick();
    assert.equal(f.ideas.querySelectorAll("li input:checked").length, 1000);
    await f.panel.setScope(undefined, { nodeIds: ids }); await tick();
    assert.equal(f.ideas.querySelectorAll("li input:checked").length, 0, "a new scope starts from an empty selection");
    assert.match(f.text(), /That would select 1001 ideas/);
  } finally { await f.close(); }
});
