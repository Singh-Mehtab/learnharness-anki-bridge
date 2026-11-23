import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { HTMLInputElement as HappyInput } from "happy-dom";
import { mountDrafting, readableError } from "../src/drafting-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { chooseMenu, fakeUi } from "./fake-ui.ts";

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const preflight = { preflightId: "p1", nodeIds: ["n_a"], nodeCount: 1, maximumCards: 2, inputTokens: 900, outputTokens: 1200, estimatedCost: null,
  model: { provider: "scratch", id: "writer" }, settings: {}, batches: [{ nodeIds: ["n_a"], inputTokens: 900, outputAllowance: 1200 }], skipped: [] };
const coverage = () => ({ state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true,
  dismissed: false, generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 });

function setup(options: { catalogUnavailable?: boolean; initialGraphFailure?: boolean; model?: boolean; estimate?: Omit<typeof preflight, "skipped"> & { skipped: Array<{ nodeId: string; reason: string }>; skippedFlagRequests?: Array<{ count: number; reason: string }> } } = {}) {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController();
  const calls: Array<{ name: string; input: any }> = [];
  const graph: any = { nodes: [{ id: "n_a", name: "Alpha", statement: "Alpha holds under A.", statementHash: "a".repeat(64),
    cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: coverage() }], missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
  const session: any = { session: { id: "s1", title: "Session one", exists: true },
    flags: [{ id: "f1", note: "", nodeIds: ["n_s"], pendingNodeIds: ["n_s"] }], cardsPerNode: 2, paired: false,
    nodes: [{ id: "n_s", name: "Session idea", statement: "Only in the session.", statementHash: "s".repeat(64), cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: coverage(), flagged: true, flagNotes: [] }] };
  const state: any = { generationSettings: { cardsPerNode: 2, enabledKinds: ["fact", "equation"], model: options.model ? { provider: "scratch", id: "writer" } : null }, generations: [] };
  let model: ((v: { provider: string; id: string }) => void | Promise<void>) | undefined;
  let modelValue: { provider: string; id: string } | undefined;
  const peers = new Set<() => void>();
  let failNextCoverage = options.initialGraphFailure;
  let recovery: (() => unknown) | undefined;
  let settingsGate: Promise<void> | undefined;
  let mutationGate: Promise<void> | undefined, hold: Promise<void> | undefined, graphHold: Promise<void> | undefined;
  let refreshed = 0, modelMounts = 0, knowledgeMounts = 0;
  const ctx = {
    signal: controller.signal, onResync: () => () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "coverageContext") { if (failNextCoverage) { failNextCoverage = false; throw new Error("Initial graph read failed"); } const result = structuredClone(graph); await graphHold; return result; }
      if (name === "sessionFlow") return structuredClone(session);
      if (name === "generationContext") throw new Error("Catalog unavailable");
      if (name === "writerModelLevels") return input.id === "writer" ? ["low", "high"] : [];
      if (name === "dismissNode" || name === "restoreNode") {
        await mutationGate;
        const node = graph.nodes.find((n: any) => n.id === input.nodeId);
        const dismissed = name === "dismissNode";
        Object.assign(node.coverage, { dismissed, selectable: !dismissed, uncarded: !dismissed, canDismiss: !dismissed,
          state: dismissed ? "dismissed" : "no-cards", base: dismissed ? "dismissed" : "no-cards" });
        return structuredClone(graph);
      }
      if (name === "generationSettings") await settingsGate;
      if (name === "generationSettings") {
        // Like the backend: a toggle applies to the saved types at the moment it arrives.
        const { toggleKind, ...rest } = input;
        if (toggleKind && state.failToggle) throw new Error("Anki Bridge is busy. Wait for the current operation to finish.");
        Object.assign(state.generationSettings, rest);
        if (toggleKind) state.generationSettings.enabledKinds = ["fact", "equation", "why", "steps", "apply", "discriminate"].filter(k => k === toggleKind.kind ? toggleKind.enabled : state.generationSettings.enabledKinds.includes(k));
      }
      if (name === "retryGeneration" && recovery) return recovery();
      if (name === "preflight" || name === "retryGeneration") { await hold; return { ...structuredClone(options.estimate ?? preflight), settings: structuredClone(state.generationSettings), followsCheapSlot: !state.generationSettings.model }; }
      if (name === "generate") state.generations.push({ id: "p1", status: "running", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r1", status: "running", input: {}, outputAllowance: 1200, sources: [{ nodeId: "n_a", name: "Alpha" }] }] });
      if (name === "cancelGeneration") { state.generations[0].status = "cancelled"; state.generations[0].tasks[0].status = "cancelled"; }
      if (name === "abandonGenerationResult") {
        const generation = state.generations.find((g: any) => g.id === input.id);
        generation.status = "failed";
        Object.assign(generation.tasks[0], { status: "failed", resultPending: undefined, error: "The unavailable result was abandoned." });
        graph.nodes[0].coverage = coverage();
      }
      if (name === "dismissGeneration") state.generations.find((g: any) => g.id === input.id).hidden = true;
      return structuredClone(state);
    },
    ui: fakeUi({
      mountKnowledgePicker: () => { knowledgeMounts++; throw new Error("Native knowledge picker must not be mounted"); },
      mountModelPicker: (_: HTMLElement, props: { onChange: typeof model; value: typeof modelValue }) => {
        if (options.catalogUnavailable) throw new Error("Catalog unavailable");
        modelMounts++; model = props.onChange; modelValue = props.value; return { update: () => {}, dispose: () => {} };
      },
    }),
  } as unknown as PluginFrontendContext;
  const ideas = window.document.createElement("div"), write = window.document.createElement("div");
  window.document.body.append(ideas, write);
  const panel = mountDrafting(ctx, ideas as unknown as HTMLElement, write as unknown as HTMLElement, controller.signal, async () => { refreshed++; }, undefined, peers);
  const doc = window.document;
  const text = () => `${ideas.textContent} ${write.textContent}`;
  const buttons = () => [...doc.querySelectorAll("button")];
  const button = (label: string | RegExp) => {
    const found = buttons().find(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
    assert.ok(found, `button ${label}`); return found;
  };
  const has = (label: string | RegExp) => buttons().some(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""));
  const event = (type: string) => new window.Event(type) as unknown as Event;
  const box = () => ideas.querySelector("li input[type=checkbox]") as unknown as HTMLInputElement;
  return { doc, ideas, write, text, calls, state, graph, session, button, has, box, event, panel,
    select: (on: boolean) => { const b = box(); b.checked = on; b.dispatchEvent(event("change")); },
    pickModel: (v: { provider: string; id: string }) => model!(v), modelValue: () => modelValue, peers,
    dialog: () => doc.querySelector(".ab-dialog"),
    holdGraphReload: () => {
      let resolve!: () => void, reject!: (error: Error) => void;
      graphHold = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      return { allowFollowingReads: () => { graphHold = undefined; }, resolve: () => { graphHold = undefined; resolve(); }, reject: () => { graphHold = undefined; reject(new Error("Graph reload failed")); } };
    },
    holdMutation: () => {
      let resolve!: () => void, reject!: (e: Error) => void;
      mutationGate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      return { resolve: () => { mutationGate = undefined; resolve(); }, reject: () => { mutationGate = undefined; reject(new Error("Graph read failed")); } };
    },
    holdSettings: () => { let release!: () => void; settingsGate = new Promise(r => { release = r; }); return () => { settingsGate = undefined; release(); }; },
    holdEstimates: () => { let release!: () => void; hold = new Promise(r => { release = r; }); return () => { hold = undefined; release(); }; },
    onRetry: (handler: () => unknown) => { recovery = handler; },
    refreshed: () => refreshed, modelMounts: () => modelMounts, knowledgeMounts: () => knowledgeMounts,
    menu: async (label: string) => { (ideas.querySelector("button.ab-icon-button") as unknown as HTMLButtonElement).click(); await chooseMenu(label); },
    close: async () => { panel.dispose(); controller.abort(); await window.happyDOM.close(); } };
}

test("Write offers only levels supported by the pinned model and clears the override with the model", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined);
    const selector = () => [...f.write.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.startsWith("Reasoning level"));
    assert.equal(selector(), undefined);
    await f.pickModel({ provider: "scratch", id: "writer" });
    assert.deepEqual([...selector()!.options].map(option => option.value), ["", "low", "high"]);
    selector()!.value = "high"; selector()!.dispatchEvent(f.event("change") as never); await tick();
    assert.deepEqual(f.state.generationSettings.model, { provider: "scratch", id: "writer", thinkingLevel: "high" });
    assert.equal(selector()!.value, "high");
    await f.pickModel({ provider: "scratch", id: "new-model" });
    assert.deepEqual(f.state.generationSettings.model, { provider: "scratch", id: "new-model" });
    assert.equal(selector(), undefined);
    [...f.write.querySelectorAll("button")].find(button => button.textContent === "Clear")!.click(); await tick();
    assert.equal(f.state.generationSettings.model, null);
  } finally { await f.close(); }
});

