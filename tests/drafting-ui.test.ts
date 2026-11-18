import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { mountDrafting } from "../src/drafting-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const preflight = { preflightId: "p1", nodeIds: ["n_a"], nodeCount: 1, maximumCards: 2, inputTokens: 900, outputTokens: 1200, estimatedCost: null,
  model: { provider: "scratch", id: "writer" }, settings: {}, batches: [{ nodeIds: ["n_a"], inputTokens: 900, outputAllowance: 1200 }], skipped: [] };

function setup(options: { catalogUnavailable?: boolean; initialGraphFailure?: boolean } = {}) {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController();
  const calls: Array<{ name: string; input: any }> = [];
  const graph: any = { nodes: [{ id: "n_a", name: "Alpha", statement: "Alpha holds under A.", statementHash: "a".repeat(64),
    cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: { state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true,
      dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 } }],
    missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
  const state: any = { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall", "why", "compose", "discriminate"], model: null }, generations: [] };
  let model: ((v: { provider: string; id: string }) => void | Promise<void>) | undefined;
  let failNextCoverage = options.initialGraphFailure;
  let refreshed = 0, knowledgeMounts = 0, hold: Promise<void> | undefined, graphHold: Promise<void> | undefined, settingsHold: Promise<void> | undefined;
  const widget = () => ({ update: () => {}, dispose: () => {} });
  const ctx = {
    signal: controller.signal, onResync: () => () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "coverageContext") { if (failNextCoverage) { failNextCoverage = false; throw new Error("Initial graph read failed"); } const result = structuredClone(graph); await graphHold; return result; }
      if (name === "generationContext") throw new Error("Catalog unavailable");
      if (name === "dismissNode" || name === "restoreNode") {
        const node = graph.nodes.find((n: any) => n.id === input.nodeId);
        const dismissed = name === "dismissNode";
        Object.assign(node.coverage, { dismissed, selectable: !dismissed, uncarded: !dismissed, canDismiss: !dismissed,
          state: dismissed ? "dismissed" : "no-cards", base: dismissed ? "dismissed" : "no-cards" });
        return structuredClone(graph);
      }
      if (name === "generationSettings") { await settingsHold; Object.assign(state.generationSettings, input); }
      if (name === "preflight" || name === "retryGeneration") { await hold; return structuredClone(preflight); }
      if (name === "generate") state.generations.push({ id: "p1", status: "running", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r1", status: "running", input: {}, outputAllowance: 1200, sources: [{ nodeId: "n_a", name: "Alpha" }] }] });
      if (name === "cancelGeneration") { state.generations[0].status = "cancelled"; state.generations[0].tasks[0].status = "cancelled"; }
      return structuredClone(state);
    },
    ui: {
      mountKnowledgePicker: () => { knowledgeMounts++; throw new Error("Native knowledge picker must not be mounted"); },
      mountModelPicker: (_: HTMLElement, props: { onChange: typeof model }) => { if (options.catalogUnavailable) throw new Error("Catalog unavailable"); model = props.onChange; return widget(); },
    },
  } as unknown as PluginFrontendContext;
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const panel = mountDrafting(ctx, container as unknown as HTMLElement, controller.signal, async () => { refreshed++; });
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(b => b.textContent === label);
    assert.ok(found, `button ${label}`); return found;
  };
  return { container, calls, state, graph, button, select: (ids: string[]) => {
      for (const box of container.querySelectorAll("li input[type=checkbox]")) {
        (box as unknown as HTMLInputElement).checked = ids.includes("n_a"); box.dispatchEvent(new window.Event("change"));
      }
    }, pickModel: (v: { provider: string; id: string }) => model!(v),
    holdSettings: () => { let release!: () => void; settingsHold = new Promise(resolve => { release = resolve; }); return () => { settingsHold = undefined; release(); }; },
    holdGraphReload: () => {
      let resolve!: () => void, reject!: (error: Error) => void;
      graphHold = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      return { allowFollowingReads: () => { graphHold = undefined; }, resolve: () => { graphHold = undefined; resolve(); }, reject: () => { graphHold = undefined; reject(new Error("Graph reload failed")); } };
    },
    refreshed: () => refreshed, knowledgeMounts: () => knowledgeMounts, panel, holdEstimates: () => { let release!: () => void; hold = new Promise(r => { release = r; }); return () => { hold = undefined; release(); }; }, close: async () => { panel.dispose(); controller.abort(); await window.happyDOM.close(); } };
}

test("drafting needs explicit selection and a confirmed estimate before any generate call", async () => {
  const f = setup();
  try {
    await tick();
    assert.match(f.container.textContent!, /Choose a configured model/);
    f.button("Estimate generation").click(); await tick();
    assert.match(f.container.textContent!, /Select at least one graph node/);
    f.select(["n_a"]); await tick();
    assert.match(f.container.textContent!, /1 node selected/);
    assert.match(f.container.textContent!, /Alpha holds under A/);
    await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { model: { provider: "scratch", id: "writer" } });
    f.select(["n_a"]); await tick();
    f.button("Estimate generation").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.container.textContent!, /up to 2 cards in 1 model call\./);
    assert.match(f.container.textContent!, /No dollar estimate/);
    // Changing the selection invalidates the visible estimate.
    f.select(["n_a"]); await tick();
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    f.button("Estimate generation").click(); await tick();
    f.button("Confirm and generate").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generate")!.input, { preflightId: "p1" });
    assert.ok(f.refreshed() >= 1);
    assert.match(f.container.textContent!, /running: 0 of 1 task applied/);
    f.button("Cancel generation").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "cancelGeneration")!.input, { id: "p1" });
    f.button("Estimate retry").click(); await tick();
    assert.ok(f.button("Confirm and generate"));
    assert.equal(f.calls.filter(c => c.name === "generate").length, 1);
  } finally { await f.close(); }
});

