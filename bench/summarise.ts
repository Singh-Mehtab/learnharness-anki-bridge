// Summarise scored bench runs against the 0.1.0 pass criteria:
// at least two in three cards kept as is or with small edits, no answer leaks,
// no factual errors in kept cards. Writes summary.md next to each run.
//
// Usage: node bench/summarise.ts [bench-output/<run> ...]   (default: newest core and trial runs)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchCard, BenchRun, CardScore, Scores } from "./types.ts";

const root = resolve("bench-output");
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2).map((d) => resolve(d))
  : ["core", "trial"]
      .map((m) => readdirSync(root).filter((d) => d.includes(`-${m}-`) && existsSync(join(root, d, "run.json"))).sort().at(-1))
      .filter(Boolean)
      .map((d) => join(root, d!));

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const kept = (s?: CardScore) => s?.verdict === "keep" || s?.verdict === "small-edit";

function table(cards: BenchCard[], scores: Scores, key: (c: BenchCard) => string): string {
  const groups = new Map<string, BenchCard[]>();
  for (const c of cards) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  const rows = [...groups.entries()].map(([k, cs]) => {
    const sc = cs.map((c) => scores.cards[c.id] ?? {});
    const v = (x: string) => sc.filter((s) => s.verdict === x).length;
    const scored = sc.filter((s) => s.verdict).length;
    return `| ${k} | ${cs.length} | ${scored} | ${v("keep")} | ${v("small-edit")} | ${v("big-edit")} | ${v("drop")} | ${pct(v("keep") + v("small-edit"), scored)} | ${sc.filter((s) => s.leak).length} | ${sc.filter((s) => s.error).length} |`;
  });
  return ["| Group | Cards | Scored | Keep | Small edit | Big edit | Drop | Kept | Leaks | Errors |", "|---|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

for (const dir of dirs) {
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as BenchRun;
  const scores: Scores = existsSync(join(dir, "scores.json")) ? JSON.parse(readFileSync(join(dir, "scores.json"), "utf8")) : { cards: {}, skips: {} };
  const cards = run.cards;
  const sc = (c: BenchCard) => scores.cards[c.id] ?? {};
  const scored = cards.filter((c) => sc(c).verdict);
  const keptCards = scored.filter((c) => kept(sc(c)));
  const leaks = cards.filter((c) => sc(c).leak);
  const keptErrors = keptCards.filter((c) => sc(c).error);
  const allScored = scored.length === cards.length;
  const keepRate = scored.length ? keptCards.length / scored.length : 0;
  const pass = allScored && keepRate >= 2 / 3 && !leaks.length && !keptErrors.length;
  const calls = run.batches.reduce((n, b) => n + b.attempts.length, 0);
  const firstTry = run.batches.filter((b) => b.accepted && b.attempts.length === 1).length;
  const modelSkips = run.skips.filter((s) => s.by === "model");
  const skipAgree = modelSkips.filter((s) => scores.skips[`${s.set}:${s.nodeId}`]?.agree === true).length;

  const lines = [
    `# Bench summary: ${run.runId}`,
    "",
    `Mode ${run.mode}, model ${run.model}, cap ${run.maxCardsPerNode} per node, kinds ${run.enabledKinds.join(", ")}.`,
    `${cards.length} cards for ${new Set(cards.map((c) => `${c.set}:${c.nodeId}`)).size} nodes; ${run.skips.length} skipped (${modelSkips.length} by the model${modelSkips.length ? `, you agreed with ${skipAgree}` : ""}).`,
    `${run.batches.length} requests, ${calls} calls, ${firstTry} passed validation first time; ${cards.filter((c) => c.unvalidated).length} cards never passed.`,
    "",
    `## Verdict: ${!allScored ? `not finished (${scored.length}/${cards.length} scored)` : pass ? "PASS" : "FAIL"}`,
    "",
    `- Kept as is or with small edits: ${keptCards.length}/${scored.length} (${pct(keptCards.length, scored.length)}; needs 67%) ${keepRate >= 2 / 3 ? "✓" : "✗"}`,
    `- Answer leaks: ${leaks.length} (needs 0) ${leaks.length ? "✗" : "✓"}`,
    `- Factual errors in kept cards: ${keptErrors.length} (needs 0) ${keptErrors.length ? "✗" : "✓"}`,
    `- Errors in any card: ${cards.filter((c) => sc(c).error).length}; unclear: ${cards.filter((c) => sc(c).unclear).length}`,
    "",
    "## By subject",
    "",
    table(cards, scores, (c) => `${c.set} (${c.origin})`),
    "",
    "## By kind",
    "",
    table(cards, scores, (c) => c.kind),
    "",
    "## Length (words; targets: front 25, back 10)",
    "",
    "| | Front median | Front over 25 | Back median | Back over 10 |",
    "|---|---|---|---|---|",
    ...(
      [
        ["all", cards],
        ["kept", keptCards],
        ["big edit or drop", scored.filter((c) => !kept(sc(c)))],
      ] as Array<[string, BenchCard[]]>
    ).map(
      ([label, cs]) =>
        `| ${label} | ${median(cs.map((c) => c.frontWords))} | ${cs.filter((c) => c.frontWords > 25).length}/${cs.length} | ${median(cs.map((c) => c.backWords))} | ${cs.filter((c) => c.backWords > 10).length}/${cs.length} |`,
    ),
  ];
  const flagged = cards.filter((c) => sc(c).leak || sc(c).error || sc(c).note);
  if (flagged.length) {
    lines.push("", "## Flagged and annotated cards", "");
    for (const c of flagged) {
      const s = sc(c);
      const tags = [s.verdict, s.leak && "leak", s.error && "error", s.unclear && "unclear"].filter(Boolean).join(", ");
      lines.push(`- **${c.nodeName}** (${c.kind}; ${tags}): ${c.front.replace(/\n/g, " ")} → ${c.back.replace(/\n/g, " ")}${s.note ? `\n  - Note: ${s.note}` : ""}`);
    }
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, "summary.md"), text);
  console.log(text);
}
