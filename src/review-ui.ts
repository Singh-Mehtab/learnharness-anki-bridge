// Step 3: check each card, approve it and send approved cards to a deck, or download them as an .apkg file.
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { SendResult } from "./anki/delivery.ts";
import type { PackageResult as ExportResult } from "./anki/apkg.ts";
/** An export plus the tags the user asked for, so a re-check sends the same request. */
type PackageResult = ExportResult & { requestTags: string[] };
import { packageRevision } from "./anki/package-revision.ts";
import { expandTagTemplate, matchTagCase, tagSuggestions, validateTags } from "./anki/tags.ts";
import { isWaitingCard, type CoverageContext } from "./coverage/flow.ts";
import { earlierRepeatSkips, repeatCardPreview } from "./earlier-repeats-ui.ts";
import { isEarlierRepeatCard } from "./generation/earlier-repeats.ts";
import type { EarlierRepeatSkipRef, Generation } from "./generation/types.ts";
import { KIND_NAMES } from "./kinds-ui.ts";
import { CLOZE_KINDS, CORE_KINDS, isStoredKind } from "./writer/types.ts";
import { answerPreview, BLANK, questionPreview, toBasic, toCloze } from "./writer/cloze.ts";
import type { Connection, Destination, Peers, Settings } from "./settings-ui.ts";
import { base64Bytes, button, confirmDialog, el, field, input, moreMenu, pill, plural, RenderScope, saveFile, status, textarea } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";
import { regenerationRevision, type RegenerationReview } from "./regeneration/types.ts";
import { replacementComparison, rewriteDecision, rewriteForm } from "./regeneration/review-ui.ts";