test("a queued reasoning change does not restore a model that was cleared first", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    const selector = () => [...f.write.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.startsWith("Reasoning level"));
    const level = selector()!;
    const release = f.holdSettings();
    [...f.write.querySelectorAll("button")].find(button => button.textContent === "Clear")!.click();
    level.value = "high"; level.dispatchEvent(f.event("change") as never);
    release(); await tick(); await tick();
    assert.equal(f.state.generationSettings.model, null);
    assert.equal(f.calls.filter(c => c.name === "generationSettings").length, 1);
  } finally { await f.close(); }
});

test("the Cloze slider shows the saved stop after an earlier queued save redraws Write", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const cap = () => [...f.write.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.startsWith("Most cards per idea"))!;
    const slider = () => f.write.querySelector(".ab-write-cloze input[type=range]") as unknown as HTMLInputElement;
    const release = f.holdSettings();
    cap().value = "3"; cap().dispatchEvent(f.event("change") as never);
    slider().value = "2"; slider().dispatchEvent(f.event("change") as never);
    release(); await tick(); await tick();
    assert.equal(f.state.generationSettings.cloze, "prefer");
    assert.equal(slider().value, "2");
  } finally { await f.close(); }
});

test("picking a model while Clear is still saving keeps the pick", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    const release = f.holdSettings();
    [...f.write.querySelectorAll("button")].find(button => button.textContent === "Clear")!.click();
    void f.pickModel({ provider: "scratch", id: "writer" });
    release(); await tick(); await tick();
    assert.deepEqual(f.state.generationSettings.model, { provider: "scratch", id: "writer" });
  } finally { await f.close(); }
});

