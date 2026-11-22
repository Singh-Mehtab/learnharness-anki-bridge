// Settings page: connection, destination profile, tags, extra card types, cloze cards and note type upkeep.
// Card review lives on the main page; nothing here sends cards.
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { exampleCard, KIND_HELP, KIND_NAMES } from "./kinds-ui.ts";
import { button, confirmDialog, el, field, input, plural, RenderScope, status } from "./ui.ts";
import { SETTINGS_KINDS } from "./writer/types.ts";
import type { CoreCardKind } from "./writer/types.ts";
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
      ? `Couldn't reach Anki at ${url}. Open Anki and check AnkiConnect is installed.`
      : `Connection failed: ${detail}` };
  }
  if (result.profile === null) return { tone: "error", text: "No profile loaded. Open a profile in Anki." };
  return { tone: "success", text: `Connected. Profile ${result.profile}, ${plural(result.decks.length, "deck")}.` };
}

interface SettingsSnapshot { settings: Settings; destination: Destination | null; generationSettings?: { enabledKinds: CoreCardKind[]; cloze?: ClozeSetting } }
type ClozeSetting = "off" | "auto" | "prefer";
/** FI-8: the three stops of the Cloze cards slider. A missing setting means auto. */
export const CLOZE_STOPS: { value: ClozeSetting; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Every card is a question and answer." },
  { value: "auto", label: "Writer chooses", help: "Cloze where the notation already says what is asked, such as [ħ] = [...]." },
  { value: "prefer", label: "Prefer cloze", help: "Cloze for every fact and equation card that can be one." },
];

