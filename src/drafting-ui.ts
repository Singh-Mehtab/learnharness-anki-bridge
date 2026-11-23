import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { activeCloze } from "./generation/types.ts";
import type { ClozeSetting, Generation, GenerationSettings } from "./generation/types.ts";
import { FLAGGED_CARD_CAP, SETTINGS_KINDS, WRITE_KINDS } from "./writer/types.ts";
import { exampleCard, KIND_HELP, KIND_NAMES } from "./kinds-ui.ts";
import { CoveragePicker } from "./coverage-ui.ts";
import type { CoverageFlag, CoverageRow, CoverageView } from "./coverage-ui.ts";
import { button, confirmDialog, el, plural, status } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";
import type { Peers } from "./settings-ui.ts";

const CLOZE_STOPS: { value: ClozeSetting; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Every card is a question and answer." },
  { value: "auto", label: "Writer chooses", help: "Use cloze when the blank makes the question clearer." },
  { value: "prefer", label: "Prefer cloze", help: "Prefer cloze for Fact and Equation cards." },
];

interface DraftingSnapshot { generationSettings: GenerationSettings; generations: Generation[] }
interface Preflight {
  preflightId: string; nodeCount: number; maximumCards: number; inputTokens: number; outputTokens: number;
  estimatedCost: number | null; model: { provider: string; id: string; thinkingLevel?: string }; modelName?: string; followsCheapSlot?: boolean;
  batches: Array<{ nodeIds: string[] }>; skipped: Array<{ nodeId: string; reason: string }>;
  skippedFlagRequests?: Array<{ count: number; reason: string }>;
  settings?: { writerNotes?: string };
}
type SessionFlowNodes = Omit<CoverageView, "flags"> & { flags: CoverageFlag[] };
export { KIND_NAMES } from "./kinds-ui.ts";

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
  onCardsChanged: () => Promise<void>, reviewWaiting?: (nodeId: string) => void, peers?: Peers): DraftingHandle {
  const settingsRow = el("div", undefined, "ab-write-settings");
  const kindHelp = el("div", undefined, "ab-muted ab-kind-help");
  const writeBar = el("div", undefined, "ab-actions ab-write-bar");
  const feedback = status();
  const activity = el("div", undefined, "ab-activity");
  writeHost.append(settingsRow, kindHelp, writeBar, feedback, activity);
  let disposed = false, state: DraftingSnapshot | undefined, scope: Scope;
  let nodes: CoverageRow[] = [];
  let modelLevels: string[] | undefined;
  // The Cloze slider is built once. Rebuilding it on every redraw would drop a drag in progress.
  const clozeField = el("div", undefined, "ab-field ab-field-inline ab-write-cloze");
  const range = el("input", undefined, "ab-range");
  range.type = "range"; range.min = "0"; range.max = "2"; range.step = "1";
  range.setAttribute("aria-label", "Cloze cards");
  const stops = el("div", undefined, "ab-range-stops");
  stops.setAttribute("aria-hidden", "true");
  for (const stop of CLOZE_STOPS) stops.append(el("span", stop.label));
  const clozeHelp = el("span", undefined, "ab-muted ab-hint");
  clozeField.append(el("span", "Cloze cards", "ab-label"), range, stops, clozeHelp);
  clozeField.hidden = true;
  settingsRow.append(clozeField);
  const showStop = (index: number) => {
    const stop = CLOZE_STOPS[index]!;
    range.value = String(index);
    range.setAttribute("aria-valuetext", stop.label);
    clozeHelp.textContent = stop.help;
    stops.querySelectorAll("span").forEach((span, i) => { span.dataset.selected = String(i === index); });
  };
  const savedCloze = () => state?.generationSettings ? activeCloze(state.generationSettings) : undefined;
  // A drag in progress is newer than any saved value; don't move the thumb under it.
  let dragging = false;
  const syncCloze = () => {
    const index = CLOZE_STOPS.findIndex(stop => stop.value === savedCloze());
    if (!dragging && index >= 0) showStop(index);
  };
  range.oninput = () => { dragging = true; showStop(Number(range.value)); };
  range.onblur = () => { dragging = false; };
  range.onchange = () => {
    dragging = false;
    const { value } = CLOZE_STOPS[Number(range.value)]!;
    invalidate();
    void run(async () => {
      if (value === savedCloze()) return;
      try { await snapshot("generationSettings", { cloze: value }); }
      finally { syncCloze(); }
    }, false);
  };
  let coverageRequest = 0, choiceRevision = 0;
  let widgets: Array<{ dispose(): void }> = [], activityWidgets: Array<{ dispose(): void }> = [];
  let loading = false, examplesOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve(), pending = 0;
  /** Bumped by every selection or settings change; an estimate from an older revision is discarded. */
  let revision = 0;
  const invalidate = () => { revision++; };
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const picker = new CoveragePicker({
    ctx, signal, reviewWaiting,
    empty: () => loading ? "Loading ideas…" : scope ? "No ideas yet." : "No ideas yet. Teach a session first.",
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
        view = { nodes: flow.nodes, missing: flow.missing, flags: flow.flags, cardsPerNode: flow.cardsPerNode, paired: flow.paired, pairingWarning: flow.pairingWarning ?? false };
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
        // An earlier error stops applying once the next action starts.
        if (feedback.dataset.tone === "error") feedback.show("");
        await action();
        if (alive()) { if (rerender) render(); else renderActivity(); }
      } catch (error) { if (alive()) feedback.show(error instanceof Error ? error.message : String(error), "error"); }
      finally { pending--; schedule(); }
    });
    return queue;
  }
  async function snapshot(name = "generationStatus", input?: unknown): Promise<void> {
    const next = await ctx.call<DraftingSnapshot>(name, input);
    if (!alive()) return;
    const pin = next.generationSettings?.model;
    const previous = state?.generationSettings?.model;
    if (!pin) modelLevels = undefined;
    else if (name === "generationStatus" || pin.provider !== previous?.provider || pin.id !== previous?.id) {
      try { modelLevels = await ctx.call<string[]>("writerModelLevels", { provider: pin.provider, id: pin.id }); }
      catch { modelLevels = undefined; }
    }
    if (alive()) state = next;
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
  type RetryResult = Preflight | { recovery: true; snapshot: DraftingSnapshot };
  /** Estimate, confirm in a dialog, then start. Retry can instead save a finished result. */
  async function estimateAndStart(estimate: () => Promise<RetryResult>, savingResult = false): Promise<void> {
    if (!savingResult && picker.isStale) throw new Error("Idea list is out of date. Refresh it.");
    invalidate(); const at = revision;
    feedback.show(savingResult ? "Saving finished result…" : "Estimating…");
    const p = await estimate();
    if (!alive()) return;
    feedback.show("");
    if ("recovery" in p) {
      state = p.snapshot;
      await refresh(); await onCardsChanged();
      return;
    }
    if (picker.isStale) throw new Error("Idea list is out of date. Refresh it.");
    if (at !== revision) throw new Error("Selection changed. Press Write cards again.");
    const body = el("div", undefined, "ab-estimate");
    const facts = el("dl", undefined, "ab-facts");
    const fact = (term: string, value: string) => { facts.append(el("dt", term), el("dd", value)); };
    const sent = new Set(p.batches.flatMap(b => b.nodeIds)).size;
    fact("Ideas", sent === p.nodeCount ? String(sent) : `${sent} of ${p.nodeCount} selected`);
    fact("Cards", `Up to ${p.maximumCards}`);
    fact("Model", `${p.modelName ?? p.model.id}${p.model.thinkingLevel ? `, ${p.model.thinkingLevel} reasoning` : ""}${p.followsCheapSlot ? " (cheap model)" : ""}`);
    fact("Model calls", `${p.batches.length}, up to ${p.batches.length * 3} with fixes`);
    fact("Cost", p.estimatedCost === null ? "No estimate" : `About $${p.estimatedCost.toFixed(4)}, first attempt`);
    // #54: the estimate counts the notes, so say they go too.
    const modelInput = `Ideas, linked ideas, excerpts from source session messages, flag notes, ${p.settings?.writerNotes ? "existing cards for these ideas, and your writer notes" : "and existing cards for these ideas"}`;
    fact("Sent to the model", p.batches.length > 1
      ? `${modelInput}. Later requests may also get a limited set of earlier drafts from this run, including local edits.`
      : modelInput);
    body.append(facts);
    if (p.skipped.length) {
      const skipped = el("ul", undefined, "ab-skipped");
      for (const skip of p.skipped) skipped.append(el("li", `${name(skip.nodeId)}: ${skip.reason}`));
      body.append(el("p", `${plural(p.skipped.length, "idea")} skipped:`, "ab-muted"), skipped);
    }
    for (const skip of p.skippedFlagRequests ?? []) {
      body.append(el("p", `${plural(skip.count, "flag request")} skipped. ${skip.reason}`, "ab-muted"));
    }
    body.append(el("p", "Safe to leave this page.", "ab-muted"));
    if (!p.batches.length) {
      const reasons = p.skipped.slice(0, 3).map(skip => `${name(skip.nodeId)}: ${skip.reason}`);
      if (p.skipped.length > 3) reasons.push(`and ${plural(p.skipped.length - 3, "more idea")}.`);
      throw new Error(["No ideas can be carded.", ...reasons].join(" "));
    }
    const ok = await confirmDialog(ctx, signal, { title: "Write cards", body, confirm: "Start writing" });
    if (!ok || !alive()) return;
    if (at !== revision || picker.isStale) throw new Error("Selection changed. Press Write cards again.");
    // Backend rejects stale, changed or replayed estimates independently of this check.
    await snapshot("generate", { preflightId: p.preflightId });
    await refresh(); await onCardsChanged();
  }

  let writeButton: ButtonHandle | undefined;
  function syncWrite(): void {
    const count = picker.ids.length;
    const blocked = picker.isStale || !count || !state || state.generations.some(g => g.status === "running");
    writeButton?.update({ disabled: blocked, label: count ? `Write cards for ${plural(count, "idea")}` : "Write cards" });
  }

  function renderActivity(): void {
    activityWidgets.forEach(w => w.dispose()); activityWidgets = [];
    activity.replaceChildren();
    syncWrite();
    if (!state) return;
    // One panel: the running run, or else the latest run's result until it is dismissed.
    const newest = [...state.generations].reverse();
    const running = newest.filter(g => g.status === "running");
    const unsaved = newest.find(g => g.tasks.some(t => t.resultPending));
    const shown = running.length ? running.slice(0, 1) : unsaved ? [unsaved] : newest.slice(0, 1).filter(g => !g.hidden);
    for (const generation of shown) {
      const panel = el("div", undefined, "ab-progress");
      panel.dataset.status = generation.status;
      const total = generation.tasks.length;
      const applied = generation.tasks.filter(t => t.status === "applied");
      const failed = generation.tasks.filter(t => ["failed", "interrupted"].includes(t.status));
      const cancelled = generation.tasks.filter(t => t.status === "cancelled");
      const omissions = applied.reduce((n, t) => n + (t.duplicatesOmitted ?? 0), 0);
      const cards = applied.reduce((n, t) => n + (t.result?.targets ?? []).reduce((m, x) => m + x.cards.length, 0), 0) - omissions;
      const ideas = generation.nodeIds.length;
      // Count the ideas that actually got cards, not every idea selected.
      const carded = new Set(applied.flatMap(t => (t.result?.targets ?? []).filter(x => x.cards.length).map(x => x.nodeId))).size;
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
          feedback.show("Cancelled. Saved cards are kept.");
        }, false) }));
      } else {
        const pendingResult = generation.tasks.some(t => t.resultPending);
        const summary = pendingResult ? "Result not saved." : generation.status === "completed" && !failed.length
          ? cards ? `Wrote ${plural(cards, "card")}${omissions ? "" : ` for ${plural(carded, "idea")}`}.` : "No cards written."
          : !cards && failed.length && !cancelled.length ? `No cards written. ${plural(failed.length, "batch", "batches")} failed.`
          : `Wrote ${plural(cards, "card")}. ${[failed.length ? `${plural(failed.length, "batch", "batches")} failed` : "", cancelled.length ? `${plural(cancelled.length, "batch", "batches")} cancelled` : ""].filter(Boolean).join(", ")}.`;
        text.append(el("strong", summary));
        if (omissions) panel.append(el("p", `${plural(omissions, "exact duplicate")} not added.`, "ab-muted"));
        const errors = [...new Set(failed.map(t => readableError(t.error)).filter(Boolean))];
        if (errors.length) panel.append(el("p", errors.join(" "), "ab-progress-error"));
        if (failed.length || cancelled.length) activityWidgets.push(button(ctx, actions, signal, { label: pendingResult ? "Retry saving" : applied.length ? "Retry the rest" : "Try again", onClick: () => run(async () => {
          await estimateAndStart(() => ctx.call<RetryResult>("retryGeneration", { id: generation.id }), pendingResult);
        }, false) }));
        if (pendingResult) activityWidgets.push(button(ctx, actions, signal, { label: "Abandon unavailable result", onClick: () => run(async () => {
          const ok = await confirmDialog(ctx, signal, { title: "Abandon unavailable result?", confirm: "Abandon result", destructive: true,
            body: el("p", "This stops recovery of the unsaved result. Saved cards are kept. No model call starts. To write replacements, run a new estimate and confirm it.") });
          if (!ok || !alive()) return;
          invalidate();
          await snapshot("abandonGenerationResult", { id: generation.id, confirmed: true });
          await refresh(); await onCardsChanged();
          feedback.show("Result abandoned.", "success");
        }, false) }));
        if (!pendingResult) activityWidgets.push(button(ctx, actions, signal, { label: "Dismiss", onClick: () => run(async () => {
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
    disposeWidgets(); writeBar.replaceChildren(); kindHelp.replaceChildren();
    // The Cloze slider stays mounted so a redraw can't end a drag in progress.
    for (const child of [...settingsRow.children]) if (child !== clozeField) child.remove();
    writeButton = undefined;
    if (!state?.generationSettings) {
      clozeField.hidden = true;
      widgets.push(button(ctx, writeBar, signal, { label: "Load", onClick: () => run(load) }));
      renderActivity(); return;
    }
    const settings = state.generationSettings;
    // One optional picker (#39). Blank (null) follows the host's cheap slot, like core Flashcards.
    const modelField = el("div", undefined, "ab-field ab-field-inline ab-model-field");
    const modelBox = el("div", undefined, "ab-model"), modelRow = el("div", undefined, "ab-model-row");
    const pin = settings.model;
    modelRow.append(modelBox);
    modelField.append(el("span", "Model to write cards", "ab-label"), modelRow);
    try {
      widgets.push(ctx.ui.mountModelPicker(modelBox, { value: pin ? { provider: pin.provider, id: pin.id } : undefined, onChange: value => {
        if (value.provider !== pin?.provider || value.id !== pin.id) invalidate();
        return run(async () => {
          // Compare with the saved model when this runs: a Clear queued first must not swallow the pick.
          const now = state?.generationSettings?.model;
          if (value.provider === now?.provider && value.id === now.id) return;
          await snapshot("generationSettings", { model: { provider: value.provider, id: value.id } });
        });
      } }, { signal }));
    } catch {
      modelBox.textContent = settings.model ? "Model picker unavailable. Saved choice still applies." : "Model picker unavailable. Using the cheap model.";
    }
    // The host picker has no empty choice, so Clear is how a chosen model goes back to blank.
    if (settings.model) widgets.push(button(ctx, modelRow, signal, { label: "Clear", variant: "ghost", size: "sm", title: "Use the cheap model", onClick: () => {
      invalidate();
      return run(async () => { await snapshot("generationSettings", { model: null }); });
    } }));
    if (!pin) modelField.append(el("span", "Blank uses the cheap model and its reasoning level.", "ab-muted ab-hint"));
    const levelField = el("label", undefined, "ab-field ab-field-inline");
    if (pin && (modelLevels?.length || pin.thinkingLevel !== undefined)) {
      const level = el("select", undefined, "ab-input ab-select");
      const option = (value: string, text: string) => { const item = el("option", text); item.value = value; level.append(item); return item; };
      option("", "Model default");
      for (const value of modelLevels ?? []) option(value, value);
      if (pin.thinkingLevel !== undefined && !modelLevels?.includes(pin.thinkingLevel)) option(pin.thinkingLevel, `${pin.thinkingLevel} (saved)`).disabled = true;
      level.value = pin.thinkingLevel ?? "";
      level.onchange = () => {
        const value = level.value;
        invalidate();
        void run(async () => {
          try { await snapshot("generationSettings", { model: { provider: pin.provider, id: pin.id, ...(value ? { thinkingLevel: value } : {}) } }); }
          catch (error) { level.value = pin.thinkingLevel ?? ""; throw error; }
        }, true, () => {
          // A Clear or model change queued first wins; don't restore this model.
          const now = state?.generationSettings?.model;
          return now?.provider === pin.provider && now.id === pin.id;
        });
      };
      levelField.append(el("span", "Reasoning level", "ab-label"), level);
    } else if (pin && modelLevels === undefined) {
      modelField.append(el("span", "Reasoning levels unavailable.", "ab-muted ab-hint"));
    }

    // Write shows the common types (#38). Apply and Contrast are switched on in Settings.
    const kindsField = el("div", undefined, "ab-field ab-field-inline ab-kinds");
    kindsField.setAttribute("role", "group"); kindsField.setAttribute("aria-label", "Card types");
    kindsField.append(el("span", "Card types", "ab-label"));
    const chips = el("div", undefined, "ab-chips");
    const enabled = settings.enabledKinds;
    for (const kind of WRITE_KINDS) {
      const chip = el("label", undefined, "ab-chip");
      const box = el("input"); box.type = "checkbox"; box.checked = enabled.includes(kind);
      // At least one type stays on.
      box.disabled = box.checked && enabled.length === 1;
      box.title = KIND_HELP[kind]; chip.title = KIND_HELP[kind];
      box.onchange = () => {
        invalidate();
        const wanted = box.checked;
        // Send only this change; the backend applies it to the saved types, so it can't undo one made in Settings.
        void run(async () => {
          try { await snapshot("generationSettings", { toggleKind: { kind, enabled: wanted } }); }
          catch (error) { box.checked = !wanted; throw error; }
          // An open Settings panel shows Apply and Contrast, and whether the last type is locked on.
          for (const peer of peers ?? []) if (peer !== reloadFromPeer) peer();
        });
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
    capField.title = `Flagged ideas can get up to ${FLAGGED_CARD_CAP} cards.`;
    settingsRow.insertBefore(modelField, clozeField);
    if (levelField.childElementCount) settingsRow.insertBefore(levelField, clozeField);
    settingsRow.insertBefore(kindsField, clozeField); settingsRow.insertBefore(capField, clozeField);
    clozeField.hidden = false; syncCloze();

    const help = el("div", undefined, "ab-kind-lines");
    for (const kind of WRITE_KINDS) { const line = el("span"); line.append(el("strong", KIND_NAMES[kind]), ` ${KIND_HELP[kind].replace(/\.$/, "")}.`); help.append(line); }
    const fromSettings = SETTINGS_KINDS.filter(k => enabled.includes(k));
    if (fromSettings.length) help.append(el("span", `Also on: ${fromSettings.map(k => KIND_NAMES[k]).join(" and ")}.`, "ab-kind-extra"));
    const examples = el("details", undefined, "ab-kind-examples");
    examples.open = examplesOpen;
    examples.ontoggle = () => { examplesOpen = examples.open; };
    examples.append(el("summary", "See examples"), ...WRITE_KINDS.map(exampleCard));
    kindHelp.append(help, examples);

    writeButton = button(ctx, writeBar, signal, { label: "Write cards", variant: "default", onClick: () => run(async () => {
      if (!picker.ids.length) throw new Error("Select an idea first.");
      const input = {
        nodeIds: picker.ids, backfillNodeIds: picker.backfillNodeIds,
        ...(scope && { flagScopes: picker.flagScopes, independentNodeIds: picker.independentNodeIds }),
      };
      await estimateAndStart(() => ctx.call<Preflight>("preflight", input));
    }, false) });
    widgets.push(writeButton);
    renderActivity();
  }
  // Settings can switch Apply or Contrast on; show that here without a page reload.
  const reloadFromPeer = () => { invalidate(); void run(async () => { await snapshot(); }); };
  peers?.add(reloadFromPeer);
  const unsubscribe = ctx.onResync(() => { invalidate(); void run(async () => { await load(); await onCardsChanged(); }); });
  return {
    setScope: (next, select) => {
      invalidate();
      scope = next;
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
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); peers?.delete(reloadFromPeer); unsubscribe(); disposeWidgets(); },
  };
}