test("a finished Cloze save does not move the slider during the next drag", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const slider = () => f.write.querySelector(".ab-write-cloze input[type=range]") as unknown as HTMLInputElement;
    const release = f.holdSettings();
    slider().value = "2"; slider().dispatchEvent(f.event("change") as never);
    slider().value = "0"; slider().dispatchEvent(f.event("input") as never);
    release(); await tick(); await tick();
    assert.equal(f.state.generationSettings.cloze, "prefer");
    assert.equal(slider().value, "0", "the drag in progress keeps its stop");
    slider().dispatchEvent(f.event("change") as never); await tick(); await tick();
    assert.equal(f.state.generationSettings.cloze, "off");
    assert.equal(slider().value, "0");
  } finally { await f.close(); }
});

test("a redraw from another Write setting keeps the Cloze slider and its drag", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const cap = () => [...f.write.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.startsWith("Most cards per idea"))!;
    const slider = () => f.write.querySelector(".ab-write-cloze input[type=range]") as unknown as HTMLInputElement;
    const dragged = slider();
    const release = f.holdSettings();
    cap().value = "3"; cap().dispatchEvent(f.event("change") as never);
    dragged.value = "2"; dragged.dispatchEvent(f.event("input") as never);
    release(); await tick(); await tick();
    assert.equal(f.state.generationSettings.cardsPerNode, 3);
    assert.ok(slider() === dragged, "the redraw keeps the same slider mounted");
    assert.equal(dragged.isConnected, true);
    assert.equal(dragged.value, "2");
    dragged.dispatchEvent(f.event("change") as never); await tick(); await tick();
    assert.equal(f.state.generationSettings.cloze, "prefer");
    assert.equal(slider().value, "2");
  } finally { await f.close(); }
});

test("split runs disclose that earlier drafts and edits can be sent to the model", async () => {
  const f = setup({ estimate: { ...preflight, nodeIds: ["n_a", "n_b"], nodeCount: 2,
    batches: [...preflight.batches, { ...preflight.batches[0], nodeIds: ["n_b"] }] } });
  try {
    f.graph.nodes.push({ ...structuredClone(f.graph.nodes[0]), id: "n_b", name: "Beta" });
    await f.panel.setScope(undefined); await tick();
    for (const element of f.ideas.querySelectorAll("li input[type=checkbox]")) {
      const box = element as unknown as HTMLInputElement;
      box.checked = true; box.dispatchEvent(f.event("change"));
    }
    await tick(); f.button("Write cards for 2 ideas").click(); await tick();
    const sent = [...f.dialog()!.querySelectorAll("dt")].find(term => term.textContent === "Sent to the model");
    assert.match(sent?.nextElementSibling?.textContent ?? "", /Later requests may also get a limited set of earlier drafts from this run, including local edits/);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
  } finally { await f.close(); }
});

test("writing needs a selection, defaults to the cheap model, confirms the estimate in a dialog, then starts once", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Model to write cards.*Blank uses the cheap model and its reasoning level\./s);
    assert.doesNotMatch(f.text(), /LearnHarness cheap model/);
    assert.equal(f.modelValue(), undefined, "the picker starts blank");
    const clear = () => [...f.write.querySelectorAll(".ab-model-row button")].find(b => b.textContent === "Clear") as unknown as HTMLButtonElement | undefined;
    assert.equal(clear(), undefined, "nothing to clear while blank");
    assert.equal(f.write.querySelectorAll(".ab-write-settings input[type=checkbox]").length, 4, "no model checkbox; only the four card types");
    assert.equal(f.button("Write cards").disabled, true);
    f.select(true); await tick();
    assert.match(f.text(), /1 idea selected/);
    assert.equal(f.button("Write cards for 1 idea").disabled, false, "no explicit model needed");
    await f.pickModel({ provider: "scratch", id: "writer" }); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "generationSettings")!.input, { model: { provider: "scratch", id: "writer" } });
    assert.deepEqual(f.modelValue(), { provider: "scratch", id: "writer" }, "the picker shows the saved choice");
    clear()!.click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").at(-1)!.input, { model: null });
    assert.equal(f.modelValue(), undefined, "Clear returns the picker to blank");
    assert.equal(clear(), undefined);
    f.button("Write cards for 1 idea").click(); await tick();
    assert.ok(f.dialog(), "estimate dialog opens");
    assert.match(f.dialog()!.textContent!, /Up to 2.*writer \(cheap model\).*Model calls1, up to 3 with fixes.*CostNo estimate/s);
    const sent = [...f.dialog()!.querySelectorAll("dt")].find(term => term.textContent === "Sent to the model");
    assert.equal(sent?.nextElementSibling?.textContent, "Ideas, linked ideas, excerpts from source session messages, flag notes, and existing cards for these ideas");
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    f.button("Start writing").click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generate").map(c => c.input), [{ preflightId: "p1" }]);
    assert.equal(f.dialog(), null);
    assert.ok(f.refreshed() >= 1);
    assert.match(f.text(), /Writing cards for 1 idea 0 of 1 batch done/);
    assert.equal(f.button("Write cards for 1 idea").disabled, true, "one generation at a time");
    f.button("Cancel").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "cancelGeneration")!.input, { id: "p1" });
    assert.match(f.text(), /Cancelled\. Saved cards are kept/);
    f.button("Try again").click(); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "retryGeneration").map(c => c.input), [{ id: "p1" }]);
    assert.ok(f.dialog(), "retry confirms its own estimate");
    assert.equal(f.calls.filter(c => c.name === "generate").length, 1);
  } finally { await f.close(); }
});

