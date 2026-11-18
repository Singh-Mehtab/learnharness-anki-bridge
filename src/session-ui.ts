import type { PluginActionContext, PluginFrontendContext } from "../sdk/index.d.ts";
import { latestTeacherTurn, MAX_FLAG_NOTE } from "./session/flow.ts";
import type { TeacherTurn } from "./session/flow.ts";

import { CoveragePicker } from "./coverage-ui.ts";
import type { CoverageRow } from "./coverage-ui.ts";

// Mirrors of the backend's public shapes (src/session/service.ts). The frontend
// bundle must not import backend modules.
type FlagStatus = "matched" | "waiting" | "no-nodes" | "missing";
interface FlagView { id: string; sessionId: string; sessionTitle: string; messageIds: string[]; note: string; flaggedAt: string; status: FlagStatus; nodeIds: string[]; created?: boolean }
interface SessionNode extends CoverageRow { flagged: boolean; flagNotes: string[] }
interface SessionFlow { session: { id: string; title: string; exists: boolean }; nodes: SessionNode[]; flags: FlagView[]; cardsPerNode: number; paired: boolean; pairingWarning?: boolean; missing?: CoverageRow[] }
interface SessionSummary { id: string; title: string; updatedAt: string; nodeCount: number; flagCount: number; waitingCount: number }
interface SessionList { sessions: SessionSummary[]; unresolved: FlagView[] }

/** What "Make cards" hands to drafting: one session, ticked node IDs and their backfill subset.
 * The draft panel owns preflight, generation and review from here. */
export interface DraftRequest { sessionId: string; nodeIds: string[]; backfillNodeIds: string[] }

export const FLAG_SHORTCUT = "mod+shift+a";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function option(text: string, value: string): HTMLOptionElement { const o = el("option", text); o.value = value; return o; }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function flagStatusText(view: Pick<FlagView, "status" | "nodeIds">): string {
  switch (view.status) {
    case "matched": return `${plural(view.nodeIds.length, "idea")} from this reply.`;
    case "waiting": return "Waiting for extraction. LearnHarness extracts ideas after a reply settles; press Refresh to check again.";
    case "no-nodes": return "Extraction found no new ideas in this reply. Remove the flag, or keep it in case a later extraction adds some.";
    case "missing": return "This reply is no longer in the saved session.";
  }
}

/** Disabled unless a teaching session has a settled, reconciled transcript with
 * teacher prose. `view.messages` can hold streamed or optimistic content otherwise. */
export function flaggableTurn(context: PluginActionContext): { sessionId: string; turn: TeacherTurn } | null {
  if (!("surface" in context) || context.surface !== "session" || context.kind !== "teaching") return null;
  const view = context.view;
  if (view.status !== "ready" || view.reconciliation !== "ready") return null;
  const turn = latestTeacherTurn(view.messages as never);
  return turn ? { sessionId: context.sessionId, turn } : null;
}

/** Hands "Make cards" requests to the plugin view, which may already be open. */
export class SessionRequests {
  private pending: string | undefined;
  private readonly listeners = new Set<(sessionId: string) => void>();
  request(sessionId: string): void {
    this.pending = sessionId;
    for (const listener of this.listeners) listener(sessionId);
  }
  take(): string | undefined { const id = this.pending; this.pending = undefined; return id; }
  subscribe(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

function openFlagDialog(ctx: PluginFrontendContext, target: { sessionId: string; turn: TeacherTurn }, immediate?: FlagView): void {
  const scope = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", done); scope.abort(); };
  ctx.signal.addEventListener("abort", done, { once: true });
  const root = el("div", undefined, "anki-bridge anki-bridge-flag");
  const heading = el("h3", !immediate ? "Flag for Anki" : immediate.created ? "Flagged for Anki" : "Already flagged for Anki");
  const reply = el("p", `Reply: ${target.turn.excerpt}`, "anki-bridge-muted");
  const status = el("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const note = el("input"); note.type = "text"; note.maxLength = MAX_FLAG_NOTE; note.placeholder = "Optional: what to remember, e.g. I got the sign wrong";
  note.value = immediate?.note ?? "";
  const noteLabel = el("label"); noteLabel.append(el("span", "Note for the card writer"), note);
  const buttons = el("div");
  const button = (text: string, action: () => Promise<void> | void) => {
    const b = el("button", text); b.type = "button";
    b.onclick = async () => {
      clearTimeout(timer);
      for (const x of buttons.querySelectorAll("button")) x.disabled = true;
      try { await action(); }
      catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { for (const x of buttons.querySelectorAll("button")) x.disabled = false; }
    };
    return b;
  };
  let current = immediate;
  const describe = (view: FlagView) => `${flagStatusText(view)}${view.note ? `\nNote: ${view.note}` : ""}`;
  const show = (view: FlagView) => {
    current = view; note.value = view.note; heading.textContent = "Flagged for Anki"; status.textContent = describe(view);
    primary.textContent = "Save note"; close.textContent = "Close";
  };
  const submit = async () => {
    const value = note.value.trim();
    // Omitting an empty note keeps any note already on this reply's flag.
    show(await ctx.call<FlagView>("flag", { sessionId: target.sessionId, messageIds: target.turn.messageIds, ...(value || current ? { note: value } : {}) }));
  };
  note.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); buttons.querySelector<HTMLButtonElement>("[data-primary]")?.click(); } };
  const primary = button(immediate ? "Save note" : "Flag", submit); primary.dataset.primary = "";
  buttons.append(primary);
  // Undo only a flag this shortcut press created; never an earlier flag and its note.
  if (immediate?.created) buttons.append(button("Undo flag", async () => { await ctx.call("unflag", { id: immediate.id }); done(); }));
  const close = button(immediate ? "Close" : "Cancel", done);
  buttons.append(close);
  root.append(heading, reply, noteLabel, buttons, status);
  if (immediate) status.textContent = describe(immediate);
  // A keyboard flag confirms briefly and closes itself unless the learner engages.
  // Focus is host-owned on open, so only pointer and key input count as engagement.
  if (immediate) timer = setTimeout(done, 3500);
  for (const type of ["pointerdown", "keydown", "input"] as const) root.addEventListener(type, () => { clearTimeout(timer); timer = undefined; });
  ctx.ui.openDialog({ title: "Flag for Anki", content: root, onClose: done }, { signal: scope.signal });
}

