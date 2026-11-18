import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { Generation, GenerationSettings } from "./generation/types.ts";

interface Node { id: string; name: string; statement: string }
interface DraftingSnapshot { generationSettings: GenerationSettings; generations: Generation[] }
interface Preflight {
  preflightId: string; nodeCount: number; maximumCards: number; inputTokens: number; outputTokens: number;
  estimatedCost: number | null; model: { provider: string; id: string };
  batches: Array<{ nodeIds: string[] }>; skipped: Array<{ nodeId: string; reason: string }>;
}
type Kind = "recall" | "why" | "compose" | "discriminate";
const kinds: readonly Kind[] = ["recall", "why", "compose", "discriminate"];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function label(text: string, input: HTMLElement): HTMLElement { const node = el("label"); node.append(el("span", text), input); return node; }

export interface DraftingHandle {
  /** Replace the node selection, e.g. from a session panel. Discards any visible estimate; never starts generation. */
  select(nodeIds: readonly string[]): Promise<void>;
  dispose(): void;
}
/** Each view owns only its widgets/timer. Closing a view does not cancel backend generation. */
export function mountDrafting(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, onCardsChanged: () => Promise<void>): DraftingHandle {
  const root = el("section");
  root.append(el("h3", "Draft from graph nodes"));
  const feedback = el("p"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const controls = el("fieldset");
  // Polling re-renders only this list, so pickers and unsaved inputs above it are never rebuilt.
  const activity = el("div");
  root.append(feedback, controls, activity); container.append(root);
  let disposed = false, state: DraftingSnapshot | undefined;
  let nodes: Node[] = [], selection: string[] = [], preflight: Preflight | undefined;
  // Unsaved cap/kind edits survive re-renders until saved or used for an estimate.
  let unsaved: { cardsPerNode: number; enabledKinds: Kind[] } | undefined;
  let widgets: Array<{ dispose(): void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve(), pending = 0;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const disposeWidgets = () => { widgets.forEach(w => w.dispose()); widgets = []; };
  /** Actions run one at a time in click order; none are silently dropped. */
  function run(action: () => Promise<void>, rerender = true): Promise<void> {
    pending++;
    feedback.textContent = "Working...";
    queue = queue.then(async () => {
      if (!alive()) return;
      try {
        await action();
        if (alive()) { if (rerender) render(); else renderActivity(); if (pending === 1) feedback.textContent = ""; }
      } catch (error) { if (alive()) feedback.textContent = error instanceof Error ? error.message : String(error); }
      finally { pending--; schedule(); }
    });
    return queue;
  }
  function button(text: string, action: () => Promise<void>, rerender = true): HTMLButtonElement {
    const node = el("button", text); node.type = "button"; node.onclick = () => { void run(action, rerender); }; return node;
  }
  async function snapshot(name = "generationStatus", input?: unknown): Promise<void> {
    const next = await ctx.call<DraftingSnapshot>(name, input);
    if (alive()) state = next;
  }
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!alive() || !state?.generations?.some(g => g.status === "running")) return;
    timer = setTimeout(() => { void poll(); }, 1200);
  }
  /** Silent read: no fence, no disabled controls, re-render only on change. */
  async function poll(): Promise<void> {
    if (!alive()) return;
    if (pending) { schedule(); return; }
    try {
      const next = await ctx.call<DraftingSnapshot>("generationStatus");
      if (!alive()) return;
      if (pending) { schedule(); return; }
      const changed = JSON.stringify(next.generations) !== JSON.stringify(state?.generations);
      state = next;
      if (changed) { renderActivity(); await onCardsChanged(); }
    } catch { /* Transient read failure; try again on the next tick. */ }
    schedule();
  }
  async function load(): Promise<void> {
    const context = await ctx.call<{ nodes: Node[] }>("generationContext");
    if (!alive()) return;
    nodes = context.nodes ?? [];
    await snapshot();
  }
  function renderSelection(target: HTMLElement): void {
    target.replaceChildren();
    target.append(el("p", `${count(selection.length, "node")} selected. Only selected nodes are drafted.`));
    const list = el("ul"); list.className = "anki-bridge-node-list";
    for (const id of selection) {
      const source = nodes.find(n => n.id === id);
      const item = el("li"); item.append(el("strong", source?.name ?? id), el("p", source?.statement ?? "Node no longer exists. Refresh the graph before drafting.")); list.append(item);
    }
    target.append(list);
  }
  const estimate = el("div");
  function renderPreflight(): void {
    estimate.replaceChildren(); estimate.className = "";
    if (!preflight) return;
    const p = preflight;
    estimate.className = "anki-bridge-preview";
    estimate.append(el("h4", "Confirm generation"), el("p", `${count(p.nodeCount, "node")}, up to ${count(p.maximumCards, "card")} in ${count(p.batches.length, "model call")}. Approximate tokens: ${p.inputTokens} input, ${p.outputTokens} reserved output.`),
      el("p", `Model: ${p.model.provider} / ${p.model.id}`), el("p", p.estimatedCost === null ? "No dollar estimate is available for this model. Subscription or provider usage still applies." : `Estimated cost: $${p.estimatedCost.toFixed(4)} USD. Actual usage can differ, especially after validation retries.`));
    for (const skip of p.skipped) estimate.append(el("p", `Skipped ${nodes.find(n => n.id === skip.nodeId)?.name ?? skip.nodeId}: ${skip.reason}`));
    const confirm = button("Confirm and generate", async () => {
      // Backend rejects stale, changed or replayed inputs independently of UI controls.
      await snapshot("generate", { preflightId: p.preflightId }); preflight = undefined; await onCardsChanged();
    }, false);
    confirm.disabled = !p.batches.length;
    estimate.append(confirm);
  }
  function renderActivity(): void {
    renderPreflight();
    activity.replaceChildren();
    if (!state?.generationSettings) return;
    activity.append(el("h4", "Generation activity"), button("Refresh generation", async () => { await snapshot(); await onCardsChanged(); }, false));
    if (!state.generations.length) activity.append(el("p", "No generation started yet. Estimating does not call a model."));
    const name = (id: string) => nodes.find(n => n.id === id)?.name ?? id;
    for (const generation of [...state.generations].reverse()) {
      const row = el("div"); row.className = "anki-bridge-batch";
      const done = generation.tasks.filter(t => t.status === "applied").length;
      row.append(el("h5", `${generation.status}: ${done} of ${count(generation.tasks.length, "task")} applied`));
      for (const skip of generation.skipped) row.append(el("p", `Skipped ${name(skip.nodeId)}: ${skip.reason}`));
      for (const task of generation.tasks) {
        row.append(el("p", `${task.sources.map(s => s.name).join(", ")}: ${task.status}${task.error ? `. ${task.error}` : ""}`));
        for (const target of task.result?.targets ?? []) if (target.skipReason) row.append(el("p", `Writer skipped ${name(target.nodeId)}: ${target.skipReason}`));
      }
      if (generation.status === "running") row.append(button("Cancel generation", async () => { await snapshot("cancelGeneration", { id: generation.id }); await onCardsChanged(); }, false));
      else if (generation.tasks.some(t => t.status !== "applied")) row.append(button("Estimate retry", async () => {
        const next = await ctx.call<Preflight>("retryGeneration", { id: generation.id }); if (alive()) preflight = next;
      }, false));
      activity.append(row);
    }
  }
  function render(): void {
    if (!alive()) return;
    disposeWidgets(); controls.replaceChildren();
    if (!state?.generationSettings) { controls.append(button("Load graph and models", load)); renderActivity(); return; }
    const settings = state.generationSettings;
    const picker = el("div"), selected = el("div");
    controls.append(picker, selected);
    renderSelection(selected);
    const knowledge = ctx.ui.mountKnowledgePicker(picker, { value: selection, onChange: ids => {
      selection = [...ids]; preflight = undefined; knowledge.update({ value: selection }); renderSelection(selected); renderPreflight();
    } }, { signal });
    widgets.push(knowledge);
    if (!nodes.length) controls.append(el("p", "Your graph has no source nodes yet. Extract knowledge in LearnHarness, then refresh the graph."));
    const model = el("div"); controls.append(label("Drafting model", model));
    const modelPicker = ctx.ui.mountModelPicker(model, { value: settings.model ?? undefined, onChange: value => {
      preflight = undefined; renderPreflight();
      return run(async () => { await snapshot("generationSettings", { model: value }); });
    } }, { signal }); widgets.push(modelPicker);
    if (!settings.model) controls.append(el("p", "Choose a configured model. There is no automatic fallback."));
    const shown = unsaved ?? { cardsPerNode: settings.cardsPerNode, enabledKinds: settings.enabledKinds as Kind[] };
    const cap = el("input"); cap.type = "number"; cap.min = "1"; cap.max = "4"; cap.step = "1"; cap.value = String(shown.cardsPerNode);
    const toggles = el("div"); toggles.className = "anki-bridge-kind-toggles";
    const checkboxes = kinds.map(kind => {
      const input = el("input"); input.type = "checkbox"; input.checked = shown.enabledKinds.includes(kind);
      toggles.append(label(kind, input)); return { kind, input };
    });
    const readSettings = () => ({ cardsPerNode: Number(cap.value), enabledKinds: checkboxes.filter(c => c.input.checked).map(c => c.kind) });
    const edited = () => { unsaved = readSettings(); preflight = undefined; renderPreflight(); };
    cap.oninput = edited; checkboxes.forEach(c => { c.input.onchange = edited; });
    controls.append(label("Maximum cards per node, 1 to 4", cap), el("p", "This is a maximum, not a quota. The writer can skip a node with a reason."), toggles,
      button("Save drafting defaults", async () => { preflight = undefined; await snapshot("generationSettings", readSettings()); unsaved = undefined; }),
      button("Refresh graph", async () => { preflight = undefined; await load(); }),
      button("Estimate generation", async () => {
        if (!selection.length) throw new Error("Select at least one graph node first.");
        preflight = undefined;
        await snapshot("generationSettings", readSettings()); unsaved = undefined;
        const next = await ctx.call<Preflight>("preflight", { nodeIds: selection });
        if (alive()) preflight = next;
      }), estimate);
    renderActivity();
  }
  const unsubscribe = ctx.onResync(() => { void run(async () => { await load(); await onCardsChanged(); }); });
  void run(load);
  return {
    select: nodeIds => run(async () => { selection = [...new Set(nodeIds)]; preflight = undefined; }),
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); unsubscribe(); disposeWidgets(); root.remove(); },
  };
}
