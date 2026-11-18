import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { Generation, GenerationSettings } from "./generation/types.ts";

import { CoveragePicker } from "./coverage-ui.ts";
import type { CoverageView } from "./coverage-ui.ts";
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
  /** Replace selection and intent, e.g. from a session panel; omitted backfill IDs mean explicit requests.
   * Discards any visible estimate; never starts generation. */
  select(nodeIds: readonly string[], backfillNodeIds?: readonly string[]): Promise<void>;
  refresh(): Promise<void>;
  invalidateEstimate(): void;
  dispose(): void;
}
/** Each view owns only its widgets/timer. Closing a view does not cancel backend generation. */
export function mountDrafting(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, onCardsChanged: () => Promise<void>, reviewWaiting?: (nodeId: string) => void): DraftingHandle {
  const root = el("section");
  root.append(el("h3", "Draft from graph nodes"));
  const feedback = el("p"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const controls = el("fieldset");
  // Polling updates coverage and activity without rebuilding model pickers or unsaved inputs.
  const activity = el("div");
  root.append(feedback, controls, activity); container.append(root);
  let disposed = false, state: DraftingSnapshot | undefined;
  let nodes: CoverageView["nodes"] = [], preflight: Preflight | undefined;
  let coverageRequest = 0, choiceRevision = 0;
  let estimateButton: HTMLButtonElement | undefined;
  // Unsaved cap/kind edits survive re-renders until saved or used for an estimate.
  let unsaved: { cardsPerNode: number; enabledKinds: Kind[] } | undefined;
  let widgets: Array<{ dispose(): void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve(), pending = 0;
  /** Bumped by every selection/settings change; an estimate reply from an older revision is discarded. */
  let revision = 0;
  const invalidate = () => { revision++; preflight = undefined; };
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const picker = new CoveragePicker({
    reviewWaiting,
    changed: source => { if (source === "user") choiceRevision++; invalidate(); renderPreflight(); if (estimateButton) estimateButton.disabled = picker.isStale; },
    mutate: (name, node) => { invalidate(); renderPreflight(); void run(async () => {
      if (picker.isStale) throw new Error("Refresh graph before changing coverage.");
      try { await ctx.call(name, { nodeId: node.id, statementHash: node.statementHash }); }
      catch (error) { if (alive()) { coverageRequest++; picker.markStale(); } throw error; }
      try { await refreshCoverage(); }
      catch (error) {
        throw new Error(`${name === "dismissNode" ? "Dismissal" : "Restoration"} saved, but the graph refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await onCardsChanged();
    }); },
  });
  root.insertBefore(picker.root, controls);
  const refreshGraph = el("button", "Refresh graph"); refreshGraph.type = "button";
  refreshGraph.onclick = () => { invalidate(); renderPreflight(); void run(load); };
  root.insertBefore(refreshGraph, controls);
  async function refreshCoverage(): Promise<void> {
    const request = ++coverageRequest;
    try {
      const context = await ctx.call<CoverageView>("coverageContext");
      if (!alive() || request !== coverageRequest) return;
      nodes = (context.nodes ?? []).map(n => ({ ...n, cards: n.cards ?? { waiting: 0, sent: 0, sentElsewhere: 0 } }));
      picker.update({ ...context, nodes, cardsPerNode: unsaved?.cardsPerNode ?? context.cardsPerNode ?? state?.generationSettings?.cardsPerNode ?? 2 });
    } catch (error) {
      if (alive() && request === coverageRequest) picker.markStale();
      throw error;
    }
  }

  async function refresh(): Promise<void> {
    try { await refreshCoverage(); }
    catch (error) { if (alive()) feedback.textContent = error instanceof Error ? error.message : String(error); }
  }
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
    if (alive()) {
      state = next;
      picker.setCardsPerNode(unsaved?.cardsPerNode ?? next.generationSettings.cardsPerNode);
      // Saved caps and model defaults also affect the session panel's estimate.
      if (name === "generationSettings") await onCardsChanged();
    }
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
      if (changed) { renderActivity(); await refresh(); await onCardsChanged(); }
    } catch { /* Transient read failure; try again on the next tick. */ }
    schedule();
  }
  async function load(): Promise<void> {
    await refreshCoverage();
    await snapshot();
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
      // A queued click must not revive an estimate invalidated by a new selection.
      if (picker.isStale || preflight !== p) throw new Error("Estimate changed. Estimate generation again before confirming.");
      // Backend rejects stale, changed or replayed inputs independently of UI controls.
      await snapshot("generate", { preflightId: p.preflightId }); preflight = undefined; await refresh(); await onCardsChanged();
    }, false);
    confirm.disabled = picker.isStale || !p.batches.length;
    estimate.append(confirm);
  }
  function renderActivity(): void {
    renderPreflight();
    activity.replaceChildren();
    if (!state?.generationSettings) return;
    activity.append(el("h4", "Generation activity"), button("Refresh generation", async () => { await snapshot(); await refresh(); await onCardsChanged(); }, false));
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
      if (generation.status === "running") row.append(button("Cancel generation", async () => { await snapshot("cancelGeneration", { id: generation.id }); await refresh(); await onCardsChanged(); }, false));
      else if (generation.tasks.some(t => t.status !== "applied")) row.append(button("Estimate retry", async () => {
        if (picker.isStale) throw new Error("Refresh stale coverage before drafting.");
        invalidate(); renderPreflight(); const at = revision;
        const next = await ctx.call<Preflight>("retryGeneration", { id: generation.id }); if (alive() && at === revision) preflight = next;
      }, false));
      activity.append(row);
    }
  }
  function render(): void {
    if (!alive()) return;
    disposeWidgets(); controls.replaceChildren();
    if (!state?.generationSettings) { controls.append(button("Load graph and models", load)); renderActivity(); return; }
    const settings = state.generationSettings;
    if (!nodes.length) controls.append(el("p", "Your graph has no source nodes yet. Extract knowledge in LearnHarness, then refresh the graph."));
    const model = el("div"); controls.append(label("Drafting model", model));
    const modelPicker = ctx.ui.mountModelPicker(model, { value: settings.model ?? undefined, onChange: value => {
      invalidate(); renderPreflight();
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
    const edited = () => { unsaved = readSettings(); invalidate(); renderPreflight(); picker.setCardsPerNode(unsaved.cardsPerNode); };
    cap.oninput = edited; checkboxes.forEach(c => { c.input.onchange = edited; });
    controls.append(label("Maximum cards per node, 1 to 4", cap), el("p", "This is a maximum, not a quota. The writer can skip a node with a reason."), toggles,
      button("Save drafting defaults", async () => {
        invalidate(); renderPreflight(); const at = revision; await snapshot("generationSettings", readSettings());
        if (at === revision) unsaved = undefined;
      }),
      (estimateButton = button("Estimate generation", async () => {
        if (picker.isStale) throw new Error("Refresh stale coverage before drafting.");
        if (!picker.ids.length) throw new Error("Select at least one graph node first.");
        invalidate(); renderPreflight(); const at = revision;
        await snapshot("generationSettings", readSettings());
        if (at !== revision) return;
        unsaved = undefined;
        const next = await ctx.call<Preflight>("preflight", { nodeIds: picker.ids, backfillNodeIds: picker.backfillNodeIds });
        if (alive() && at === revision) preflight = next;
      })), estimate);
    estimateButton.disabled = picker.isStale;
    renderActivity();
  }
  const unsubscribe = ctx.onResync(() => { invalidate(); renderPreflight(); void run(async () => { await load(); await onCardsChanged(); }); });
  void run(load);
  return {
    select: (nodeIds, backfillNodeIds = []) => {
      invalidate(); renderPreflight(); picker.select(nodeIds, backfillNodeIds, true); const at = ++choiceRevision;
      return run(async () => { await load(); if (at === choiceRevision) picker.select(nodeIds, backfillNodeIds, true); });
    },
    refresh,
    invalidateEstimate: () => { invalidate(); renderPreflight(); },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); unsubscribe(); disposeWidgets(); root.remove(); },
  };
}