export function registerSessionActions(ctx: PluginFrontendContext, requests: SessionRequests): void {
  ctx.cleanup(ctx.registerAction({
    id: "flag-for-anki",
    name: "Flag for Anki",
    shortcut: { scope: { sessions: ["teaching"] }, defaultBinding: FLAG_SHORTCUT },
    disabled: (context) => flaggableTurn(context) === null,
    run: async (context) => {
      const target = flaggableTurn(context);
      if (!target) throw new Error("Wait for the teacher's reply to finish before flagging it.");
      if (context.placement === "keyboard") {
        // The shortcut flags at once, without a note; the confirmation offers one.
        const view = await ctx.call<FlagView>("flag", { sessionId: target.sessionId, messageIds: target.turn.messageIds });
        openFlagDialog(ctx, target, view);
      } else openFlagDialog(ctx, target);
    },
  }));
  ctx.cleanup(ctx.placeAction({ id: "flag-top-bar", actionId: "flag-for-anki", location: "top-bar", sessions: ["teaching"] }));
  ctx.cleanup(ctx.registerAction({
    id: "make-cards",
    name: "Make cards",
    run: (context) => {
      if (!("surface" in context) || context.surface !== "session") throw new Error("Open a teaching session first.");
      requests.request(context.sessionId);
      ctx.app.openView("bridge");
    },
  }));
  ctx.cleanup(ctx.placeAction({ id: "make-cards-top-bar", actionId: "make-cards", location: "top-bar", sessions: ["teaching"] }));
}

export interface SessionPanelOptions {
  requests: SessionRequests;
  onInvalidateEstimate?: () => void;
  onCoverageChanged?: () => Promise<void>;
  /** Puts these nodes into the draft panel's selection. Without it the Draft button stays disabled. */
  onDraft?: (request: DraftRequest) => void | Promise<void>;
}

export interface SessionPanelHandle {
  (): void;
  refresh(): Promise<void>;
}

