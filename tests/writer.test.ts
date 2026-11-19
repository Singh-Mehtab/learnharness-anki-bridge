import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTarget,
  capText,
  containsName,
  findProblems,
  givesAwayAnswer,
  messageText,
  neighbours,
  pack,
  sourcePassage,
  trimToFit,
  validateResult,
  writerInstructions,
  writerPrompt,
  FLAGGED_CARD_CAP,
  duplicateIndexes,
  type GraphLike,
  type WriterInput,
} from "../src/writer/index.ts";

const graph: GraphLike = {
  propositions: [
    { id: "a", name: "Premise A", statement: "A holds.", aliases: [], provenance: [{ chatId: "c1", messageId: "m1" }] },
    { id: "b", name: "Premise B", statement: "B holds.", aliases: [] },
    { id: "c", name: "Conclusion C", statement: "A and B give C.", aliases: ["C rule"] },
    { id: "d", name: "Sibling D", statement: "A gives D with E.", aliases: [] },
    { id: "e", name: "Premise E", statement: "E holds.", aliases: [] },
    { id: "f", name: "Downstream F", statement: "C gives F.", aliases: [] },
  ],
  chains: [
    { id: "ch1", premises: ["a", "b"], conclusion: "c" },
    { id: "ch2", premises: ["a", "e"], conclusion: "d" },
    { id: "ch3", premises: ["c"], conclusion: "f" },
  ],
};

test("buildTarget keeps concluding chains whole and lists feeds", () => {
  const t = buildTarget(graph, "c");
  assert.deepEqual(t.concludedBy.map((c) => c.premises.map((p) => p.id)), [["a", "b"]]);
  assert.deepEqual(t.feeds.map((f) => f.conclusion.id), ["f"]);
  assert.deepEqual(t.aliases, ["C rule"]);
});

test("neighbours rank siblings first", () => {
  assert.equal(neighbours(graph, "c")[0], "d");
  assert.ok(!neighbours(graph, "c").includes("c"));
});

test("buildTarget throws on a broken chain", () => {
  const broken: GraphLike = { ...graph, chains: [{ id: "x", premises: ["zz"], conclusion: "c" }] };
  assert.throws(() => buildTarget(broken, "c"), /Incomplete reasoning chain/);
});

test("messageText prefers send_to_user over text parts", () => {
  const msg = {
    id: "m1",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "draft" },
      { type: "toolCall", name: "send_to_user", arguments: { message: "taught text" } },
    ],
  };
  assert.equal(messageText(msg as never), "taught text");
  assert.equal(messageText({ content: [{ type: "text", text: "only text" }] }), "only text");
});

test("sourcePassage follows the first provenance with a messageId and caps it", () => {
  const long = `${"Para one. ".repeat(100)}\n\n${"Para two. ".repeat(100)}`;
  const chat = { messages: [{ id: "m1", content: [{ type: "toolCall", name: "send_to_user", arguments: { message: long } }] }] };
  const s = sourcePassage(graph.propositions[0], (id) => (id === "c1" ? chat : null));
  assert.ok(s && s.length <= 1510 && s.endsWith("[…]"));
  assert.equal(sourcePassage(graph.propositions[1], () => chat), undefined);
});

test("capText leaves short text alone", () => {
  assert.equal(capText("short"), "short");
});

test("givesAwayAnswer and containsName", () => {
  assert.ok(givesAwayAnswer("Which came first, 1980 or 1982? (1980)", "1980"));
  assert.ok(!givesAwayAnswer("What does the integral of $e^{-\\alpha x}$ from 0 to infinity equal?", "$\\frac{1}{\\alpha}$"));
  assert.ok(!givesAwayAnswer("anything", "$i$"));
  // Maths and code compare as whole expressions, not command names.
  assert.ok(!givesAwayAnswer("Which single number is $\\langle f|f\\rangle$ for $f(x)$, versus $|f(x)|^2$?", "$\\int|f(x)|^2dx$"));
  assert.ok(givesAwayAnswer("Since $\\int|f(x)|^2 dx$ is a total, which quantity is it?", "$\\int |f(x)|^2dx$"));
  assert.ok(!givesAwayAnswer("Fix `callbacks = [lambda: print(name) for name in names]` so each prints its own name.", "`lambda name=name: print(name)`"));
  assert.ok(!givesAwayAnswer("Is $(1,0)^T$ orthogonal to $(0,1)^T$? What is their bracket?", "$0$"));
  assert.ok(givesAwayAnswer("The bracket is $0$. Are the states orthogonal? Give the bracket value: zero or not", "Zero, $0$"));
  assert.ok(givesAwayAnswer("Costs \\$5 each", "\\$5"));
  assert.ok(!givesAwayAnswer("What does one cost?", "\\$5"));
  assert.ok(containsName("Use the **Premise A** here", "Premise A"));
  assert.ok(!containsName("Premises are listed", "Premise A"));
});

