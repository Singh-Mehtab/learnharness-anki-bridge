import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { Generation, GenerationSettings } from "./generation/types.ts";
import { CoveragePicker } from "./coverage-ui.ts";
import type { CoverageRow, CoverageView } from "./coverage-ui.ts";
import { button, confirmDialog, el, plural, status } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";

interface DraftingSnapshot { generationSettings: GenerationSettings; generations: Generation[] }
interface Preflight {
  preflightId: string; nodeCount: number; maximumCards: number; inputTokens: number; outputTokens: number;
  estimatedCost: number | null; model: { provider: string; id: string };
  batches: Array<{ nodeIds: string[] }>; skipped: Array<{ nodeId: string; reason: string }>;
}
interface SessionFlowNodes { session: { id: string; title: string; exists: boolean }; nodes: CoverageRow[]; missing?: CoverageRow[]; cardsPerNode: number; paired: boolean; pairingWarning?: boolean }
type Kind = "recall" | "why" | "compose" | "discriminate";
const kinds: readonly Kind[] = ["recall", "why", "compose", "discriminate"];
/** Learner-facing names. "discriminate" stays the stored and prompt name. */
export const KIND_NAMES: Record<string, string> = { recall: "Recall", why: "Why", compose: "Compose", discriminate: "Contrast" };
export const KIND_HELP: Record<Kind, string> = {
  recall: "State a fact, definition or formula.",
  why: "Explain the reason behind the idea.",
  compose: "Combine linked ideas to reach this one.",
  discriminate: "Tell the idea apart from a similar one.",
};

/** Provider errors often arrive as raw JSON; show the message and status only. */
export function readableError(error: string | undefined): string {
  if (!error) return "";
  const status = /^(\d{3})\s/.exec(error)?.[1];
  const message = /"message"\s*:\s*"([^"]+)"/.exec(error)?.[1];
  return message ? `${message.charAt(0).toUpperCase()}${message.slice(1)}${status ? ` (HTTP ${status})` : ""}.` : error;
}

/** Ideas come from one session or from the whole graph. */
export type Scope = { sessionId: string } | undefined;

export interface DraftingHandle {
  /** Show ideas from one session, or the whole graph. Clears selection and any estimate. */
  setScope(scope: Scope, select?: { nodeIds: readonly string[]; backfillNodeIds?: readonly string[] }): Promise<void>;
  refresh(): Promise<void>;
  invalidateEstimate(): void;
  dispose(): void;
}

