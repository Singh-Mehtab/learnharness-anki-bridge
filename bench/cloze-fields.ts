// FI-8: build Anki cloze Text fields plus the expected question and answer
// HTML, for bench/cloze-anki-check.py to verify against Anki's own library.
// Usage: node bench/cloze-fields.ts <run.json | --samples> > fields.json

import { readFileSync } from "node:fs";
import { clozeProblems, clozeTextField, questionPreview, assemble, laidOutFront, type DraftCard } from "../src/writer/index.ts";
import { renderMarkdown as render } from "../src/anki/render.ts";

const SAMPLES: Array<[string, string]> = [
  ["In SI units, \\([\\hbar] = {{blank}}\\)", "\\mathrm{J\\,s}"],
  ["The prefix femto- (f) means {{blank}}.", "\\(10^{-15}\\)"],
  ["Rest energy of a particle of mass \\(m\\): \\(E_0 = {{blank}}\\)", "mc^2"],
  ["\\(\\vec{p} = {{blank}}\\)", "\\gamma m \\vec{v}"],
  ["\\(\\frac{1}{\\sqrt{2}} \\approx {{blank}}\\)", "0.707"],
  ["\\(x^{{{blank}}}\\)", "2"],
  ["a::b and {{blank}}", "c::d"],
  ["say {{c1::x}} then {{blank}}", "y"],
  ["Python's null value is {{blank}}.", "`None`"],
  ["**Bold** before {{blank}} and \\(\\{a\\}\\)", "\\(\\frac{a}{b}\\)"],
  ["\\(a_n = {{blank}}\\)", "n![z^n](1-z)^{-1}"],
];

const arg = process.argv[2];
const cards: Array<{ id: string; front: string; back: string }> = arg === "--samples"
  ? SAMPLES.map(([front, back], i) => ({ id: `sample-${i}`, front, back }))
  : (JSON.parse(readFileSync(arg!, "utf8")).cards as Array<DraftCard & { id: string }>)
      .filter((c) => c.format === "cloze").map(({ id, front, back }) => ({ id, front, back }));

const out = cards.map((c) => {
  const problems = clozeProblems({ kind: "fact", format: "cloze", front: c.front, back: c.back });
  return {
    id: c.id,
    problems,
    text: problems.length ? null : clozeTextField(c.front, c.back),
    expectQ: render(questionPreview(c.front)),
    expectA: render(assemble(laidOutFront(c.front), c.back)),
  };
});
console.log(JSON.stringify(out, null, 2));
