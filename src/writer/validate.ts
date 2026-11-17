// Result validator for the card writer (worker validateResult). Pure, no side
// effects. Collects every problem so one retry can fix them all.
//
// givesAwayAnswer is adapted (AGPL-3.0) from Twig,
// src/agent/subagents/card-writer.ts, https://github.com/amoghu1s1/twig

import type { CardKind, DraftCard, WriterInput, WriterTarget } from "./types.ts";

/** LaTeX commands that are layout, not content. Removed before comparing
 *  terms so "\frac" on both sides doesn't count as a leak. */
const LAYOUT_COMMANDS =
  /\\(?:d?frac|tfrac|sqrt|left|right|big|Big|bigg|Bigg|mathrm|mathbf|mathit|mathcal|text|textbf|textit|operatorname|begin|end|quad|qquad|cdot|cdots|ldots|dots|displaystyle|,|;|!)/g;

/** Distinctive terms: numbers and words of 4+ letters, lower-cased. */
export function answerTerms(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(LAYOUT_COMMANDS, " ")
      .replace(/\*\*/g, "")
      .match(/\d+|[a-zÀ-ɏ]{4,}/g) ?? []
  );
}

/** The front gives the answer away: every distinctive term of the back
 *  already appears on the front. */
export function givesAwayAnswer(front: string, back: string): boolean {
  const terms = answerTerms(back);
  if (!terms.length) return false;
  const shown = new Set(answerTerms(front));
  return terms.every((t) => shown.has(t));
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

const FORBIDDEN: Array<[RegExp, string]> = [
  [/```|~~~/, "code fences"],
  [/!\[[^\]]*\]\(/, "images"],
  [/<img\b/i, "images"],
  [/\bmermaid\b/i, "Mermaid"],
];

function kindFits(kind: CardKind, target: WriterTarget): string | null {
  if ((kind === "why" || kind === "compose") && !target.concludedBy.length) {
    return `a ${kind} card needs a chain that concludes in the target, and this target has none`;
  }
  if (kind === "discriminate" && !target.neighbours.length) {
    return "a discriminate card needs a listed neighbour, and this target has none";
  }
  return null;
}

export function cardProblems(card: DraftCard, target: WriterTarget, input: WriterInput): string[] {
  const problems: string[] = [];
  const front = typeof card.front === "string" ? card.front : "";
  const quote = `"${front.slice(0, 60)}${front.length > 60 ? "…" : ""}"`;
  if (!input.enabledKinds.includes(card.kind)) problems.push(`${quote}: kind "${card.kind}" is not enabled`);
  else {
    const fit = kindFits(card.kind, target);
    if (fit) problems.push(`${quote}: ${fit}`);
  }
  const blankFront = !front.trim();
  const blankBack = typeof card.back !== "string" || !card.back.trim();
  if (blankFront) problems.push("a card has a blank front");
  if (blankBack) problems.push(`${quote}: blank back`);
  if (blankFront || blankBack) return problems;
  if (givesAwayAnswer(card.front, card.back)) {
    problems.push(`${quote}: the front gives the answer away (every key term of the back is already on the front)`);
  }
  if ((card.kind === "recall" || card.kind === "discriminate") && containsName(card.front, target.name)) {
    problems.push(`${quote}: a ${card.kind} front must not contain the idea's name "${target.name}"`);
  }
  for (const field of [card.front, card.back, card.extra ?? ""]) {
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(field)) problems.push(`${quote}: ${label} are not allowed`);
    }
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
    if (cards.length > input.maxCardsPerNode) {
      problems.push(`Target ${nodeId}: ${cards.length} cards, but the cap is ${input.maxCardsPerNode}.`);
    }
    if (!cards.length && (typeof row.skipReason !== "string" || !row.skipReason.trim())) {
      problems.push(`Target ${nodeId}: no cards, so give a skipReason.`);
    }
    const fronts = new Set(target.existingCards.map((c) => normalise(c.front)));
    for (const card of cards) {
      for (const p of cardProblems(card, target, input)) problems.push(`Target ${nodeId}: ${p}.`);
      if (typeof card.front === "string" && card.front.trim()) {
        const key = normalise(card.front);
        if (fronts.has(key)) problems.push(`Target ${nodeId}: front repeats an existing card: "${card.front.slice(0, 60)}".`);
        fronts.add(key);
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