/** Steps 1 (idea list) and 2 (write). Closing a view does not cancel backend generation. */
export function mountDrafting(ctx: PluginFrontendContext, ideasHost: HTMLElement, writeHost: HTMLElement, signal: AbortSignal,
  onCardsChanged: () => Promise<void>, reviewWaiting?: (nodeId: string) => void): DraftingHandle {
  const settingsRow = el("div", undefined, "ab-write-settings");
  const kindHelp = el("p", undefined, "ab-muted ab-kind-help");
  const writeBar = el("div", undefined, "ab-actions ab-write-bar");
  const feedback = status();
  const activity = el("div", undefined, "ab-activity");
  writeHost.append(settingsRow, kindHelp, writeBar, feedback, activity);
  let disposed = false, state: DraftingSnapshot | undefined, scope: Scope;
  let nodes: CoverageRow[] = [];
  let coverageRequest = 0, choiceRevision = 0;
  let widgets: Array<{ dispose(): void }> = [], activityWidgets: Array<{ dispose(): void }> = [];
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve(), pending = 0;
  /** Bumped by every selection or settings change; an estimate from an older revision is discarded. */
  let revision = 0;
  const invalidate = () => { revision++; };
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const picker = new CoveragePicker({
    ctx, signal, reviewWaiting, defaults: false,
    empty: () => loading ? "Loading ideas…" : scope ? "No ideas from this session yet." : "Your graph has no ideas yet. Teach a session in LearnHarness first.",
    changed: source => { if (source === "user") choiceRevision++; invalidate(); syncWrite(); },
    mutate: (name, node) => { invalidate(); void run(async () => {
      try { await ctx.call(name, { nodeId: node.id, statementHash: node.statementHash }); }
      catch (error) { if (alive()) { coverageRequest++; picker.markStale(); } throw error; }
      try {
        try { await refreshCoverage(); }
        finally { await onCardsChanged(); }
      } catch (error) {
        throw new Error(`${name === "dismissNode" ? "Saved" : "Restored"}, but the list did not refresh: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, true, () => {
      const current = nodes.find(n => n.id === node.id);
      return !picker.isStale && !!current && current.statementHash === node.statementHash &&
        !!(name === "dismissNode" ? current.coverage?.canDismiss : current.coverage?.dismissed);
    }); },
  });
  ideasHost.append(picker.root);

  async function refreshCoverage(): Promise<void> {
    const request = ++coverageRequest, wanted = scope;
    try {
      let view: CoverageView;
      if (wanted) {
        const flow = await ctx.call<SessionFlowNodes>("sessionFlow", { sessionId: wanted.sessionId });
        view = { nodes: flow.nodes, missing: flow.missing, cardsPerNode: flow.cardsPerNode, paired: flow.paired, pairingWarning: flow.pairingWarning ?? false };
      } else view = await ctx.call<CoverageView>("coverageContext");
      if (!alive() || request !== coverageRequest || wanted !== scope) return;
      nodes = (view.nodes ?? []).map(n => ({ ...n, cards: n.cards ?? { waiting: 0, sent: 0, sentElsewhere: 0 } }));
      picker.update({ ...view, nodes, cardsPerNode: state?.generationSettings?.cardsPerNode ?? view.cardsPerNode ?? 2 });
    } catch (error) {
      if (alive() && request === coverageRequest) picker.markStale();
      throw error;
    }
  }
  async function refresh(): Promise<void> {
    try { await refreshCoverage(); }
    catch { /* The list shows that it is stale; keep action feedback intact. */ }
  }
  const disposeWidgets = () => { widgets.forEach(w => w.dispose()); widgets = []; activityWidgets.forEach(w => w.dispose()); activityWidgets = []; };
  /** Actions run in click order. */
  function run(action: () => Promise<void>, rerender = true, shouldRun = () => true): Promise<void> {
    pending++;
    queue = queue.then(async () => {
      try {
        if (!alive() || !shouldRun()) return;
        await action();
        if (alive()) { if (rerender) render(); else renderActivity(); }
      } catch (error) { if (alive()) feedback.show(error instanceof Error ? error.message : String(error), "error"); }
      finally { pending--; schedule(); }
    });
    return queue;
  }
  async function snapshot(name = "generationStatus", input?: unknown): Promise<void> {
    const next = await ctx.call<DraftingSnapshot>(name, input);
    if (alive()) {
      state = next;
      picker.setCardsPerNode(next.generationSettings.cardsPerNode);
    }
  }
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!alive() || !state?.generations?.some(g => g.status === "running")) return;
    timer = setTimeout(() => { void poll(); }, 1200);
  }
  /** Silent read: no fence, re-render only on change. */
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

  const name = (id: string) => nodes.find(n => n.id === id)?.name ?? id;
  /** Estimate, confirm in a dialog, then start. Retry passes its own estimate call. */
  async function estimateAndStart(estimate: () => Promise<Preflight>): Promise<void> {
    if (picker.isStale) throw new Error("The idea list is out of date. Refresh it first.");
    invalidate(); const at = revision;
    feedback.show("Estimating…");
    const p = await estimate();
    if (!alive()) return;
    feedback.show("");
    if (at !== revision) throw new Error("The selection changed. Press Write cards again.");
    const body = el("div", undefined, "ab-estimate");
    const facts = el("dl", undefined, "ab-facts");
    const fact = (term: string, value: string) => { facts.append(el("dt", term), el("dd", value)); };
    fact("Ideas", String(p.nodeCount));
    fact("Cards", `Up to ${p.maximumCards}`);
    fact("Model", p.model.id);
    fact("Model calls", `${p.batches.length}, or up to ${p.batches.length * 3} if answers need fixing`);
    fact("Cost", p.estimatedCost === null ? "No estimate for this model" : `About $${p.estimatedCost.toFixed(4)} for the first attempt`);
    body.append(facts);
    if (p.skipped.length) {
      const skipped = el("ul", undefined, "ab-skipped");
      for (const skip of p.skipped) skipped.append(el("li", `${name(skip.nodeId)}: ${skip.reason}`));
      body.append(el("p", `${plural(p.skipped.length, "idea")} will be skipped:`, "ab-muted"), skipped);
    }
    body.append(el("p", "Cards are written in the background. You can leave this page; progress also shows under Background agents.", "ab-muted"));
    if (!p.batches.length) throw new Error("None of these ideas can be carded right now. Check the skipped reasons.");
    const ok = await confirmDialog(ctx, signal, { title: "Write cards", body, confirm: "Start writing" });
    if (!ok || !alive()) return;
    if (at !== revision || picker.isStale) throw new Error("The selection changed while the dialog was open. Press Write cards again.");
    // Backend rejects stale, changed or replayed estimates independently of this check.
    await snapshot("generate", { preflightId: p.preflightId });
    await refresh(); await onCardsChanged();
  }

  let writeButton: ButtonHandle | undefined;
  function syncWrite(): void {
    const count = picker.ids.length;
    const blocked = picker.isStale || !count || !state?.generationSettings?.model || state.generations.some(g => g.status === "running");
    writeButton?.update({ disabled: blocked, label: count ? `Write cards for ${plural(count, "idea")}` : "Write cards" });
  }

  function renderActivity(): void {
    activityWidgets.forEach(w => w.dispose()); activityWidgets = [];
    activity.replaceChildren();
    syncWrite();
    if (!state) return;
    // Only the running batch and the latest unfinished or undismissed one stay on the page.
    const visible = [...state.generations].reverse().filter(g => !g.hidden);
    const shown = [...visible.filter(g => g.status === "running"), ...visible.filter(g => g.status !== "running").slice(0, 1)];
    for (const generation of shown) {
      const panel = el("div", undefined, "ab-progress");
      panel.dataset.status = generation.status;
      const total = generation.tasks.length;
      const applied = generation.tasks.filter(t => t.status === "applied");
      const failed = generation.tasks.filter(t => ["failed", "interrupted"].includes(t.status));
      const cancelled = generation.tasks.filter(t => t.status === "cancelled");
      const cards = applied.reduce((n, t) => n + (t.result?.targets ?? []).reduce((m, x) => m + x.cards.length, 0), 0);
      const ideas = generation.nodeIds.length;
      const head = el("div", undefined, "ab-progress-head");
      const text = el("p", undefined, "ab-progress-text");
      const actions = el("div", undefined, "ab-actions");
      head.append(text, actions);
      panel.append(head);
      if (generation.status === "running") {
        text.append(el("strong", `Writing cards for ${plural(ideas, "idea")}`), el("span", ` ${applied.length} of ${plural(total, "batch", "batches")} done`, "ab-muted"));
        const bar = el("div", undefined, "ab-bar"); const fill = el("span");
        fill.style.width = `${Math.max(4, Math.round(100 * applied.length / Math.max(1, total)))}%`;
        bar.append(fill); bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(total)); bar.setAttribute("aria-valuenow", String(applied.length));
        panel.append(bar);
        activityWidgets.push(button(ctx, actions, signal, { label: "Cancel", onClick: () => run(async () => {
          await snapshot("cancelGeneration", { id: generation.id }); await refresh(); await onCardsChanged();
          feedback.show("Cancelled. Finished cards are kept for review. The other ideas can be selected again.");
        }, false) }));
      } else {
        const summary = generation.status === "completed" && !failed.length
          ? `Wrote ${plural(cards, "card")} for ${plural(ideas, "idea")}.`
          : !cards && failed.length && !cancelled.length ? `Couldn't write cards. ${failed.length === 1 ? "The model call failed." : `${failed.length} model calls failed.`}`
          : `Wrote ${plural(cards, "card")}. ${[failed.length ? `${plural(failed.length, "batch", "batches")} failed` : "", cancelled.length ? `${plural(cancelled.length, "batch", "batches")} cancelled` : ""].filter(Boolean).join(", ")}.`;
        text.append(el("strong", summary), el("span", cards ? " Review them in step 3." : "", "ab-muted"));
        const errors = [...new Set(failed.map(t => readableError(t.error)).filter(Boolean))];
        if (errors.length) panel.append(el("p", errors.join(" "), "ab-progress-error"));
        if (failed.length || cancelled.length) activityWidgets.push(button(ctx, actions, signal, { label: "Retry the rest", onClick: () => run(async () => {
          await estimateAndStart(() => ctx.call<Preflight>("retryGeneration", { id: generation.id }));
        }, false) }));
        activityWidgets.push(button(ctx, actions, signal, { label: "Dismiss", onClick: () => run(async () => {
          await snapshot("dismissGeneration", { id: generation.id });
        }, false) }));
      }
      const skipped = [...generation.skipped, ...applied.flatMap(t => (t.result?.targets ?? []).filter(x => x.skipReason).map(x => ({ nodeId: x.nodeId, reason: x.skipReason! })))];
      if (skipped.length && generation.status !== "running") {
        const details = el("details", undefined, "ab-progress-skips");
        details.append(el("summary", `${plural(skipped.length, "idea")} skipped`));
        const list = el("ul");
        for (const s of skipped) list.append(el("li", `${name(s.nodeId)}: ${s.reason}`));
        details.append(list); panel.append(details);
      }
      activity.append(panel);
    }
  }

  function render(): void {
    if (!alive()) return;
    disposeWidgets(); settingsRow.replaceChildren(); writeBar.replaceChildren(); kindHelp.replaceChildren();
    writeButton = undefined;
    if (!state?.generationSettings) {
      widgets.push(button(ctx, writeBar, signal, { label: "Load", onClick: () => run(load) }));
      renderActivity(); return;
    }
    const settings = state.generationSettings;
    const modelBox = el("div", undefined, "ab-model");
    const modelField = el("div", undefined, "ab-field ab-field-inline");
    modelField.append(el("span", "Model to write cards", "ab-label"), modelBox);
    widgets.push(ctx.ui.mountModelPicker(modelBox, { value: settings.model ?? undefined, onChange: value => {
      invalidate();
      return run(async () => { await snapshot("generationSettings", { model: value }); });
    } }, { signal }));

    const kindsField = el("div", undefined, "ab-field ab-field-inline ab-kinds");
    kindsField.setAttribute("role", "group"); kindsField.setAttribute("aria-label", "Card types");
    kindsField.append(el("span", "Card types", "ab-label"));
    const chips = el("div", undefined, "ab-chips");
    const enabled = settings.enabledKinds as Kind[];
    for (const kind of kinds) {
      const chip = el("label", undefined, "ab-chip");
      const box = el("input"); box.type = "checkbox"; box.checked = enabled.includes(kind);
      // At least one type stays on.
      box.disabled = box.checked && enabled.length === 1;
      box.title = KIND_HELP[kind]; chip.title = KIND_HELP[kind];
      box.onchange = () => {
        invalidate();
        const next = kinds.filter(k => k === kind ? box.checked : enabled.includes(k));
        void run(async () => { await snapshot("generationSettings", { enabledKinds: next }); });
      };
      chip.append(box, el("span", KIND_NAMES[kind]));
      chips.append(chip);
    }
    kindsField.append(chips);

    const capField = el("label", undefined, "ab-field ab-field-inline");
    const cap = el("select", undefined, "ab-input ab-select");
    for (const n of [1, 2, 3, 4]) { const o = el("option", String(n)); o.value = String(n); cap.append(o); }
    cap.value = String(settings.cardsPerNode);
    cap.onchange = () => { invalidate(); void run(async () => { await snapshot("generationSettings", { cardsPerNode: Number(cap.value) }); }); };
    capField.append(el("span", "Most cards per idea", "ab-label"), cap);
    settingsRow.append(modelField, kindsField, capField);

    for (const kind of kinds) { const line = el("span"); line.append(el("strong", KIND_NAMES[kind]), ` ${KIND_HELP[kind].replace(/\.$/, "")}.`); kindHelp.append(line); }

    writeButton = button(ctx, writeBar, signal, { label: "Write cards", variant: "default", onClick: () => run(async () => {
      if (!picker.ids.length) throw new Error("Select at least one idea in step 1.");
      const ids = picker.ids, backfill = picker.backfillNodeIds;
      await estimateAndStart(() => ctx.call<Preflight>("preflight", { nodeIds: ids, backfillNodeIds: backfill }));
    }, false) });
    widgets.push(writeButton);
    if (!settings.model) writeBar.append(el("span", "Choose a model first. There is no automatic fallback.", "ab-muted"));
    else writeBar.append(el("span", "The model only drafts. You check every card before anything reaches Anki.", "ab-muted"));
    renderActivity();
  }
  const unsubscribe = ctx.onResync(() => { invalidate(); void run(async () => { await load(); await onCardsChanged(); }); });
  return {
    setScope: (next, select) => {
      invalidate();
      scope = next;
      picker.setDefaults(!!next);
      const at = ++choiceRevision;
      coverageRequest++;
      loading = true;
      picker.update({ nodes: [], missing: [], cardsPerNode: state?.generationSettings?.cardsPerNode ?? 2, paired: false, pairingWarning: false }, true);
      return run(async () => {
        try { await load(); } finally { loading = false; }
        if (select && at === choiceRevision) picker.select(select.nodeIds, select.backfillNodeIds ?? [], true);
      });
    },
    refresh,
    invalidateEstimate: () => { invalidate(); },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); unsubscribe(); disposeWidgets(); },
  };
}
