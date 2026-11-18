import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { Generation, GenerationSettings } from "./generation/types.ts";

interface Node { id: string; name: string; statement: string }
interface DraftingSnapshot { generationSettings: GenerationSettings; generations: Generation[] }
interface Preflight {
  preflightId: string; nodeCount: number; maximumCards: number; inputTokens: number; outputTokens: number;
  estimatedCost: number | null; model: { provider: string; id: string };
  batches: Array<{ nodeIds: string[] }>; skipped: Array<{ nodeId: string; reason: string }>;
}
const kinds = ["recall", "why", "compose", "discriminate"] as const;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
function label(text: string, input: HTMLElement): HTMLElement { const node = el("label"); node.append(el("span", text), input); return node; }

/** Each view owns only its widgets/timer. Closing a view does not cancel backend generation. */
export function mountDrafting(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, onCardsChanged: () => Promise<void>): () => void {
  const root = el("section");
  root.append(el("h3", "Draft from graph nodes"));
  const feedback = el("p"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const controls = el("fieldset"); root.append(feedback, controls); container.append(root);
  let disposed = false, busy = false, state: DraftingSnapshot | undefined;
  let nodes: Node[] = [], selection: string[] = [], preflight: Preflight | undefined;
  let widgets: Array<{ dispose(): void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const disposeWidgets = () => { widgets.forEach(w => w.dispose()); widgets = []; };
  async function run(action: () => Promise<void>): Promise<void> {
    if (!alive() || busy) return;
    busy = true; controls.disabled = true; feedback.textContent = "Working...";
    try { await action(); if (alive()) { render(); feedback.textContent = ""; } }
    catch (error) { if (alive()) feedback.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; if (alive()) controls.disabled = false; schedule(); }
  }
  function button(text: string, action: () => Promise<void>): HTMLButtonElement {
    const node = el("button", text); node.type = "button"; node.onclick = () => { void run(action); }; return node;
  }
  async function snapshot(name = "generationStatus", input?: unknown): Promise<void> {
    const next = await ctx.call<DraftingSnapshot>(name, input);
    if (alive()) state = next;
  }
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!alive() || !state?.generations?.some(g => g.status === "running")) return;
    timer = setTimeout(() => {
      if (!alive()) return;
      if (busy) { schedule(); return; }
      void run(async () => {
        const previous = JSON.stringify(state?.generations);
        await snapshot();
        if (JSON.stringify(state?.generations) !== previous) await onCardsChanged();
      });
    }, 1200);
  }
  async function load(): Promise<void> {
    const context = await ctx.call<{ nodes: Node[] }>("generationContext");
    if (!alive()) return;
    nodes = context.nodes ?? [];
    await snapshot();
  }
  function renderSelection(target: HTMLElement): void {
    target.replaceChildren();
    target.append(el("p", `${selection.length} nodes selected. Only selected nodes are drafted.`));
    const list = el("ul"); list.className = "anki-bridge-node-list";
    for (const id of selection) {
      const source = nodes.find(n => n.id === id);
      const item = el("li"); item.append(el("strong", source?.name ?? id), el("p", source?.statement ?? "Node no longer exists. Refresh the graph before drafting.")); list.append(item);
    }
    target.append(list);
  }
  function render(): void {
    if (!alive()) return;
    disposeWidgets(); controls.replaceChildren();
    if (!state?.generationSettings) { controls.append(button("Load graph and models", load)); return; }
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
    const modelPicker = ctx.ui.mountModelPicker(model, { value: settings.model ?? undefined, onChange: async value => {
      await run(async () => { preflight = undefined; await snapshot("generationSettings", { model: value }); });
    } }, { signal }); widgets.push(modelPicker);
    if (!settings.model) controls.append(el("p", "Choose a configured model. There is no automatic fallback."));
    const cap = el("input"); cap.type = "number"; cap.min = "1"; cap.max = "4"; cap.step = "1"; cap.value = String(settings.cardsPerNode);
    const toggles = el("div"); toggles.className = "anki-bridge-kind-toggles";
    const checkboxes = kinds.map(kind => {
      const input = el("input"); input.type = "checkbox"; input.checked = settings.enabledKinds.includes(kind);
      toggles.append(label(kind, input)); return { kind, input };
    });
    const readSettings = () => ({ cardsPerNode: Number(cap.value), enabledKinds: checkboxes.filter(c => c.input.checked).map(c => c.kind) });
    const invalidate = () => { preflight = undefined; renderPreflight(); };
    cap.oninput = invalidate; checkboxes.forEach(c => { c.input.onchange = invalidate; });
    controls.append(label("Maximum cards per node, 1 to 4", cap), el("p", "This is a maximum, not a quota. The writer can skip a node with a reason."), toggles,
      button("Save drafting defaults", async () => { preflight = undefined; await snapshot("generationSettings", readSettings()); }),
      button("Refresh graph", async () => { preflight = undefined; await load(); }),
      button("Estimate generation", async () => {
        if (!selection.length) throw new Error("Select at least one graph node first.");
        preflight = undefined;
        await snapshot("generationSettings", readSettings());
        const next = await ctx.call<Preflight>("preflight", { nodeIds: selection });
        if (alive()) preflight = next;
      }));
    const estimate = el("div"); controls.append(estimate);
    function renderPreflight(): void {
      estimate.replaceChildren();
      if (!preflight) return;
      const p = preflight;
      estimate.className = "anki-bridge-preview";
      estimate.append(el("h4", "Confirm generation"), el("p", `${p.nodeCount} nodes, up to ${p.maximumCards} cards in ${p.batches.length} model calls. Approximate tokens: ${p.inputTokens} input, ${p.outputTokens} reserved output.`),
        el("p", `Model: ${p.model.provider} / ${p.model.id}`), el("p", p.estimatedCost === null ? "No dollar estimate is available for this model. Subscription or provider usage still applies." : `Estimated cost: $${p.estimatedCost.toFixed(4)} USD. Actual usage can differ, especially after validation retries.`));
      for (const skip of p.skipped) estimate.append(el("p", `Skipped ${nodes.find(n => n.id === skip.nodeId)?.name ?? skip.nodeId}: ${skip.reason}`));
      const confirm = button("Confirm and generate", async () => {
        // Backend rejects stale, changed or replayed inputs independently of UI controls.
        await snapshot("generate", { preflightId: p.preflightId }); preflight = undefined; await onCardsChanged();
      }); confirm.disabled = !p.batches.length;
      estimate.append(confirm);
    }
    // Selection callbacks fire only on user interaction, after this closure is initialized.
    renderPreflight = renderPreflight.bind(null);
    renderPreflight();
    controls.append(el("h4", "Generation activity"), button("Refresh generation", async () => { await snapshot(); await onCardsChanged(); }));
    if (!state.generations.length) controls.append(el("p", "No generation started yet. Estimating does not call a model."));
    for (const generation of [...state.generations].reverse()) {
      const row = el("div"); row.className = "anki-bridge-batch";
      const done = generation.tasks.filter(t => t.status === "applied").length;
      row.append(el("h5", `${generation.status}: ${done}/${generation.tasks.length} tasks applied`));
      for (const skip of generation.skipped) row.append(el("p", `Skipped ${skip.nodeId}: ${skip.reason}`));
      for (const task of generation.tasks) {
        row.append(el("p", `${task.sources.map(s => s.name).join(", ")}: ${task.status}${task.error ? `. ${task.error}` : ""}`));
        for (const target of task.result?.targets ?? []) if (target.skipReason) row.append(el("p", `Writer skipped ${target.nodeId}: ${target.skipReason}`));
      }
      if (generation.status === "running") row.append(button("Cancel generation", async () => { await snapshot("cancelGeneration", { id: generation.id }); await onCardsChanged(); }));
      else if (generation.tasks.some(t => t.status !== "applied")) row.append(button("Estimate retry", async () => {
        const next = await ctx.call<Preflight>("retryGeneration", { id: generation.id }); if (alive()) preflight = next;
      }));
      controls.append(row);
    }
  }
  // Reassigned by each render so picker callbacks invalidate the visible estimate.
  let renderPreflight = () => {};
  const unsubscribe = ctx.onResync(() => { void run(async () => { await load(); await onCardsChanged(); }); });
  void run(load);
  return () => { disposed = true; if (timer) clearTimeout(timer); unsubscribe(); disposeWidgets(); root.remove(); };
}
