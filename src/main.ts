import type { PluginFrontendContext } from "../sdk/index.d.ts";

interface Destination { url: string; profile: string }
interface Card {
  id: string;
  nodeId: string;
  statementHash: string;
  sessionId: string;
  nodeName: string;
  sessionName: string;
  kind: string;
  front: string;
  back: string;
  extra: string;
  status: "draft" | "approved" | "sending" | "sent" | "failed" | "dropped";
  deck?: string;
  noteId?: number;
  destination?: Destination;
  lastError?: string;
  presence?: "present" | "deleted" | "unknown";
}
interface Snapshot {
  settings: { url: string; lastDeck: string; hasApiKey: boolean };
  destination: Destination | null;
  cards: Card[];
  recoveryError?: string;
}
interface Connection { profile: string | null; decks: string[] }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function field(label: string, input: HTMLElement): HTMLLabelElement {
  const wrapper = element("label");
  wrapper.append(element("span", label), input);
  return wrapper;
}
function textInput(value = ""): HTMLInputElement {
  const input = element("input");
  input.type = "text";
  input.value = value;
  return input;
}
function textArea(value = ""): HTMLTextAreaElement {
  const input = element("textarea");
  input.value = value;
  input.rows = 3;
  return input;
}

function confirmAction(ctx: PluginFrontendContext, signal: AbortSignal, title: string, message: string): Promise<boolean> {
  if (signal.aborted || ctx.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const content = element("div");
    content.className = "anki-bridge";
    content.append(element("h3", title), element("p", message));
    const cancel = element("button", "Cancel");
    const confirm = element("button", "Confirm");
    cancel.type = confirm.type = "button";
    content.append(cancel, confirm);
    let handle: ReturnType<PluginFrontendContext["ui"]["openDialog"]> | undefined;
    let finished = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      ctx.signal.removeEventListener("abort", abort);
      handle?.dispose();
      resolve(accepted);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    ctx.signal.addEventListener("abort", abort, { once: true });
    cancel.onclick = () => finish(false);
    confirm.onclick = () => finish(true);
    try {
      handle = ctx.ui.openDialog({ title, content, onClose: () => finish(false) }, { signal });
    } catch (error) {
      finish(false);
      throw error;
    }
  });
}

