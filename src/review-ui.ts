// Step 3: check each card, approve it and send approved cards to a deck.
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { expandTagTemplate, validateTags } from "./anki/tags.ts";
import { isWaitingCard } from "./coverage/flow.ts";
import { KIND_NAMES } from "./drafting-ui.ts";
import type { Connection, Destination, Peers, Settings } from "./settings-ui.ts";
import { button, confirmDialog, el, field, input, moreMenu, pill, plural, RenderScope, status, textarea } from "./ui.ts";
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
  const tags = input(""); tags.spellcheck = false; tags.placeholder = "No tags";
  const tagHint = el("span", undefined, "ab-muted");
  const deckField = field("Deck", deck); deckField.append(deckHint);
  const tagField = field("Tags", tags); tagField.append(tagHint);
  const sendActions = el("div", undefined, "ab-actions ab-send-actions");
  sendBar.append(deckField, decks, tagField, sendActions);
  const feedback = status();
  const list = el("div", undefined, "ab-cards");
  const history = el("details", undefined, "ab-history");
  host.append(banner, sendBar, feedback, list, history);

  const menuSlot = options.headerAside;
  let state: Snapshot | undefined, connection: Connection | undefined, connectionError = "";
  let disposed = false, busy = false, refreshPending = false, actions = 0;
  let deckTouched = false, tagsTouched = false;
  const edits = new Map<string, Fields>();
  const editing = new Set<string>();
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const scope = new RenderScope(signal), barScope = new RenderScope(signal);
  let approveAll: ButtonHandle | undefined, sendAll: ButtonHandle | undefined;

  async function run(action: () => Promise<string | void>): Promise<void> {
    if (!alive() || busy) return;
    busy = true; actions++; syncBar();
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
  let reading: Promise<Snapshot | "busy"> | undefined;
  async function fetchSnapshot(): Promise<Snapshot | "busy"> {
    for (;;) {
      const started = actions;
      const fresh = await ctx.call<Snapshot>("snapshot");
      if (busy) { refreshPending = true; return "busy"; }
      if (started === actions) return fresh;
    }
  }
  function readSnapshot(): Promise<Snapshot | "busy"> {
    reading ??= fetchSnapshot().finally(() => { reading = undefined; });
    return reading;
  }
  async function backgroundRefresh(): Promise<void> {
    if (!alive()) return;
    if (busy) { refreshPending = true; return; }
    refreshPending = false;
    try {
      const fresh = await readSnapshot();
      if (!alive() || fresh === "busy") return;
      state = fresh; render();
    } catch (error) {
      refreshPending = true;
      if (alive()) feedback.show(`Couldn't refresh the cards: ${message(error)}`, "error");
    }
  }
  function refreshFromPeer(): void { void backgroundRefresh(); void loadDecks(); }
  async function loadDecks(): Promise<void> {
    if (!state?.destination) return;
    try { connection = await ctx.call<Connection>("connection"); connectionError = ""; }
    catch (error) { connection = undefined; connectionError = message(error); }
    if (!alive()) return;
    decks.replaceChildren(...(connection?.decks ?? []).map(name => { const o = el("option"); o.value = name; return o; }));
    syncDeck(); renderBanner();
  }

  const approvedCards = () => (state?.cards ?? []).filter(c => (c.status === "approved" || c.status === "failed") && c.noteId === undefined);
  const draftCards = () => (state?.cards ?? []).filter(c => c.status === "draft");
  const deckName = () => deck.value.trim();
  function tagList(): string[] { return tags.value.split(/\s+/u).filter(Boolean); }
  function syncDeck(): void {
    const name = deckName();
    if (!name) deckHint.textContent = "Type a deck name, or pick one of your decks.";
    else if (!connection) deckHint.textContent = connectionError ? "Open Anki to check this deck name." : "";
    else if (connection.decks.includes(name)) deckHint.textContent = "Existing deck.";
    else {
      const close = connection.decks.find(d => d.toLocaleLowerCase() === name.toLocaleLowerCase());
      deckHint.textContent = close ? `New deck. Did you mean ${close}?` : "New deck. Anki Bridge creates it when you send.";
    }
    if (!tagsTouched && state) tags.value = expandTagTemplate(state.settings.tagTemplate, name || "Deck").join(" ");
    let tagProblem = "";
    try { validateTags(tagList()); } catch (error) { tagProblem = message(error); }
    const extra = state?.settings.systemTags ? " The learnharness tags are added too." : "";
    tagHint.textContent = tagProblem || (tagList().length ? `Separate tags with spaces.${extra}` : `No tags yet. Set a default in settings.${extra}`);
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
  function syncBar(): void {
    const approved = approvedCards().length, drafts = draftCards().length;
    approveAll?.update({ label: drafts ? `Approve all drafts (${drafts})` : "Approve all drafts", disabled: busy || !drafts });
    const blocked = sendBlocker();
    sendAll?.update({ label: approved ? `Send ${plural(approved, "card")} to Anki` : "Send to Anki", disabled: busy || !approved, title: blocked ?? "" });
  }
  async function send(ids: string[]): Promise<string> {
    const blocked = sendBlocker();
    if (blocked) throw new Error(blocked);
    const name = deckName();
    await call("send", { ids, deck: name, tags: validateTags(tagList()), expectedDestination: state?.destination });
    deckTouched = false;
    const sent = ids.filter(id => state?.cards.find(c => c.id === id)?.status === "sent").length;
    void loadDecks();
    return sent === ids.length ? `Sent ${plural(sent, "card")} to ${name}.` : `Sent ${sent} of ${plural(ids.length, "card")}. Check the cards marked Send failed.`;
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
    for (const k of ["recall", "why", "compose", "discriminate"]) { const o = el("option", KIND_NAMES[k]); o.value = k; kind.append(o); }
    const err = status();
    const actionsRow = el("div", undefined, "ab-actions ab-dialog-actions");
    content.append(el("h3", "Write a card", "ab-dialog-heading"), field("Front", front), field("Back", back), field("Extra, optional", extra, "One line with the reason or a hint."), field("Card type", kind), err, actionsRow);
    let handle: ReturnType<PluginFrontendContext["ui"]["openDialog"]> | undefined;
    const close = () => { dialogScope.abort(); handle?.dispose(); };
    button(ctx, actionsRow, dialogScope.signal, { label: "Cancel", variant: "ghost", onClick: close });
    button(ctx, actionsRow, dialogScope.signal, { label: "Add card", variant: "default", onClick: async () => {
      try {
        await call("draft", { front: front.value, back: back.value, extra: extra.value, kind: kind.value });
        close(); render(); feedback.show("Card added for review.", "success");
      } catch (error) { err.show(message(error), "error"); }
    } });
    handle = ctx.ui.openDialog({ title: "Write a card", content, onClose: close }, { signal: dialogScope.signal });
  }

  function renderBanner(): void {
    banner.replaceChildren();
    if (!state) return;
    const note = (text: string, tone: "warn" | "bad" = "warn", action?: { label: string; run: () => void }) => {
      const box = el("div", undefined, "ab-banner"); box.dataset.tone = tone;
      box.append(el("span", text));
      if (action) button(ctx, box, scope.signal, { label: action.label, size: "xs", onClick: action.run });
      banner.append(box);
    };
    if (state.recoveryError) note(`An earlier send needs checking: ${state.recoveryError}`, "bad");
    if (!state.destination) note("Choose an Anki profile in settings before sending.", "warn", { label: "Open settings", run: () => ctx.app.openSettings() });
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
    title.append(pill(KIND_NAMES[card.kind] ?? card.kind, "info"), el("span", card.nodeName || "Card", "ab-card-idea"));
    if (card.sessionName && card.sessionName !== "Manual") title.append(el("span", card.sessionName, "ab-muted ab-card-session"));
    head.append(title, pill(STATUS[card.status].text, STATUS[card.status].tone));
    article.append(head);

    const notices: string[] = [];
    if (card.lastError) notices.push(card.lastError);
    if (card.sourceMissing) notices.push("The idea this card came from is no longer in the graph. Check the card before approving.");
    else if (card.sourceChanged) notices.push("The idea has changed since this card was written. Check it against the source below.");
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
      source.append(el("summary", "Source idea"), el("p", card.sourceStatement));
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
        button(ctx, left, s, { label: "Cancel", onClick: () => { edits.delete(card.id); editing.delete(card.id); render(); } });
        button(ctx, right, s, { label: "Save", variant: "default", onClick: () => run(async () => {
          const now = edits.get(card.id) ?? card;
          if (!saved()) await call("edit", { id: card.id, front: now.front, back: now.back, extra: now.extra });
          edits.delete(card.id); editing.delete(card.id);
          return card.status === "draft" ? "" : "Saved. Edited cards go back to draft, so approve it again.";
        }) });
      } else {
        button(ctx, left, s, { label: "Edit", onClick: () => { editing.add(card.id); render(); article.ownerDocument.querySelector<HTMLTextAreaElement>(`[data-keep="card-${card.id}-front"]`)?.focus(); } });
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
    const s = scope.reset();
    list.replaceChildren();
    renderBanner();
    if (!state) {
      button(ctx, list, s, { label: "Try loading again", onClick: () => run(async () => { await call("snapshot"); }) });
      return;
    }
    if (!deckTouched || !deck.value) deck.value = state.settings.lastDeck;
    renderBar();
    syncDeck();
    const waiting = state.cards.filter(c => c.status !== "sent" && c.status !== "dropped");
    if (!waiting.length) {
      const empty = el("div", undefined, "ab-empty-card");
      empty.append(el("p", "No cards to review.", "ab-empty-title"), el("p", "Cards you write in step 2 appear here. You can also write one by hand from the menu.", "ab-muted"));
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
  const unsubscribe = ctx.onResync(() => { void (state ? backgroundRefresh() : run(async () => { await call("snapshot"); })); });
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
    dispose: () => { disposed = true; options.peers.delete(refreshFromPeer); unsubscribe(); scope.dispose(); barScope.dispose(); },
  };
}