const input = (overrides: Partial<WriterInput> = {}): WriterInput => ({
  version: 1,
  maxCardsPerNode: 2,
  enabledKinds: ["recall", "why", "compose", "discriminate"],
  targets: [buildTarget(graph, "c"), buildTarget(graph, "b")],
  ...overrides,
});

test("a valid result passes", () => {
  const result = {
    targets: [
      { nodeId: "c", cards: [{ kind: "why", front: "Why must C hold here?", back: "A and B together" }] },
      { nodeId: "b", cards: [], skipReason: "Prior knowledge." },
    ],
  };
  assert.deepEqual(findProblems(result, input()), []);
  assert.doesNotThrow(() => validateResult(result, { input: input() }));
});

test("validator catches target, kind, leak, name, format and duplicate problems", () => {
  const i = input({
    enabledKinds: ["recall", "why"],
    targets: [
      { ...buildTarget(graph, "c"), existingCards: [{ kind: "recall", front: "Old front?", back: "Old" }] },
      buildTarget(graph, "b"),
    ],
  });
  const result = {
    targets: [
      {
        nodeId: "c",
        cards: [
          { kind: "compose", front: "Given A and B, what follows?", back: "Conclusion C" },
          { kind: "recall", front: "Old front?", back: "something else" },
          { kind: "recall", front: "When does Conclusion C apply? It is the rule", back: "rule" },
        ],
      },
      { nodeId: "zzz", cards: [] },
      { nodeId: "c", cards: [] },
    ],
  };
  const problems = findProblems(result, i).join("\n");
  assert.match(problems, /not enabled/);
  assert.match(problems, /cap is 2/);
  assert.match(problems, /repeats an existing card/);
  assert.match(problems, /must not contain the idea's name/);
  assert.match(problems, /gives the answer away/);
  assert.match(problems, /Unknown target "zzz"/);
  assert.match(problems, /more than once/);
  assert.match(problems, /Missing targets: b/);
});

test("why and discriminate need graph support; images rejected; skipReason required", () => {
  const i = input({ targets: [buildTarget(graph, "b")] });
  i.targets[0].neighbours = [];
  const result = {
    targets: [
      {
        nodeId: "b",
        cards: [
          { kind: "why", front: "Why?", back: "Because" },
          { kind: "discriminate", front: "Which fits ![x](y)?", back: "this one" },
        ],
      },
    ],
  };
  const problems = findProblems(result, i).join("\n");
  assert.match(problems, /needs a chain/);
  assert.match(problems, /needs a listed neighbour/);
  assert.match(problems, /images/);
  assert.match(findProblems({ targets: [{ nodeId: "b", cards: [] }] }, i).join(), /skipReason/);
});

test("fenced code is allowed while images and Mermaid remain forbidden", () => {
  const i = input({ targets: [buildTarget(graph, "b")] });
  const result = (front: string) => ({ targets: [{ nodeId: "b", cards: [{ kind: "recall", front, back: "2" }] }] });
  assert.deepEqual(findProblems(result("What prints?\n```python\nx = [1]\nx.append(2)\nprint(len(x))\n```"), i), []);
  assert.deepEqual(findProblems(result("What prints?\n~~~python\nx = [1]\nx.append(2)\nprint(len(x))\n~~~"), i), []);
  assert.match(findProblems(result(String.raw`What is the magnitude of \(a+b?`), i).join(), /Unpaired or empty TeX delimiters/);
  assert.deepEqual(findProblems(result(String.raw`What is the magnitude of \(a+b\)?`), i), []);
  assert.deepEqual(findProblems(result('What prints?\n```tex\n\\(unclosed\n```'), i), []);
  assert.match(findProblems(result("```mermaid\ngraph TD; A-->B\n```"), i).join(), /Mermaid/);
  assert.match(findProblems(result('<img src="x">'), i).join(), /images/);
});

test("leak checking treats a fenced block as code, not prose or maths", () => {
  const front = 'What prints?\n```python\nx = "$answer$"\nprint(x)\n```';
  assert.ok(givesAwayAnswer(front, '```python\nx = "$answer$"\nprint(x)\n```'));
  assert.ok(!givesAwayAnswer(front, "answer"));
  assert.ok(!givesAwayAnswer("~~~python\nprint(10)\n~~~", "0"));
  assert.ok(!givesAwayAnswer('```python\nprint("a b")\n```', '`print("ab")`'));
  assert.match(writerInstructions(), /multiline fenced code blocks are allowed/);
});

test("pack sets allowedKinds from chains and neighbours, and skips nodes no kind fits", () => {
  const { batches, skipped } = pack(graph, ["c", "b"], () => ({}), { maxCardsPerNode: 2, enabledKinds: ["why", "recall"] });
  const kinds = Object.fromEntries(batches.flatMap((b) => b.input.targets).map((t) => [t.nodeId, t.allowedKinds]));
  assert.deepEqual(kinds, { c: ["why", "recall"], b: ["recall"] });
  assert.equal(skipped.length, 0);
  const onlyWhy = pack(graph, ["b"], () => ({}), { maxCardsPerNode: 2, enabledKinds: ["why"] });
  assert.equal(onlyWhy.batches.length, 0);
  assert.match(onlyWhy.skipped[0].reason, /None of the enabled card kinds/);
});

test("pack respects the chunk budget, rides big nodes alone and skips oversized ones", () => {
  const ids = graph.propositions.map((n) => n.id);
  const { batches, skipped } = pack(graph, ids, () => ({}), { maxCardsPerNode: 2, enabledKinds: ["recall"], chunkBudget: 250 });
  assert.equal(skipped.length, 0);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap((b) => b.input.targets.map((t) => t.nodeId)), ids);
  for (const b of batches) assert.ok(b.input.targets.length === 1 || b.inputTokens <= 250);

  const huge = "x".repeat(60000);
  const r = pack(graph, ["a", "b"], (id) => (id === "a" ? { source: huge } : {}), { maxCardsPerNode: 2, enabledKinds: ["recall"] });
  assert.deepEqual(r.skipped.map((s) => s.nodeId), ["a"]);
  assert.match(r.skipped[0].reason, /Too large/);

  const limited = pack(graph, ids, () => ({}), { maxCardsPerNode: 2, enabledKinds: ["recall"], maxTokens: 900 });
  assert.ok(limited.batches.every((b) => b.input.targets.length <= 1));
});

