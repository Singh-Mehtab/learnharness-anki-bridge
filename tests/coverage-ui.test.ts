import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { CoveragePicker } from "../src/coverage-ui.ts";
import type { CoverageRow, CoverageView } from "../src/coverage-ui.ts";
import type { Coverage } from "../src/coverage/flow.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { chooseMenu, fakeUi } from "./fake-ui.ts";

const coverage: Coverage = { state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true, dismissed: false,
  generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 };
function row(id: string, changes: Partial<Coverage> = {}, extra: Partial<CoverageRow> = {}): CoverageRow {
  return { id, name: id, statement: `Statement for ${id}`, statementHash: "a".repeat(64), cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: { ...coverage, ...changes }, ...extra };
}
function setup(defaults = false) {
  const window = new Window(); Object.assign(globalThis, { document: window.document });
  let changes = 0;
  const mutations: unknown[] = [];
  const controller = new AbortController();
  const ctx = { signal: controller.signal, ui: fakeUi() } as unknown as PluginFrontendContext;
  const picker = new CoveragePicker({ ctx, signal: controller.signal, defaults, changed: () => { changes++; }, mutate: (name, node) => mutations.push([name, node.id, node.statementHash]) });
  window.document.body.append(picker.root as never);
  const view: CoverageView = { nodes: [], missing: [], cardsPerNode: 3, paired: true, pairingWarning: false };
  const buttons = () => [...picker.root.querySelectorAll("button")];
  const button = (prefix: string) => { const found = buttons().find(b => b.textContent?.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const box = (id: string) => { const found = picker.root.querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`); assert.ok(found, id); return found; };
  const event = (type: string) => new window.Event(type) as never;
  const more = (id: string) => { const found = picker.root.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${id}"]`); assert.ok(found, `menu for ${id}`); return found; };
  const menu = async (id: string, label: string) => { more(id).click(); await chooseMenu(label); };
  return { window, picker, view, button, box, event, more, menu, mutations, changes: () => changes, close: () => { controller.abort(); return window.happyDOM.close(); } };
}

test("coverage picker labels mixed coverage and warnings, and only current dismissals offer Restore", async () => {
  const f = setup();
  try {
    f.picker.update({ ...f.view, pairingWarning: true, nodes: [
      row("mixed", { state: "sent", base: "sent", uncarded: false, canDismiss: false, olderSourceCards: 1, unknownSourceCards: 2, deletedNotes: 1, skipReason: "No useful contrast" }, { cards: { waiting: 2, sent: 3, sentElsewhere: 1 } }),
      row("changed", { state: "source-changed", uncarded: false, olderSourceCards: 1 }),
      row("dismissed", { state: "dismissed", base: "dismissed", selectable: false, uncarded: false, canDismiss: false, dismissed: true }),
      row("running", { selectable: false, uncarded: false, canDismiss: false, generating: true }),
      row("uncertain", { state: "drafts-waiting", base: "drafts-waiting", selectable: false, uncarded: false, canDismiss: false, unresolved: 1 }),
    ], missing: [row("history", { state: "source-missing", selectable: false, uncarded: false, canDismiss: false })] });
    const text = f.picker.root.textContent!;
    for (const label of ["Anki address changed", "3 in Anki", "2 to review", "1 in another profile", "Changed since carded", "1 deleted in Anki", "Not carding", "Writing…", "1 unconfirmed", "Ideas missing from this graph read (1)"]) assert.ok(text.includes(label), label);
    assert.deepEqual(f.picker.ids, [], "global selection starts empty");
    assert.equal(f.box("mixed").disabled, false);
    for (const id of ["dismissed", "running", "uncertain"]) assert.equal(f.box(id).disabled, true);
    assert.equal(f.picker.root.querySelector('[aria-label="Select history"]'), null);
    const historical = f.picker.root.querySelector("details")!;
    assert.equal(historical.hidden, false); assert.match(historical.textContent!, /Ideas missing from this graph read.*Their cards are kept/);
    assert.match(historical.textContent!, /Statement for history/);
    assert.doesNotMatch(f.picker.root.querySelector("ul")!.textContent!, /Statement for history/);
    assert.equal(f.picker.root.querySelector('button[aria-label="More actions for history"]'), null, "historical rows have no actions");
    await f.menu("dismissed", "Make cards for this idea again");
    assert.deepEqual(f.mutations[0], ["restoreNode", "dismissed", "a".repeat(64)]);
    await f.menu("changed", "Don't make cards for this idea");
    assert.deepEqual(f.mutations[1], ["dismissNode", "changed", "a".repeat(64)]);
  } finally { await f.close(); }
});

test("coverage picker uses shared No cards eligibility for visible bulk selection and prunes filter/search selections", async () => {
  const f = setup();
  try {
    const nodes = [row("alpha"), row("elsewhere", {}, { cards: { waiting: 0, sent: 0, sentElsewhere: 2 } }),
      row("changed", { state: "source-changed", uncarded: false }), row("generating", { generating: true, selectable: false, uncarded: false })];
    f.picker.update({ ...f.view, nodes });
    assert.equal(f.button("Select ideas without cards").textContent, "Select ideas without cards (2)");
    f.button("Select ideas without cards").click(); assert.deepEqual(f.picker.ids, ["alpha", "elsewhere"]);
    const search = f.picker.root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = "alpha"; search.dispatchEvent(f.event("input")); assert.deepEqual(f.picker.ids, ["alpha"]);
    search.value = ""; search.dispatchEvent(f.event("input")); assert.deepEqual(f.picker.ids, ["alpha"], "search does not restore hidden choices");
    f.picker.select(["changed"]);
    const scope = f.picker.root.querySelector("select")!; scope.value = "uncarded"; scope.dispatchEvent(f.event("change"));
    assert.deepEqual(f.picker.ids, []); assert.equal(f.picker.root.textContent!.includes("Statement for changed"), false);
    f.button("Select ideas without cards").click(); f.button("Clear").click();
    f.picker.update({ ...f.view, nodes }); assert.deepEqual(f.picker.ids, []);
    scope.value = "all"; scope.dispatchEvent(f.event("change"));
    f.box("changed").checked = true; f.box("changed").dispatchEvent(f.event("change")); assert.deepEqual(f.picker.ids, ["changed"]);
  } finally { await f.close(); }
});

test("session coverage defaults flagged even sent, excludes blocked rows, and never reticks cleared choices on refresh", async () => {
  const f = setup(true);
  try {
    const nodes = [row("sent", { state: "sent", base: "sent", uncarded: false, canDismiss: false }, { flagged: true, cards: { waiting: 1, sent: 1, sentElsewhere: 0 } }),
      row("dismissed", { dismissed: true, selectable: false, uncarded: false }, { flagged: true }),
      row("generating", { generating: true, selectable: false, uncarded: false }, { flagged: true }),
      row("unresolved", { unresolved: 1, selectable: false, uncarded: false }, { flagged: true }), row("unflagged"),
      row("changed", { state: "source-changed", uncarded: false }, { flagged: false })];
    const view = { ...f.view, nodes };
    f.picker.update(view, true); assert.deepEqual(f.picker.ids, ["sent"]);
    f.button("Clear").click(); f.picker.update(structuredClone(view)); assert.deepEqual(f.picker.ids, []);
    f.box("changed").click(); f.picker.update(structuredClone(view)); assert.deepEqual(f.picker.ids, ["changed"]);
    f.picker.update({ ...view, nodes: nodes.map(n => n.id === "changed" ? { ...n, coverage: { ...n.coverage!, generating: true, selectable: false } } : n) });
    assert.deepEqual(f.picker.ids, [], "newly blocked choices are pruned");
    f.picker.update(view); assert.deepEqual(f.picker.ids, [], "unblocked rows are not reticked");
  } finally { await f.close(); }
});

test("coverage read failure retains rows marked stale, disables selection and mutations, and refresh preserves explicit choices", async () => {
  const f = setup(true);
  try {
    const view = { ...f.view, nodes: [row("alpha", {}, { flagged: true })] };
    f.picker.update(view, true); const before = f.changes(); f.picker.markStale();
    assert.ok(f.changes() > before); assert.match(f.picker.root.textContent!, /may be out of date/);
    assert.equal(f.box("alpha").disabled, true);
    assert.equal(f.button("Select ideas without cards").disabled, true);
    assert.equal(f.button("Clear").disabled, true);
    assert.equal(f.more("alpha").disabled, true);
    const search = f.picker.root.querySelector<HTMLInputElement>('input[type=search]')!;
    const scope = f.picker.root.querySelector<HTMLSelectElement>('select')!;
    assert.equal(search.disabled, true); assert.equal(scope.disabled, true);
    search.value = "unrelated"; search.oninput?.(new Event("input")); search.value = "";
    f.picker.select([]); assert.deepEqual(f.picker.ids, ["alpha"], "stale reads cannot change explicit choices");
    f.picker.update(view); assert.equal(f.box("alpha").disabled, false); assert.deepEqual(f.picker.ids, ["alpha"]);
  } finally { await f.close(); }
});

test("coverage intent distinguishes bulk, explicit and flagged choices across refresh and pruning", async () => {
  const f = setup(true);
  try {
    const nodes = [row("alpha", {}, { flagged: true }), row("beta")];
    f.picker.update({ ...f.view, nodes }, true);
    assert.deepEqual(f.picker.ids, ["alpha"]);
    assert.deepEqual(f.picker.backfillNodeIds, [], "flagged defaults are explicit");
    f.button("Select ideas without cards").click();
    assert.deepEqual(f.picker.backfillNodeIds, ["alpha", "beta"]);
    const sent = nodes.map(n => n.id === "alpha" ? row("alpha", { state: "sent", base: "sent", uncarded: false }, { flagged: true }) : n);
    f.picker.update({ ...f.view, nodes: sent });
    assert.deepEqual(f.picker.backfillNodeIds, ["alpha", "beta"], "refresh never promotes a bulk choice to explicit, even when now sent and flagged");
    f.box("alpha").click(); f.box("alpha").click();
    assert.deepEqual(f.picker.backfillNodeIds, ["beta"], "manual reselection is explicit");
    const search = f.picker.root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = "alpha"; search.dispatchEvent(f.event("input"));
    assert.deepEqual(f.picker.backfillNodeIds, [], "hidden nodes lose intent");
    search.value = ""; search.dispatchEvent(f.event("input"));
    f.button("Select ideas without cards").click();
    f.picker.update({ ...f.view, nodes: [sent[0]] });
    assert.deepEqual(f.picker.ids, []); assert.deepEqual(f.picker.backfillNodeIds, [], "removed nodes lose intent");
    f.picker.update({ ...f.view, nodes }); f.button("Select ideas without cards").click(); f.button("Clear").click();
    assert.deepEqual(f.picker.backfillNodeIds, []);
    f.button("Select flagged").click(); assert.deepEqual(f.picker.ids, ["alpha"]); assert.deepEqual(f.picker.backfillNodeIds, []);
    f.picker.select(["alpha"], ["alpha", "absent"]); assert.deepEqual(f.picker.backfillNodeIds, ["alpha"], "intent is a selected subset");
    f.picker.select(["alpha"]); assert.deepEqual(f.picker.backfillNodeIds, [], "legacy programmatic callers are explicit");
  } finally { await f.close(); }
});

const limitRows = (count: number, flagged = false) => Array.from({ length: count }, (_, i) => row(`node-${i}`, {}, { flagged }));
function assertLimitWarning(picker: CoveragePicker) {
  assert.match(picker.root.textContent!, /Limit is 1000 ideas\. Narrow the search\./);
}

test("coverage picker enforces 1000/1001 for manual, bulk and programmatic selections without truncation", async () => {
  const f = setup();
  try {
    const nodes = limitRows(1001);
    f.picker.update({ ...f.view, nodes });
    f.picker.select(nodes.slice(0, 999).map(n => n.id));
    f.box("node-999").click(); assert.equal(f.picker.ids.length, 1000);
    f.box("node-1000").click(); assert.equal(f.picker.ids.length, 1000); assert.equal(f.box("node-1000").checked, false); assertLimitWarning(f.picker);
    const before = f.picker.ids;
    f.button("Select ideas without cards").click(); assert.deepEqual(f.picker.ids, before); assertLimitWarning(f.picker);
    f.picker.select(nodes.map(n => n.id), nodes.map(n => n.id)); assert.deepEqual(f.picker.ids, before); assert.deepEqual(f.picker.backfillNodeIds, []); assertLimitWarning(f.picker);
    f.picker.update({ ...f.view, nodes: nodes.slice(0, 1000) });
    f.button("Select ideas without cards").click(); assert.equal(f.picker.ids.length, 1000); assert.equal(f.picker.backfillNodeIds.length, 1000);
    f.picker.select(nodes.slice(0, 1000).map(n => n.id)); assert.equal(f.picker.ids.length, 1000); assert.deepEqual(f.picker.backfillNodeIds, []);
  } finally { await f.close(); }
});

test("flagged defaults enforce 1000/1001 on open and refresh without partial additions", async () => {
  const f = setup(true);
  try {
    const nodes = limitRows(1001, true);
    f.picker.update({ ...f.view, nodes }, true);
    assert.deepEqual(f.picker.ids, []); assertLimitWarning(f.picker);
    f.picker.update({ ...f.view, nodes: nodes.slice(0, 1000) }, true);
    assert.equal(f.picker.ids.length, 1000); assert.deepEqual(f.picker.backfillNodeIds, []);
    const before = f.picker.ids;
    f.picker.update({ ...f.view, nodes }); assert.deepEqual(f.picker.ids, before); assertLimitWarning(f.picker);
    f.button("Select flagged").click(); assert.deepEqual(f.picker.ids, before); assertLimitWarning(f.picker);
    f.picker.update({ ...f.view, nodes: nodes.slice(0, 999) }, true);
    f.picker.update({ ...f.view, nodes }); assert.equal(f.picker.ids.length, 999, "no partial fill to the limit on refresh"); assertLimitWarning(f.picker);
    f.picker.update({ ...f.view, nodes: nodes.slice(0, 1000) }); assert.equal(f.picker.ids.length, 1000, "exactly 1000 refreshed defaults work");
  } finally { await f.close(); }
});

test("current dismissal remains visible and restorable when the primary label is Sent", async () => {
  const f = setup(true);
  try {
    f.picker.update({ ...f.view, nodes: [row("repaired", { state: "sent", base: "sent", dismissed: true, selectable: false, uncarded: false, canDismiss: false }, { flagged: true, cards: { waiting: 0, sent: 1, sentElsewhere: 0 } })] });
    assert.match(f.picker.root.textContent!, /Not carding.*1 in Anki/);
    assert.equal(f.box("repaired").disabled, true); assert.deepEqual(f.picker.ids, []);
    await f.menu("repaired", "Make cards for this idea again"); assert.deepEqual(f.mutations, [["restoreNode", "repaired", "a".repeat(64)]]);
  } finally { await f.close(); }
});

test("a flagged idea without cards says No cards next to Flagged (#17)", async () => {
  const f = setup(true);
  try {
    f.picker.update({ ...f.view, nodes: [row("alpha", {}, { flagged: true }), row("beta", { state: "sent", base: "sent", uncarded: false }, { flagged: true, cards: { waiting: 0, sent: 1, sentElsewhere: 0 } })] });
    const pills = (id: string) => Array.from(f.box(id).closest(".ab-idea")!.querySelectorAll(".ab-pill")).map(p => p.textContent);
    assert.deepEqual(pills("alpha"), ["Flagged", "No cards"]);
    assert.deepEqual(pills("beta"), ["Flagged", "1 in Anki"]);
  } finally { await f.close(); }
});
