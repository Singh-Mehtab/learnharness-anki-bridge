import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { mountDrafting } from "../src/drafting-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const preflight = { preflightId: "p1", nodeIds: ["n_a"], nodeCount: 1, maximumCards: 2, inputTokens: 900, outputTokens: 1200, estimatedCost: null,
  model: { provider: "scratch", id: "writer" }, settings: {}, batches: [{ nodeIds: ["n_a"], inputTokens: 900, outputAllowance: 1200 }], skipped: [] };

function setup() {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController();
  const calls: Array<{ name: string; input: any }> = [];
  const state: any = { generationSettings: { cardsPerNode: 2, enabledKinds: ["recall", "why", "compose", "discriminate"], model: null }, generations: [] };
  let knowledge: ((ids: readonly string[]) => void) | undefined, model: ((v: { provider: string; id: string }) => void | Promise<void>) | undefined;
  let refreshed = 0, knowledgeMounts = 0;
  const widget = () => ({ update: () => {}, dispose: () => {} });
  const ctx = {
    signal: controller.signal, onResync: () => () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "generationContext") return { nodes: [{ id: "n_a", name: "Alpha", statement: "Alpha holds under A." }], catalog: {} };
      if (name === "generationSettings") Object.assign(state.generationSettings, input);
      if (name === "preflight" || name === "retryGeneration") return structuredClone(preflight);
      if (name === "generate") state.generations.push({ id: "p1", status: "running", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r1", status: "running", input: {}, outputAllowance: 1200, sources: [{ nodeId: "n_a", name: "Alpha" }] }] });
      if (name === "cancelGeneration") { state.generations[0].status = "cancelled"; state.generations[0].tasks[0].status = "cancelled"; }
      return structuredClone(state);
    },
    ui: {
      mountKnowledgePicker: (_: HTMLElement, props: { onChange: typeof knowledge }) => { knowledgeMounts++; knowledge = props.onChange; return widget(); },
      mountModelPicker: (_: HTMLElement, props: { onChange: typeof model }) => { model = props.onChange; return widget(); },
    },
  } as unknown as PluginFrontendContext;
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const unmount = mountDrafting(ctx, container as unknown as HTMLElement, controller.signal, async () => { refreshed++; });
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(b => b.textContent === label);
    assert.ok(found, `button ${label}`); return found;
  };
  return { container, calls, state, button, select: (ids: string[]) => knowledge!(ids), pickModel: (v: { provider: string; id: string }) => model!(v),
    refreshed: () => refreshed, knowledgeMounts: () => knowledgeMounts, close: async () => { unmount(); controller.abort(); await window.happyDOM.close(); } };
}

test("drafting needs explicit selection and a confirmed estimate before any generate call", async () => {
  const f = setup();
  try {
    await tick();
    assert.match(f.container.textContent!, /Choose a configured model/);
    f.button("Estimate generation").click(); await tick();
    assert.match(f.container.textContent!, /Select at least one graph node/);
    f.select(["n_a"]); await tick();
    assert.match(f.container.textContent!, /1 nodes selected/);
    assert.match(f.container.textContent!, /Alpha holds under A/);
    await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { model: { provider: "scratch", id: "writer" } });
    f.select(["n_a"]); await tick();
    f.button("Estimate generation").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.container.textContent!, /up to 2 cards in 1 model calls/);
    assert.match(f.container.textContent!, /No dollar estimate/);
    // Changing the selection invalidates the visible estimate.
    f.select(["n_a"]); await tick();
    assert.equal([...f.container.querySelectorAll("button")].some(b => b.textContent === "Confirm and generate"), false);
    f.button("Estimate generation").click(); await tick();
    f.button("Confirm and generate").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generate")!.input, { preflightId: "p1" });
    assert.ok(f.refreshed() >= 1);
    assert.match(f.container.textContent!, /running: 0\/1 tasks applied/);
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
    const toggles = [...f.container.querySelectorAll("input[type=checkbox]")] as unknown as HTMLInputElement[];
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
    assert.match(f.container.textContent!, /completed: 1\/1 tasks applied/);
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
    assert.deepEqual(f.calls.map(c => c.name).filter(n => n !== "generationStatus"), ["generationContext", "generationSettings", "generationContext"]);
  } finally { await f.close(); }
});