export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, peers: Peers): () => void {
  const root = el("div", undefined, "anki-bridge ab-settings");
  container.append(root);
  let state: SettingsSnapshot | undefined;
  let disposed = false, busy = false, tagsQueued = false, loads = 0;
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
  const keyField = field("API key", key, "Only needed if AnkiConnect has an apiKey. Stored in plain text in this plugin's data folder.");
  const connectionActions = el("div", undefined, "ab-actions");
  const connectionStatus = status();
  connection.append(el("h3", "Connect to Anki", "ab-panel-title"),
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
    field("Tags for new cards", template, "Separate with spaces. {deck} becomes the deck name, with underscores for spaces."),
    systemLabel, tagStatus);

  // Card types that stay off the Write step (#38)
  const kinds = el("section", undefined, "ab-panel");
  const kindStatus = status();
  const kindBoxes = new Map<CoreCardKind, HTMLInputElement>();
  kinds.append(el("h3", "More card types", "ab-panel-title"),
    el("p", "Extra card types the writer may use.", "ab-muted ab-panel-intro"));
  for (const kind of SETTINGS_KINDS) {
    const box = el("input"); box.type = "checkbox";
    const label = el("label", undefined, "ab-check");
    label.append(box, el("span", `${KIND_NAMES[kind]}: ${KIND_HELP[kind].charAt(0).toLowerCase()}${KIND_HELP[kind].slice(1)}`));
    kindBoxes.set(kind, box);
    box.onchange = () => {
      const wanted = box.checked;
      if (busy) { syncKinds(); kindStatus.show("Wait for the current action to finish.", "error"); return; }
      void act(kindStatus, async () => {
        // Send only this change; the backend applies it to the saved types, so it can't undo one made on the Write step.
        await apply("generationSettings", { toggleKind: { kind, enabled: wanted } });
        return `${KIND_NAMES[kind]} ${wanted ? "on" : "off"}.`;
      }, "Saving…").then(() => { if (alive()) syncKinds(); });
    };
    kinds.append(label, exampleCard(kind));
  }
  kinds.append(kindStatus);

  // Cloze cards (FI-8)
  const cloze = el("section", undefined, "ab-panel");
  const clozeRange = el("input", undefined, "ab-range");
  clozeRange.type = "range"; clozeRange.min = "0"; clozeRange.max = "2"; clozeRange.step = "1";
  clozeRange.setAttribute("aria-label", "Cloze cards");
  const clozeStops = el("div", undefined, "ab-range-stops");
  clozeStops.setAttribute("aria-hidden", "true");
  for (const stop of CLOZE_STOPS) clozeStops.append(el("span", stop.label));
  const clozeHelp = el("p", undefined, "ab-muted");
  const clozeStatus = status();
  cloze.append(el("h3", "Cloze cards", "ab-panel-title"),
    el("p", "A cloze card hides one part of a statement, such as the units in [ħ] = [...]. Only fact and equation cards can be cloze.", "ab-muted ab-panel-intro"),
    clozeRange, clozeStops, clozeHelp, clozeStatus);
  const clozeIndex = () => Math.max(0, CLOZE_STOPS.findIndex(s => s.value === (state?.generationSettings?.cloze ?? "auto")));
  function showClozeStop(index: number): void {
    const stop = CLOZE_STOPS[index]!;
    clozeRange.value = String(index);
    clozeRange.setAttribute("aria-valuetext", stop.label);
    clozeHelp.textContent = stop.help;
    clozeStops.querySelectorAll("span").forEach((span, i) => { span.dataset.selected = String(i === index); });
  }
  function syncCloze(): void {
    cloze.hidden = !state?.generationSettings;
    if (state?.generationSettings) showClozeStop(clozeIndex());
  }
  clozeRange.oninput = () => showClozeStop(Number(clozeRange.value));
  clozeRange.onchange = () => {
    const stop = CLOZE_STOPS[Number(clozeRange.value)]!;
    if (busy) { syncCloze(); clozeStatus.show("Wait for the current action to finish.", "error"); return; }
    if (stop.value === (state?.generationSettings?.cloze ?? "auto")) return;
    void act(clozeStatus, async () => {
      await apply("generationSettings", { cloze: stop.value });
      return `Cloze cards: ${stop.label}.`;
    }, "Saving…").then(() => { if (alive()) syncCloze(); });
  };

  // Note type upkeep
  const noteType = el("section", undefined, "ab-panel ab-panel-quiet");
  const noteActions = el("div", undefined, "ab-actions");
  const noteStatus = status();
  const noteChoice = el("select", undefined, "ab-input ab-select");
  noteChoice.setAttribute("aria-label", "Note type to repair");
  for (const [value, label] of [["basic", "LearnHarness Basic"], ["cloze", "LearnHarness Cloze"]]) { const o = el("option", label); o.value = value!; noteChoice.append(o); }
  const chosenNoteType = () => noteChoice.value === "cloze" ? "LearnHarness Cloze" : "LearnHarness Basic";
  noteType.append(el("h3", "Note type", "ab-panel-title"),
    el("p", "Use only if Anki Bridge reports a problem with the LearnHarness Basic or LearnHarness Cloze note type.", "ab-muted ab-panel-intro"),
    field("Note type", noteChoice), noteActions, noteStatus);

  root.append(connection, destination, tags, kinds, cloze, noteType);

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
    urlHint.textContent = (/localhost/i.test(url.value) ? "Use 127.0.0.1, not localhost." : "Usually http://127.0.0.1:8765. No API path.")
      + (changed ? " Saving a new address removes the saved key." : "")
      + (keyCleared ? " Key cleared because the address changed. Type it again." : "");
  }
  /** Checkboxes follow the saved types. At least one type stays on across Write and Settings. */
  function syncKinds(): void {
    const enabled = state?.generationSettings?.enabledKinds;
    kinds.hidden = !enabled;
    for (const [kind, box] of kindBoxes) {
      box.checked = !!enabled?.includes(kind);
      box.disabled = box.checked && enabled?.length === 1;
    }
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
      else if (reloadQueued && alive()) { reloadQueued = false; void load(); }
    }
  }
  async function apply(name: string, value?: unknown): Promise<void> {
    loads++; // A read started before this mutation must not overwrite its result.
    let next: SettingsSnapshot;
    try { next = await ctx.call<SettingsSnapshot>(name, value); }
    catch (error) { reloadQueued = true; throw error; }
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
    return "Saved.";
  }, "Saving…") });
  testButton = button(ctx, connectionActions, signal, { label: "Test connection", onClick: () => {
    if (dirty()) { connectionStatus.show("Save your changes first.", "error"); return; }
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
      body: `Send new cards to profile ${profile} at ${savedUrl}?` });
    if (!ok || !alive()) return "";
    await apply("pair", { confirmed: true, expectedDestination });
    return `Sending to profile ${profile}.`;
  }, "Checking Anki…") });

  const shown = () => state?.destination ?? undefined;
  button(ctx, noteActions, signal, { label: "Add missing fields", onClick: () => act(noteStatus, async () => {
    const target = shown(), noteType = noteChoice.value, name = chosenNoteType();
    const ok = await confirmDialog(ctx, signal, { title: "Add missing fields", confirm: "Add fields",
      body: `Add missing fields to ${name} in ${target ? `profile ${target.profile}` : "the paired profile"}.` });
    if (!ok || !alive()) return "";
    await ctx.call("repairFields", { noteType, expectedDestination: target });
    return "Fields checked.";
  }) });
  button(ctx, noteActions, signal, { label: "Reset styling and templates", onClick: () => act(noteStatus, async () => {
    const target = shown(), noteType = noteChoice.value, name = chosenNoteType();
    const ok = await confirmDialog(ctx, signal, { title: "Reset styling and templates", confirm: "Reset", destructive: true,
      body: `Replace ${name} styling and templates in ${target ? `profile ${target.profile}` : "the paired profile"}. Your edits to them in Anki are lost.` });
    if (!ok || !alive()) return "";
    await ctx.call("updateStyling", { noteType, confirmed: true, expectedDestination: target });
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
    key.placeholder = next.settings.hasApiKey ? "Saved. Type to replace." : "None";
    const ks = keyScope.reset();
    keySaved.replaceChildren();
    removeKey = undefined;
    if (next.settings.hasApiKey) {
      keySaved.append(el("span", "Key saved for this address.", "ab-muted"));
      removeKey = button(ctx, keySaved, ks, { label: "Remove saved key", onClick: () => act(connectionStatus, async () => {
        await apply("settings", { url: savedUrl, apiKey: "" });
        return "Key removed.";
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
      if (endpoint(d.url) !== endpoint(next.settings.url)) destinationText.append(el("span", " Address changed. Choose the profile again.", "ab-warning"));
    } else {
      destinationText.append("No profile chosen. Open one in Anki, then choose it here.");
    }
    pairButton.update({ label: d ? "Switch to the open profile" : "Use the open profile" });
    syncKinds(); syncCloze(); urlAdvice(); syncButtons();
  }
  async function load(): Promise<void> {
    const sequence = ++loads;
    try {
      const next = await ctx.call<SettingsSnapshot>("snapshot");
      if (alive() && sequence === loads) render(next);
    } catch (error) {
      if (alive() && sequence === loads) connectionStatus.show(`Couldn't load settings: ${message(error)}`, "error");
    }
  }
  let reloadQueued = false;
  // A change made elsewhere during a save here is loaded once that save ends.
  function refreshFromPeer(): void { if (busy) reloadQueued = true; else void load(); }
  peers.add(refreshFromPeer);
  const unsubscribe = ctx.onResync(refreshFromPeer);
  void load();
  return () => { disposed = true; peers.delete(refreshFromPeer); unsubscribe(); keyScope.dispose(); root.remove(); };
}