test("drafting settings validate locally through the backend and keep the cap as a maximum", async () => {
  const f = setup();
  try {
    await tick();
    const cap = f.container.querySelector("input[type=number]") as unknown as HTMLInputElement;
    cap.value = "4";
    const toggles = [...f.container.querySelectorAll(".anki-bridge-kind-toggles input[type=checkbox]")] as unknown as HTMLInputElement[];
    toggles[3]!.checked = false;
    f.button("Save drafting defaults").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { cardsPerNode: 4, enabledKinds: ["recall", "why", "compose"] });
    assert.match(f.container.textContent!, /maximum, not a quota/);
  } finally { await f.close(); }
});

test("polling a running generation keeps unsaved settings and pickers, and refreshes cards on change", async () => {
  const f = setup();
  try {
    await tick();
    await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
    f.select(["n_a"]); await tick();
    f.button("Estimate generation").click(); await tick();
    f.button("Confirm and generate").click(); await tick();
    const mounts = f.knowledgeMounts(), refreshed = f.refreshed();
    const cap = f.container.querySelector("input[type=number]") as unknown as HTMLInputElement;
    cap.value = "3"; cap.dispatchEvent(new (cap.ownerDocument.defaultView as any).Event("input"));
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.equal(f.knowledgeMounts(), mounts, "unchanged poll does not rebuild pickers");
    assert.equal((f.container.querySelector("input[type=number]") as unknown as HTMLInputElement).value, "3");
    f.state.generations[0].status = "completed"; f.state.generations[0].tasks[0].status = "applied";
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.match(f.container.textContent!, /completed: 1 of 1 task applied/);
    assert.equal(f.refreshed(), refreshed + 1);
    assert.equal(f.knowledgeMounts(), mounts);
    assert.equal((f.container.querySelector("input[type=number]") as unknown as HTMLInputElement).value, "3");
  } finally { await f.close(); }
});

test("actions clicked while another is in flight are queued, not dropped", async () => {
  const f = setup();
  try {
    await tick();
    f.button("Save drafting defaults").click();
    f.button("Refresh graph").click();
    await tick(); await tick();
    assert.deepEqual(f.calls.map(c => c.name).filter(n => n !== "generationStatus"), ["coverageContext", "generationSettings", "coverageContext"]);
  } finally { await f.close(); }
});

test("an outside selection (0.4.0 session panel) replaces the selection without starting generation", async () => {
  const f = setup();
  try {
    await tick();
    await f.panel.select(["n_a", "n_a"]); await tick();
    assert.match(f.container.textContent!, /1 node selected/);
    assert.match(f.container.textContent!, /Alpha holds under A/);
    assert.equal(f.calls.some(c => c.name === "preflight" || c.name === "generate"), false);
  } finally { await f.close(); }
});

test("session handoff clears old confirmation before graph reload and rejects its queued click", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const f = setup();
    let gate: ReturnType<typeof f.holdGraphReload> | undefined;
    try {
      await tick();
      f.select(["n_a"]); await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
      f.button("Estimate generation").click(); await tick();
      const oldConfirm = f.button("Confirm and generate");
      gate = f.holdGraphReload();
      const selecting = f.panel.select(["n_b"]);
      oldConfirm.click(); // The click can queue before the selection action begins.
      await tick();
      assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false, outcome);
      gate[outcome](); await selecting; await tick();
      assert.equal(f.calls.some(c => c.name === "generate"), false, outcome);
      assert.match(f.container.textContent!, /Estimate changed/);
    } finally { gate?.resolve(); await f.close(); }
  }
});