test("a selection change while the dialog is open blocks the start", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    f.select(false); f.select(true); await tick();
    f.button("Start writing").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.text(), /Selection changed\. Press Write cards again/);
  } finally { await f.close(); }
});

test("an estimate with no writable batch explains why the flag request was skipped", async () => {
  const f = setup({ estimate: { ...preflight, batches: [], maximumCards: 0,
    skipped: [{ nodeId: "n_a", reason: "The model cannot fit an ordinary card request." }],
    skippedFlagRequests: [{ count: 1, reason: "The noted flag group cannot fit one request." }] } });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    assert.match(f.text(), /No ideas can be carded\. 1 flag request skipped\. The noted flag group cannot fit one request\./);
    assert.match(f.text(), /Alpha: The model cannot fit an ordinary card request\./);
    assert.equal(f.dialog(), null);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
  } finally { await f.close(); }
});

test("an estimate that returns after the selection changed opens no dialog", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    const release = f.holdEstimates();
    f.button("Write cards for 1 idea").click(); await tick();
    f.select(false); f.select(true);
    release(); await tick();
    assert.equal(f.dialog(), null);
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    assert.match(f.text(), /Selection changed\. Press Write cards again/);
  } finally { await f.close(); }
});

test("Write shows four card types with Fact and Equation on, explains them and has no constants toggle", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const chips = [...f.write.querySelectorAll(".ab-chips label")].map(l => l.textContent);
    assert.deepEqual(chips, ["Fact", "Equation", "Why", "Steps"]);
    const toggles = [...f.write.querySelectorAll(".ab-chips input[type=checkbox]")] as unknown as HTMLInputElement[];
    assert.deepEqual(toggles.map(box => box.checked), [true, true, false, false]);
    const help = f.write.querySelector(".ab-kind-lines")!.textContent!;
    assert.match(help, /Fact Remember a definition, unit or other fact\..*Equation Recall a formula\..*Why Explain why a result holds\..*Steps Recall the next step of a method\./s);
    const examples = f.write.querySelector("details.ab-kind-examples") as unknown as HTMLDetailsElement;
    assert.equal(examples.open, false);
    assert.equal(examples.querySelector("summary")!.textContent, "See examples");
    assert.equal(examples.querySelectorAll(".ab-kind-example").length, 4);
    assert.match(examples.textContent!, /Front: What power of ten does the prefix femto- represent\?Back: 10⁻¹⁵/);
    assert.doesNotMatch(f.write.textContent!, /Compose|Apply|Contrast|physical constants|Also on/);
  } finally { await f.close(); }
});

test("card types and cap save as soon as they change, keep Settings types, and the last type stays on", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const cap = f.write.querySelector(".ab-write-settings select") as unknown as HTMLSelectElement;
    cap.value = "4"; cap.dispatchEvent(f.event("change")); await tick();
    const toggles = () => [...f.write.querySelectorAll(".ab-chips input[type=checkbox]")] as unknown as HTMLInputElement[];
    // Settings switched Apply on after this view loaded; Write has not seen it yet, and sends only its own change.
    f.state.generationSettings.enabledKinds = ["fact", "equation", "apply"];
    toggles()[2]!.checked = true; toggles()[2]!.dispatchEvent(f.event("change")); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "generationSettings").map(c => c.input), [{ cardsPerNode: 4 }, { toggleKind: { kind: "why", enabled: true } }]);
    assert.deepEqual(f.state.generationSettings.enabledKinds, ["fact", "equation", "why", "apply"]);
    assert.match(f.text(), /Also on: Apply\./);
    for (const i of [1, 2]) { toggles()[i]!.checked = false; toggles()[i]!.dispatchEvent(f.event("change")); await tick(); }
    assert.deepEqual(f.state.generationSettings.enabledKinds, ["fact", "apply"]);
    assert.equal(toggles()[0]!.disabled, false, "Apply is still on, so Fact can go off");
    f.state.generationSettings.enabledKinds = ["fact"];
    f.peers.forEach(peer => peer()); await tick();
    assert.equal(toggles()[0]!.disabled, true, "the only remaining type cannot be turned off");
    assert.doesNotMatch(f.text(), /Also on/);
  } finally { await f.close(); }
});

