// Result validator for the card writer (worker validateResult). Pure, no side
// effects. Collects every problem so one retry can fix them all.
//
// givesAwayAnswer is adapted (AGPL-3.0) from Twig,
// src/agent/subagents/card-writer.ts, https://github.com/amoghu1s1/twig
// Twig compares words and numbers only. Here maths and code are compared as
// whole expressions, because LaTeX command names (\langle) and code
// identifiers repeat on both sides without giving anything away.

import { renderMarkdown } from "../anki/render.ts";
import type { DraftCard, WriterInput, WriterTarget } from "./types.ts";
import { capFor, kindMisfit } from "./kinds.ts";
import { clozeCardProblems } from "./cloze.ts";

// Code blocks come first: dollars, backticks and LaTeX inside them are code.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;
const SEGMENT = /\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`\n]+`/g;

/** Maths and code segments, normalised for comparison. */
export function answerSegments(text: string): string[] {
  const blocks: string[] = [];
  const prose = text.replace(FENCE, (_, _fence, code: string) => { blocks.push(code); return " "; });
  const inline = (prose.replace(/\\\$/g, "").match(SEGMENT) ?? []).map((s) => {
    if (s.startsWith("`")) return s.slice(1, -1).trim();
    return (s.startsWith("\\") ? s.slice(2, -2) : s.replace(/^\$\$|\$\$$|^\$|\$$/g, ""))
      .replace(/\\(?:left|right|[,;!]|displaystyle)/g, "").replace(/\s+/g, "");
  });
  // Preserve code whitespace: Python indentation and spaces in strings matter.
  return [...blocks.map((s) => s.trim()), ...inline].filter((s) => s.length > 0);
}

/** Distinctive prose terms outside maths and code: numbers and words of
 *  4+ letters, lower-cased. */
export function answerTerms(text: string): string[] {
  return (
    text
      .replace(FENCE, " ")
      .replace(/\\\$/g, "")
      .replace(SEGMENT, " ")
      .toLowerCase()
      .replace(/\*\*/g, "")
      .match(/\d+|[a-zÀ-ɏ]{4,}/g) ?? []
  );
}

/** The front gives the answer away: every distinctive prose term of the
 *  back is on the front, and every maths or code segment of the back appears
 *  whole on the front. Very short segments ($0$, $i$) must match a whole
 *  front segment, since they occur inside unrelated expressions. A back with
 *  neither terms nor segments never counts as a leak. */
