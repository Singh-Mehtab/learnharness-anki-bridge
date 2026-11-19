import type { PluginActionContext, PluginFrontendContext } from "../sdk/index.d.ts";
import { latestTeacherTurn, MAX_FLAG_NOTE } from "./session/flow.ts";
import type { TeacherTurn } from "./session/flow.ts";

import type { CoverageRow } from "./coverage-ui.ts";
import type { DraftingHandle } from "./drafting-ui.ts";
import { button as hostButton, el, field, input, plural } from "./ui.ts";

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
/** How long the saved confirmation stays before the flag dialog closes. */
export const FLAG_DIALOG_CLOSE_MS = 1500;

function option(text: string, value: string): HTMLOptionElement { const o = el("option", text); o.value = value; return o; }

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
  let timer: ReturnType<typeof setTimeout> | undefined, closing: ReturnType<typeof setTimeout> | undefined;
  const done = () => { clearTimeout(timer); clearTimeout(closing); ctx.signal.removeEventListener("abort", done); scope.abort(); };
  ctx.signal.addEventListener("abort", done, { once: true });
  const root = el("div", undefined, "anki-bridge ab-dialog ab-flag");
  const heading = el("h3", !immediate ? "Flag for Anki" : immediate.created ? "Flagged for Anki" : "Already flagged for Anki", "ab-dialog-heading");
  const reply = el("blockquote", target.turn.excerpt, "ab-quote");
  const status = el("p", undefined, "ab-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const note = input(""); note.maxLength = MAX_FLAG_NOTE; note.placeholder = "For example: I got the sign wrong";
  note.value = immediate?.note ?? "";
  const noteLabel = field("Note for the card writer, optional", note);
  const buttons = el("div", undefined, "ab-actions ab-dialog-actions");
  const handles: Array<ReturnType<typeof hostButton>> = [];
  const setDisabled = (disabled: boolean) => { for (const h of handles) h.update({ disabled }); };
  let busy = false;
  const run = async (action: () => Promise<void> | void) => {
    if (busy || scope.signal.aborted) return;
    busy = true;
    clearTimeout(timer);
    setDisabled(true);
    try { await action(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.tone = "error"; }
    finally { busy = false; setDisabled(false); syncFinished(); }
  };
  const button = (label: string, action: () => Promise<void> | void, variant: "default" | "ghost" | "outline" = "outline") => {
    const handle = hostButton(ctx, buttons, scope.signal, { label, variant, onClick: () => run(action) });
    handles.push(handle);
    return handle;
  };
  let current = immediate;
  /** The flag being edited: the shortcut's flag, or one found by the top-bar Flag. */
  let existing = immediate;
  const describe = (view: FlagView) => flagStatusText(view);
  /** After a flag or note is saved, confirm it and close shortly after (#33). */
  const finish = (view: FlagView, saved: string) => {
    current = view; note.value = view.note; note.readOnly = true; heading.textContent = "Flagged for Anki";
    status.textContent = `${saved} ${describe(view)}`; status.dataset.tone = "success";
    finished = true; close.update({ label: "Close" });
    clearTimeout(timer); closing = setTimeout(done, FLAG_DIALOG_CLOSE_MS);
  };
  let finished = false;
  const submit = async () => {
    if (finished) return;
    const value = note.value.trim(), noteChange = !!existing && value !== (current?.note ?? "");
    // Omitting an empty note keeps any note already on this reply's flag.
    const view = await ctx.call<FlagView>("flag", { sessionId: target.sessionId, messageIds: target.turn.messageIds, ...(value || current ? { note: value } : {}) });
    if (!existing && view.created === false && view.note && !value) {
      // The reply was already flagged with a note the learner hasn't seen. Show it so they can keep, edit or clear it.
      existing = current = view; note.value = view.note; heading.textContent = "Already flagged for Anki";
      status.textContent = `Already flagged with a note. ${describe(view)}`; status.dataset.tone = "";
      primary.update({ label: "Save note" }); close.update({ label: "Close" });
      return;
    }
    finish(view, existing ? (noteChange ? (value ? "Note saved." : "Note removed.") : "Saved.")
      : view.created === false ? (value ? "Note saved." : "Already flagged.") : value ? "Flagged with your note." : "Flagged.");
  };
  note.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); void run(submit); } };
  const close = button(immediate ? "Close" : "Cancel", done, "ghost");
  // Undo only a flag this shortcut press created; never an earlier flag and its note.
  if (immediate?.created) button("Undo flag", async () => { await ctx.call("unflag", { id: immediate.id }); done(); });
  const primary = button(immediate ? "Save note" : "Flag", submit, "default");
  /** Once saved, only Close stays live while the dialog closes itself. */
  function syncFinished(): void { if (finished) for (const h of handles) if (h !== close) h.update({ disabled: true }); }
  root.append(heading, el("p", "Latest reply", "ab-label ab-quote-label"), reply, noteLabel, status, buttons);
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

