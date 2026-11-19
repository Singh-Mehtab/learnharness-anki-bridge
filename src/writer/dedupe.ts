// Cross-request duplicate detection for drafted cards. Pure.
//
// Each writer request sees only its own targets, so a fact several ideas rely on
// (a constant's units, a prefix) can be drafted once per request. Two cards are
// duplicates when their answers match after normalisation and their questions
// share most of their content words, or ask about exactly the same maths
// symbols. Same answer with a different question is not enough: "dimension of
// length" and "dimension of time" can both be eV^-1.

const STOP = new Set(
  "what which when where does with from into that this than then they them their there these those have give gives given state write what's about roughly approximately usually value units unit".split(" "),
);

const normaliseFull = (text: string): string => text.replace(/\\(approx|simeq|sim|geq?|leq?|gtrsim|lesssim)|[≈~<>]/g, "").replace(/\s+/g, "");

/** Answer text reduced to its core: maths markup, spacing, approximation
 *  signs and a trailing aside removed, and only the right-hand side of a short
 *  "x = value" kept, so "[\hbar] = eV s (energy x time)" matches "eV s". */
export function normaliseAnswer(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$?/g, " ")
    .replace(/\\(mathrm|text|rm|operatorname)\{([^}]*)\}/g, "$2")
    .replace(/\\(approx|simeq|sim)|≈|~/g, "=")
    .replace(/\\(left|right|,|;|!|quad|qquad)/g, "")
    .replace(/\b(about|approximately|roughly)\b/g, "");
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(/\s*\([^()]*\)\s*$/, ""); }
  t = t.replace(/[*_`{}\\\s.,;:]/g, "");
  const eq = t.lastIndexOf("=");
  if (eq > 0 && eq <= 12 && eq < t.length - 1) t = t.slice(eq + 1);
  return t.replace(/^=+/, "");
}

const words = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().replace(/\\[a-z]+/g, (m) => ` ${m.slice(1)} `).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w),
    ),
  );

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
};

export const DUPLICATE_OVERLAP = 0.6;

const MATH = /\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$]+)\$/g;

/** The maths symbols a question asks about, e.g. "hbar|c". Empty when none. */
export function questionSymbols(front: string): string {
  const symbols = new Set<string>();
  for (const m of front.matchAll(MATH)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(mathrm|text|rm)\{[^}]*\}/g, " ");
    for (const t of body.match(/\\[a-zA-Z]+|[a-zA-Z]/g) ?? []) symbols.add(t.replace(/^\\/, ""));
  }
  return [...symbols].sort().join("|");
}

/** For each card, the index of an earlier card it duplicates, or -1. */
export function duplicateIndexes(cards: readonly { front: string; back: string }[]): number[] {
  const keys = cards.map((c) => ({ equation: /=/.test(normaliseFull(c.back)), answer: normaliseAnswer(c.back), question: words(c.front), symbols: questionSymbols(c.front) }));
  return keys.map((k, i) => {
    for (let j = 0; j < i; j++) {
      const other = keys[j];
      if (!k.answer || k.answer !== other.answer) continue;
      // A whole equation is one fact however it is asked. Short answers ("eV^-1") are not.
      if (k.equation && k.answer.length >= 10) return j;
      if (overlap(k.question, other.question) >= DUPLICATE_OVERLAP || (k.symbols && k.symbols === other.symbols)) return j;
    }
    return -1;
  });
}