test("an estimate reply that arrives after the selection or settings changed is discarded", async () => {
  for (const change of ["selection", "settings"] as const) {
    const f = setup();
    try {
      await tick();
      f.select(["n_a"]); await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
      const release = f.holdEstimates();
      f.button("Estimate generation").click(); await tick();
      if (change === "selection") f.select(["n_a", "n_b"]);
      else { const cap = f.container.querySelector("input[type=\"number\"]") as any; cap.value = "1"; cap.dispatchEvent(new cap.ownerDocument.defaultView.Event("input")); }
      release(); await tick();
      assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false, change);
      assert.equal(f.calls.some(c => c.name === "generate"), false);
    } finally { await f.close(); }
  }
});

test("coverage rows need neither a selected model nor a model catalog, and never mount the native knowledge picker", async () => {
  for (const catalogUnavailable of [false, true]) {
    const f = setup({ catalogUnavailable });
    try {
      await tick();
      assert.match(f.container.textContent!, /Alpha holds under A/);
      assert.match(f.container.textContent!, /No cards/);
      assert.equal(f.knowledgeMounts(), 0);
      assert.equal(f.calls.some(c => c.name === "generationContext" || c.name === "connection"), false);
      const box = f.container.querySelector('li input[type=checkbox]') as any;
      assert.equal(box.disabled, false); assert.equal(box.checked, false);
      box.click(); assert.match(f.container.textContent!, /1 node selected/);
      assert.equal(f.calls.some(c => c.name === "preflight" || c.name === "generate"), false);
    } finally { await f.close(); }
  }
});

test("dismiss and restore send the current hash, invalidate confirmation, and refresh eligibility without reticking", async () => {
  const f = setup();
  try {
    await tick(); f.select(["n_a"]); f.button("Estimate generation").click(); await tick();
    assert.ok(f.button("Confirm and generate"));
    f.button("Don't card this").click();
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    assert.match(f.container.textContent!, /0 nodes selected/);
    assert.equal((f.container.querySelector('li input[type=checkbox]') as any).disabled, true);
    f.button("Restore").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "restoreNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    const box = f.container.querySelector('li input[type=checkbox]') as any;
    assert.equal(box.disabled, false); assert.equal(box.checked, false);
  } finally { await f.close(); }
});

test("source changes invalidate confirmation even when the selected node ID is unchanged", async () => {
  const f = setup();
  try {
    await tick(); f.select(["n_a"]); f.button("Estimate generation").click(); await tick();
    const old = f.button("Confirm and generate");
    f.graph.nodes[0].statement = "Revised source."; f.graph.nodes[0].statementHash = "b".repeat(64);
    await f.panel.refresh();
    assert.match(f.container.textContent!, /Revised source/);
    assert.match(f.container.textContent!, /1 node selected/);
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    old.click(); await tick(); assert.equal(f.calls.some(c => c.name === "generate"), false);
  } finally { await f.close(); }
});

test("older coverage responses cannot replace a newer view or restore a cleared selection", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await tick(); f.select(["n_a"]);
    gate = f.holdGraphReload(); const oldRead = f.panel.refresh(); gate.allowFollowingReads();
    f.graph.nodes[0].statement = "Newest graph view."; f.graph.nodes[0].statementHash = "c".repeat(64);
    await f.panel.refresh(); f.button("Clear selection").click();
    gate.resolve(); await oldRead; await tick();
    assert.match(f.container.textContent!, /Newest graph view/);
    assert.doesNotMatch(f.container.textContent!, /Alpha holds under A/);
    assert.match(f.container.textContent!, /0 nodes selected/);
  } finally { gate?.resolve(); await f.close(); }
});

test("a late handoff graph read cannot retick choices cleared while it was pending", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await tick(); gate = f.holdGraphReload(); const handoff = f.panel.select(["n_a"]); await tick();
    f.button("Clear selection").click(); gate.resolve(); await handoff; await tick();
    assert.match(f.container.textContent!, /0 nodes selected/);
  } finally { gate?.resolve(); await f.close(); }
});