interface Card {
  id: string; nodeId: string; statementHash: string; sessionId: string; nodeName: string; sessionName: string;
  kind: string; front: string; back: string; extra: string;
  /** FI-8: absent means basic. */
  format?: "cloze";
  status: "draft" | "approved" | "sending" | "sent" | "imported" | "failed" | "dropped";
  deck?: string; noteId?: number; existingNote?: true; destination?: Destination; lastError?: string;
  presence?: "present" | "deleted" | "unknown";
  possibleRepeatOf?: string;
  sourceStatement?: string; sourceChanged?: boolean; sourceMissing?: boolean; sourceUnavailable?: boolean;
  canRegenerate?: true; regeneration?: RegenerationReview;
}
export interface Snapshot { settings: Settings; destination: Destination | null; cards: Card[]; generations?: Generation[]; recoveryError?: string; generationRecoveryError?: string; durabilityWarning?: string; importMarkId?: string }
/** Editor values. format is part of an edit (FI-8), so a switch with no text change still saves. */
type Fields = { front: string; back: string; extra: string; format?: "cloze" };
const isClozeKind = (kind: string) => (CLOZE_KINDS as readonly string[]).includes(kind);
/** Preview text for a field: a cloze card shows the question with [...] and the answer filled in. */
function previewText(key: "front" | "back" | "extra", fields: Fields): string {
  if (fields.format !== "cloze" || key === "extra") return fields[key];
  if (!fields.front.includes(BLANK)) return key === "front" ? fields.front : fields.back;
  return key === "front" ? questionPreview(fields.front) : answerPreview(fields.front, fields.back);
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;

const STATUS: Record<Card["status"], { text: string; tone: "neutral" | "good" | "warn" | "bad" | "info" }> = {
  draft: { text: "Draft", tone: "neutral" }, approved: { text: "Approved", tone: "good" }, sending: { text: "Unconfirmed", tone: "warn" },
  sent: { text: "In Anki", tone: "good" }, imported: { text: "Imported", tone: "good" }, failed: { text: "Send failed", tone: "bad" }, dropped: { text: "Dropped", tone: "neutral" },
};

export interface ReviewHandle {
  refresh(): Promise<void>;
  showWaiting(nodeId: string): Promise<void>;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function mountReview(ctx: PluginFrontendContext, host: HTMLElement, signal: AbortSignal, options: {
  peers: Peers; onChanged: () => Promise<void>; headerAside: HTMLElement; visible?: boolean;
}): ReviewHandle {
  const banner = el("div", undefined, "ab-banners");
  const sendBar = el("div", undefined, "ab-send-bar");
  const deck = input(""); deck.setAttribute("list", "anki-bridge-decks"); deck.spellcheck = false; deck.placeholder = "Year 3::Nuclear Physics";
  const decks = el("datalist"); decks.id = "anki-bridge-decks";
  const deckHint = el("span", undefined, "ab-muted ab-deck-hint");
  const tags = input(""); tags.setAttribute("list", "anki-bridge-tags"); tags.spellcheck = false; tags.placeholder = "No tags"; tags.autocomplete = "off";
  const tagOptions = el("datalist"); tagOptions.id = "anki-bridge-tags";
  const tagHint = el("span", undefined, "ab-muted");
  const deckField = field("Deck", deck); deckField.append(deckHint);
  const tagField = field("Tags", tags); tagField.append(tagHint);
  const sendActions = el("div", undefined, "ab-actions ab-send-actions");
  sendActions.tabIndex = -1;
  sendActions.setAttribute("role", "group");
  sendActions.setAttribute("aria-label", "Bulk review actions");
  sendBar.append(deckField, decks, tagField, tagOptions, sendActions);
  const feedback = status();
  /** A clear confirmation after a send, kept until the next action or dismissed (#32). */
  const sentPanel = el("div", undefined, "ab-sent");
  sentPanel.setAttribute("role", "status"); sentPanel.hidden = true;
  const downloadPanel = el("div", undefined, "ab-sent");
  downloadPanel.setAttribute("role", "status"); downloadPanel.hidden = true;
  const importedPanel = el("div", undefined, "ab-sent");
  importedPanel.setAttribute("role", "status"); importedPanel.hidden = true;
  const list = el("div", undefined, "ab-cards");
  const repeatSkips = el("section", undefined, "ab-repeat-skips"); repeatSkips.hidden = true;
  const history = el("details", undefined, "ab-history");
  host.append(banner, sendBar, feedback, sentPanel, downloadPanel, importedPanel, repeatSkips, list, history);

  const menuSlot = options.headerAside;
  let state: Snapshot | undefined, connection: Connection | undefined, connectionError = "";
  let disposed = false, busy = false, refreshPending = false, actions = 0;
  let deckTouched = false, tagsTouched = false;
  const edits = new Map<string, Fields>();
  /** Fields as they were before a pending format switch; switching back restores them exactly. */
  const beforeSwitch = new Map<string, Fields>();
  /** Counts format switches per card, so a switch redraws its row. */
  const switches = new Map<string, number>();
  const editing = new Set<string>();
  /** Cards whose save is in flight. Their editors stay read-only across re-renders. */
  const saving = new Set<string>();
  let packageMarkInFlight = false;
  let regenerationTimer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const historyScope = new RenderScope(signal), barScope = new RenderScope(signal), bannerScope = new RenderScope(signal);
  const rows = new Map<string, { key: string; scope: RenderScope; view: ReturnType<typeof renderCard> }>();
  const repeatScope = new RenderScope(signal);
  let bannerKey = "", historyKey = "", repeatSkipsKey = "";
  let approveAll: ButtonHandle | undefined, sendAll: ButtonHandle | undefined, downloadAll: ButtonHandle | undefined;
  let bulkTargetKey: string | undefined;
  const sentScope = new RenderScope(signal), downloadScope = new RenderScope(signal), importedScope = new RenderScope(signal);
  let syncReceipt: (() => void) | undefined;
  function hideDownload(): void { if (packageMarkInFlight) return; downloadScope.reset(); downloadPanel.replaceChildren(); downloadPanel.hidden = true; syncReceipt = undefined; }
  function hideImported(): void { if (busy) return; importedScope.reset(); importedPanel.replaceChildren(); importedPanel.hidden = true; }
  function hideSent(): void { sentScope.reset(); sentPanel.replaceChildren(); sentPanel.hidden = true; delete sentPanel.dataset.kind; }
  function showSent({ added, found, skipped, failed, deck, tags }: SendResult["delivery"]): void {
    const ids = [...added, ...found];
    const s = sentScope.reset();
    const icon = el("span", undefined, "ab-sent-icon"); icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    const text = el("div", undefined, "ab-sent-text");
    if (added.length) {
      text.append(el("p", `${plural(added.length, "card")} sent to Anki`, "ab-sent-title"));
      if (deck) text.append(el("p", `Deck ${deck}`, "ab-sent-detail"));
      if (tags.length) text.append(el("p", `Tags ${tags.join(" ")}`, "ab-sent-detail"));
    }
    if (found.length) text.append(el("p", `Found ${plural(found.length, "existing note")} in Anki. Left unchanged.`, added.length ? "ab-sent-detail" : "ab-sent-title"));
    if (skipped.length) text.append(el("p", `Skipped ${plural(skipped.length, "card")} already sent.`, ids.length ? "ab-sent-detail" : "ab-sent-title"));
    if (failed.length) text.append(el("p", `${plural(failed.length, "card")} failed.`, "ab-sent-detail ab-warning"));
    const actionsBox = el("div", undefined, "ab-actions");
    if (ids.length && state?.destination) button(ctx, actionsBox, s, { label: "Show in Anki", onClick: async () => {
      // Not run(): that would clear this confirmation.
      try { await ctx.call("show", { ids }); } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    } });
    button(ctx, actionsBox, s, { label: "Dismiss", variant: "ghost", onClick: hideSent });
    revealPanel(icon, text, actionsBox);
  }
  async function dropCard(card: Card): Promise<string> {
    const next = await call("drop", { ids: [card.id] });
    edits.delete(card.id);
    if (!alive() || next.durabilityWarning || next.cards.some(c => c.nodeId === card.nodeId && isWaitingCard(c))) return "Card dropped.";
    // Dropping is already saved. A failed coverage read must not report it as a failed drop.
    let coverage: CoverageContext;
    try { coverage = await ctx.call<CoverageContext>("coverageContext"); }
    catch { return "Card dropped."; }
    const node = coverage.nodes?.find(n => n.id === card.nodeId);
    if (!alive() || !node?.coverage.canDismiss || node.statementHash !== card.statementHash) return "Card dropped.";
    const s = sentScope.reset();
    sentPanel.dataset.kind = "drop";
    const text = el("div", undefined, "ab-sent-text");
    text.append(el("p", "Card dropped", "ab-sent-title"), el("p", node.name, "ab-sent-detail"));
    const actionsBox = el("div", undefined, "ab-actions");
    button(ctx, actionsBox, s, { label: "Don't make cards for this idea", onClick: () => {
      if (s.aborted) return;
      return run(async () => {
        await ctx.call("dismissNode", { nodeId: node.id, statementHash: node.statementHash });
        await options.onChanged();
        return "Idea dismissed.";
      });
    } });
    button(ctx, actionsBox, s, { label: "Close", variant: "ghost", onClick: hideSent });
    revealPanel(text, actionsBox);
    return "";
  }
  function revealPanel(...children: HTMLElement[]): void {
    sentPanel.replaceChildren(...children);
    sentPanel.hidden = false;
    // Restart the entrance animation for a second send in a row.
    sentPanel.classList.remove("ab-sent-enter"); void sentPanel.offsetWidth; sentPanel.classList.add("ab-sent-enter");
    sentPanel.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }
  /** Requesting a download leaves approval and delivery unchanged. */
  function showDownloaded(result: PackageResult, bytes: Uint8Array<ArrayBuffer>): void {
    const s = downloadScope.reset();
    downloadPanel.dataset.kind = "download";
    const icon = el("span", undefined, "ab-sent-icon"); icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';
    const text = el("div", undefined, "ab-sent-text");
    text.append(el("p", `Download requested: ${result.fileName}, ${plural(result.ids.length, "card")}`, "ab-sent-title"), el("p", `Deck ${result.deck}`, "ab-sent-detail"));
    if (result.tags.length) text.append(el("p", `Tags ${result.tags.join(" ")}`, "ab-sent-detail"));
    text.append(
      el("p", "Downloading does not change card status. Open the file in Anki to import it.", "ab-sent-detail"),
      el("p", "Importing may duplicate cards already in Anki or update notes from an earlier package.", "ab-sent-detail ab-warning"));
    const actionsBox = el("div", undefined, "ab-actions");
    // Download again re-exports through the backend, which rejects imported or
    // sent cards even when this view's snapshot is stale.
    // A pending edit, including an unsaved format switch, blocks both actions, as
    // Mark as imported already did: the package must match what the editor shows (S21).
    const pendingEdit = () => result.ids.some(id => editing.has(id));
    const eligible = () => !packageMarkInFlight && result.ids.every((id, i) => { const card = state?.cards.find(c => c.id === id); return card && !card.regeneration && result.revisions[i] === packageRevision(card) && (card.status === "approved" || card.status === "failed") && card.noteId === undefined; });
    const warning = el("p", "", "ab-sent-detail ab-warning"); text.append(warning);
    const again = button(ctx, actionsBox, s, { label: "Download again", onClick: () => {
      if (pendingEdit()) { feedback.show("Save or cancel your edits before downloading these cards again.", "error"); return; }
      if (eligible()) void downloadAgain(result, bytes);
    } });
    const mark = button(ctx, actionsBox, s, { label: "Mark as imported", onClick: () => { if (eligible()) void packageAction("markImported", result, bytes, s); } });
    syncReceipt = () => { const blocked = !eligible(); again.update({ disabled: blocked }); mark.update({ disabled: blocked }); warning.textContent = packageMarkInFlight ? "Marking cards as imported…" : blocked ? "Some cards are no longer eligible. Dismiss this receipt and review the cards." : ""; };
    button(ctx, actionsBox, s, { label: "Dismiss", variant: "ghost", onClick: hideDownload });
    downloadPanel.replaceChildren(icon, text, actionsBox); downloadPanel.hidden = false; syncReceipt();
  }
  function showImported(result: PackageResult, bytes: Uint8Array<ArrayBuffer>, markId: string): void {
    const s = importedScope.reset();
    importedPanel.dataset.kind = "imported";
    const text = el("div", undefined, "ab-sent-text");
    text.append(el("p", `${plural(result.ids.length, "card")} marked as imported`, "ab-sent-title"));
    const actionsBox = el("div", undefined, "ab-actions");
    button(ctx, actionsBox, s, { label: "Undo", onClick: () => packageAction("unmarkImported", result, bytes, s, markId) });
    button(ctx, actionsBox, s, { label: "Dismiss", variant: "ghost", onClick: hideImported });
    importedPanel.replaceChildren(text, actionsBox); importedPanel.hidden = false;
  }
  async function packageAction(name: "markImported" | "unmarkImported", result: PackageResult, bytes: Uint8Array<ArrayBuffer>, panel: AbortSignal, markId?: string): Promise<void> {
    if (!alive() || busy || panel.aborted) return;
    if (name === "markImported" && !importedPanel.hidden) { feedback.show("Undo or dismiss the previous import first.", "error"); return; }
    if (name === "markImported" && result.ids.some(id => editing.has(id))) { feedback.show("Save or cancel your edits before marking these cards imported.", "error"); return; }
    busy = true; packageMarkInFlight = name === "markImported"; actions++; syncBar(); syncReceipt?.();
    let committed: Snapshot | undefined;
    try {
      const next = await ctx.call<Snapshot>(name, name === "markImported" ? { ids: result.ids, deck: result.deck, fingerprints: result.fingerprints } : { ids: result.ids, markId });
      if (alive()) {
        if (name === "markImported" && !next.importMarkId) throw new Error("Import confirmation was incomplete");
        state = next; render();
        if (!panel.aborted) {
          if (name === "markImported") { packageMarkInFlight = false; hideDownload(); showImported(result, bytes, next.importMarkId!); }
          else { importedScope.reset(); importedPanel.replaceChildren(); importedPanel.hidden = true; if (downloadPanel.hidden) showDownloaded(result, bytes); }
        }
        feedback.show(next.durabilityWarning ? `Cards updated, but saving could not be confirmed: ${next.durabilityWarning}.` : "", next.durabilityWarning ? "error" : undefined);
        committed = next;
      }
    } catch (error) { if (alive()) feedback.show(`${message(error)}. Refresh cards and check their status before retrying.`, "error"); }
    finally { busy = false; packageMarkInFlight = false; if (alive()) { syncBar(); syncReceipt?.(); } if (refreshPending && alive()) void backgroundRefresh(); }
    // Coverage refreshes after the action finishes, so the confirmation's Undo works immediately.
    if (committed && alive()) {
      const warned = !!committed.durabilityWarning;
      try { await options.onChanged(); } catch { if (alive() && !warned) feedback.show("Cards updated, but coverage could not refresh. Refresh the page.", "error"); }
    }
  }

  async function run(action: () => Promise<string | void>, keepPosition = false): Promise<void> {
    if (!alive() || busy) return;
    const start = () => {
      busy = true; actions++; syncBar();
      hideSent();
      feedback.show("Working…");
    };
    if (keepPosition) preserveCardPosition(start); else start();
    try { const done = await action(); if (alive()) render(() => feedback.show(done ?? "", "success")); }
    catch (error) { if (alive()) render(() => feedback.show(message(error), "error")); }
    finally { busy = false; if (alive()) syncBar(); if (refreshPending && alive()) void backgroundRefresh(); }
  }
  async function call<T extends Snapshot = Snapshot>(name: string, input?: unknown): Promise<T> {
    try {
      const next = await ctx.call<T>(name, input);
      if (name === "pair" || name === "settings") for (const peer of options.peers) if (peer !== refreshFromPeer) peer();
      if (alive()) { state = next; await options.onChanged(); }
      return next;
    } catch (error) {
      if ((name === "send" || name === "regenerateCard" || name === "acceptRegeneration" || name === "keepOriginalCard" || name === "retryRegenerationResult" || name === "rewriteAnyway") && alive()) {
        // A failed or stale action can still leave a different saved snapshot.
        try { const fresh = await ctx.call<Snapshot>("snapshot"); if (alive()) { state = fresh; await options.onChanged(); } } catch { /* Keep the send error. */ }
      }
      throw error;
    }
  }
  let reading: Promise<Snapshot | "busy"> | undefined, queuedRead: Promise<Snapshot | "busy"> | undefined;
  async function fetchSnapshot(): Promise<Snapshot | "busy"> {
    for (;;) {
      const started = actions;
      const fresh = await ctx.call<Snapshot>("snapshot");
      if (busy) { refreshPending = true; return "busy"; }
      if (started === actions) return fresh;
    }
  }
  /** Each caller gets a snapshot read that started after its request. */
  function readSnapshot(): Promise<Snapshot | "busy"> {
    if (!reading) { reading = fetchSnapshot().finally(() => { reading = undefined; }); return reading; }
    queuedRead ??= reading.catch(() => undefined).then(() => { queuedRead = undefined; return readSnapshot(); });
    return queuedRead;
  }
  async function backgroundRefresh(): Promise<void> {
    if (!alive()) return;
    if (busy) { refreshPending = true; return; }
    refreshPending = false;
    try {
      const fresh = await readSnapshot();
      if (!alive() || fresh === "busy") return;
      const before = destinationKey(state?.destination), lookupBefore = lookupKey();
      state = fresh; render();
      // A new profile changes which ideas count as in Anki, and a new profile or address changes which decks exist.
      if (destinationKey(fresh.destination) !== before) void options.onChanged().catch(() => undefined);
      if (lookupKey() !== lookupBefore) void loadDecks();
    } catch (error) {
      refreshPending = true;
      if (alive()) feedback.show(`Refresh failed: ${message(error)}`, "error");
    }
  }
  function refreshFromPeer(): void { void backgroundRefresh(); }
  const destinationKey = (d: Destination | null | undefined) => d ? `${d.url}\n${d.profile}` : "";
  /** Decks are looked up only while the saved address is the paired one, as the backend requires for sending. */
  const lookupKey = () => state?.destination && state.settings.url === state.destination.url ? destinationKey(state.destination) : "";
  let decksFor = "", lookups = 0;
  let visible = options.visible ?? true, lookupDeferred = false;
  function syncRegenerationPoll(): void {
    const polling = visible && alive() && (state?.generations?.some(g => g.status === "running") ||
      state?.cards.some(c => c.regeneration?.status === "queued" || c.regeneration?.status === "running"));
    if (!polling) { clearTimeout(regenerationTimer); regenerationTimer = undefined; }
    else if (!regenerationTimer) regenerationTimer = setTimeout(() => {
      regenerationTimer = undefined;
      void backgroundRefresh().finally(syncRegenerationPoll);
    }, 1200);
  }
  /** Deck names shown for the profile in Anki, or none while that profile isn't the paired one. */
  const knownDecks = () => connection && lookupKey() && connection.profile === state?.destination?.profile ? connection.decks : undefined;
  /** Tag names in that profile, for suggestions and matching the collection's casing. */
  const knownTags = () => knownDecks() ? connection?.tags ?? [] : [];
  function syncTagSuggestions(): void {
    const next = tagSuggestions(tags.value, knownTags(), deckName());
    const now = [...tagOptions.children].map(o => (o as HTMLOptionElement).value);
    if (next.length === now.length && next.every((v, i) => v === now[i])) return;
    tagOptions.replaceChildren(...next.map(value => { const o = el("option"); o.value = value; return o; }));
  }
  async function loadDecks(): Promise<void> {
    if (!alive()) return;
    // Local snapshots may refresh in the background, but only Make cards needs Anki's decks and tags.
    if (!visible) { lookupDeferred = true; return; }
    lookupDeferred = false;
    const asked = lookupKey();
    if (!asked) {
      // No pairing, or the address changed since pairing: offer nothing until it is paired again.
      decksFor = ""; connection = undefined; connectionError = "";
      decks.replaceChildren(); syncDeck(); renderBanner();
      return;
    }
    if (asked !== decksFor) {
      // Don't offer the old profile's decks while the new one loads.
      decksFor = asked; connection = undefined; connectionError = "";
      decks.replaceChildren(); syncDeck();
    }
    const lookup = ++lookups;
    let next: Connection | undefined, error = "";
    try { next = await ctx.call<Connection>("connection"); }
    catch (e) { error = message(e); }
    // Ignore answers for an address or profile that has since changed, and any answer a newer lookup replaces (#19).
    if (!alive() || lookupKey() !== asked || lookup !== lookups) return;
    connection = next; connectionError = error;
    decks.replaceChildren(...(knownDecks() ?? []).map(name => { const o = el("option"); o.value = name; return o; }));
    syncDeck(); renderBanner();
  }

  const approvedCards = () => (state?.cards ?? []).filter(c => !c.regeneration && (c.status === "approved" || c.status === "failed") && c.noteId === undefined);
  const draftCards = () => (state?.cards ?? []).filter(c => c.status === "draft" && !c.regeneration);
  const deckName = () => deck.value.trim();
  function tagList(): string[] { return tags.value.split(/\s+/u).filter(Boolean); }
  function syncDeck(): void {
    const name = deckName();
    if (!name) deckHint.textContent = "";
    else if (state?.destination && !lookupKey()) deckHint.textContent = "Address changed. Choose the profile again in settings.";
    else if (!connection) deckHint.textContent = connectionError ? "Open Anki to check this deck name." : "";
    else if (!knownDecks()) deckHint.textContent = `Open the ${state?.destination?.profile ?? "chosen"} profile in Anki to check this deck name.`;
    else if (knownDecks()!.includes(name)) deckHint.textContent = "Existing deck.";
    else {
      const close = knownDecks()!.find(d => d.toLocaleLowerCase() === name.toLocaleLowerCase());
      deckHint.textContent = close ? `New deck. Did you mean ${close}?` : "New deck.";
    }
    // A template that uses {deck} waits for a deck name rather than inventing one.
    const waitsForDeck = !name && !!state?.settings.tagTemplate.includes("{deck}");
    if (!tagsTouched && state) tags.value = waitsForDeck ? "" : expandTagTemplate(state.settings.tagTemplate, name).map(t => matchTagCase(t, knownTags())).join(" ");
    syncTagSuggestions();
    let tagProblem = "";
    try { validateTags(tagList()); } catch (error) { tagProblem = message(error); }
    const extra = state?.settings.systemTags ? " Plus learnharness tags." : "";
    tagHint.textContent = tagProblem || (tagList().length ? `Separate tags with spaces.${extra}` : waitsForDeck && !tagsTouched ? `Tags fill in after you choose a deck.${extra}` : `No tags.${extra}`);
    tagHint.dataset.tone = tagProblem ? "error" : "";
    syncBar();
  }
  deck.oninput = () => { deckTouched = true; syncDeck(); };
  tags.oninput = () => { tagsTouched = true; syncDeck(); };

  function sendBlocker(): string | undefined {
    if (!state?.destination) return "Choose a profile in settings.";
    if (!deckName()) return "Choose a deck first.";
    try { validateTags(tagList()); } catch (error) { return message(error); }
    if ([...editing].some(id => approvedCards().some(c => c.id === id))) return "Save or cancel your edits first.";
    return undefined;
  }
  /** Downloading needs a deck and valid tags, but no profile and no running Anki. */
  function downloadBlocker(): string | undefined {
    if (!deckName()) return "Choose a deck first.";
    try { validateTags(tagList()); } catch (error) { return message(error); }
    if ([...editing].some(id => approvedCards().some(c => c.id === id))) return "Save or cancel your edits first.";
    return undefined;
  }
  function syncBar(): void {
    if (!approveAll) return;
    const ids = approvedCards().map(c => c.id), drafts = draftCards().length;
    approveAll.update({ label: drafts ? `Approve all drafts (${drafts})` : "Approve all drafts", disabled: busy || !drafts });
    const sendProps = { disabled: busy || !ids.length, title: sendBlocker() ?? "" };
    const downloadProps = { disabled: busy || !ids.length, title: downloadBlocker() ?? "Works with Anki closed." };
    const targetKey = JSON.stringify(ids);
    if (bulkTargetKey !== targetKey) {
      bulkTargetKey = targetKey;
      // Hold the toolbar's height while replacement portals are empty. Even
      // a briefly collapsed flex row can shift the anchored review cards.
      sendActions.style.setProperty("--ab-send-actions-height", `${sendActions.getBoundingClientRect().height}px`);
      // The host commits button labels later. Retire controls whose action
      // would otherwise send or export a different set than the one shown.
      for (const control of [downloadAll, sendAll]) {
        if (!control) continue;
        if (control.root.contains(host.ownerDocument.activeElement)) sendActions.focus({ preventScroll: true });
        control.dispose(); control.root.remove();
      }
      downloadAll = button(ctx, sendActions, barScope.signal, { ...downloadProps, label: "Download .apkg", onClick: () => run(() => download(ids)) });
      sendAll = button(ctx, sendActions, barScope.signal, { ...sendProps, label: ids.length ? `Send ${plural(ids.length, "card")} to Anki` : "Send to Anki", variant: "default", onClick: () => run(() => send(ids)) });
      sendAll.root.classList.add("ab-bulk-send");
    } else {
      downloadAll?.update(downloadProps);
      sendAll?.update(sendProps);
    }
  }
  async function downloadAgain(result: PackageResult, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (busy) return;
    busy = true; actions++; syncBar();
    try {
      const fresh = await ctx.call<ExportResult>("exportPackage", { ids: result.ids, deck: result.deck, tags: result.requestTags });
      if (!alive()) return;
      if (fresh.fingerprints.join() !== result.fingerprints.join()) throw new Error("These cards changed after the download. Dismiss this receipt and download again");
      // An edit or format switch started while the export ran would make the file
      // differ from the editor (round 1 S3).
      if (result.ids.some(id => editing.has(id))) { feedback.show("Save or cancel your edits before downloading these cards again.", "error"); return; }
      saveFile(result.fileName, bytes);
    } catch (error) {
      if (!alive()) return;
      feedback.show(`${message(error)}. Refresh cards and check their status.`, "error");
      try { const fresh = await ctx.call<Snapshot>("snapshot"); if (alive()) { state = fresh; render(); await options.onChanged(); } } catch { /* The message above already asks for a refresh. */ }
    } finally { busy = false; if (alive()) { syncBar(); syncReceipt?.(); } if (refreshPending && alive()) void backgroundRefresh(); }
  }
  async function download(ids: string[]): Promise<string> {
    if (!downloadPanel.hidden) throw new Error("Mark or dismiss the previous download before starting another.");
    const blocked = downloadBlocker();
    if (blocked) throw new Error(blocked);
    const requestTags = validateTags(tagList());
    const result: PackageResult = { ...await ctx.call<ExportResult>("exportPackage", { ids, deck: deckName(), tags: requestTags }), requestTags };
    if (!alive()) return "";
    // Checked again after the export, in case an edit started while it ran (round 1 S3).
    if (result.ids.some(id => editing.has(id))) throw new Error("Save or cancel your edits first.");
    const bytes = base64Bytes(result.data);
    saveFile(result.fileName, bytes);
    showDownloaded(result, bytes);
    return "";
  }
  const earlierCard = (id: string | undefined) => id ? state?.cards.find(c => c.id === id && isEarlierRepeatCard(c)) : undefined;
  async function send(ids: string[]): Promise<string> {
    const blocked = sendBlocker();
    if (blocked) throw new Error(blocked);
    const name = deckName(), sentTags = tags.value, sentTagList = validateTags(tagList());
    const expectedDestination = state?.destination;
    const repeatCount = state?.cards.filter(c => ids.includes(c.id) && earlierCard(c.possibleRepeatOf)).length ?? 0;
    // The send uses these values, so they can't change underneath it.
    deck.readOnly = true; tags.readOnly = true;
    let result: SendResult;
    try {
      if (repeatCount) {
        const ok = await confirmDialog(ctx, signal, { title: "Send to Anki", confirm: "Send",
          body: `${repeatCount} of ${plural(ids.length, "card")} to send ${repeatCount === 1 ? "is a possible repeat" : "are possible repeats"}. You can send them as they are or go back to review them.` });
        if (!ok || !alive()) return "";
      }
      result = await call<SendResult>("send", { ids, deck: name, tags: sentTagList, expectedDestination });
    } finally { deck.readOnly = false; tags.readOnly = false; }
    if (!alive()) return "";
    if (deckName() === name && result.delivery.added.length) deckTouched = false;
    // Tags typed for this send apply to this send only.
    if (!result.delivery.failed.length && tags.value === sentTags) tagsTouched = false;
    void loadDecks();
    if (result.delivery.failed.length === ids.length) return "No cards sent.";
    showSent(result.delivery);
    return "";
  }

  function renderBar(): void {
    if (approveAll) return; // Keep Approve and More mounted when the bulk targets change.
    const s = barScope.signal;
    approveAll = button(ctx, sendActions, s, { label: "Approve all drafts", onClick: () => run(async () => {
      const drafts = draftCards();
      if (!drafts.length) return;
      if ([...editing].some(id => drafts.some(c => c.id === id))) throw new Error("Save or cancel your edits first.");
      const ok = await confirmDialog(ctx, signal, { title: "Approve all drafts", confirm: "Approve",
        body: `Check the answers before approving these ${plural(drafts.length, "draft")}. Approving does not send cards to Anki.` });
      if (!ok || !alive()) return;
      await call("approve", { ids: drafts.map(c => c.id) });
      return `Approved ${plural(drafts.length, "card")}.`;
    }, true) });
    menuSlot.replaceChildren();
    moreMenu(ctx, menuSlot, s, "More", () => {
      const hasSent = sentCardsHere().length > 0, unsentCount = unsentCards().length;
      // A resync can happen with the menu open. Resolve selections against current state.
      return [
        { key: "write", label: "Write a card by hand", onSelect: () => openManual() },
        { key: "refresh", label: "Refresh cards", onSelect: () => run(async () => { await call("snapshot"); void loadDecks(); }, true) },
        { key: "reconcile", label: "Check unconfirmed sends", disabled: !hasUnconfirmedSends(), onSelect: () => run(async () => {
          if (!hasUnconfirmedSends()) return;
          await call("reconcile"); return "Checked unconfirmed sends.";
        }) },
        { key: "presence", label: "Check which sent cards are still in Anki", disabled: !hasSent, onSelect: () => run(async () => {
          if (!sentCardsHere().length) return;
          await call("presence"); return "Checked sent cards.";
        }) },
        { key: "show", label: "Show sent cards in Anki", disabled: !hasSent, onSelect: () => run(async () => {
          const ids = sentCardsHere().map(c => c.id);
          if (ids.length) await ctx.call("show", { ids });
        }) },
        { key: "drop", label: `Drop all unsent cards (${unsentCount})`, disabled: !unsentCount, onSelect: () => run(async () => {
          const ids = unsentCards().map(c => c.id);
          if (!ids.length) return;
          const ok = await confirmDialog(ctx, signal, { title: "Drop all unsent cards", confirm: "Drop cards", destructive: true,
            body: `Drop ${plural(ids.length, "unsent card")}?` });
          if (!ok || !alive()) return;
          await call("drop", { ids });
          for (const id of ids) { edits.delete(id); editing.delete(id); }
          return `Dropped ${plural(ids.length, "card")}.`;
        }) },
      ];
    });
  }

  const atShown = (card: Card) => !!state?.destination && card.destination?.url === state.destination.url && card.destination.profile === state.destination.profile;
  const sentCardsHere = () => (state?.cards ?? []).filter(c => c.status === "sent" && atShown(c));
  const unsentCards = () => (state?.cards ?? []).filter(c => ["draft", "approved", "failed"].includes(c.status) && c.noteId === undefined);
  const hasUnconfirmedSends = () => (state?.cards ?? []).some(c => c.status === "sending");

  function openManual(): void {
    const dialogScope = new AbortController();
    const content = el("div", undefined, "anki-bridge ab-dialog ab-manual");
    const front = textarea("", 3), back = textarea("", 3), extra = textarea("", 2);
    const kind = el("select", undefined, "ab-input ab-select");
    for (const k of CORE_KINDS) { const o = el("option", KIND_NAMES[k]); o.value = k; kind.append(o); }
    // FI-8: a fact or equation card can be written as a cloze card.
    const format = el("select", undefined, "ab-input ab-select");
    for (const [value, label] of [["basic", "Question and answer"], ["cloze", "Cloze"]]) { const o = el("option", label); o.value = value!; format.append(o); }
    const frontField = field("Front", front), backField = field("Back", back), formatField = field("Format", format);
    const blankRow = el("div", undefined, "ab-actions");
    button(ctx, blankRow, dialogScope.signal, { label: "Insert blank", size: "xs", onClick: () => {
      front.setRangeText(BLANK, front.selectionStart ?? front.value.length, front.selectionEnd ?? front.value.length, "end"); front.focus();
    } });
    const syncFormat = () => {
      if (!isClozeKind(kind.value)) format.value = "basic";
      formatField.hidden = !isClozeKind(kind.value);
      const cloze = format.value === "cloze";
      frontField.querySelector(".ab-label")!.textContent = cloze ? "Text" : "Front";
      backField.querySelector(".ab-label")!.textContent = cloze ? "Hidden part" : "Back";
      blankRow.hidden = !cloze;
    };
    kind.onchange = syncFormat; format.onchange = syncFormat;
    const err = status();
    const actionsRow = el("div", undefined, "ab-actions ab-dialog-actions");
    content.append(el("h3", "Write a card", "ab-dialog-heading"), field("Card type", kind), formatField, frontField, blankRow, backField, field("Extra, optional", extra, "Reason or hint."), err, actionsRow);
    syncFormat();
    let handle: ReturnType<PluginFrontendContext["ui"]["openDialog"]> | undefined;
    const close = () => { dialogScope.abort(); handle?.dispose(); };
    button(ctx, actionsRow, dialogScope.signal, { label: "Cancel", variant: "ghost", onClick: close });
    button(ctx, actionsRow, dialogScope.signal, { label: "Add card", variant: "default", onClick: async () => {
      if (busy) { err.show("Wait for the current action to finish.", "error"); return; }
      // Counted like other actions, so an older background read can't hide the new card.
      busy = true; actions++; syncBar();
      hideSent();
      try {
        await call("draft", { front: front.value, back: back.value, extra: extra.value, kind: kind.value, format: format.value });
        close(); render(); feedback.show("Card added.", "success");
      } catch (error) { err.show(message(error), "error"); }
      finally { busy = false; if (alive()) syncBar(); if (refreshPending && alive()) void backgroundRefresh(); }
    } });
    handle = ctx.ui.openDialog({ title: "Write a card", content, onClose: close }, { signal: dialogScope.signal });
  }

  function renderBanner(): void {
    if (!state) return;
    type Action = { label: string; run: () => void };
    const notes: { text: string; tone: "warn" | "bad"; action?: Action }[] = [];
    const note = (text: string, tone: "warn" | "bad" = "warn", action?: Action) => { notes.push({ text, tone, action }); };
    if (state.recoveryError) note(`An earlier send needs checking: ${state.recoveryError}`, "bad");
    if (state.generationRecoveryError) note(`Card generation needs checking: ${state.generationRecoveryError}`, "bad");
    if (!state.destination) note("Choose an Anki profile to send. Download .apkg works without one.", "warn", { label: "Open settings", run: () => ctx.app.openSettings() });
    else if (state.destination.url !== state.settings.url) note("Anki address changed. Choose the profile again.", "warn", { label: "Open settings", run: () => ctx.app.openSettings() });
    else if (connectionError) note("Anki isn't reachable. Open Anki.", "warn", { label: "Try again", run: () => { void loadDecks(); } });
    else if (connection && connection.profile !== state.destination.profile) note(`Anki has ${connection.profile ?? "no profile"} open. Open ${state.destination.profile} to send.`, "warn");
    const key = JSON.stringify(notes);
    if (key === bannerKey) return;
    bannerKey = key;
    const bs = bannerScope.reset();
    banner.replaceChildren();
    for (const { text, tone, action } of notes) {
      const box = el("div", undefined, "ab-banner"); box.dataset.tone = tone;
      box.append(el("span", text));
      if (action) button(ctx, box, bs, { label: action.label, size: "xs", onClick: action.run });
      banner.append(box);
    }
  }

  function renderCard(card: Card, s: AbortSignal) {
    const article = el("article", undefined, "ab-card");
    article.dataset.status = card.status;
    article.dataset.cardId = card.id;
    if (isWaitingCard(card)) {
      article.tabIndex = -1;
      if (card.nodeId) article.dataset.waitingNode = card.nodeId;
    }
    const importedConflict = card.status === "imported" && editing.has(card.id);
    const rewriteConflict = !!card.regeneration && editing.has(card.id);
    const editConflict = importedConflict || rewriteConflict;
    const editable = editConflict || (!card.regeneration && ["draft", "approved", "failed"].includes(card.status) && card.noteId === undefined);
    if (!editable) { edits.delete(card.id); beforeSwitch.delete(card.id); editing.delete(card.id); }
    const isEditing = editable && editing.has(card.id);
    const values: Fields = (isEditing && edits.get(card.id)) || card;

    const head = el("header", undefined, "ab-card-head");
    const title = el("div", undefined, "ab-card-title");
    const kindName = isStoredKind(card.kind) ? KIND_NAMES[card.kind] : card.kind;
    title.append(pill(kindName, "info"));
    if (values.format === "cloze") title.append(pill("Cloze", "neutral"));
    const covering = editable ? earlierCard(card.possibleRepeatOf) : undefined;
    if (covering) title.append(pill("Possible repeat", "warn"));
    title.append(el("span", card.nodeName || "Card", "ab-card-idea"));
    if (card.sessionName && card.sessionName !== "Manual") title.append(el("span", card.sessionName, "ab-muted ab-card-session"));
    const badge = pill(STATUS[card.status].text, STATUS[card.status].tone);
    head.append(title, badge);
    article.append(head);

    const notices: string[] = [];
    if (importedConflict) notices.push("This card was marked imported in another view. Copy your unsaved edits before cancelling; they cannot be saved to this imported card.");
    if (rewriteConflict) notices.push("A rewrite was queued in another view. Copy your unsaved edits before cancelling to review the rewrite.");
    if (card.lastError) notices.push(card.lastError);
    if (card.sourceMissing) notices.push("Source idea wasn't found in this graph snapshot. Check the card before approving.");
    else if (card.sourceChanged) notices.push("Idea changed since this card was written.");
    else if (card.sourceUnavailable) notices.push("Couldn't check for idea changes. Refresh to retry.");
    if (card.status === "sending") notices.push("May not have reached Anki. Use Check unconfirmed sends in the menu.");
    for (const text of notices) article.append(el("p", text, card.lastError === text || card.status === "sending" ? "ab-card-error" : "ab-card-warning"));

    const grid = el("div", undefined, "ab-card-fields");
    const inputs: Partial<Record<keyof Fields, HTMLTextAreaElement>> = {};
    const length = el("p", undefined, "ab-muted ab-card-length");
    const handles: Array<ReturnType<PluginFrontendContext["ui"]["mountMarkdown"]>> = [];
    const cloze = values.format === "cloze";
    const current = (): Fields => inputs.front ? { front: inputs.front.value, back: inputs.back!.value, extra: inputs.extra!.value, ...(cloze ? { format: "cloze" as const } : {}) } : values;
    const showLength = () => {
      const f = words(inputs.front?.value ?? values.front), b = words(inputs.back?.value ?? values.back);
      length.textContent = [f > 30 ? `Long front: ${f} words. Aim for about 30.` : "", b > 15 ? `Long back: ${b} words. Aim for about 15.` : ""].filter(Boolean).join(" ");
    };
    for (const key of ["front", "back", "extra"] as const) {
      if (key === "extra" && !isEditing && !values.extra.trim()) continue;
      const col = el("section", undefined, "ab-card-field");
      const label = key === "extra" ? "Extra" : cloze ? (key === "front" ? "Text" : "Hidden part") : key === "front" ? "Front" : "Back";
      col.append(el("h4", label, "ab-field-name"));
      const preview = el("div", undefined, "ab-markdown");
      if (isEditing) {
        const lines = values[key].split("\n").length + Math.ceil(values[key].length / 60);
        const area = textarea(values[key], Math.min(12, Math.max(key === "extra" ? 2 : 3, lines)));
        area.setAttribute("aria-label", label);
        area.dataset.keep = `card-${card.id}-${key}`;
        area.readOnly = saving.has(card.id);
        inputs[key] = area;
        area.oninput = () => {
          const now = current();
          edits.set(card.id, now);
          // A cloze preview of either side depends on both the text and the hidden part.
          (["front", "back", "extra"] as const).forEach((k, i) => { if (k === key || (cloze && k !== "extra")) handles[i]?.update({ text: previewText(k, now) || " " }); });
          showLength();
        };
        col.append(area);
        preview.classList.add("ab-markdown-preview");
      }
      col.append(preview);
      handles[["front", "back", "extra"].indexOf(key)] = ctx.ui.mountMarkdown(preview, { text: previewText(key, values) || " " }, { signal: s });
      grid.append(col);
    }
    const rewrite = card.regeneration;
    article.append(rewrite?.replacement && !rewriteConflict ? replacementComparison(ctx, s, grid, kindName, rewrite.replacement, previewText) : grid);
    const replacement = rewrite?.replacement;
    const repeatMatch = replacement ? earlierCard(replacement.possibleRepeatOf) : covering;
    if (repeatMatch && !isEditing) {
      const compare = el("details", undefined, "ab-card-source");
      const sides = el("div", undefined, "ab-card-fields");
      sides.append(repeatCardPreview(ctx, replacement ? "Replacement" : "This draft", replacement ?? values, s),
        repeatCardPreview(ctx, repeatMatch.nodeName || "Earlier card", repeatMatch, s));
      compare.append(el("summary", replacement ? "Possible repeat: compare replacement with earlier card" : "Compare with earlier card"), sides);
      article.append(compare);
    }
    showLength();
    if (isEditing || (editable && length.textContent)) article.append(length);

    if (card.sourceStatement) {
      const source = el("details", undefined, "ab-card-source");
      source.append(el("summary", "Idea when this card was written"), el("p", card.sourceStatement));
      article.append(source);
    }

    const foot = el("footer", undefined, "ab-card-foot");
    const left = el("div", undefined, "ab-actions"), right = el("div", undefined, "ab-actions");
    foot.append(left, right);
    const saved = () => {
      const now = edits.get(card.id);
      return !now || (now.front === card.front && now.back === card.back && now.extra === card.extra && now.format === card.format);
    };
    let footerActions: ButtonHandle[] | undefined;
    function renderFooterActions(status: Card["status"]): ButtonHandle[] {
      const actions: ButtonHandle[] = [];
      if (status === "draft") actions.push(button(ctx, right, s, { label: "Approve", onClick: () => run(async () => { await call("approve", { ids: [card.id] }); }, true) }));
      if (status === "approved") actions.push(button(ctx, right, s, { label: "Approved", variant: "outline", title: "Click to return to Draft", onClick: () => run(async () => { await call("unapprove", { id: card.id }); }, true) }));
      if (status === "approved" || status === "failed") actions.push(button(ctx, right, s, { label: status === "failed" ? "Retry send" : "Send this card", onClick: () => run(() => send([card.id])) }));
      return actions;
    }
    if (editable) {
      if (isEditing) {
        button(ctx, left, s, { label: "Cancel", disabled: saving.has(card.id), onClick: () => { edits.delete(card.id); beforeSwitch.delete(card.id); editing.delete(card.id); feedback.show(""); render(); } });
        // FI-8: switch an unsent fact or equation draft between basic and cloze. Nothing is saved until Save.
        const formatControls: ButtonHandle[] = [];
        if (!editConflict && isClozeKind(card.kind)) {
          formatControls.push(button(ctx, left, s, { label: cloze ? "Switch to basic" : "Switch to cloze", disabled: saving.has(card.id), onClick: () => {
            if (saving.has(card.id)) return;
            const now = current(), target: Fields["format"] = cloze ? undefined : "cloze";
            const stashed = beforeSwitch.get(card.id);
            let next: Fields;
            if (stashed && stashed.format === target) { next = stashed; beforeSwitch.delete(card.id); }
            else {
              if (!stashed) beforeSwitch.set(card.id, now);
              next = { ...(target === "cloze" ? toCloze(now) : toBasic(now)), extra: now.extra, ...(target ? { format: target } : {}) };
            }
            edits.set(card.id, next); switches.set(card.id, (switches.get(card.id) ?? 0) + 1); feedback.show(""); render();
            article.ownerDocument.querySelector<HTMLTextAreaElement>(`[data-keep="card-${card.id}-front"]`)?.focus();
          } }));
          if (cloze) formatControls.push(button(ctx, left, s, { label: "Insert blank", disabled: saving.has(card.id), onClick: () => {
            const area = inputs.front;
            if (!area || saving.has(card.id)) return;
            area.setRangeText(BLANK, area.selectionStart ?? area.value.length, area.selectionEnd ?? area.value.length, "end");
            area.oninput?.(new Event("input"));
            area.focus();
          } }));
        }
        if (!editConflict) button(ctx, right, s, { label: "Save", variant: "default", onClick: () => run(async () => {
          // Typing during the save would be lost when the editor closes.
          saving.add(card.id);
          for (const area of Object.values(inputs)) if (area) area.readOnly = true;
          for (const control of formatControls) control.update({ disabled: true });
          try {
            const now = edits.get(card.id) ?? card, changed = !saved();
            // Basic edits send what 0.9.0 sent; a cloze card or a switch names its format.
            if (changed) await call("edit", { id: card.id, front: now.front, back: now.back, extra: now.extra, ...(now.format || card.format ? { format: now.format ?? "basic" } : {}) });
            edits.delete(card.id); beforeSwitch.delete(card.id); editing.delete(card.id);
            return card.status === "draft" || !changed ? "" : "Saved as draft. Approve again.";
          } finally {
            saving.delete(card.id);
            for (const area of Object.values(inputs)) if (area) area.readOnly = false;
            for (const control of formatControls) control.update({ disabled: false });
          }
        }) });
      } else {
        button(ctx, left, s, { label: "Edit", onClick: () => { if (packageMarkInFlight) return; editing.add(card.id); feedback.show(""); render(); article.ownerDocument.querySelector<HTMLTextAreaElement>(`[data-keep="card-${card.id}-front"]`)?.focus(); } });
        button(ctx, left, s, { label: "Drop", onClick: () => run(() => dropCard(card)) });
        footerActions = renderFooterActions(card.status);
      }
    } else if (card.status === "imported") {
      if (card.deck) left.append(el("span", card.deck, "ab-muted"));
    } else if (card.status === "sent") {
      const where = [card.existingNote ? "Found in Anki" : card.deck, card.presence === "deleted" ? "deleted in Anki" : ""].filter(Boolean).join(", ");
      if (where) left.append(el("span", where, "ab-muted"));
      if (atShown(card)) button(ctx, right, s, { label: "Show in Anki", onClick: () => run(async () => { await ctx.call("show", { ids: [card.id] }); }) });
    }
    if (!rewrite || rewriteConflict) article.append(foot);
    if (rewrite && !rewriteConflict) article.append(rewriteDecision(ctx, s, rewrite, name => run(async () => {
      await call(name, { id: card.id, requestId: rewrite.requestId });
      if (name === "acceptRegeneration") return "Replacement saved as a draft. Approve it before sending.";
      if (name === "keepOriginalCard") return "Original kept.";
    }, true)));
    else if (editable && !isEditing && card.canRegenerate) article.append(rewriteForm(ctx, s, instruction => run(async () => {
      await call("regenerateCard", { id: card.id, revision: regenerationRevision(card), instruction });
    }, true)));
    return { article, updateStatus: (status: Card["status"]) => {
      if (card.status === status) return;
      card = { ...card, status };
      article.dataset.status = status;
      badge.textContent = STATUS[status].text;
      badge.dataset.tone = STATUS[status].tone;
      if (footerActions) {
        // Retire old callbacks without remounting the row or disturbing focus elsewhere.
        if (footerActions.some(action => action.root.contains(article.ownerDocument.activeElement))) article.focus({ preventScroll: true });
        for (const action of footerActions) { action.dispose(); action.root.remove(); }
        footerActions = renderFooterActions(status);
      }
    } };
  }

  const waitingCards = () => list.querySelectorAll<HTMLElement>(":scope > article[data-card-id]");
  const waitingCard = (id: string | undefined) => [...waitingCards()].find(article => article.dataset.cardId === id);
  function preserveCardPosition(update: () => void): void {
    // LearnHarness can scroll a containing pane instead of the document. Anchor to
    // the first visible card immediately around the DOM change, not across the network wait.
    const doc = host.ownerDocument;
    let scroller = list.parentElement;
    while (scroller && !scroller.scrollTop) scroller = scroller.parentElement;
    scroller ??= doc.scrollingElement as HTMLElement | null;
    if (!scroller?.scrollTop) { update(); return; }
    const viewportTop = () => scroller === doc.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
    const top = viewportTop();
    const bottom = top + (scroller === doc.scrollingElement ? doc.documentElement.clientHeight : scroller.clientHeight);
    let id: string | undefined, offset = 0;
    for (const card of waitingCards()) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > top && rect.top < bottom) { id = card.dataset.cardId; offset = rect.top - top; break; }
    }
    update();
    const anchor = id && waitingCard(id);
    if (anchor) {
      const delta = anchor.getBoundingClientRect().top - viewportTop() - offset;
      if (delta) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "instant" });
    }
  }
  function render(after?: () => void): void {
    if (!alive()) return;
    preserveCardPosition(() => {
      // Unchanged rows keep the actual focused control (and textarea caret).
      // Only restore focus explicitly when a changed row replaced that node.
      const active = host.ownerDocument.activeElement as HTMLElement | null;
      const card = active?.closest<HTMLElement>("article[data-card-id]");
      const keepCard = card && list.contains(card) ? card.dataset.cardId : undefined;
      const area = keepCard && active?.tagName === "TEXTAREA" ? active as HTMLTextAreaElement : undefined;
      const keep = area && { key: area.dataset.keep, start: area.selectionStart, end: area.selectionEnd, dir: area.selectionDirection };
      draw(); syncReceipt?.(); syncRegenerationPoll(); after?.();
      if (keepCard && !active?.isConnected) {
        const row = waitingCard(keepCard);
        const next = keep && [...(row?.querySelectorAll<HTMLTextAreaElement>("textarea[data-keep]") ?? [])].find(a => a.dataset.keep === keep.key);
        (next || row)?.focus({ preventScroll: true });
        if (next && keep) next.setSelectionRange(keep.start, keep.end, keep.dir);
      }
    });
  }
  function reconcileWaiting(cards: Card[]): void {
    // LearnHarness adds empty portal targets synchronously and commits their
    // contents later. Keep existing rows in place rather than measuring a
    // collapsed list, or scheduling a scroll that could override the user.
    const next = cards.map(card => {
      const { status, ...rest } = card;
      const key = JSON.stringify([rest, ["draft", "approved", "failed"].includes(status) && card.noteId === undefined ? "editable" : status,
        editing.has(card.id), saving.has(card.id), switches.get(card.id) ?? 0, earlierCard(card.possibleRepeatOf),
        earlierCard(card.regeneration?.replacement?.possibleRepeatOf)]);
      return { card, key };
    });
    const keys = new Map(next.map(({ card, key }) => [card.id, key]));
    for (const [id, row] of rows) {
      if (keys.get(id) === row.key) continue;
      row.scope.dispose(); row.view.article.remove(); rows.delete(id);
    }
    if (list.firstElementChild?.tagName !== "ARTICLE") list.replaceChildren();
    let cursor = list.firstElementChild;
    for (const { card, key } of next) {
      let row = rows.get(card.id);
      if (!row) {
        const scope = new RenderScope(signal);
        row = { key, scope, view: renderCard(card, scope.signal) };
        rows.set(card.id, row);
      } else row.view.updateStatus(card.status);
      if (row.view.article !== cursor) list.insertBefore(row.view.article, cursor);
      cursor = row.view.article.nextElementSibling;
    }
  }
  async function writeAnyway(ref: EarlierRepeatSkipRef): Promise<string> {
    const p = await ctx.call<{ preflightId: string; modelName: string; estimatedCost: number | null; batches: unknown[]; skipped: { reason: string }[] }>("preflightWriteAnyway", ref);
    if (!alive()) return "";
    if (p.batches.length !== 1) throw new Error(p.skipped[0]?.reason ?? "This idea cannot fit one writer call.");
    const cost = p.estimatedCost === null ? "No cost estimate available." : `Estimated first-attempt cost: $${p.estimatedCost.toFixed(4)}.`;
    const ok = await confirmDialog(ctx, signal, { title: "Write anyway", confirm: "Write anyway",
      body: `Try writing one card for this idea using ${p.modelName}. ${cost} The model gets the idea, its writing context, and any earlier card candidates that fit. It can still flag repeats and apply the other writing rules.` });
    if (!ok || !alive()) return "";
    await call("generate", { preflightId: p.preflightId });
    return "Writing one card for this idea…";
  }
  function renderRepeatSkips(): void {
    const generations = state?.generations ?? [];
    const running = generations.some(g => g.status === "running");
    const entries = earlierRepeatSkips(generations, state?.cards ?? []).map(skip => ({ ...skip, live: earlierCard(skip.covering.id) }));
    const key = JSON.stringify([entries, running]);
    if (key === repeatSkipsKey) return;
    repeatSkipsKey = key;
    const s = repeatScope.reset();
    repeatSkips.replaceChildren(); repeatSkips.hidden = !entries.length;
    for (const { ref, name, reason, covering, live } of entries) {
      const row = el("article", undefined, "ab-card");
      const title = el("header", undefined, "ab-card-head");
      title.append(el("strong", name), pill("Not drafted", "neutral"));
      const current = live && live.front === covering.front && live.back === covering.back && live.format === covering.format;
      row.append(title, el("p", reason || "An earlier card covers this recall task."),
        repeatCardPreview(ctx, current ? live.nodeName || "Covering card" : "Earlier card at write time (since changed or unavailable)", covering, s));
      const actions = el("div", undefined, "ab-card-foot");
      button(ctx, actions, s, { label: "Write anyway", disabled: running, onClick: () => run(() => writeAnyway(ref)) });
      row.append(actions); repeatSkips.append(row);
    }
  }
  function draw(): void {
    renderBanner();
    if (!state) {
      if (list.firstElementChild) return;
      button(ctx, list, historyScope.signal, { label: "Try loading again", onClick: () => run(async () => { await call("snapshot"); void loadDecks(); }) });
      return;
    }
    // Only fill the deck the learner hasn't touched. A cleared field stays clear.
    if (!deckTouched) deck.value = state.settings.lastDeck;
    renderBar();
    syncDeck();
    renderRepeatSkips();
    const waiting = state.cards.filter(c => c.status !== "sent" && (c.status !== "imported" || editing.has(c.id)) && c.status !== "dropped");
    reconcileWaiting(waiting);
    if (!waiting.length) {
      const empty = el("div", undefined, "ab-empty-card");
      const anySent = state.cards.some(c => c.status === "sent" || c.status === "imported");
      empty.append(el("p", anySent ? "Nothing left to review." : "No cards yet.", "ab-empty-title"));
      list.append(empty);
    }
    const sent = state.cards.filter(c => c.status === "sent" || (c.status === "imported" && !editing.has(c.id)));
    const key = JSON.stringify(sent.map(c => [c, atShown(c)]));
    if (historyKey === key) return;
    historyKey = key;
    const s = historyScope.reset();
    const wasOpen = history.open;
    history.replaceChildren();
    history.hidden = !sent.length;
    const summary = el("summary", `Sent cards (${sent.length})`);
    history.append(summary);
    const fill = () => { if (history.childElementCount === 1) { const box = el("div", undefined, "ab-cards"); for (const c of [...sent].reverse()) box.append(renderCard(c, s).article); history.append(box); } };
    history.ontoggle = () => { if (history.open) fill(); };
    if (wasOpen) fill();
  }

  options.peers.add(refreshFromPeer);
  const unsubscribe = ctx.onResync(() => { void (state ? backgroundRefresh() : run(async () => { await call("snapshot"); void loadDecks(); })); });
  void run(async () => { await call("snapshot"); void loadDecks(); });
  return {
    refresh: backgroundRefresh,
    setVisible: next => {
      visible = next;
      syncRegenerationPoll();
      if (visible && lookupDeferred) void loadDecks();
    },
    showWaiting: async nodeId => {
      const focus = () => {
        const row = [...list.querySelectorAll<HTMLElement>("[data-waiting-node]")].find(r => r.dataset.waitingNode === nodeId);
        if (!row) return false;
        row.scrollIntoView?.({ block: "start", behavior: "smooth" }); row.focus();
        return true;
      };
      if (!alive() || focus()) return;
      await backgroundRefresh();
      if (alive() && !focus()) feedback.show("No cards waiting for this idea.");
    },
    dispose: () => { disposed = true; clearTimeout(regenerationTimer); options.peers.delete(refreshFromPeer); unsubscribe(); for (const row of rows.values()) row.scope.dispose(); historyScope.dispose(); barScope.dispose(); bannerScope.dispose(); sentScope.dispose(); repeatScope.dispose(); },
  };
}
