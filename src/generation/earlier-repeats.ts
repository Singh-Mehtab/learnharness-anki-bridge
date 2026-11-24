import type { Card } from '../anki/state.ts';
import type { DraftCard, EarlierRepeatCandidate, WriterInput } from '../writer/types.ts';

export const MAX_EARLIER_REPEAT_CANDIDATES = 3;
/** Both the question and the answer must overlap. This only raises an advisory flag. */
export const EARLIER_REPEAT_THRESHOLD = 0.72;

const math = /\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)|\$\$[\s\S]+?\$\$|(?<!\\)\$[^$\n]+?\$/g;
const stopWords = new Set('a an and are as at by for from in is it of on or that the to was what which with'.split(' '));
const unwrapMath = (s: string) => s.replace(math, span => span.startsWith('\\') ? span.slice(2, -2) : span.replace(/^\$+|\$+$/g, ''));
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const normaliseMath = (s: string) => unwrapMath(s)
  .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, run => `^${[...run].map(c => superscripts.indexOf(c)).join('')}`)
  .replace(/\\(?:left|right|displaystyle)\b|\\[,;! ]|\s+/g, '')
  .replace(/([_^])\{([\p{L}\p{N}])\}/gu, '$1$2');
function terms(text: string): Set<string> {
  const result = new Set<string>();
  const prose = text.normalize('NFC').replace(/\{\{blank\}\}/g, ' ').replace(math, span => {
    const formula = normaliseMath(span);
    if (formula) result.add(`math:${formula}`);
    return ' ';
  });
  for (const word of prose.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (!stopWords.has(word)) result.add(word);
  return result;
}
const weight = (word: string) => word.startsWith('math:') ? 4 : 1;
function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0, total = 0;
  for (const word of a) { const w = weight(word); total += w; if (b.has(word)) shared += w; }
  for (const word of b) total += weight(word);
  return total ? 2 * shared / total : 0;
}

type RecallText = Pick<Card, 'front' | 'back' | 'format'> | Pick<DraftCard, 'front' | 'back' | 'format'>;
const clozeMath = (c: RecallText) => c.format === 'cloze' ? c.front.match(math)?.find(span => span.includes('{{blank}}')) : undefined;
function recallTerms(c: RecallText) {
  const span = clozeMath(c);
  const equation = span ? normaliseMath(unwrapMath(span).replace('{{blank}}', unwrapMath(c.back))) : normaliseMath(c.back);
  return { front: terms(c.front), back: terms(c.back), prose: terms(c.front.replace(math, ' ')),
    equation: equation.includes('=') ? equation : undefined, cloze: c.format === 'cloze' };
}
function recallSimilarity(a: ReturnType<typeof recallTerms>, b: ReturnType<typeof recallTerms>): number {
  const literal = Math.min(similarity(a.front, b.front), similarity(a.back, b.back));
  // A cloze may hide only the right-hand side. Compare the reconstructed equation
  // to a Basic answer, and still require similar cues to distinguish recall tasks.
  return a.cloze !== b.cloze && a.equation && a.equation === b.equation ? Math.max(literal, similarity(a.prose, b.prose)) : literal;
}

function rankTerms(text: string): Set<string> {
  const tokens = terms(text);
  // Some graph statements use bare maths or Unicode exponents. An exact symbolic
  // right-hand side helps find the card even when the graph used a different cue.
  for (const [, rhs] of unwrapMath(text).matchAll(/=\s*([\p{L}][\p{L}\p{N}⁰¹²³⁴⁵⁶⁷⁸⁹^_{}]*)/gu)) {
    if (/[\p{N}^_]/u.test(rhs)) tokens.add(`math:rhs=${normaliseMath(rhs)}`);
  }
  return tokens;
}

/** Lexical evidence only. An identical answer by itself is not the same recall task. */
export function earlierRepeatSimilarity(a: RecallText, b: RecallText): number {
  return recallSimilarity(recallTerms(a), recallTerms(b));
}

