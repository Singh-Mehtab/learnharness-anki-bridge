// Settings page: connection, destination profile, tags and note type upkeep.
// Card review lives on the main page; nothing here sends cards.
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { button, confirmDialog, el, field, input, plural, RenderScope, status } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";

export interface Destination { url: string; profile: string }
export interface Settings { url: string; lastDeck: string; hasApiKey: boolean; tagTemplate: string; systemTags: boolean }
export interface Connection { profile: string | null; decks: string[]; tags?: string[] }
/** Live mounts of this activation. A change in one refreshes the others. */
export type Peers = Set<() => void>;

export function endpoint(value: string | undefined): string | undefined {
  try { return value === undefined ? undefined : new URL(value.trim()).href; }
  catch { return value?.trim(); }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Plain wording for the connection test, including Anki being closed. */
export function connectionText(url: string, result: Connection | Error): { text: string; tone: "error" | "success" } {
  if (result instanceof Error) {
    const detail = result.message;
    const closed = /refused|ECONNREFUSED|timed out|fetch failed|network|reach|could not complete the AnkiConnect request/i.test(detail);
    return { tone: "error", text: closed
      ? `Couldn't reach Anki at ${url}. Open Anki, check that AnkiConnect is installed, then test again.`
      : `Connection failed: ${detail}` };
  }
  if (result.profile === null) return { tone: "error", text: "Anki is open but no profile is loaded. Open a profile in Anki, then test again." };
  return { tone: "success", text: `Connected. Profile ${result.profile} is open with ${plural(result.decks.length, "deck")}.` };
}

interface SettingsSnapshot { settings: Settings; destination: Destination | null }

export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, peers: Peers): () => void {
  const root = el("div", undefined, "anki-bridge ab-settings");
  container.append(root);
  let state: SettingsSnapshot | undefined;
  let disposed = false, busy = false, tagsQueued = false;
  const keyScope = new RenderScope(signal);
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;

  // Connection
  const connection = el("section", undefined, "ab-panel");
  const url = input("", "url");
  url.spellcheck = false;
  const key = input("", "password");
  key.autocomplete = "off";
  const keySaved = el("div", undefined, "ab-inline");
  const urlHint = el("span", undefined, "ab-muted");
  const urlField = field("AnkiConnect address", url); urlField.append(urlHint);
  const keyField = field("API key", key, "Only needed if you set apiKey in AnkiConnect's config. It is stored in plain text in this plugin's data folder.");
  const connectionActions = el("div", undefined, "ab-actions");
  const connectionStatus = status();
  connection.append(el("h3", "Connect to Anki", "ab-panel-title"),
    el("p", "Anki Bridge sends cards through the AnkiConnect add-on. Keep Anki open while you send.", "ab-muted ab-panel-intro"),
    urlField, keyField, keySaved, connectionActions, connectionStatus);

  // Destination profile
  const destination = el("section", undefined, "ab-panel");
  const destinationText = el("p", undefined, "ab-destination");
  const destinationActions = el("div", undefined, "ab-actions");
  const destinationStatus = status();
  destination.append(el("h3", "Anki profile", "ab-panel-title"), destinationText, destinationActions, destinationStatus);

  // Tags
  const tags = el("section", undefined, "ab-panel");
  const template = input("");
  template.spellcheck = false;
  template.placeholder = "YEAR_3::Nuclear_Physics::Lecture_01";
  const systemTags = el("input"); systemTags.type = "checkbox";
  const systemLabel = el("label", undefined, "ab-check");
  systemLabel.append(systemTags, el("span", "Also add learnharness and card-type tags"));
  const tagStatus = status();
  tags.append(el("h3", "Tags", "ab-panel-title"),
    field("Tags for new cards", template, "Separate tags with spaces. {deck} becomes the deck name with spaces replaced by underscores. You can still change the tags before each send."),
    systemLabel, tagStatus);

  // Note type upkeep
  const noteType = el("section", undefined, "ab-panel ab-panel-quiet");
  const noteActions = el("div", undefined, "ab-actions");
  const noteStatus = status();
  noteType.append(el("h3", "Note type", "ab-panel-title"),
    el("p", "Cards use the LearnHarness Basic note type, which Anki Bridge creates on the first send. Use these only if Anki Bridge reports a problem with it. Neither changes your cards or review history.", "ab-muted ab-panel-intro"),
    noteActions, noteStatus);

  root.append(connection, destination, tags, noteType);

  let saveButton: ButtonHandle, testButton: ButtonHandle, pairButton: ButtonHandle, removeKey: ButtonHandle | undefined;
  let savedUrl = "";
  const dirty = () => endpoint(url.value) !== endpoint(savedUrl) || key.value !== "";
  function syncButtons(): void {
    saveButton?.update({ disabled: busy || !dirty() });
    testButton?.update({ disabled: busy });
    pairButton?.update({ disabled: busy });
    removeKey?.update({ disabled: busy });
  }
  let keyCleared = false;
  function urlAdvice(): void {
    const changed = state?.settings.hasApiKey && endpoint(url.value) !== endpoint(savedUrl);
    urlHint.textContent = (/localhost/i.test(url.value) ? "Use 127.0.0.1 instead of localhost, which can fail over IPv6." : "Usually http://127.0.0.1:8765. Use the root address, not an API path.")
      + (changed ? " Saving a different address removes the saved API key." : "")
      + (keyCleared ? " The key you typed was cleared because the address changed. Type it again for this address." : "");
  }
  let lastEndpoint = "";
  url.oninput = () => {
    // A typed key belongs to the address beside it.
    if (endpoint(url.value) !== lastEndpoint) { keyCleared ||= !!key.value; key.value = ""; lastEndpoint = endpoint(url.value) ?? ""; }
    urlAdvice(); syncButtons();
  };
  key.oninput = () => { if (keyCleared) { keyCleared = false; urlAdvice(); } syncButtons(); };

  async function act(target: ReturnType<typeof status>, action: () => Promise<string | void>, working = "Working…"): Promise<void> {
    if (!alive() || busy) return;
    busy = true; syncButtons(); target.show(working);
    try { const done = await action(); if (alive()) target.show(done ?? "", "success"); }
    catch (error) { if (alive()) target.show(message(error), "error"); }
    finally {
      busy = false;
      if (alive()) syncButtons();
      // A tag change made during another save is saved now, with the latest values.
      if (tagsQueued && alive()) { tagsQueued = false; void saveTags(); }
    }
  }
  async function apply(name: string, value?: unknown): Promise<void> {
    const next = await ctx.call<SettingsSnapshot>(name, value);
    for (const peer of peers) if (peer !== refreshFromPeer) peer();
    if (alive()) render(next);
  }
  async function test(): Promise<Connection | Error> {
    try { return await ctx.call<Connection>("connection"); }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }

  saveButton = button(ctx, connectionActions, signal, { label: "Save", variant: "default", disabled: true, onClick: () => act(connectionStatus, async () => {
    const value: { url: string; apiKey?: string } = { url: url.value };
    if (key.value) value.apiKey = key.value;
    // The save sends these values, so they can't change underneath it.
    url.readOnly = true; key.readOnly = true;
    try { await apply("settings", value); }
    finally { url.readOnly = false; key.readOnly = false; }
    key.value = ""; keyCleared = false; urlAdvice();
    return "Saved. Test the connection to check it.";
  }, "Saving…") });
  testButton = button(ctx, connectionActions, signal, { label: "Test connection", onClick: () => {
    if (dirty()) { connectionStatus.show("Save the new address or key first, then test.", "error"); return; }
    return act(connectionStatus, async () => {
      const result = await test();
      const shown = connectionText(savedUrl, result);
      if (result instanceof Error || shown.tone === "error") throw new Error(shown.text);
      return shown.text;
    }, "Testing…");
  } });
  pairButton = button(ctx, destinationActions, signal, { label: "Use the open profile", onClick: () => act(destinationStatus, async () => {
    const result = await test();
    if (result instanceof Error || result.profile === null) throw new Error(connectionText(savedUrl, result).text);
    const profile = result.profile;
    const expectedDestination = { url: savedUrl, profile };
    const current = state?.destination;
    if (current?.profile === profile && current.url === savedUrl) return `Already sending to profile ${profile}.`;
    const ok = await confirmDialog(ctx, signal, { title: "Send cards to this profile?", confirm: "Use this profile",
      body: `New cards will go to the Anki profile ${profile} at ${savedUrl}. Cards you already sent stay where they are.` });
    if (!ok || !alive()) return "";
    await apply("pair", { confirmed: true, expectedDestination });
    return `New cards will go to profile ${profile}.`;
  }, "Checking Anki…") });

  const shown = () => state?.destination ?? undefined;
  button(ctx, noteActions, signal, { label: "Add missing fields", onClick: () => act(noteStatus, async () => {
    const target = shown();
    const ok = await confirmDialog(ctx, signal, { title: "Add missing fields", confirm: "Add fields",
      body: `Add any missing fields to LearnHarness Basic in ${target ? `profile ${target.profile}` : "the paired profile"}. Templates and cards are not changed.` });
    if (!ok || !alive()) return "";
    await ctx.call("repairFields", { expectedDestination: target });
    return "Fields checked and added where missing.";
  }) });
  button(ctx, noteActions, signal, { label: "Reset styling and templates", onClick: () => act(noteStatus, async () => {
    const target = shown();
    const ok = await confirmDialog(ctx, signal, { title: "Reset styling and templates", confirm: "Reset", destructive: true,
      body: `Replace the LearnHarness Basic styling and templates in ${target ? `profile ${target.profile}` : "the paired profile"}. Any edits you made to them in Anki will be lost. Card content and review history stay the same.` });
    if (!ok || !alive()) return "";
    await ctx.call("updateStyling", { confirmed: true, expectedDestination: target });
    return "Styling and templates reset.";
  }) });

  const saveTags = (): Promise<void> => {
    if (busy) { tagsQueued = true; return Promise.resolve(); }
    return act(tagStatus, async () => {
    if (!state) return;
    if (template.value === state.settings.tagTemplate && systemTags.checked === state.settings.systemTags) return "";
    await apply("settings", { tagTemplate: template.value, systemTags: systemTags.checked });
    return "Tags saved.";
  }, "Saving…");
  };
  template.onchange = () => { void saveTags(); };
  systemTags.onchange = () => { void saveTags(); };

  function render(next: SettingsSnapshot): void {
    const urlTouched = state !== undefined && endpoint(url.value) !== endpoint(state.settings.url);
    state = next;
    savedUrl = next.settings.url;
    if (!urlTouched) {
      const before = endpoint(url.value);
      url.value = next.settings.url || "http://127.0.0.1:8765";
      // A typed key belongs to the address it was typed beside, so drop it if a refresh changes that address.
      if (endpoint(url.value) !== before) key.value = "";
      lastEndpoint = endpoint(url.value) ?? "";
    }
    key.placeholder = next.settings.hasApiKey ? "Saved key. Type a new one to replace it." : "None";
    const ks = keyScope.reset();
    keySaved.replaceChildren();
    removeKey = undefined;
    if (next.settings.hasApiKey) {
      keySaved.append(el("span", "An API key is saved for this address.", "ab-muted"));
      removeKey = button(ctx, keySaved, ks, { label: "Remove saved key", onClick: () => act(connectionStatus, async () => {
        await apply("settings", { url: savedUrl, apiKey: "" });
        return "Saved key removed.";
      }) });
    }
    // Leave unsaved tag edits alone; a queued save will send them.
    if (!tagsQueued) {
      if (document.activeElement !== template) template.value = next.settings.tagTemplate;
      systemTags.checked = next.settings.systemTags;
    }
    const d = next.destination;
    destinationText.replaceChildren();
    if (d) {
      destinationText.append("New cards go to profile ", el("strong", d.profile), ` at ${d.url}`);
      if (endpoint(d.url) !== endpoint(next.settings.url)) destinationText.append(el("span", " The saved address has changed since you chose this profile. Choose the profile again before sending.", "ab-warning"));
    } else {
      destinationText.append("No profile chosen yet. Open the profile you want in Anki, then choose it here. Use a throwaway profile while you try Anki Bridge.");
    }
    pairButton.update({ label: d ? "Switch to the open profile" : "Use the open profile" });
    urlAdvice(); syncButtons();
  }
  async function load(): Promise<void> {
    try { const next = await ctx.call<SettingsSnapshot>("snapshot"); if (alive()) render(next); }
    catch (error) { if (alive()) connectionStatus.show(`Couldn't load settings: ${message(error)}`, "error"); }
  }
  function refreshFromPeer(): void { if (!busy) void load(); }
  peers.add(refreshFromPeer);
  const unsubscribe = ctx.onResync(() => { void load(); });
  void load();
  return () => { disposed = true; peers.delete(refreshFromPeer); unsubscribe(); keyScope.dispose(); root.remove(); };
}