test("a rejected card-type toggle puts the checkbox back and tells Settings nothing changed", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const why = () => ([...f.write.querySelectorAll(".ab-chips input[type=checkbox]")] as unknown as HTMLInputElement[])[2]!;
    let notified = 0; f.peers.add(() => { notified++; });
    f.state.failToggle = true;
    why().checked = true; why().dispatchEvent(f.event("change")); await tick();
    assert.equal(why().checked, false, "the saved state is shown again");
    assert.match(f.text(), /busy/);
    assert.equal(notified, 0);
    f.state.failToggle = false;
    why().checked = true; why().dispatchEvent(f.event("change")); await tick();
    assert.equal(why().checked, true);
    assert.equal(notified, 1, "Settings hears about a saved Write change");
  } finally { await f.close(); }
});

test("#54: the estimate says writer notes are sent, and a Settings change while it is open blocks the start", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    const sent = () => [...f.dialog()!.querySelectorAll("dt")].find(term => term.textContent === "Sent to the model")?.nextElementSibling?.textContent;
    assert.doesNotMatch(sent()!, /writer notes/);
    f.button("Cancel").click(); await tick();
    f.state.generationSettings.writerNotes = "Name the unit system on units cards.";
    f.button("Write cards for 1 idea").click(); await tick();
    assert.equal(sent(), "Ideas, linked ideas, excerpts from source session messages, flag notes, existing cards for these ideas, and your writer notes");
    // Settings saves new notes while the estimate is open: Settings tells its peers, and Write drops the estimate.
    f.state.generationSettings.writerNotes = "Prefer cloze for prefix facts.";
    f.peers.forEach(peer => peer()); await tick();
    f.button("Start writing").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
    // The next Write asks the backend for a fresh estimate.
    f.button("Write cards for 1 idea").click(); await tick();
    assert.equal(f.calls.filter(c => c.name === "preflight").length, 3);
    f.button("Start writing").click(); await tick();
    assert.equal(f.calls.filter(c => c.name === "generate").length, 1);
  } finally { await f.close(); }
});

test("#54: a split estimate with writer notes names both the notes and the earlier drafts", async () => {
  const f = setup({ estimate: { ...preflight, nodeIds: ["n_a", "n_b"], nodeCount: 2,
    batches: [...preflight.batches, { ...preflight.batches[0], nodeIds: ["n_b"] }] } });
  try {
    f.state.generationSettings.writerNotes = "Name the unit system on units cards.";
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    const sent = [...f.dialog()!.querySelectorAll("dt")].find(term => term.textContent === "Sent to the model");
    assert.equal(sent?.nextElementSibling?.textContent, "Ideas, linked ideas, excerpts from source session messages, flag notes, existing cards for these ideas, and your writer notes. Later requests may also get a limited set of earlier drafts from this run, including local edits.");
  } finally { await f.close(); }
});

test("a Settings change reaches Write through the shared peers without a reload", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    assert.doesNotMatch(f.text(), /Also on/);
    f.state.generationSettings.enabledKinds = ["fact", "equation", "apply", "discriminate"];
    f.peers.forEach(peer => peer()); await tick();
    assert.match(f.text(), /Also on: Apply and Contrast\./);
  } finally { await f.close(); }
});

test("polling updates progress without rebuilding the model picker and refreshes cards once on change", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined); await tick();
    f.select(true); await tick();
    f.button("Write cards for 1 idea").click(); await tick();
    f.button("Start writing").click(); await tick();
    const mounts = f.modelMounts(), refreshed = f.refreshed();
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.equal(f.modelMounts(), mounts, "unchanged poll does not rebuild pickers");
    f.state.generations[0].status = "completed"; f.state.generations[0].tasks[0].status = "applied";
    f.state.generations[0].tasks[0].result = { targets: [{ nodeId: "n_a", cards: [{}, {}] }] };
    await new Promise(resolve => setTimeout(resolve, 1300)); await tick();
    assert.match(f.text(), /Wrote 2 cards for 1 idea\./);
    assert.equal(f.refreshed(), refreshed + 1);
    assert.equal(f.modelMounts(), mounts);
  } finally { await f.close(); }
});

test("finished batches can be dismissed, and dismissing the latest one empties the panel", async () => {
  const f = setup();
  try {
    const done = (id: string, cards: number) => ({ id, status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: `r-${id}`, status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: Array(cards).fill({}) }] } }] });
    f.state.generations.push(done("old", 1), done("new", 3));
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Wrote 3 cards/); assert.doesNotMatch(f.text(), /Wrote 1 card\b/);
    f.button("Dismiss").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissGeneration")!.input, { id: "new" });
    assert.doesNotMatch(f.text(), /Wrote \d+ cards?\b/, "dismissing the latest result leaves the panel empty");
  } finally { await f.close(); }
});