export function isEarlierRepeatCard(card: Pick<Card, 'status' | 'presence' | 'noteId'>): boolean {
  return card.status === 'imported' || (card.status === 'sent' ? card.presence !== 'deleted'
    : card.noteId === undefined && (card.status === 'draft' || card.status === 'approved' || card.status === 'failed'));
}

/** A local, cross-deck index. Exclude the current run or the original being replaced. */
export function indexEarlierRepeats(cards: readonly Card[], exclude: { generationId?: string; cardId?: string } = {}) {
  const eligible = cards.filter(c => c.id !== exclude.cardId && (!exclude.generationId || c.generationId !== exclude.generationId) && isEarlierRepeatCard(c));
  const records = eligible.map(card => {
    const recall = recallTerms(card);
    const text = rankTerms(`${card.front}\n${card.back}\n${recall.equation ?? ''}`);
    return { card, recall, text };
  });
  const byId = new Map(eligible.map(card => [card.id, card]));
  return {
    rank(target: { name: string; statement: string }): EarlierRepeatCandidate[] {
      const text = rankTerms(`${target.name}\n${target.statement}`);
      const ranked: { card: Card; score: number }[] = [];
      for (const record of records) {
        const score = similarity(text, record.text);
        if (score === 0) continue;
        const position = ranked.findIndex(r => score >= r.score);
        if (position !== -1) ranked.splice(position, 0, { card: record.card, score });
        else if (ranked.length < MAX_EARLIER_REPEAT_CANDIDATES) ranked.push({ card: record.card, score });
        if (ranked.length > MAX_EARLIER_REPEAT_CANDIDATES) ranked.pop();
      }
      return ranked.map(({ card }) => earlierRepeatCandidate(card));
    },
    /** Only unchanged, still eligible evidence can authorise a skip or a model flag. */
    current(candidate: EarlierRepeatCandidate): boolean {
      const card = byId.get(candidate.id);
      return !!card && candidate.front === card.front && candidate.back === card.back && candidate.format === card.format;
    },
    possible(card: RecallText): string | undefined {
      const query = recallTerms(card);
      let best = EARLIER_REPEAT_THRESHOLD, id: string | undefined;
      for (const r of records) {
        const score = recallSimilarity(query, r.recall);
        if (score >= best) { best = score; id = r.card.id; }
      }
      return id;
    },
  };
}
export type EarlierRepeatIndex = ReturnType<typeof indexEarlierRepeats>;
const earlierRepeatCandidate = ({ id, front, back, format }: Card): EarlierRepeatCandidate =>
  ({ id, front, back, ...(format && { format }) });

/** Attach only within the caller's existing prompt budget, without changing the batch or its flags. */
export function addEarlierRepeatCandidates(input: WriterInput, index: EarlierRepeatIndex, fits: (input: WriterInput) => boolean,
  sources: ReadonlyMap<string, { name: string; statement: string }> = new Map()): WriterInput {
  const targets = [...input.targets];
  const ranked = targets.map(t => index.rank(sources.get(t.nodeId) ?? t));
  // Give each target its strongest candidate before spending on second and third candidates.
  for (let rank = 0; rank < MAX_EARLIER_REPEAT_CANDIDATES; rank++) for (let i = 0; i < targets.length; i++) {
    const candidate = ranked[i][rank], previous = targets[i];
    if (!candidate) continue;
    targets[i] = { ...previous, earlierRepeatCandidates: [...(previous.earlierRepeatCandidates ?? []), candidate] };
    if (!fits({ ...input, targets })) targets[i] = previous;
  }
  return { ...input, targets };
}

/** A validated model flag has priority; otherwise compare locally against the full eligible index. */
export function possibleEarlierRepeat(card: DraftCard, candidates: readonly EarlierRepeatCandidate[] | undefined, index: EarlierRepeatIndex): string | undefined {
  const cited = candidates?.find(c => c.id === card.possibleRepeatOf);
  return cited && index.current(cited) ? cited.id : index.possible(card);
}
