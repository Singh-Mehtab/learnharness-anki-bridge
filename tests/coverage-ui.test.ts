import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { CoveragePicker } from "../src/coverage-ui.ts";
import type { CoverageRow, CoverageView } from "../src/coverage-ui.ts";
import type { Coverage } from "../src/coverage/flow.ts";

const coverage: Coverage = { state: "no-cards", base: "no-cards", selectable: true, uncarded: true, canDismiss: true, dismissed: false,
  generating: false, unresolved: 0, olderSourceCards: 0, unknownSourceCards: 0, deletedNotes: 0 };
function row(id: string, changes: Partial<Coverage> = {}, extra: Partial<CoverageRow> = {}): CoverageRow {
  return { id, name: id, statement: `Statement for ${id}`, statementHash: "a".repeat(64), cards: { waiting: 0, sent: 0, sentElsewhere: 0 }, coverage: { ...coverage, ...changes }, ...extra };
}
function setup(defaults = false) {
  const window = new Window(); Object.assign(globalThis, { document: window.document });
  let changes = 0;
  const mutations: unknown[] = [];
  const picker = new CoveragePicker({ defaults, changed: () => { changes++; }, mutate: (name, node) => mutations.push([name, node.id, node.statementHash]) });
  window.document.body.append(picker.root as never);
  const view: CoverageView = { nodes: [], missing: [], cardsPerNode: 3, paired: true, pairingWarning: false };
  const buttons = () => [...picker.root.querySelectorAll("button")];
  const button = (prefix: string) => { const found = buttons().find(b => b.textContent?.startsWith(prefix)); assert.ok(found, prefix); return found; };
  const box = (id: string) => { const found = picker.root.querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`); assert.ok(found, id); return found; };
  const event = (type: string) => new window.Event(type) as never;
  return { window, picker, view, button, box, event, mutations, changes: () => changes, close: () => window.happyDOM.close() };
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
    for (const label of ["Pairing warning", "3 sent", "2 not yet sent", "sent to another profile", "Source changed", "Base: No cards", "older-source cards", "unknown-source cards", "deleted Anki notes", "No useful contrast", "Generating", "unresolved deliveries", "Source missing"]) assert.ok(text.includes(label), label);
    assert.deepEqual(f.picker.ids, [], "global selection starts empty");
    assert.equal(f.box("mixed").disabled, false);
    for (const id of ["dismissed", "running", "uncertain"]) assert.equal(f.box(id).disabled, true);
    assert.equal(f.picker.root.querySelector('[aria-label="Select history"]'), null);
    const historical = f.picker.root.querySelector("section")!;
    assert.equal(historical.hidden, false); assert.match(historical.querySelector("h4")!.textContent!, /Historical sources/);
    assert.match(historical.textContent!, /Statement for history/);
    assert.doesNotMatch(f.picker.root.querySelector("ul")!.textContent!, /Statement for history/);
    assert.equal([...f.picker.root.querySelectorAll("button")].filter(b => b.textContent === "Restore").length, 1);
    f.button("Restore").click();
    assert.deepEqual(f.mutations[0], ["restoreNode", "dismissed", "a".repeat(64)]);
    f.button("Don't card this").click();
    assert.deepEqual(f.mutations[1], ["dismissNode", "changed", "a".repeat(64)]);
  } finally { await f.close(); }
});

test("coverage picker uses shared No cards eligibility for visible bulk selection and prunes filter/search selections", async () => {
  const f = setup();
  try {
    const nodes = [row("alpha"), row("elsewhere", {}, { cards: { waiting: 0, sent: 0, sentElsewhere: 2 } }),
      row("changed", { state: "source-changed", uncarded: false }), row("generating", { generating: true, selectable: false, uncarded: false })];
    f.picker.update({ ...f.view, nodes });
    assert.match(f.button("Select all uncarded").textContent!, /2 ideas, up to 6 cards/);
    f.button("Select all uncarded").click(); assert.deepEqual(f.picker.ids, ["alpha", "elsewhere"]);
    const search = f.picker.root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = "alpha"; search.dispatchEvent(f.event("input")); assert.deepEqual(f.picker.ids, ["alpha"]);
    search.value = ""; search.dispatchEvent(f.event("input")); assert.deepEqual(f.picker.ids, ["alpha"], "search does not restore hidden choices");
    f.picker.select(["changed"]);
    const scope = f.picker.root.querySelector("select")!; scope.value = "uncarded"; scope.dispatchEvent(f.event("change"));
    assert.deepEqual(f.picker.ids, []); assert.equal(f.picker.root.textContent!.includes("Statement for changed"), false);
    f.button("Select all uncarded").click(); f.button("Clear selection").click();
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
    f.button("Clear selection").click(); f.picker.update(structuredClone(view)); assert.deepEqual(f.picker.ids, []);
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
    assert.ok(f.changes() > before); assert.match(f.picker.root.textContent!, /Coverage is stale/);
    assert.equal(f.box("alpha").disabled, true);
    assert.equal(f.button("Select all uncarded").disabled, true);
    assert.equal(f.button("Clear selection").disabled, true);
    assert.equal(f.button("Don't card this").disabled, true);
    f.picker.select([]); assert.deepEqual(f.picker.ids, ["alpha"], "stale reads cannot change explicit choices");
    f.picker.update(view); assert.equal(f.box("alpha").disabled, false); assert.deepEqual(f.picker.ids, ["alpha"]);
  } finally { await f.close(); }
});