function mount(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, settingsOnly = false): () => void {
  const root = element("section");
  root.className = "anki-bridge";
  const feedback = element("p");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const controls = element("fieldset");
  root.append(element("h2", settingsOnly ? "Anki Bridge settings" : "Anki Bridge 0.2.0"),
    element("p", "Hand-written testing cards only. No graph access or AI generation. Use a throwaway Anki profile."), feedback, controls);
  container.append(root);
  let disposed = false;
  let busy = false;
  let state: Snapshot | undefined;
  let connection: Connection | undefined;
  let deckChoice: string | undefined;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;

  async function run(action: () => Promise<void>): Promise<void> {
    if (!alive() || busy) return;
    busy = true;
    controls.disabled = true;
    feedback.textContent = "Working...";
    try {
      await action();
      if (alive()) { render(); feedback.textContent = "Done."; }
    } catch (error) {
      if (alive()) {
        if (!state) render();
        feedback.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      busy = false;
      if (alive()) controls.disabled = false;
    }
  }
  function button(label: string, action: () => Promise<void>): HTMLButtonElement {
    const node = element("button", label);
    node.type = "button";
    node.onclick = () => { void run(action); };
    return node;
  }
  async function snapshotAction(name: string, input?: unknown): Promise<void> {
    try {
      const next = await ctx.call<Snapshot>(name, input);
      if (alive()) state = next;
    } catch (error) {
      if (name === "send" && alive()) {
        // A failed send may still have persisted per-card results.
        try { const fresh = await ctx.call<Snapshot>("snapshot"); if (alive()) { state = fresh; render(); } } catch { /* Preserve the send error. */ }
      }
      throw error;
    }
  }
  async function refresh(): Promise<void> { await snapshotAction("snapshot"); }
  async function checkConnection(): Promise<void> {
    connection = undefined;
    render();
    const next = await ctx.call<Connection>("connection");
    if (alive()) { connection = next; render(); }
  }
  function render(): void {
    if (!alive()) return;
    controls.replaceChildren();
    if (!state) {
      controls.append(button("Retry loading", refresh));
      return;
    }
    if (state.recoveryError) controls.append(element("p", `Recovery error: ${state.recoveryError}`));
    const url = textInput(state.settings.url || "http://127.0.0.1:8765");
    const key = textInput();
    key.type = "password";
    key.autocomplete = "off";
    key.placeholder = state.settings.hasApiKey ? "Saved. Leave blank to keep it." : "Optional API key";
    const clearKey = element("input");
    clearKey.type = "checkbox";
    const urlWarning = element("p");
    const warn = () => { urlWarning.textContent = /localhost/i.test(url.value) ? "Use 127.0.0.1 instead of localhost to avoid IPv6 connection failures." : "Use the AnkiConnect root URL, not an API path."; };
    url.oninput = warn;
    warn();
    controls.append(element("h3", "Connection"), field("AnkiConnect root URL", url), urlWarning,
      field("API key", key), field("Clear saved API key", clearKey),
      element("p", "The API key is stored in plain text in the plugin's data folder."),
      button("Save connection settings", async () => {
        const input: { url: string; apiKey?: string } = { url: url.value };
        if (clearKey.checked) input.apiKey = "";
        else if (key.value) input.apiKey = key.value;
        connection = undefined;
        await snapshotAction("settings", input);
      }), button("Test connection", checkConnection));
    controls.append(element("p", connection ? (connection.profile === null ? "Connected. Open a profile in Anki." : `Connected profile: ${connection.profile}`) : "Connection not tested. Test again after switching profiles in Anki."));
    if (connection) controls.append(element("p", `Decks: ${connection.decks.join(", ") || "none"}`));
    controls.append(element("p", state.destination ? `Paired destination: ${state.destination.profile} at ${state.destination.url}` : "Not paired. Test the connection, then pair before sending."));
    const pair = button(state.destination ? "Re-pair destination" : "Pair destination", async () => {
      // The user may have switched profiles since the last connection test.
      await checkConnection();
      if (!alive()) return;
      const target = connection?.profile;
      if (!target || !state) throw new Error("Test the connection with an open profile first.");
      const expectedDestination = { url: state.settings.url, profile: target };
      if (await confirmAction(ctx, signal, "Pair Anki destination", `Pair with profile ${target} at ${expectedDestination.url}? Previous sent cards keep their original destination. Use a throwaway profile for testing.`)) {
        if (alive()) await snapshotAction("pair", { confirmed: true, expectedDestination });
      }
    });
    pair.disabled = !connection?.profile;
    controls.append(pair);
    controls.append(element("h3", "Note type maintenance"),
      element("p", "Repairs apply only to the plugin-owned LearnHarness Basic note type. They do not edit note content."),
      button("Add missing fields", async () => {
        if (await confirmAction(ctx, signal, "Add missing fields", "Add missing fields to LearnHarness Basic in the paired profile? Existing templates are not changed.")) {
          if (!alive()) return;
          await ctx.call("repairFields");
          await refresh();
        }
      }), button("Update note type styling", async () => {
        if (await confirmAction(ctx, signal, "Replace styling and templates", "This replaces LearnHarness Basic styling and templates. Your Anki-side template edits will be lost. Note content and review history are not changed.")) {
          if (!alive()) return;
          await ctx.call("updateStyling", { confirmed: true });
          await refresh();
        }
      }));
    if (settingsOnly) return;

    controls.append(element("h3", "Hand-written draft"));
    const front = textArea(), back = textArea(), extra = textArea();
    const kind = element("select");
    for (const name of ["recall", "why", "compose", "discriminate"]) {
      const option = element("option", name); option.value = name; kind.append(option);
    }
    controls.append(field("Front", front), field("Back", back), field("Extra, optional", extra), field("Kind", kind),
      button("Create draft", async () => {
        await snapshotAction("draft", { front: front.value, back: back.value, extra: extra.value, kind: kind.value });
      }));
    controls.append(element("h3", "Delivery"));
    const deck = textInput(deckChoice ?? state.settings.lastDeck);
    const decks = element("datalist");
    decks.id = "anki-bridge-decks";
    for (const name of connection?.decks ?? []) { const option = element("option"); option.value = name; decks.append(option); }
    deck.setAttribute("list", decks.id);
    deck.oninput = () => { deckChoice = deck.value; };
    controls.append(field("Destination deck, existing or new", deck), decks,
      button("Refresh cards", refresh), button("Reconcile uncertain sends", () => snapshotAction("reconcile")),
      button("Check presence in Anki", () => snapshotAction("presence")),
      element("p", "Approve each card explicitly, then send it. Sent or uncertain cards cannot be resent. Deleted notes stay deleted."));
    for (const card of state.cards) {
      const row = element("article");
      row.append(element("h4", `${card.kind} · ${card.status}`));
      if (card.nodeName || card.sessionName) row.append(element("p", `${card.nodeName} / ${card.sessionName}`));
      if (card.lastError) row.append(element("p", `Error: ${card.lastError}`));
      if (card.destination) row.append(element("p", `Sent destination: ${card.destination.profile} at ${card.destination.url}`));
      if (card.deck) row.append(element("p", `Deck: ${card.deck}`));
      if (card.presence) row.append(element("p", `Anki presence: ${card.presence}`));
      if (card.noteId !== undefined) row.append(element("p", `Anki note ID: ${card.noteId}`));
      const editable = ["draft", "approved", "failed"].includes(card.status) && card.noteId === undefined;
      const cardFront = textArea(card.front), cardBack = textArea(card.back), cardExtra = textArea(card.extra);
      cardFront.readOnly = cardBack.readOnly = cardExtra.readOnly = !editable;
      row.append(field("Front", cardFront), field("Back", cardBack), field("Extra", cardExtra));
      if (editable) {
        row.append(button("Save edits", () => snapshotAction("edit", { id: card.id, front: cardFront.value, back: cardBack.value, extra: cardExtra.value })));
        // Never approve or send different content from the visible editor.
        const requireSaved = () => {
          if (cardFront.value !== card.front || cardBack.value !== card.back || cardExtra.value !== card.extra) throw new Error("Save edits before approving or sending this card.");
        };
        if (card.status === "draft") row.append(button("Approve card", async () => { requireSaved(); await snapshotAction("approve", { ids: [card.id] }); }));
        if (card.status === "approved" || card.status === "failed") row.append(button(card.status === "failed" ? "Retry approved card" : "Send approved card", async () => {
          requireSaved();
          if (!deck.value.trim()) throw new Error("Choose a destination deck first.");
          await snapshotAction("send", { ids: [card.id], deck: deck.value.trim() });
        }));
      }
      if (card.status === "sent") row.append(button("Show in Anki", async () => { await ctx.call("show", { ids: [card.id] }); }));
      controls.append(row);
    }
  }
  const unsubscribe = ctx.onResync(() => { void run(refresh); });
  void run(refresh);
  return () => { disposed = true; unsubscribe(); root.remove(); };
}

export function activate(ctx: PluginFrontendContext): void {
  ctx.cleanup(ctx.registerView({ id: "bridge", name: "Anki Bridge", mount: (container, signal) => mount(ctx, container, signal) }));
  ctx.cleanup(ctx.registerAction({ id: "open-bridge", name: "Anki Bridge", run: () => ctx.app.openView("bridge") }));
  ctx.cleanup(ctx.placeAction({ id: "bridge-sidebar", actionId: "open-bridge", location: "sidebar" }));
  ctx.cleanup(ctx.registerSettings((container, signal) => mount(ctx, container, signal, true)));
}