export interface SourceOptions {
  requests: SessionRequests;
  drafting: Pick<DraftingHandle, "setScope" | "refresh">;
}
export interface SourceHandle {
  (): void;
  refresh(): Promise<void>;
}

const GRAPH = "";
const shortDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };

/** Step 1 header: where ideas come from, plus flags for that session. */
export function mountSources(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, options: SourceOptions): SourceHandle {
  const root = el("div", undefined, "ab-source");
  const picker = el("select", undefined, "ab-input ab-select ab-source-select");
  picker.setAttribute("aria-label", "Ideas from");
  const pickerField = el("label", undefined, "ab-field ab-field-inline ab-source-field");
  pickerField.append(el("span", "Ideas from", "ab-label"), picker);
  const bar = el("div", undefined, "ab-source-bar");
  const refreshSlot = el("span");
  bar.append(pickerField, refreshSlot);
  const notes = el("div", undefined, "ab-source-notes");
  const feedback = el("p", undefined, "ab-status"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  root.append(bar, notes, feedback);
  container.append(root);
  let disposed = false, busy = false, refreshPending = false, refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let list: SessionList | undefined, flow: SessionFlow | undefined;
  let sessionId: string | undefined = options.requests.take();
  let chosen = sessionId !== undefined;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  let noteScope = new AbortController();
  signal.addEventListener("abort", () => noteScope.abort(), { once: true });

  async function run(action: () => Promise<void>, quiet = false): Promise<void> {
    if (!alive()) return;
    // A choice made while a load runs is loaded straight after it.
    if (busy) { refreshPending = true; return; }
    busy = true; picker.disabled = true;
    try { await action(); if (alive()) { render(); if (!quiet) feedback.textContent = ""; } }
    catch (error) { if (alive()) { render(); feedback.textContent = error instanceof Error ? error.message : String(error); feedback.dataset.tone = "error"; } }
    finally {
      busy = false;
      if (alive()) picker.disabled = false;
      if (refreshPending && alive()) { refreshPending = false; void run(load, true); }
    }
  }
  async function load(): Promise<void> {
    const nextList = await ctx.call<SessionList>("sessions");
    if (!alive()) return;
    list = nextList;
    // First visit: the most recent session, or the whole graph when there are none.
    if (!chosen) { chosen = true; sessionId = list.sessions[0]?.id; void options.drafting.setScope(sessionId ? { sessionId } : undefined); }
    const requested = sessionId;
    const nextFlow = requested ? await ctx.call<SessionFlow>("sessionFlow", { sessionId: requested }) : undefined;
    if (!alive() || requested !== sessionId) return;
    flow = nextFlow;
  }
  function choose(id: string | undefined, select?: { nodeIds: string[]; backfillNodeIds?: string[] }): void {
    sessionId = id; chosen = true; flow = undefined;
    void options.drafting.setScope(id ? { sessionId: id } : undefined, select);
    void run(load);
  }
  function scheduleRefresh(): void {
    if (!alive() || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void run(load, true).then(() => options.drafting.refresh()); }, 1000);
  }
  hostButton(ctx, refreshSlot, signal, { label: "Refresh", onClick: () => run(async () => { await load(); await options.drafting.refresh(); }) });
  picker.onchange = () => choose(picker.value || undefined);

  function render(): void {
    noteScope.abort(); noteScope = new AbortController();
    picker.replaceChildren();
    for (const s of list?.sessions ?? []) {
      const extra = s.waitingCount ? ` · ${s.waitingCount} flag${s.waitingCount === 1 ? "" : "s"} waiting` : s.flagCount ? ` · ${plural(s.flagCount, "flag")}` : "";
      picker.append(option(`${s.title || "Untitled session"} · ${plural(s.nodeCount, "idea")}${extra}`, s.id));
    }
    if (sessionId && !list?.sessions.some(s => s.id === sessionId)) picker.append(option(flow?.session.title || "Session no longer saved", sessionId));
    picker.append(option("All sessions (whole graph)", GRAPH));
    picker.value = sessionId ?? GRAPH;

    notes.replaceChildren();
    if (flow && !flow.session.exists) notes.append(el("p", "This session is no longer saved. Its flags stay until you remove them.", "ab-note"));
    if (flow?.flags.length) {
      const box = el("div", undefined, "ab-flags");
      box.append(el("p", flow.flags.length === 1 ? "You flagged a reply in this session. Its ideas are selected below." : `You flagged ${flow.flags.length} replies in this session. Their ideas are selected below.`, "ab-flags-title"));
      const items = el("ul");
      for (const flag of flow.flags) {
        const item = el("li", undefined, "ab-flag-item");
        const text = el("div", undefined, "ab-flag-text");
        text.append(el("span", shortDate(flag.flaggedAt), "ab-muted"));
        if (flag.note) text.append(el("span", `Note: ${flag.note}`));
        if (flag.status !== "matched") text.append(el("span", flagStatusText(flag), "ab-muted"));
        item.append(text);
        const slot = el("span"); item.append(slot);
        hostButton(ctx, slot, noteScope.signal, { label: "Remove flag", size: "xs", onClick: () => run(async () => {
          await ctx.call("unflag", { id: flag.id }); await load(); await options.drafting.refresh();
        }) });
        items.append(item);
      }
      box.append(items);
      notes.append(box);
    }
    if (flow && !flow.nodes.length && flow.flags.some(f => f.status === "waiting")) notes.append(el("p", "LearnHarness is still extracting ideas from this session. They appear here when the reply settles.", "ab-note"));
    const elsewhere = (list?.unresolved ?? []).filter(f => f.sessionId !== sessionId);
    if (elsewhere.length) {
      const line = el("div", undefined, "ab-elsewhere");
      line.append(el("span", "Flags waiting in other sessions:", "ab-muted"));
      const bySession = new Map<string, { title: string; count: number }>();
      for (const f of elsewhere) { const e = bySession.get(f.sessionId) ?? { title: f.sessionTitle || "Untitled session", count: 0 }; e.count++; bySession.set(f.sessionId, e); }
      for (const [id, e] of bySession) hostButton(ctx, line, noteScope.signal, { label: `${e.title} (${e.count})`, variant: "link", size: "xs", onClick: () => choose(id) });
      notes.append(line);
    }
  }

  const unsubscribers = [
    options.requests.subscribe(id => { options.requests.take(); if (busy) refreshPending = true; choose(id); }),
    ctx.onResync(() => { if (busy) refreshPending = true; else void run(load, true); }),
    // Extraction has no completion event. Phase changes are a hint to re-check
    // waiting flags; Refresh remains the reliable path.
    ctx.onAppEvent(event => {
      if (event.type !== "activity-changed" && event.type !== "turn-settled") return;
      if (list?.unresolved.some(f => f.status === "waiting") || flow?.flags.some(f => f.status === "waiting")) scheduleRefresh();
    }),
  ];
  if (sessionId) void options.drafting.setScope({ sessionId });
  void run(load);
  return Object.assign(() => { disposed = true; clearTimeout(refreshTimer); noteScope.abort(); for (const u of unsubscribers) u(); root.remove(); }, {
    refresh: async () => {
      if (busy) { refreshPending = true; return; }
      await run(load, true);
    },
  });
}