test("a running batch has the progress panel to itself", async () => {
  const f = setup();
  try {
    f.state.generations.push(
      { id: "old", status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r-old", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [{}] }] } }] },
      { id: "now", status: "running", nodeIds: ["n_b"], skipped: [], settings: {}, createdAt: "", tasks: [
        { requestId: "r-now", status: "running", input: {}, outputAllowance: 1, sources: [] }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Writing cards for 1 idea/);
    assert.doesNotMatch(f.text(), /Wrote 1 card\b/);
  } finally { await f.close(); }
});

test("the summary counts ideas that got cards, and lists the skipped ones", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "completed", nodeIds: ["n_a", "n_b", "n_c"], skipped: [{ nodeId: "n_c", reason: "Too long" }], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [{}, {}] }, { nodeId: "n_b", cards: [], skipReason: "Couldn't check it" }] } }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Wrote 2 cards for 1 idea\./);
    assert.match(f.text(), /2 ideas skipped/);
  } finally { await f.close(); }
});

test("a run where every idea was skipped says no cards were written", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "completed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "applied", input: {}, outputAllowance: 1, sources: [], result: { targets: [{ nodeId: "n_a", cards: [], skipReason: "Couldn't check it" }] } }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /No cards written\./);
    assert.doesNotMatch(f.text(), /Wrote 0/);
  } finally { await f.close(); }
});

test("failed batches show the provider message, not raw JSON", async () => {
  const f = setup();
  try {
    f.state.generations.push({ id: "g", status: "failed", nodeIds: ["n_a"], skipped: [], settings: {}, createdAt: "", tasks: [
      { requestId: "r", status: "failed", input: {}, outputAllowance: 1, sources: [], error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }] });
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /No cards written\. 1 batch failed\./);
    assert.match(f.text(), /Invalid x-api-key \(HTTP 401\)\./);
    assert.doesNotMatch(f.text(), /authentication_error/);
    assert.equal(readableError("plain failure"), "plain failure");
  } finally { await f.close(); }
});

test("session scope reads only that session's ideas and preselects flagged ones; the graph scope does not", async () => {
  const f = setup();
  try {
    await f.panel.setScope({ sessionId: "s1" }); await tick();
    assert.deepEqual(f.calls.filter(c => c.name === "sessionFlow").map(c => c.input), [{ sessionId: "s1" }]);
    assert.equal(f.calls.some(c => c.name === "coverageContext"), false);
    assert.match(f.text(), /Session idea/); assert.doesNotMatch(f.text(), /Alpha/);
    assert.match(f.text(), /1 idea selected/);
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Alpha/); assert.doesNotMatch(f.text(), /Session idea/);
    assert.match(f.text(), /No ideas selected/);
  } finally { await f.close(); }
});

test("session preflight keeps overlap, group choices and direct choices separate", async () => {
  const f = setup({ estimate: { ...preflight, nodeCount: 4, batches: [
    { ...preflight.batches[0], nodeIds: ["n_s", "n_b", "n_c", "n_d"] }, { ...preflight.batches[0], nodeIds: ["n_b"] },
  ] } });
  try {
    const names = ["Session idea", "Beta", "Gamma", "Delta", "Handled"];
    const ids = ["n_s", "n_b", "n_c", "n_d", "n_e"];
    f.session.nodes = ids.map((id, i) => ({ ...f.session.nodes[0], id, name: names[i] }));
    f.session.flags = [
      { id: "noted", note: "Only ask about Beta's exception", nodeIds: ids, pendingNodeIds: ids.slice(0, 4) },
      { id: "blank", note: "", nodeIds: ["n_b"], pendingNodeIds: ["n_b"] },
    ];
    await f.panel.setScope({ sessionId: "s1" });
    const toggle = (n: number) => f.ideas.querySelector<HappyInput>(`input[aria-label="Include flag ${n} request"]`)!;
    const direct = (name: string) => [...f.ideas.querySelectorAll<HappyInput>(`input[aria-label="Select ${name} directly"]`)];
    const estimate = async (count: number, input: unknown) => {
      f.button(`Write cards for ${count} ${count === 1 ? "idea" : "ideas"}`).click(); await tick();
      assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, input);
    };
    const dismiss = async () => { f.button("Cancel").click(); await tick(); };
    assert.match(toggle(1).closest("fieldset")!.textContent!, /5 candidates.*Only ask about Beta's exception.*4 of 5 included/);
    assert.match(toggle(2).closest("fieldset")!.textContent!, /1 candidate.*No note.*1 of 1 included/);
    assert.equal(direct("Beta").length, 2);
    const noted = { id: "noted", nodeIds: ids.slice(0, 4) }, blank = { id: "blank", nodeIds: ["n_b"] };
    await estimate(4, { nodeIds: ids.slice(0, 4), backfillNodeIds: [], flagScopes: [noted, blank], independentNodeIds: [] });
    assert.match(f.dialog()!.textContent!, /Ideas4Cards/); await dismiss();
    toggle(1).click();
    await estimate(1, { nodeIds: ["n_b"], backfillNodeIds: [], flagScopes: [blank], independentNodeIds: [] }); await dismiss();
    direct("Beta")[0]!.click();
    assert.ok(direct("Beta").every(box => box.checked), "duplicate rows share the same independent checkbox state");
    toggle(2).click();
    direct("Handled")[0]!.click();
    await estimate(2, { nodeIds: ["n_b", "n_e"], backfillNodeIds: [], flagScopes: [], independentNodeIds: ["n_b", "n_e"] }); await dismiss();
    assert.equal(f.calls.some(c => c.name === "generate"), false);
  } finally { await f.close(); }
});

