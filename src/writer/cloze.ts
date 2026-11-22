// FI-8 cloze cards: placeholder handling, content checks and the Anki Text
// field. Pure: no host imports. See docs/fi-8-cloze-design.md.
//
// A cloze draft keeps the basic card shape: front is the statement with one
// {{blank}}, back is the hidden part. The plugin builds Anki's {{c1::...}}
// markup itself, so it never has to find the end of a blank by counting braces.

import { renderMarkdown } from "../anki/render.ts";
import { answerSegments, givesAwayAnswer } from "./validate.ts";
import { CLOZE_KINDS, type DraftCard } from "./types.ts";

export const BLANK = "{{blank}}";
const OPEN = "\u0002";
const CLOSE = "\u0003";

/** Inline maths ranges in a front: \(...\), \[...\], $$...$$, $...$. Code spans
 *  are skipped. Ranges are [start, end) over the whole segment with delimiters. */
interface Segment { start: number; end: number; open: string; close: string; code?: boolean }
const SEGMENT = /\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`\n]+`/g;

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const m of text.matchAll(SEGMENT)) {
    const s = m[0];
    const code = s.startsWith("`");
    const open = code ? "`" : s.startsWith("\\") ? s.slice(0, 2) : s.startsWith("$$") ? "$$" : "$";
    out.push({ start: m.index!, end: m.index! + s.length, open, close: code ? "`" : open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open, code });
  }
  return out;
}

export type BlankPlace = { where: "prose" } | { where: "math"; segment: Segment } | { where: "code" };

/** Where the single blank sits. Undefined if the front does not have exactly one. */
export function blankPlace(front: string): BlankPlace | undefined {
  const first = front.indexOf(BLANK);
  if (first < 0 || front.indexOf(BLANK, first + 1) >= 0) return undefined;
  const seg = segments(front).find((s) => first >= s.start && first + BLANK.length <= s.end);
  if (!seg) return { where: "prose" };
  return seg.code ? { where: "code" } : { where: "math", segment: seg };
}

export const isCloze = (card: Pick<DraftCard, "format">): boolean => card.format === "cloze";

/** Front with the hidden part put back. */
export const assemble = (front: string, back: string, marked = false): string =>
  front.replace(BLANK, marked ? `${OPEN}${back}${CLOSE}` : back);

/** Layout of maths blanks (spec: "Layout of maths blanks"). When the blank is
 *  inside maths, that segment becomes display maths on its own line, the text
 *  before it a lead-in paragraph and the text after it a following paragraph,
 *  dropped if it is only punctuation. Other fronts are returned unchanged. The
 *  writer and the validator see the one-line front; rendering uses this. */
export function laidOutFront(front: string): string {
  const place = blankPlace(front);
  if (place?.where !== "math") return front;
  const { start, end, open, close } = place.segment;
  const tex = front.slice(start + open.length, end - close.length).trim();
  const before = front.slice(0, start).trim();
  const after = front.slice(end).trim();
  return [before, `$$${tex}$$`, /^[\s.,;:!?]*$/.test(after) ? "" : after].filter(Boolean).join("\n\n");
}

/** Front as shown on the question side, for previews. */
export const questionPreview = (front: string): string => laidOutFront(front).replace(BLANK, "[...]");