test("trimToFit drops feeds whole before giving up", () => {
  const t = buildTarget(graph, "c", { existingCards: [{ kind: "recall", front: "q".repeat(400), back: "a" }] });
  const trimmed = trimToFit(t, 200);
  assert.ok(trimmed);
  assert.equal(trimmed.existingCards.length, 0);
  assert.deepEqual(trimmed.concludedBy, t.concludedBy);
});

test("instructions describe only requested kinds; prompt carries cap and kinds", () => {
  const core = writerInstructions();
  assert.ok(core.includes("- discriminate:") && !core.includes("mini-problem"));
  const trial = writerInstructions({ kinds: ["mini-problem", "spot-the-mistake"], completion: "Return JSON." });
  assert.ok(trial.includes("- mini-problem:") && !trial.includes("- recall:") && trial.endsWith("Return JSON."));
  const p = writerPrompt(input());
  assert.match(p, /at most 2 cards per target/);
  assert.match(p, /Enabled kinds: recall, why, compose, discriminate/);
});

// 0.7.2 (#34): fact and equation by default; flags are explicit requests.
test("default instructions put facts first and describe every shipping kind", () => {
  const text = writerInstructions();
  for (const k of ["fact", "equation", "steps", "apply", "why", "compose", "discriminate"]) assert.ok(text.includes(`- ${k}:`), `missing kind ${k}`);
  assert.ok(!text.includes("- recall:") && !text.includes("- mini-problem:"));
  assert.ok(text.includes("Standard reference facts"));
  assert.ok(!text.includes("Not \"What is <name>?\""), "fact cards may ask directly");
});