test("a handoff selection replaces the choice and resets search without starting anything", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const search = f.ideas.querySelector("input[type=search]") as unknown as HTMLInputElement;
    search.value = "unrelated"; search.dispatchEvent(f.event("input"));
    await f.panel.setScope(undefined, { nodeIds: ["n_a", "n_a"], backfillNodeIds: ["n_a"] }); await tick();
    assert.equal(search.value, "");
    assert.match(f.text(), /1 idea selected/);
    assert.equal(f.calls.some(c => c.name === "preflight" || c.name === "generate"), false);
  } finally { await f.close(); }
});

test("idea rows need neither a model nor a catalog, and never mount the native knowledge picker", async () => {
  for (const catalogUnavailable of [false, true]) {
    const f = setup({ catalogUnavailable });
    try {
      await f.panel.setScope(undefined); await tick();
      assert.match(f.text(), /Alpha holds under A/);
      assert.match(f.text(), /No cards/);
      assert.equal(f.knowledgeMounts(), 0);
      assert.equal(f.calls.some(c => c.name === "generationContext" || c.name === "connection"), false);
      assert.equal(f.box().disabled, false); assert.equal(f.box().checked, false);
      f.box().click(); assert.match(f.text(), /1 idea selected/);
    } finally { await f.close(); }
  }
});

test("Write still offers drafting controls when the optional model picker cannot mount", async () => {
  for (const model of [false, true]) {
    const f = setup({ catalogUnavailable: true, model });
    const clear = () => [...f.write.querySelectorAll(".ab-model-row button")].find(b => b.textContent === "Clear") as unknown as HTMLButtonElement | undefined;
    try {
      await f.panel.setScope(undefined); await tick();
      assert.match(f.write.textContent!, /Model picker unavailable/);
      assert.equal(f.write.querySelectorAll(".ab-kinds input").length, 4);
      assert.ok(f.write.querySelector("select"));
      f.box().click();
      assert.ok(f.has("Write cards for 1 idea"));
      if (model) {
        assert.ok(clear()); clear()!.click(); await tick();
        assert.equal(f.state.generationSettings.model, null);
        assert.equal(clear(), undefined);
      } else assert.equal(clear(), undefined);
    } finally { await f.close(); }
  }
});

test("dismiss and restore send the current hash and refresh eligibility without reticking", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true); await tick();
    await f.menu("Don't make cards for this idea"); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "dismissNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    assert.match(f.text(), /No ideas selected/);
    assert.equal(f.box().disabled, true);
    await f.menu("Make cards for this idea again"); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "restoreNode")!.input, { nodeId: "n_a", statementHash: "a".repeat(64) });
    assert.equal(f.box().disabled, false); assert.equal(f.box().checked, false);
  } finally { await f.close(); }
});

test("a queued dismissal does not run after the first one marks the list stale", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const mutation = f.holdMutation();
    await f.menu("Don't make cards for this idea"); await f.menu("Don't make cards for this idea"); await tick();
    assert.equal(f.calls.filter(c => c.name === "dismissNode").length, 1);
    mutation.reject(); await tick();
    assert.equal(f.calls.filter(c => c.name === "dismissNode").length, 1);
    assert.match(f.text(), /may be out of date/);
  } finally { await f.close(); }
});

test("a saved dismissal keeps its acknowledgement and refreshes cards when the list read fails", async () => {
  const f = setup();
  try {
    await f.panel.setScope(undefined); await tick();
    const mutation = f.holdMutation(), refreshed = f.refreshed();
    await f.menu("Don't make cards for this idea"); await tick();
    const graph = f.holdGraphReload();
    mutation.resolve(); await tick();
    graph.reject(); await tick();
    assert.match(f.text(), /Saved, but the list did not refresh/);
    assert.match(f.text(), /may be out of date/);
    assert.equal(f.refreshed(), refreshed + 1, "cards refresh even if the list does not");
  } finally { await f.close(); }
});

test("older list responses cannot replace a newer view or restore a cleared selection", async () => {
  const f = setup(); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true);
    gate = f.holdGraphReload(); const oldRead = f.panel.refresh(); gate.allowFollowingReads();
    f.graph.nodes[0].statement = "Newest graph view."; f.graph.nodes[0].statementHash = "c".repeat(64);
    await f.panel.refresh(); f.button("Clear").click();
    gate.resolve(); await oldRead; await tick();
    assert.match(f.text(), /Newest graph view/);
    assert.doesNotMatch(f.text(), /Alpha holds under A/);
    assert.match(f.text(), /No ideas selected/);
  } finally { gate?.resolve(); await f.close(); }
});

test("a list read failure keeps the last rows as stale and blocks writing until a refresh", async () => {
  const f = setup({ model: true }); let gate: ReturnType<typeof f.holdGraphReload> | undefined;
  try {
    await f.panel.setScope(undefined); await tick(); f.select(true); await tick();
    gate = f.holdGraphReload(); const reading = f.panel.refresh();
    gate.reject(); await reading; await tick();
    assert.match(f.text(), /may be out of date/); assert.match(f.text(), /Alpha holds under A/);
    assert.equal(f.box().disabled, true);
    assert.equal(f.button("Write cards for 1 idea").disabled, true);
    await f.panel.refresh(); await tick();
    assert.equal(f.box().disabled, false);
    assert.equal(f.button("Write cards for 1 idea").disabled, false);
  } finally { gate?.resolve(); await f.close(); }
});

