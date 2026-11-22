import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankPlace,
  clozeLeaks,
  clozeProblems,
  clozeTextField,
  duplicateIndexes,
  findProblems,
  resultSchemaFor,
  writerInstructions,
  type DraftCard,
  type WriterInput,
} from "../src/writer/index.ts";

const cloze = (front: string, back: string, kind: DraftCard["kind"] = "fact"): DraftCard => ({ kind, format: "cloze", front, back });
const ok = (front: string, back: string) => assert.deepEqual(clozeProblems(cloze(front, back)), [], `${front} / ${back}`);
const bad = (front: string, back: string, match: RegExp) => {
  const problems = clozeProblems(cloze(front, back));
  assert.ok(problems.some((p) => match.test(p)), `${front} / ${back}: ${problems.join("; ") || "no problems"}`);
};

test("blank position", () => {
  assert.equal(blankPlace("\\([\\hbar] = {{blank}}\\)")?.where, "math");
  assert.equal(blankPlace("femto- means {{blank}}.")?.where, "prose");
  assert.equal(blankPlace("`x = {{blank}}`")?.where, "code");
  assert.equal(blankPlace("no blank"), undefined);
  assert.equal(blankPlace("{{blank}} and {{blank}}"), undefined);
});

test("valid cloze cards pass", () => {
  ok("In SI units, \\([\\hbar] = {{blank}}\\)", "\\mathrm{J\\,s}");
  ok("The prefix femto- (f) means {{blank}}.", "\\(10^{-15}\\)");
  ok("Rest energy of a particle of mass \\(m\\): \\(E_0 = {{blank}}\\)", "mc^2");
  ok("A function that calls itself is a {{blank}} function.", "recursive");
  ok("Python's null value is {{blank}}.", "`None`");
  ok("\\(a_n = {{blank}}\\)", "n![z^n](1-z)^{-1}");
});

test("structure checks", () => {
  bad("no placeholder", "x", /exactly once/);
  bad("{{blank}} and {{blank}}", "x", /exactly once/);
  bad("\\(E_0 = {{blank}}\\)", "\\(mc^2\\)", /raw TeX/);
  bad("\\(x = {{blank}}}\\)", "\\frac{1}{2", /whole TeX group/);
  bad("Value: {{blank}} b\\)", "\\(a", /complete on its own/);
  bad("x is {{blank}}", "- a\n- b", /one line|inline/);
  bad("`x = {{blank}}`", "1", /outside inline code/);
  bad("**bold {{blank}}** end", "x** y **z", /formatting|formatted/);
  bad("[docs]({{blank}})", "https://example.org", /link|Markdown|formatted/);
  bad("$$E = {{blank}}$$", "mc^2", /one line with inline maths/);
  assert.ok(clozeProblems({ kind: "why", format: "cloze", front: "{{blank}}", back: "x" }).some((p) => /only fact and equation/.test(p)));
});

test("leak checks by blank position", () => {
  assert.equal(clozeLeaks("\\(E_0 = mc^2 = {{blank}}\\)", "mc^2"), true);
  assert.equal(clozeLeaks("\\(E_0 = {{blank}}\\)", "mc^2"), false);
  assert.equal(clozeLeaks("\\(F = m{{blank}}\\)", "a"), false);
  assert.equal(clozeLeaks("\\(a = {{blank}}\\), and \\(a\\) is it", "a"), true);
  assert.equal(clozeLeaks("Recursive: a {{blank}} function", "recursive"), true);
});

test("Anki text field escaping", () => {
  const field = (front: string, back: string) => clozeTextField(front, back);
  assert.equal(field("\\(\\vec{p} = {{blank}}\\)", "\\gamma m \\vec{v}"), "<p>\\(\\vec{p} = {{c1::\\gamma m \\vec{v}<!-- -->}}\\)</p>");
  assert.equal(field("\\(\\frac{1}{\\sqrt{2}} = {{blank}}\\)", "x"), "<p>\\(\\frac{1}{\\sqrt{2}<!-- -->} = {{c1::x}}\\)</p>");
  assert.equal(field("\\(x^{{{blank}}}\\)", "2"), "<p>\\(x^{<!-- -->{{c1::2}}<!-- -->}\\)</p>");
  assert.equal(field("a::b {{blank}}", "c::d"), "<p>a::b {{c1::c:<!-- -->:d}}</p>");
  assert.equal(field("say {{c1::x}} then {{blank}}", "y"), "<p>say {<!-- -->{c1::x}<!-- -->} then {{c1::y}}</p>");
  assert.equal(field("triple }}} {{blank}}", "y"), "<p>triple }<!-- -->}<!-- -->} {{c1::y}}</p>");
});

const input = (cloze?: "auto" | "prefer"): WriterInput => ({
  version: 1, maxCardsPerNode: 2, enabledKinds: ["fact", "equation"], ...(cloze ? { cloze } : {}),
  targets: [{ nodeId: "n1", name: "N", statement: "S", aliases: [], concludedBy: [], feeds: [], neighbours: [], existingCards: [] }],
});

test("mode gate applies to writer output only", () => {
  const result = { targets: [{ nodeId: "n1", cards: [cloze("In SI units, \\([\\hbar] = {{blank}}\\)", "\\mathrm{J\\,s}")] }] };
  assert.ok(findProblems(result, input()).some((p) => /cloze cards are off/.test(p)));
  assert.deepEqual(findProblems(result, input("auto")), []);
  assert.deepEqual(clozeProblems(result.targets[0]!.cards[0]!), []);
});

test("basic cards keep today's contract, including a literal {{blank}}", () => {
  const result = { targets: [{ nodeId: "n1", cards: [{ kind: "fact" as const, front: "What does the template token `{{blank}}` mark?", back: "Where the hidden part goes." }] }] };
  assert.deepEqual(findProblems(result, input()), []);
});

test("duplicate keys include format", () => {
  const a = { kind: "fact", front: "x {{blank}}", back: "y" };
  assert.deepEqual(duplicateIndexes([a, { ...a, format: "cloze" }]), [-1, -1]);
  assert.deepEqual(duplicateIndexes([a, { ...a, format: "basic" }]), [-1, 0]);
});

test("Off instructions and schema are unchanged by the cloze option", () => {
  assert.equal(writerInstructions({ kinds: ["fact", "equation"] }), writerInstructions({ kinds: ["fact", "equation"], cloze: false }));
  assert.equal(JSON.stringify(resultSchemaFor(["fact", "equation"])), JSON.stringify(resultSchemaFor(["fact", "equation"], { cloze: false })));
  assert.ok(!writerInstructions({ kinds: ["fact", "equation"] }).includes("{{blank}}"));
  assert.ok(writerInstructions({ kinds: ["fact", "equation"], cloze: true }).includes("{{blank}}"));
  assert.ok(JSON.stringify(resultSchemaFor(["fact"], { cloze: true })).includes('"format"'));
});