test("graph read failure retains the last view as stale, removes estimates, and blocks generation until refresh", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await tick(); f.select(["n_a"]); f.button("Estimate generation").click(); await tick();
    const confirm = f.button("Confirm and generate"); gate = f.holdGraphReload(); const reading = f.panel.refresh();
    gate.reject(); await reading; await tick();
    assert.match(f.container.textContent!, /Coverage is stale/); assert.match(f.container.textContent!, /Alpha holds under A/);
    assert.equal((f.container.querySelector('li input[type=checkbox]') as any).disabled, true);
    confirm.click(); f.button("Estimate generation").click(); await tick();
    assert.equal(f.calls.filter(c => c.name === "preflight").length, 1);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    await f.panel.refresh(); assert.equal((f.container.querySelector('li input[type=checkbox]') as any).disabled, false);
    assert.match(f.container.textContent!, /1 node selected/);
  } finally { gate?.resolve(); await f.close(); }
});

for (const filter of ["search", "scope"] as const) test(`a late estimate cannot survive a ${filter} change`, async () => {
  const f = setup();
  try {
    await tick(); f.select(["n_a"]); const release = f.holdEstimates(); f.button("Estimate generation").click(); await tick();
    if (filter === "search") {
      const input = f.container.querySelector('input[type=search]') as any; input.value = "hidden"; input.dispatchEvent(new input.ownerDocument.defaultView.Event("input"));
    } else {
      const input = f.container.querySelector('select[aria-label="Coverage view"]') as any; input.value = "uncarded"; input.dispatchEvent(new input.ownerDocument.defaultView.Event("change"));
    }
    release(); await tick();
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    if (filter === "search") assert.match(f.container.textContent!, /0 nodes selected/);
  } finally { await f.close(); }
});

test("a session handoff resets graph search and scope so an explicit sent node is visible and selected", async () => {
  const f = setup();
  try {
    await tick();
    Object.assign(f.graph.nodes[0].coverage, { state: "sent", base: "sent", uncarded: false, canDismiss: false });
    f.graph.nodes[0].cards.sent = 1; await f.panel.refresh();
    const scope = f.container.querySelector('select[aria-label="Coverage view"]') as any;
    scope.value = "uncarded"; scope.dispatchEvent(new scope.ownerDocument.defaultView.Event("change"));
    const search = f.container.querySelector('input[type=search]') as any;
    search.value = "unrelated"; search.dispatchEvent(new search.ownerDocument.defaultView.Event("input"));
    await f.panel.select(["n_a"]);
    assert.equal(scope.value, "all"); assert.equal(search.value, "");
    assert.match(f.container.textContent!, /Alpha holds under A/); assert.match(f.container.textContent!, /1 node selected/);
  } finally { await f.close(); }
});

for (const action of ["Save drafting defaults", "Estimate generation"]) test(`late ${action} settings responses preserve newer unsaved inputs`, async () => {
  const f = setup(); let release: (() => void) | undefined;
  try {
    await tick(); f.select(["n_a"]);
    const cap = f.container.querySelector('input[type=number]') as any;
    const edit = (value: string) => { cap.value = value; cap.dispatchEvent(new cap.ownerDocument.defaultView.Event("input")); };
    edit("3"); release = f.holdSettings(); f.button(action).click(); await tick(); edit("4");
    release(); await tick();
    assert.equal((f.container.querySelector('input[type=number]') as any).value, "4");
    assert.match(f.container.textContent!, /1 node selected\. Up to 4 cards/);
    assert.equal(f.calls.some(c => c.name === "preflight"), false);
  } finally { release?.(); await f.close(); }
});

test("Refresh graph is always available after an initial graph failure, even without a model catalog", async () => {
  for (const catalogUnavailable of [false, true]) {
    const f = setup({ initialGraphFailure: true, catalogUnavailable });
    try {
      await tick(); assert.match(f.container.textContent!, /Coverage is stale/);
      assert.equal(f.button("Refresh graph").disabled, false);
      f.button("Refresh graph").click(); await tick();
      assert.match(f.container.textContent!, /Alpha holds under A/);
      assert.doesNotMatch(f.container.querySelector('.anki-bridge-coverage [role=status]')!.textContent!, /stale/);
      assert.equal((f.container.querySelector('li input[type=checkbox]') as any).disabled, false);
      assert.equal(f.calls.some(c => c.name === "generationContext"), false);
    } finally { await f.close(); }
  }
});

test("Refresh graph clears an estimate synchronously before waiting for its graph response", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await tick(); f.select(["n_a"]); f.button("Estimate generation").click(); await tick();
    const oldConfirm = f.button("Confirm and generate"); gate = f.holdGraphReload();
    f.button("Refresh graph").click();
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    oldConfirm.click(); gate.resolve(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
  } finally { gate?.resolve(); await f.close(); }
});