function balancedBraces(tex: string): boolean {
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "\\") { i++; continue; }
    if (tex[i] === "{") depth++;
    else if (tex[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

const normaliseTex = (tex: string) => tex.replace(/\\(?:left|right|[,;!]|displaystyle)/g, "").replace(/\s+/g, "");

/** C7 for a blank inside maths: the visible maths already shows the back. */
function mathBackLeaks(front: string, back: string): boolean {
  const target = normaliseTex(back);
  if (!target) return false;
  // \u0001 keeps the tokens either side of the blank from joining up.
  const visible = answerSegments(front.replace(BLANK, "\u0001"));
  if (target.length >= 3) return visible.some((v) => v.includes(target));
  return visible.some((v) => v.split("\u0001").some((part) => part === target || part.split("=").some((side) => side === target)));
}

/** C7: the visible text gives the hidden part away. */
export function clozeLeaks(front: string, back: string): boolean {
  const place = blankPlace(front);
  if (place?.where === "math") return mathBackLeaks(front, back);
  return givesAwayAnswer(front.replace(BLANK, " "), back);
}

const VOID = new Set(["br", "hr", "img"]);

/** C6: the markers survive once each in text content and the answer range does
 *  not cut through markup. Returns a problem, or undefined. */
function markerProblem(html: string): string | undefined {
  const open = html.indexOf(OPEN);
  const close = html.indexOf(CLOSE);
  if (open < 0 || close < 0 || html.indexOf(OPEN, open + 1) >= 0 || html.indexOf(CLOSE, close + 1) >= 0 || close < open) {
    return "the blank must sit in plain text or maths, not inside link syntax or other Markdown";
  }
  const insideTag = (i: number) => html.lastIndexOf("<", i) > html.lastIndexOf(">", i);
  if (insideTag(open) || insideTag(close)) return "the blank must not be inside a link URL or other attribute";
  const stack: string[] = [];
  for (const m of html.slice(open, close).matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const name = m[2]!.toLowerCase();
    if (VOID.has(name)) continue;
    if (!m[1]) stack.push(name);
    else if (stack.pop() !== name) return "the blank cuts through formatting: put whole bold, code or link markup inside the hidden part or outside it";
  }
  if (stack.length) return "the blank cuts through formatting: put whole bold, code or link markup inside the hidden part or outside it";
  return undefined;
}

/** C2 content rule and C3-C8 for one cloze card. Messages are correction text. */
export function clozeProblems(card: DraftCard): string[] {
  const problems: string[] = [];
  const front = card.front;
  const back = card.back;
  if (!CLOZE_KINDS.includes(card.kind as never)) problems.push(`only ${CLOZE_KINDS.join(" and ")} cards can be cloze`);
  for (const field of [front, back, card.extra ?? ""]) {
    if (/[\u0002\u0003]/.test(field)) { problems.push("control characters are not allowed"); return problems; }
  }
  const count = front.split(BLANK).length - 1;
  if (count !== 1) { problems.push(`a cloze front must contain ${BLANK} exactly once (found ${count})`); return problems; }
  if (back.includes(BLANK) || (card.extra ?? "").includes(BLANK)) problems.push(`${BLANK} belongs only in the front`);
  if (/\n/.test(back.trim())) problems.push("the hidden part must be one line");
  if (/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|```|~~~)/.test(back) || /\$\$|\\\[|\\\]/.test(back)) {
    problems.push("the hidden part must be inline text or inline maths, not a list, heading, code block or display maths");
  }
  if (/\n/.test(front.trim()) || /\$\$|\\\[/.test(front)) problems.push("a cloze card is one line with inline maths only");
  const place = blankPlace(front)!;
  if (place.where === "code") problems.push(`put ${BLANK} outside inline code; the hidden part can carry its own inline code`);
  if (place.where === "math" && /\\\(|\\\)|\\\[|\\\]|(?<!\\)\$/.test(back)) {
    problems.push(`the blank is inside maths, so the hidden part is raw TeX without \\( \\) or $ delimiters`);
  }
  if (place.where === "math" && !balancedBraces(back)) {
    problems.push("the hidden part must be a whole TeX group: its { and } must balance");
  }
  if (place.where === "prose") {
    // C5: each side of the blank must be well formed on its own, or Anki shows
    // half a maths segment when the answer is hidden.
    for (const [label, text] of [["hidden part", back], ["visible text", front.replace(BLANK, "x")]] as const) {
      try { renderMarkdown(text, { checkMath: true }); }
      catch (error) { problems.push(`the ${label} must be complete on its own: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (problems.length) return problems;
  // C6: render the marked assembly once; it must match the unmarked render.
  let marked: string;
  let plain: string;
  try {
    marked = renderMarkdown(assemble(laidOutFront(front), back, true), { checkMath: true });
    plain = renderMarkdown(assemble(laidOutFront(front), back), { checkMath: true });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  const marker = markerProblem(marked);
  if (marker) problems.push(marker);
  else if (marked.replace(/[\u0002\u0003]/g, "") !== plain) problems.push("the blank changes how the text is formatted; move it or reword");
  for (const m of plain.matchAll(/href="([^"]*)"/g)) {
    if (/\}\}|\{\{|::/.test(m[1]!)) problems.push("a link URL in a cloze card must not contain }}, {{ or ::");
  }
  if (clozeLeaks(front, back)) problems.push("the visible text gives the hidden part away");
  return problems;
}

const COMMENT = "<!-- -->";

/** The Anki Text field: rendered HTML with exactly one {{c1::...}}. Assumes
 *  clozeProblems(card) is empty. */
export function clozeTextField(front: string, back: string): string {
  let html = renderMarkdown(assemble(laidOutFront(front), back, true));
  const escapeAll = (pattern: RegExp, fix: (s: string) => string, text: string) => {
    let prev: string;
    do { prev = text; text = text.replace(pattern, fix); } while (text !== prev);
    return text;
  };
  html = escapeAll(/\}\}/, () => `}${COMMENT}}`, html);
  html = escapeAll(/\{\{(?=c\d)/i, () => `{${COMMENT}{`, html);
  const o = html.indexOf(OPEN);
  const c = html.indexOf(CLOSE);
  let answer = escapeAll(/::/, () => `:${COMMENT}:`, html.slice(o + 1, c));
  if (answer.endsWith("}")) answer += COMMENT;
  if (answer.startsWith(":")) answer = COMMENT + answer;
  let before = html.slice(0, o);
  if (before.endsWith("{")) before += COMMENT;
  let after = html.slice(c + 1);
  if (after.startsWith("}")) after = COMMENT + after;
  return `${before}{{c1::${answer}}}${after}`;
}