test("a flagged target may exceed the per-node cap, up to FLAGGED_CARD_CAP", () => {
  const flagged = buildTarget(graph, "b", { flagged: true });
  assert.equal(flagged.maxCards, FLAGGED_CARD_CAP);
  assert.equal(buildTarget(graph, "b", { flagNote: "all prefixes" }).flagged, true);
  assert.equal(buildTarget(graph, "b").maxCards, undefined);
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "fact", front: `Prefix question ${i}?`, back: `Answer number ${i}` }));
  const fi = input({ enabledKinds: ["fact"], targets: [flagged] });
  assert.deepEqual(findProblems({ targets: [{ nodeId: "b", cards: cards(5) }] }, fi), []);
  assert.match(findProblems({ targets: [{ nodeId: "b", cards: cards(FLAGGED_CARD_CAP + 1) }] }, fi).join(), /the cap is 12/);
  const plain = input({ enabledKinds: ["fact"], targets: [buildTarget(graph, "b")] });
  assert.match(findProblems({ targets: [{ nodeId: "b", cards: cards(3) }] }, plain).join(), /the cap is 2/);
  const packed = pack(graph, ["b", "c"], (id) => (id === "b" ? { flagged: true } : {}), { maxCardsPerNode: 2, enabledKinds: ["fact"] });
  assert.equal(packed.batches[0].outputAllowance, 300 * 12 + 200 + 300 * 2 + 200);
});

test("fact cards may name the idea; apply cards may not", () => {
  const t = buildTarget(graph, "b");
  const fi = input({ enabledKinds: ["fact", "apply"], targets: [t] });
  assert.deepEqual(findProblems({ targets: [{ nodeId: "b", cards: [{ kind: "fact", front: "What does Premise B say?", back: "It holds always" }] }] }, fi), []);
  assert.match(findProblems({ targets: [{ nodeId: "b", cards: [{ kind: "apply", front: "Where does Premise B apply?", back: "Situations like this" }] }] }, fi).join(), /must not contain the idea's name/);
});

test("duplicateIndexes finds the same fact drafted by separate requests, not same-answer different facts", () => {
  const cards = [
    { front: "What are the SI units of the speed of light \\(c\\)?", back: "\\(\\mathrm{m\\,s^{-1}}\\)" },
    { front: "When restoring SI units from natural units, what units do you use for \\(c\\)?", back: "\\(\\mathrm{m\\,s^{-1}}\\)" },
    { front: "What power of ten does the SI prefix femto- (\\(\\mathrm{f}\\)) denote?", back: "$$10^{-15}$$" },
    { front: "What power of ten does the SI prefix femto- (f) denote?", back: "\\(10^{-15}\\)" },
    { front: "In natural units, what is the dimension of a length?", back: "\\(\\mathrm{eV^{-1}}\\)" },
    { front: "In natural units, what is the dimension of a time interval?", back: "\\(\\mathrm{eV^{-1}}\\)" },
    { front: "What is the approximate rest energy of a proton, in MeV?", back: "About \\(940\\ \\mathrm{MeV}\\)" },
    { front: "Roughly what is a proton's rest energy in MeV?", back: "\\(940\\ \\mathrm{MeV}\\)" },
  ];
  assert.deepEqual(duplicateIndexes(cards), [-1, 0, -1, 2, -1, -1, -1, 6]);
});

test("duplicateIndexes treats the same whole equation as one fact, however it is asked", () => {
  const cards = [
    { front: "Restoring SI units: relate a length \\(L_{\\rm SI}\\) to its natural-unit value.", back: "$$L_{\\rm SI} = \\hbar c\\,L_{\\rm NU}$$" },
    { front: "Convert a length from natural units to SI.", back: "$$L_{\\rm SI} = \\hbar c\\, L_{\\rm NU}$$" },
    { front: "In natural units, what is the dimension of time?", back: "\\([t] = [E]^{-1}\\)" },
    { front: "In natural units, what is the dimension of length in terms of energy?", back: "\\([x] = [E]^{-1}\\)" },
  ];
  assert.deepEqual(duplicateIndexes(cards), [-1, 0, -1, -1]);
});