/** Session picker, flags with extraction status, and node selection for drafting. */
export function mountSessionFlow(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, options: SessionPanelOptions): SessionPanelHandle {
  const root = el("section", undefined, "anki-bridge-session");
  const feedback = el("p"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const controls = el("fieldset");
  root.append(el("h3", "Cards from a session"), feedback, controls);
  container.append(root);
  let disposed = false, busy = false, refreshPending = false, refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let list: SessionList | undefined, flow: SessionFlow | undefined;
  let sessionId = options.requests.take();
  const coverage = new CoveragePicker({
    defaults: true,
    changed: source => {
      if (source === "user" || coverage.isStale) options.onInvalidateEstimate?.();
      // A session read can discover extraction or coverage changes before drafting does.
      if (source === "read") void options.onCoverageChanged?.();
      if (draft) draft.disabled = !options.onDraft || !coverage.ids.length || coverage.isStale;
    },
    mutate: (name, node) => { void run(async () => {
      await ctx.call(name, { nodeId: node.id, statementHash: node.statementHash }); await load();
    }); },
  });
  let draft: HTMLButtonElement | undefined;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;

  async function run(action: () => Promise<void>, quiet = false): Promise<void> {
    if (!alive() || busy) return;
    busy = true; controls.disabled = true;
    if (!quiet) feedback.textContent = "Working...";
    try { await action(); if (alive()) { render(); if (!quiet) feedback.textContent = ""; } }
    catch (error) { if (alive()) { render(); feedback.textContent = error instanceof Error ? error.message : String(error); } }
    finally {
      busy = false;
      if (alive()) controls.disabled = false;
      if (refreshPending && alive()) { refreshPending = false; void run(load, true); }
    }
  }
  function button(text: string, action: () => Promise<void> | void, disabled = false): HTMLButtonElement {
    const b = el("button", text); b.type = "button"; b.disabled = disabled;
    b.onclick = () => { void run(async () => { await action(); }); };
    return b;
  }
  async function load(): Promise<void> {
    const requested = sessionId;
    let nextList: SessionList, nextFlow: SessionFlow | undefined;
    try {
      nextList = await ctx.call<SessionList>("sessions");
      if (requested) nextFlow = await ctx.call<SessionFlow>("sessionFlow", { sessionId: requested });
    } catch (error) { if (requested !== sessionId) return; coverage.markStale(); throw error; }
    if (!alive() || requested !== sessionId) return;
    feedback.textContent = "";
    const switched = nextFlow?.session.id !== flow?.session.id;
    list = nextList; flow = nextFlow;
    if (!flow) return;
    coverage.update({ ...flow, pairingWarning: flow.pairingWarning ?? false }, switched);
  }
  function scheduleRefresh(): void {
    if (!alive() || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void run(load, true); }, 1000);
  }

  function renderFlags(target: HTMLElement, flags: FlagView[], heading: string): void {
    if (!flags.length) return;
    target.append(el("h4", heading));
    const items = el("ul", undefined, "anki-bridge-flags");
    for (const flag of flags) {
      const item = el("li", undefined, `anki-bridge-flag-${flag.status}`);
      const when = new Date(flag.flaggedAt);
      item.append(el("strong", `${flag.sessionTitle || "Untitled session"} · ${Number.isNaN(when.getTime()) ? flag.flaggedAt : when.toLocaleString()}`));
      if (flag.note) item.append(el("p", `Note: ${flag.note}`));
      item.append(el("p", flagStatusText(flag)));
      item.append(button("Remove flag", async () => { await ctx.call("unflag", { id: flag.id }); await load(); }));
      if (flag.sessionId !== sessionId) item.append(button("Open session", () => { options.onInvalidateEstimate?.(); sessionId = flag.sessionId; return load(); }));
      items.append(item);
    }
    target.append(items);
  }

  function render(): void {
    if (flow?.session.id !== sessionId) { flow = undefined; }
    controls.replaceChildren();
    const picker = el("select");
    picker.append(option("Choose a teaching session", ""));
    for (const s of list?.sessions ?? []) {
      const flags = s.flagCount ? `, ${plural(s.flagCount, "flag")}${s.waitingCount ? ` (${s.waitingCount} unresolved)` : ""}` : "";
      picker.append(option(`${s.title || "Untitled session"}: ${plural(s.nodeCount, "idea")}${flags}`, s.id));
    }
    if (sessionId && !list?.sessions.some(s => s.id === sessionId)) picker.append(option(flow?.session.title || sessionId, sessionId));
    picker.value = sessionId ?? "";
    picker.onchange = () => { options.onInvalidateEstimate?.(); sessionId = picker.value || undefined; void run(load); };
    const pickLabel = el("label"); pickLabel.append(el("span", "Session"), picker);
    controls.append(pickLabel, button("Refresh", load));

    const elsewhere = (list?.unresolved ?? []).filter(f => f.sessionId !== sessionId);
    renderFlags(controls, elsewhere, `Unresolved flags in other sessions (${elsewhere.length})`);
    if (!flow) {
      controls.append(el("p", "Pick a session, or press Make cards in a teaching session's top bar."));
      return;
    }
    if (!flow.session.exists) controls.append(el("p", "This session is no longer saved. Its flags are kept until you remove them."));
    renderFlags(controls, flow.flags, `Flags in this session (${flow.flags.length})`);

    const nodes = flow.nodes;
    if (!nodes.length) {
      controls.append(el("p", flow.flags.some(f => f.status === "waiting")
        ? "No ideas extracted from this session yet. Extraction runs after each reply settles; press Refresh to check again."
        : "No graph ideas come from this session."));
      if (!flow.missing?.length) return;
    }
    controls.append(el("h4", `Ideas from this session (${nodes.length})`), coverage.root);
    draft = button("Draft cards for selected", async () => {
      if (!options.onDraft || !flow || coverage.isStale) return;
      await options.onDraft({ sessionId: flow.session.id, nodeIds: coverage.ids, backfillNodeIds: coverage.backfillNodeIds });
    }, !options.onDraft || !coverage.ids.length || coverage.isStale);
    controls.append(draft);
  }

  const unsubscribers = [
    options.requests.subscribe(id => {
      options.requests.take(); options.onInvalidateEstimate?.(); sessionId = id;
      if (busy) refreshPending = true; else void run(load);
    }),
    ctx.onResync(() => { if (busy) refreshPending = true; else void run(load, true); }),
    // Extraction has no completion event. Phase changes are a hint to re-check
    // waiting flags; Refresh remains the reliable path.
    ctx.onAppEvent(event => {
      if (event.type !== "activity-changed" && event.type !== "turn-settled") return;
      if (list?.unresolved.some(f => f.status === "waiting") || flow?.flags.some(f => f.status === "waiting")) scheduleRefresh();
    }),
  ];
  void run(load);
  return Object.assign(() => { disposed = true; clearTimeout(refreshTimer); for (const u of unsubscribers) u(); root.remove(); }, {
    refresh: async () => {
      if (busy) { refreshPending = true; return; }
      await run(load, true);
    },
  });
}
