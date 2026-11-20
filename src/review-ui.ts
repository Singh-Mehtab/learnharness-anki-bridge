// Step 3: check each card, approve it and send approved cards to a deck, or download them as an .apkg file.
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { PackageResult } from "./anki/apkg.ts";
import { expandTagTemplate, matchTagCase, systemTags, tagSuggestions, validateTags } from "./anki/tags.ts";
import { isWaitingCard } from "./coverage/flow.ts";
import { KIND_NAMES } from "./drafting-ui.ts";
import { CORE_KINDS, isStoredKind } from "./writer/types.ts";
import type { Connection, Destination, Peers, Settings } from "./settings-ui.ts";
import { base64Bytes, button, confirmDialog, el, field, input, moreMenu, pill, plural, RenderScope, saveFile, status, textarea } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";

interface Card {
  id: string; nodeId: string; statementHash: string; sessionId: string; nodeName: string; sessionName: string;
  kind: string; front: string; back: string; extra: string;
  status: "draft" | "approved" | "sending" | "sent" | "failed" | "dropped";
  deck?: string; noteId?: number; destination?: Destination; lastError?: string;
  presence?: "present" | "deleted" | "unknown";
  sourceStatement?: string; sourceChanged?: boolean; sourceMissing?: boolean; sourceUnavailable?: boolean;
}
export interface Snapshot { settings: Settings; destination: Destination | null; cards: Card[]; recoveryError?: string }
type Fields = { front: string; back: string; extra: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;

const STATUS: Record<Card["status"], { text: string; tone: "neutral" | "good" | "warn" | "bad" | "info" }> = {
  draft: { text: "Draft", tone: "neutral" }, approved: { text: "Approved", tone: "good" }, sending: { text: "Unconfirmed", tone: "warn" },
  sent: { text: "In Anki", tone: "good" }, failed: { text: "Send failed", tone: "bad" }, dropped: { text: "Dropped", tone: "neutral" },
};

export interface ReviewHandle { refresh(): Promise<void>; showWaiting(nodeId: string): Promise<void>; dispose(): void }

export function mountReview(ctx: PluginFrontendContext, host: HTMLElement, signal: AbortSignal, options: {
  peers: Peers; onChanged: () => Promise<void>; headerAside: HTMLElement;
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
  sendBar.append(deckField, decks, tagField, tagOptions, sendActions);
  const feedback = status();
  /** A clear confirmation after a send, kept until the next action or dismissed (#32). */
  const sentPanel = el("div", undefined, "ab-sent");
  sentPanel.setAttribute("role", "status"); sentPanel.hidden = true;
  const list = el("div", undefined, "ab-cards");
  const history = el("details", undefined, "ab-history");
  host.append(banner, sendBar, feedback, sentPanel, list, history);

  const menuSlot = options.headerAside;
  let state: Snapshot | undefined, connection: Connection | undefined, connectionError = "";
  let disposed = false, busy = false, refreshPending = false, actions = 0;
  let deckTouched = false, tagsTouched = false;
  const edits = new Map<string, Fields>();
  const editing = new Set<string>();
  /** Cards whose save is in flight. Their editors stay read-only across re-renders. */
  const saving = new Set<string>();
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const scope = new RenderScope(signal), barScope = new RenderScope(signal), bannerScope = new RenderScope(signal);
  let approveAll: ButtonHandle | undefined, sendAll: ButtonHandle | undefined, downloadAll: ButtonHandle | undefined;
  const sentScope = new RenderScope(signal);
  function hideSent(): void { sentScope.reset(); sentPanel.replaceChildren(); sentPanel.hidden = true; delete sentPanel.dataset.kind; }
  function showSent(ids: string[], deckSent: string, tagsSent: string[]): void {
    const s = sentScope.reset();
    const icon = el("span", undefined, "ab-sent-icon"); icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    const text = el("div", undefined, "ab-sent-text");
    text.append(el("p", `${plural(ids.length, "card")} sent to Anki`, "ab-sent-title"), el("p", `Deck ${deckSent}`, "ab-sent-detail"));
    // Show every tag the send added, including the automatic ones (delivery.ts adds them per card).
    const auto = state?.settings.systemTags === false ? [] : ids.flatMap(id => { const c = state?.cards.find(card => card.id === id); return c ? systemTags(c.kind) : []; });
    const allTags = [...new Set([...tagsSent, ...auto])];
    if (allTags.length) text.append(el("p", `Tags ${allTags.join(" ")}`, "ab-sent-detail"));
    const actionsBox = el("div", undefined, "ab-actions");
    if (state?.destination) button(ctx, actionsBox, s, { label: "Show in Anki", onClick: async () => {
      // Not run(): that would clear this confirmation.
      try { await ctx.call("show", { ids }); } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    } });
    button(ctx, actionsBox, s, { label: "Dismiss", variant: "ghost", onClick: hideSent });
    revealPanel(icon, text, actionsBox);
  }
  function revealPanel(...children: HTMLElement[]): void {
    sentPanel.replaceChildren(...children);
    sentPanel.hidden = false;
    // Restart the entrance animation for a second send in a row.
    sentPanel.classList.remove("ab-sent-enter"); void sentPanel.offsetWidth; sentPanel.classList.add("ab-sent-enter");
    sentPanel.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }
  /** After a download. The cards are still approved, not in Anki, so this says so plainly. */
  function showDownloaded(result: PackageResult, bytes: Uint8Array<ArrayBuffer>): void {
    const s = sentScope.reset();
    sentPanel.dataset.kind = "download";
    const icon = el("span", undefined, "ab-sent-icon"); icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>';
    const text = el("div", undefined, "ab-sent-text");
    text.append(el("p", `Download of ${plural(result.ids.length, "card")} requested as ${result.fileName}`, "ab-sent-title"), el("p", `Deck ${result.deck}`, "ab-sent-detail"));
    if (result.tags.length) text.append(el("p", `Tags ${result.tags.join(" ")}`, "ab-sent-detail"));
    text.append(
      el("p", "Not sent. These cards stay approved and don't count as in Anki. Open the file with Anki, or use File > Import, to add them.", "ab-sent-detail"),
      el("p", "Importing can add duplicates of cards already in Anki, or update notes from an earlier package. Anki decides how to match notes; Anki Bridge can't check what it will do.", "ab-sent-detail ab-warning"));
    const actionsBox = el("div", undefined, "ab-actions");
    // The same file again, byte for byte, without asking the backend.
    button(ctx, actionsBox, s, { label: "Download again", onClick: () => saveFile(result.fileName, bytes) });
    button(ctx, actionsBox, s, { label: "Dismiss", variant: "ghost", onClick: hideSent });
    revealPanel(icon, text, actionsBox);
  }

  async function run(action: () => Promise<string | void>): Promise<void> {
    if (!alive() || busy) return;
    busy = true; actions++; syncBar();
    hideSent();
    feedback.show("Working…");
    try { const done = await action(); if (alive()) { render(); feedback.show(done ?? "", "success"); } }
    catch (error) { if (alive()) { render(); feedback.show(message(error), "error"); } }
    finally { busy = false; if (alive()) syncBar(); if (refreshPending && alive()) void backgroundRefresh(); }
  }
  async function call(name: string, input?: unknown): Promise<void> {
    try {
      const next = await ctx.call<Snapshot>(name, input);
      if (name === "pair" || name === "settings") for (const peer of options.peers) if (peer !== refreshFromPeer) peer();
      if (alive()) { state = next; await options.onChanged(); }
    } catch (error) {
      if (name === "send" && alive()) {
        // A failed send may still have saved per-card results.
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
      if (alive()) feedback.show(`Couldn't refresh the cards: ${message(error)}`, "error");
    }
  }
  function refreshFromPeer(): void { void backgroundRefresh(); }
  const destinationKey = (d: Destination | null | undefined) => d ? `${d.url}\n${d.profile}` : "";
  /** Decks are looked up only while the saved address is the paired one, as the backend requires for sending. */
  const lookupKey = () => state?.destination && state.settings.url === state.destination.url ? destinationKey(state.destination) : "";
  let decksFor = "", lookups = 0;
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

  const approvedCards = () => (state?.cards ?? []).filter(c => (c.status === "approved" || c.status === "failed") && c.noteId === undefined);
  const draftCards = () => (state?.cards ?? []).filter(c => c.status === "draft");
  const deckName = () => deck.value.trim();
  function tagList(): string[] { return tags.value.split(/\s+/u).filter(Boolean); }
  function syncDeck(): void {
    const name = deckName();
    if (!name) deckHint.textContent = "Type a deck name, or pick one of your decks.";
    else if (state?.destination && !lookupKey()) deckHint.textContent = "Choose the profile again in settings to check this deck name at the new address.";
    else if (!connection) deckHint.textContent = connectionError ? "Open Anki to check this deck name." : "";
    else if (!knownDecks()) deckHint.textContent = `Open the ${state?.destination?.profile ?? "chosen"} profile in Anki to check this deck name.`;
    else if (knownDecks()!.includes(name)) deckHint.textContent = "Existing deck.";
    else {
      const close = knownDecks()!.find(d => d.toLocaleLowerCase() === name.toLocaleLowerCase());
      deckHint.textContent = close ? `New deck. Did you mean ${close}?` : "New deck. Anki Bridge creates it when you send.";
    }
    // A template that uses {deck} waits for a deck name rather than inventing one.
    const waitsForDeck = !name && !!state?.settings.tagTemplate.includes("{deck}");
    if (!tagsTouched && state) tags.value = waitsForDeck ? "" : expandTagTemplate(state.settings.tagTemplate, name).map(t => matchTagCase(t, knownTags())).join(" ");
    syncTagSuggestions();
    let tagProblem = "";
    try { validateTags(tagList()); } catch (error) { tagProblem = message(error); }
    const extra = state?.settings.systemTags ? " The learnharness tags are added too." : "";
    const suggested = knownTags().length ? " Your Anki tags are suggested as you type." : "";
    tagHint.textContent = tagProblem || (tagList().length ? `Separate tags with spaces.${suggested}${extra}` : waitsForDeck && !tagsTouched ? `Tags fill in from your template once you choose a deck.${extra}` : `No tags yet. Set a default in settings.${suggested}${extra}`);
    tagHint.dataset.tone = tagProblem ? "error" : "";
    syncBar();
  }
  deck.oninput = () => { deckTouched = true; syncDeck(); };
  tags.oninput = () => { tagsTouched = true; syncDeck(); };

  function sendBlocker(): string | undefined {
    if (!state?.destination) return "Choose an Anki profile in settings first.";
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
    const approved = approvedCards().length, drafts = draftCards().length;
    approveAll?.update({ label: drafts ? `Approve all drafts (${drafts})` : "Approve all drafts", disabled: busy || !drafts });
    const blocked = sendBlocker();
    sendAll?.update({ label: approved ? `Send ${plural(approved, "card")} to Anki` : "Send to Anki", disabled: busy || !approved, title: blocked ?? "" });
    downloadAll?.update({ disabled: busy || !approved, title: downloadBlocker() ?? "Save the approved cards as an Anki package file. Works with Anki closed. Nothing is sent." });
  }
  async function download(ids: string[]): Promise<string> {
    const blocked = downloadBlocker();
    if (blocked) throw new Error(blocked);
    const result = await ctx.call<PackageResult>("exportPackage", { ids, deck: deckName(), tags: validateTags(tagList()) });
    if (!alive()) return "";
    const bytes = base64Bytes(result.data);
    saveFile(result.fileName, bytes);
    showDownloaded(result, bytes);
    return "";
  }
  async function send(ids: string[]): Promise<string> {
    const blocked = sendBlocker();
    if (blocked) throw new Error(blocked);
    const name = deckName(), sentTags = tags.value, sentTagList = validateTags(tagList());
    // The send uses these values, so they can't change underneath it.
    deck.readOnly = true; tags.readOnly = true;
    try { await call("send", { ids, deck: name, tags: sentTagList, expectedDestination: state?.destination }); }
    finally { deck.readOnly = false; tags.readOnly = false; }
    if (deckName() === name) deckTouched = false;
    const sent = ids.filter(id => state?.cards.find(c => c.id === id)?.status === "sent").length;
    // Tags typed for this send apply to this send only.
    if (sent === ids.length && tags.value === sentTags) tagsTouched = false;
    void loadDecks();
    if (sent === ids.length) { showSent(ids, name, sentTagList); return ""; }
    return `Sent ${sent} of ${plural(ids.length, "card")}. Check the cards marked Send failed.`;
  }

  function renderBar(): void {
    const s = barScope.reset();
    sendActions.replaceChildren();
    approveAll = button(ctx, sendActions, s, { label: "Approve all drafts", onClick: () => run(async () => {
      const drafts = draftCards();
      if ([...editing].some(id => drafts.some(c => c.id === id))) throw new Error("Save or cancel your edits before approving.");
      const ok = await confirmDialog(ctx, signal, { title: "Approve all drafts", confirm: "Approve",
        body: `Approve ${plural(drafts.length, "draft")}? Check each answer is correct first. Approving does not send anything.` });
      if (!ok || !alive()) return;
      await call("approve", { ids: drafts.map(c => c.id) });
      return `Approved ${plural(drafts.length, "card")}.`;
    }) });
    downloadAll = button(ctx, sendActions, s, { label: "Download .apkg", onClick: () => run(() => download(approvedCards().map(c => c.id))) });
    sendAll = button(ctx, sendActions, s, { label: "Send to Anki", variant: "default", onClick: () => run(() => send(approvedCards().map(c => c.id))) });
    menuSlot.replaceChildren();
    moreMenu(ctx, menuSlot, s, "More", () => {
      const sent = (state?.cards ?? []).filter(c => c.status === "sent" && atShown(c));
      const drafts = (state?.cards ?? []).filter(c => ["draft", "approved", "failed"].includes(c.status) && c.noteId === undefined);
      return [
        { key: "write", label: "Write a card by hand", onSelect: () => openManual() },
        { key: "refresh", label: "Refresh cards", onSelect: () => run(async () => { await call("snapshot"); void loadDecks(); }) },
        { key: "reconcile", label: "Check unconfirmed sends", disabled: !(state?.cards ?? []).some(c => c.status === "sending"), onSelect: () => run(async () => { await call("reconcile"); return "Checked unconfirmed sends."; }) },
        { key: "presence", label: "Check which sent cards are still in Anki", disabled: !sent.length, onSelect: () => run(async () => { await call("presence"); return "Checked sent cards."; }) },
        { key: "show", label: "Show sent cards in Anki", disabled: !sent.length, onSelect: () => run(async () => { await ctx.call("show", { ids: sent.map(c => c.id) }); }) },
        { key: "drop", label: `Drop all unsent cards (${drafts.length})`, disabled: !drafts.length, onSelect: () => run(async () => {
          const ok = await confirmDialog(ctx, signal, { title: "Drop all unsent cards", confirm: "Drop cards", destructive: true,
            body: `Drop ${plural(drafts.length, "card")} that you have not sent? Their ideas become available to write again. Sent cards are not affected.` });
          if (!ok || !alive()) return;
          await call("drop", { ids: drafts.map(c => c.id) });
          for (const c of drafts) { edits.delete(c.id); editing.delete(c.id); }
          return `Dropped ${plural(drafts.length, "card")}.`;
        }) },
      ];
    });
    syncBar();
  }

  const atShown = (card: Card) => !!state?.destination && card.destination?.url === state.destination.url && card.destination.profile === state.destination.profile;

  function openManual(): void {
    const dialogScope = new AbortController();
    const content = el("div", undefined, "anki-bridge ab-dialog ab-manual");
    const front = textarea("", 3), back = textarea("", 3), extra = textarea("", 2);
    const kind = el("select", undefined, "ab-input ab-select");
    for (const k of CORE_KINDS) { const o = el("option", KIND_NAMES[k]); o.value = k; kind.append(o); }
    const err = status();
    const actionsRow = el("div", undefined, "ab-actions ab-dialog-actions");
    content.append(el("h3", "Write a card", "ab-dialog-heading"), field("Front", front), field("Back", back), field("Extra, optional", extra, "One line with the reason or a hint."), field("Card type", kind), err, actionsRow);
    let handle: ReturnType<PluginFrontendContext["ui"]["openDialog"]> | undefined;
    const close = () => { dialogScope.abort(); handle?.dispose(); };
    button(ctx, actionsRow, dialogScope.signal, { label: "Cancel", variant: "ghost", onClick: close });
    button(ctx, actionsRow, dialogScope.signal, { label: "Add card", variant: "default", onClick: async () => {
      if (busy) { err.show("Wait for the current action to finish, then add the card.", "error"); return; }
      // Counted like other actions, so an older background read can't hide the new card.
      busy = true; actions++; syncBar();
      hideSent();
      try {
        await call("draft", { front: front.value, back: back.value, extra: extra.value, kind: kind.value });
        close(); render(); feedback.show("Card added for review.", "success");
      } catch (error) { err.show(message(error), "error"); }
      finally { busy = false; if (alive()) syncBar(); if (refreshPending && alive()) void backgroundRefresh(); }
    } });
    handle = ctx.ui.openDialog({ title: "Write a card", content, onClose: close }, { signal: dialogScope.signal });
  }

  function renderBanner(): void {
    const bs = bannerScope.reset();
    banner.replaceChildren();
    if (!state) return;
    const note = (text: string, tone: "warn" | "bad" = "warn", action?: { label: string; run: () => void }) => {
      const box = el("div", undefined, "ab-banner"); box.dataset.tone = tone;
      box.append(el("span", text));
      if (action) button(ctx, box, bs, { label: action.label, size: "xs", onClick: action.run });
      banner.append(box);
    };
    if (state.recoveryError) note(`An earlier send needs checking: ${state.recoveryError}`, "bad");
    if (!state.destination) note("Choose an Anki profile in settings before sending. Download .apkg works without one.", "warn", { label: "Open settings", run: () => ctx.app.openSettings() });
    else if (state.destination.url !== state.settings.url) note("The Anki address changed since you chose a profile. Choose the profile again in settings.", "warn", { label: "Open settings", run: () => ctx.app.openSettings() });
    else if (connectionError) note("Anki isn't reachable. Open Anki to send cards and see your decks.", "warn", { label: "Try again", run: () => { void loadDecks(); } });
    else if (connection && connection.profile !== state.destination.profile) note(`Anki has profile ${connection.profile ?? "none"} open. Cards go to ${state.destination.profile}, so open that profile to send.`, "warn");
  }

  function renderCard(card: Card, parent: HTMLElement, s: AbortSignal): void {
    const article = el("article", undefined, "ab-card");
    article.dataset.status = card.status;
    if (card.nodeId && isWaitingCard(card)) { article.dataset.waitingNode = card.nodeId; article.tabIndex = -1; }
    const editable = ["draft", "approved", "failed"].includes(card.status) && card.noteId === undefined;
    if (!editable) { edits.delete(card.id); editing.delete(card.id); }
    const isEditing = editable && editing.has(card.id);
    const values: Fields = (isEditing && edits.get(card.id)) || card;

    const head = el("header", undefined, "ab-card-head");
    const title = el("div", undefined, "ab-card-title");
    title.append(pill(isStoredKind(card.kind) ? KIND_NAMES[card.kind] : card.kind, "info"), el("span", card.nodeName || "Card", "ab-card-idea"));
    if (card.sessionName && card.sessionName !== "Manual") title.append(el("span", card.sessionName, "ab-muted ab-card-session"));
    head.append(title, pill(STATUS[card.status].text, STATUS[card.status].tone));
    article.append(head);

    const notices: string[] = [];
    if (card.lastError) notices.push(card.lastError);
    if (card.sourceMissing) notices.push("The idea this card came from is no longer in the graph. Check the card before approving.");
    else if (card.sourceChanged) notices.push("The idea has changed since this card was written. Compare the card with the current idea in step 1.");
    else if (card.sourceUnavailable) notices.push("Couldn't check whether the idea has changed. Refresh the cards to try again.");
    if (card.status === "sending") notices.push("Anki Bridge isn't sure this card reached Anki. Use Check unconfirmed sends in the menu.");
    for (const text of notices) article.append(el("p", text, card.lastError === text || card.status === "sending" ? "ab-card-error" : "ab-card-warning"));

    const grid = el("div", undefined, "ab-card-fields");
    const inputs: Partial<Record<keyof Fields, HTMLTextAreaElement>> = {};
    const length = el("p", undefined, "ab-muted ab-card-length");
    const handles: Array<ReturnType<PluginFrontendContext["ui"]["mountMarkdown"]>> = [];
    const showLength = () => {
      const f = words(inputs.front?.value ?? values.front), b = words(inputs.back?.value ?? values.back);
      length.textContent = f > 30 || b > 15 ? `Long card: ${f} words on the front and ${b} on the back. Aim for about 30 and 15.` : "";
    };
    for (const key of ["front", "back", "extra"] as const) {
      if (key === "extra" && !isEditing && !values.extra.trim()) continue;
      const col = el("section", undefined, "ab-card-field");
      col.append(el("h4", key === "front" ? "Front" : key === "back" ? "Back" : "Extra", "ab-field-name"));
      const preview = el("div", undefined, "ab-markdown");
      if (isEditing) {
        const lines = values[key].split("\n").length + Math.ceil(values[key].length / 60);
        const area = textarea(values[key], Math.min(12, Math.max(key === "extra" ? 2 : 3, lines)));
        area.setAttribute("aria-label", `${key[0].toUpperCase()}${key.slice(1)}`);
        area.dataset.keep = `card-${card.id}-${key}`;
        area.readOnly = saving.has(card.id);
        inputs[key] = area;
        area.oninput = () => {
          edits.set(card.id, { front: inputs.front!.value, back: inputs.back!.value, extra: inputs.extra!.value });
          handles[["front", "back", "extra"].indexOf(key)]?.update({ text: area.value });
          showLength();
        };
        col.append(area);
        preview.classList.add("ab-markdown-preview");
      }
      col.append(preview);
      handles[["front", "back", "extra"].indexOf(key)] = ctx.ui.mountMarkdown(preview, { text: values[key] || " " }, { signal: s });
      grid.append(col);
    }
    article.append(grid);
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
      return !now || (now.front === card.front && now.back === card.back && now.extra === card.extra);
    };
    if (editable) {
      if (isEditing) {
        button(ctx, left, s, { label: "Cancel", disabled: saving.has(card.id), onClick: () => { edits.delete(card.id); editing.delete(card.id); feedback.show(""); render(); } });
        button(ctx, right, s, { label: "Save", variant: "default", onClick: () => run(async () => {
          // Typing during the save would be lost when the editor closes.
          saving.add(card.id);
          for (const area of Object.values(inputs)) if (area) area.readOnly = true;
          try {
            const now = edits.get(card.id) ?? card, changed = !saved();
            if (changed) await call("edit", { id: card.id, front: now.front, back: now.back, extra: now.extra });
            edits.delete(card.id); editing.delete(card.id);
            return card.status === "draft" || !changed ? "" : "Saved. Edited cards go back to draft, so approve it again.";
          } finally { saving.delete(card.id); }
        }) });
      } else {
        button(ctx, left, s, { label: "Edit", onClick: () => { editing.add(card.id); feedback.show(""); render(); article.ownerDocument.querySelector<HTMLTextAreaElement>(`[data-keep="card-${card.id}-front"]`)?.focus(); } });
        button(ctx, left, s, { label: "Drop", onClick: () => run(async () => { await call("drop", { ids: [card.id] }); edits.delete(card.id); return "Card dropped."; }) });
        if (card.status === "draft") button(ctx, right, s, { label: "Approve", onClick: () => run(async () => { await call("approve", { ids: [card.id] }); }) });
        if (card.status === "approved" || card.status === "failed") button(ctx, right, s, { label: card.status === "failed" ? "Retry send" : "Send this card", onClick: () => run(() => send([card.id])) });
      }
    } else if (card.status === "sent") {
      const where = [card.deck, card.presence === "deleted" ? "deleted in Anki" : ""].filter(Boolean).join(", ");
      if (where) left.append(el("span", where, "ab-muted"));
      if (atShown(card)) button(ctx, right, s, { label: "Show in Anki", onClick: () => run(async () => { await ctx.call("show", { ids: [card.id] }); }) });
    }
    article.append(foot);
    parent.append(article);
  }

  function render(): void {
    if (!alive()) return;
    // Keep the caret in a card editor across background refreshes.
    const active = host.ownerDocument.activeElement as HTMLTextAreaElement | null;
    const keep = active?.tagName === "TEXTAREA" && list.contains(active) ? { key: active.dataset.keep, start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection } : undefined;
    const s = scope.reset();
    list.replaceChildren();
    try { draw(s); }
    finally {
      if (keep?.key) {
        const area = [...list.querySelectorAll<HTMLTextAreaElement>("textarea[data-keep]")].find(a => a.dataset.keep === keep.key);
        if (area) { area.focus(); area.setSelectionRange?.(keep.start, keep.end, keep.dir ?? undefined); }
      }
    }
  }
  function draw(s: AbortSignal): void {
    renderBanner();
    if (!state) {
      button(ctx, list, s, { label: "Try loading again", onClick: () => run(async () => { await call("snapshot"); void loadDecks(); }) });
      return;
    }
    // Only fill the deck the learner hasn't touched. A cleared field stays clear.
    if (!deckTouched) deck.value = state.settings.lastDeck;
    renderBar();
    syncDeck();
    const waiting = state.cards.filter(c => c.status !== "sent" && c.status !== "dropped");
    if (!waiting.length) {
      const empty = el("div", undefined, "ab-empty-card");
      const anySent = state.cards.some(c => c.status === "sent");
      empty.append(el("p", anySent ? "Nothing left to review." : "No cards to review.", "ab-empty-title"),
        el("p", anySent ? "Your sent cards are listed below. Write more in step 2, or write one by hand from the menu." : "Cards you write in step 2 appear here. You can also write one by hand from the menu.", "ab-muted"));
      list.append(empty);
    }
    // Saved order, so a card stays in place when it is approved.
    for (const card of waiting) renderCard(card, list, s);
    const sent = state.cards.filter(c => c.status === "sent");
    const wasOpen = history.open;
    history.replaceChildren();
    history.hidden = !sent.length;
    const summary = el("summary", `Sent cards (${sent.length})`);
    history.append(summary);
    const fill = () => { if (history.childElementCount === 1) { const box = el("div", undefined, "ab-cards"); for (const c of [...sent].reverse()) renderCard(c, box, s); history.append(box); } };
    history.ontoggle = () => { if (history.open) fill(); };
    if (wasOpen) fill();
  }

  options.peers.add(refreshFromPeer);
  const unsubscribe = ctx.onResync(() => { void (state ? backgroundRefresh() : run(async () => { await call("snapshot"); void loadDecks(); })); });
  void run(async () => { await call("snapshot"); void loadDecks(); });
  return {
    refresh: backgroundRefresh,
    showWaiting: async nodeId => {
      const focus = () => {
        const row = [...list.querySelectorAll<HTMLElement>("[data-waiting-node]")].find(r => r.dataset.waitingNode === nodeId);
        if (!row) return false;
        row.scrollIntoView?.({ block: "start", behavior: "smooth" }); row.focus();
        return true;
      };
      if (!alive() || focus()) return;
      await backgroundRefresh();
      if (alive() && !focus()) feedback.show("No cards for this idea are waiting for review.");
    },
    dispose: () => { disposed = true; options.peers.delete(refreshFromPeer); unsubscribe(); scope.dispose(); barScope.dispose(); bannerScope.dispose(); sentScope.dispose(); },
  };
}