export function givesAwayAnswer(front: string, back: string): boolean {
  const terms = answerTerms(back);
  const segments = answerSegments(back);
  if (!terms.length && !segments.length) return false;
  const shownTerms = new Set(answerTerms(front));
  const frontSegments = answerSegments(front);
  const shown = (s: string) => (s.length < 3 ? frontSegments.includes(s) : frontSegments.some((f) => f.includes(s)));
  return terms.every((t) => shownTerms.has(t)) && segments.every(shown);
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[*_`$\\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function containsName(front: string, name: string): boolean {
  const n = normalise(name);
  return n.length > 0 && ` ${normalise(front)} `.includes(` ${n} `);
}

export const FORBIDDEN: Array<[RegExp, string]> = [
  [/!\[[^\]]*\]\(/, "images"],
  [/<img\b/i, "images"],
  [/\bmermaid\b/i, "Mermaid"],
];

export function cardProblems(card: DraftCard, target: WriterTarget, input: WriterInput): string[] {
  const problems: string[] = [];
  const front = typeof card.front === "string" ? card.front : "";
  const quote = `"${front.slice(0, 60)}${front.length > 60 ? "…" : ""}"`;
  if (!input.enabledKinds.includes(card.kind)) problems.push(`${quote}: kind "${card.kind}" is not enabled`);
  else {
    const misfit = kindMisfit(card.kind, target);
    if (misfit) problems.push(`${quote}: ${misfit}; allowed kinds for this target: ${(target.allowedKinds ?? input.enabledKinds).join(", ")}`);
  }
  const blankFront = !front.trim();
  const blankBack = typeof card.back !== "string" || !card.back.trim();
  if (blankFront) problems.push("a card has a blank front");
  if (blankBack) problems.push(`${quote}: blank back`);
  if (blankFront || blankBack) return problems;
  // FI-8: C1 format value, C2a mode gate (writer output only), then the cloze
  // content checks, which replace the standalone front/back checks below.
  const format = (card as { format?: unknown }).format;
  if (format !== undefined && format !== "basic" && format !== "cloze") problems.push(`${quote}: format must be "basic" or "cloze"`);
  if (format === "cloze") {
    if (!input.cloze) problems.push(`${quote}: cloze cards are off for this request; write a basic card`);
    for (const p of clozeCardProblems(card)) problems.push(`${quote}: ${p}`);
    return problems;
  }
  if (givesAwayAnswer(card.front, card.back)) {
    problems.push(`${quote}: the front gives the answer away (every key term of the back is already on the front)`);
  }
  if ((card.kind === "apply" || card.kind === "recall" || card.kind === "discriminate") && containsName(card.front, target.name)) {
    problems.push(`${quote}: a ${card.kind} front must not contain the idea's name "${target.name}"`);
  }
  for (const field of [card.front, card.back, card.extra ?? ""]) {
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(field)) problems.push(`${quote}: ${label} are not allowed`);
    }
    try { renderMarkdown(field, { checkMath: true }); }
    catch (error) { problems.push(`${quote}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return problems;
}

/** All problems with a result, as correction messages. Empty means valid. */
export function findProblems(result: unknown, input: WriterInput): string[] {
  const problems: string[] = [];
  const rows = (result as { targets?: unknown })?.targets;
  if (!Array.isArray(rows)) return ["Return an object with a targets array."];
  const byId = new Map(input.targets.map((t) => [t.nodeId, t]));
  const seen = new Set<string>();
  for (const row of rows as Array<{ nodeId?: unknown; cards?: unknown; skipReason?: unknown }>) {
    const nodeId = typeof row?.nodeId === "string" ? row.nodeId : "";
    const target = byId.get(nodeId);
    if (!target) {
      problems.push(`Unknown target "${nodeId}": use the nodeIds from the input verbatim.`);
      continue;
    }
    if (seen.has(nodeId)) {
      problems.push(`Target ${nodeId} appears more than once: return each target once.`);
      continue;
    }
    seen.add(nodeId);
    if (!Array.isArray(row.cards)) {
      problems.push(`Target ${nodeId}: cards must be an array.`);
      continue;
    }
    const cards = row.cards as DraftCard[];
    const cap = capFor(target, input.maxCardsPerNode);
    if (cards.length > cap) {
      problems.push(`Target ${nodeId}: ${cards.length} cards, but the cap is ${cap}.`);
    }
    if (!cards.length && (typeof row.skipReason !== "string" || !row.skipReason.trim())) {
      problems.push(`Target ${nodeId}: no cards, so give a skipReason.`);
    }
    const seenCards = new Set<string>();
    for (const card of cards) {
      for (const p of cardProblems(card, target, input)) problems.push(`Target ${nodeId}: ${p}.`);
      if (typeof card.front === "string" && card.front.trim()) {
        // Same front or answer alone is not proof of a duplicate. Earlier
        // requests are handled independently at apply time against live cards.
        const key = JSON.stringify([card.kind, card.format ?? "basic", card.front, card.back, card.extra ?? ""]);
        if (seenCards.has(key)) problems.push(`Target ${nodeId}: repeats a card in this result: "${card.front.slice(0, 60)}".`);
        seenCards.add(key);
      }
    }
  }
  const missing = input.targets.map((t) => t.nodeId).filter((id) => !seen.has(id));
  if (missing.length) problems.push(`Missing targets: ${missing.join(", ")}.`);
  return problems;
}

/** Worker validateResult: throws one message listing every problem. */
export function validateResult(result: unknown, context: { input: unknown }): void {
  const problems = findProblems(result, context.input as WriterInput);
  if (problems.length) throw new Error(`Fix these problems and submit again:\n- ${problems.join("\n- ")}`);
}

/** Word count, for review-screen length highlighting (not validation). */
export const wordCount = (text: string): number =>
  text
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, " x ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