test("an initial list failure recovers on refresh without a model catalog", async () => {
  const f = setup({ initialGraphFailure: true, catalogUnavailable: true });
  try {
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /may be out of date/);
    await f.panel.refresh(); await tick();
    assert.match(f.text(), /Alpha holds under A/);
    assert.doesNotMatch(f.text(), /may be out of date/);
    assert.equal(f.calls.some(c => c.name === "generationContext"), false);
  } finally { await f.close(); }
});

test("backfill intent travels through handoff and bulk selection; a manual tick is explicit", async () => {
  const f = setup({ model: true });
  try {
    await f.panel.setScope(undefined, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] }); await tick();
    const write = async () => { f.button(/^Write cards for/).click(); await tick(); f.button("Cancel").click(); await tick(); };
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] });
    f.select(false); f.select(true); await tick();
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: [] });
    f.button(/^Select ideas without cards/).click(); await tick();
    await write();
    assert.deepEqual(f.calls.filter(c => c.name === "preflight").at(-1)!.input, { nodeIds: ["n_a"], backfillNodeIds: ["n_a"] });
  } finally { await f.close(); }
});

test("a programmatic handoff accepts 1000 ideas and refuses 1001 with a warning", async () => {
  const f = setup();
  try {
    const template = f.graph.nodes[0];
    f.graph.nodes = Array.from({ length: 1001 }, (_, i) => ({ ...template, id: `node-${i}`, name: `Node ${i}` }));
    const ids = f.graph.nodes.map((n: { id: string }) => n.id);
    await f.panel.setScope(undefined, { nodeIds: ids.slice(0, 1000), backfillNodeIds: ids.slice(0, 1000) }); await tick();
    assert.equal(f.ideas.querySelectorAll("li input:checked").length, 1000);
    await f.panel.setScope(undefined, { nodeIds: ids }); await tick();
    assert.equal(f.ideas.querySelectorAll("li input:checked").length, 0, "a new scope starts from an empty selection");
    assert.match(f.text(), /Limit is 1000 ideas\. Narrow the search\./);
  } finally { await f.close(); }
});

test("Retry saving uses the finished result without a model confirmation", async () => {
  const f = setup();
  const batch = { id: "g1", status: "interrupted", nodeIds: ["n_a"], skipped: [], tasks: [
    { status: "interrupted", resultPending: true, error: "The model finished, but Anki Bridge could not save its result." },
  ] };
  try {
    f.state.generations = [batch];
    f.onRetry(() => ({ recovery: true, snapshot: { ...f.state, generations: [{ ...batch, status: "completed", tasks: [
      { status: "applied", result: { targets: [{ nodeId: "n_a", cards: [{}] }] } },
    ] }] } }));
    await f.panel.setScope(undefined); await tick();
    assert.match(f.text(), /Result not saved/);
    assert.equal(f.has("Dismiss"), false);
    f.button("Retry saving").click(); await tick();
    assert.deepEqual(f.calls.filter(c => ["preflight", "retryGeneration", "generate"].includes(c.name)), [{ name: "retryGeneration", input: { id: "g1" } }]);
    assert.equal(f.dialog(), null);
    assert.match(f.text(), /Wrote 1 card for 1 idea/);
    assert.equal(f.has("Dismiss"), true);
  } finally { await f.close(); }
});

test("abandoning an unavailable result requires its own confirmation and releases ideas without estimating or writing", async () => {
  const f = setup();
  try {
    f.state.generations = [{ id: "g1", status: "interrupted", nodeIds: ["n_a"], skipped: [], tasks: [
      { status: "interrupted", resultPending: true },
    ] }];
    Object.assign(f.graph.nodes[0].coverage, { generating: true, selectable: false, uncarded: false });
    await f.panel.setScope(undefined); await tick();
    assert.equal(f.box().disabled, true);
    f.button("Abandon unavailable result").click(); await tick();
    assert.match(f.dialog()!.textContent!, /This stops recovery of the unsaved result\. Saved cards are kept\. No model call starts\..*run a new estimate and confirm it/);
    f.button("Cancel").click(); await tick();
    assert.equal(f.calls.some(c => c.name === "abandonGenerationResult"), false);
    assert.equal(f.box().disabled, true);
    f.button("Abandon unavailable result").click(); await tick();
    f.button("Abandon result").click(); await tick();
    assert.deepEqual(f.calls.filter(c => ["abandonGenerationResult", "preflight", "retryGeneration", "generate"].includes(c.name)), [
      { name: "abandonGenerationResult", input: { id: "g1", confirmed: true } },
    ]);
    assert.equal(f.box().disabled, false);
    assert.equal(f.has("Retry saving"), false);
    assert.equal(f.has("Dismiss"), true);
    assert.match(f.text(), /Result abandoned\./);
    assert.doesNotMatch(f.text(), /model call failed/);
  } finally { await f.close(); }
});
