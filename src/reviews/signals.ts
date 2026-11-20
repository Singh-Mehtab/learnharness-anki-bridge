// Pure rules for Topics to revisit. No I/O. The numbers are starting points with no
// evidence behind them, kept in one place so they are easy to change.
import type { Destination } from '../anki/state.ts';

export const REVIEW_RULES = { lapses: 3, recentAgain: 2, windowDays: 30 } as const;
const DAY = 86_400_000;

/** One review log row as AnkiConnect returns it: id is the review time in ms. */
export interface ReviewRow { id: number; ease: number; type: number }
/** One Anki card of a bridge-owned note, as cardsInfo returns it. */
export interface CardInfo { cardId: number; lapses: number; reps: number; queue: number; deckName: string }

/** Everything read for one local card record whose Anki note passed the identity checks. */
export interface NoteReading {
  lhId: string; noteId: number; nodeId: string; nodeName: string; sessionId: string; sessionName: string;
  kind: string; front: string; back: string;
  tags: string[]; cards: CardInfo[]; reviews: ReviewRow[];
}
export type Reason = 'lapses' | 'again' | 'leech';
export interface CardEvidence {
  lhId: string; noteId: number; kind: string; front: string; back: string;
  sessionId: string; sessionName: string;
  lapses: number; reps: number; recentAgain: number[]; leech: boolean; suspended: boolean; decks: string[];
  reasons: Reason[];
}
export interface TopicSession { id: string; name: string }
export interface Topic {
  nodeId: string; nodeName: string;
  /** null when the graph could not be read. */
  inGraph: boolean | null;
  sessions: TopicSession[];
  totals: { lapses: number; recentAgain: number; leech: number; cards: number; cardsChecked: number };
  lastAgain: number | null;
  cards: CardEvidence[];
}
export interface ReviewCheck {
  checkedAt: number;
  destination: Destination;
  rules: typeof REVIEW_RULES;
  topics: Topic[];
  counts: { sent: number; checked: number; notReviewed: number; quietTopics: number; changed: number; missing: number };
}
export interface GraphInfo { nodes: ReadonlySet<string>; nodeSessions: Readonly<Record<string, readonly string[]>>; sessions: Readonly<Record<string, string>> }

/** Again on a review (type 1) or relearning step (type 2) inside the window. Learning
 * steps, filtered, manual and rescheduled entries never count. */
export function recentAgain(reviews: readonly ReviewRow[], now: number, windowDays = REVIEW_RULES.windowDays): number[] {
  const since = now - windowDays * DAY;
  return reviews.filter(r => r.ease === 1 && (r.type === 1 || r.type === 2) && r.id >= since && r.id <= now)
    .map(r => r.id).sort((a, b) => b - a);
}

export function evidence(note: NoteReading, now: number): CardEvidence {
  const lapses = note.cards.reduce((sum, c) => sum + c.lapses, 0);
  const reps = note.cards.reduce((sum, c) => sum + c.reps, 0);
  const again = recentAgain(note.reviews, now);
  const leech = note.tags.some(t => t.toLowerCase() === 'leech');
  const reasons: Reason[] = [];
  if (lapses >= REVIEW_RULES.lapses) reasons.push('lapses');
  if (again.length >= REVIEW_RULES.recentAgain) reasons.push('again');
  if (leech) reasons.push('leech');
  return {
    lhId: note.lhId, noteId: note.noteId, kind: note.kind, front: note.front, back: note.back,
    sessionId: note.sessionId, sessionName: note.sessionName,
    lapses, reps, recentAgain: again, leech, suspended: note.cards.length > 0 && note.cards.every(c => c.queue === -1),
    decks: [...new Set(note.cards.map(c => c.deckName))], reasons,
  };
}

const order = <T extends { recentAgain: number; lapses: number; name: string }>(a: T, b: T) =>
  b.recentAgain - a.recentAgain || b.lapses - a.lapses || a.name.localeCompare(b.name);

/** A session link is offered only for a native LearnHarness session ID. */
const linkable = (id: string) => !!id && id !== 'manual';

/** Group flagged cards by LearnHarness node. Plain sort: recent Again presses, then lapses, then name. */
export function buildTopics(notes: readonly NoteReading[], now: number, graph: GraphInfo | null): { topics: Topic[]; notReviewed: number; quietTopics: number } {
  const byNode = new Map<string, NoteReading[]>();
  for (const note of notes) byNode.set(note.nodeId, [...byNode.get(note.nodeId) ?? [], note]);
  const topics: Topic[] = [];
  let notReviewed = 0, quietTopics = 0;
  for (const [nodeId, group] of byNode) {
    const all = group.map(n => evidence(n, now));
    notReviewed += all.filter(c => c.reps === 0).length;
    const flagged = all.filter(c => c.reasons.length);
    if (!flagged.length) { if (all.some(c => c.reps > 0)) quietTopics++; continue; }
    flagged.sort((a, b) => order({ recentAgain: a.recentAgain.length, lapses: a.lapses, name: a.front }, { recentAgain: b.recentAgain.length, lapses: b.lapses, name: b.front }));
    const sessions = new Map<string, string>();
    for (const card of group) if (linkable(card.sessionId)) sessions.set(card.sessionId, graph?.sessions[card.sessionId] || card.sessionName || 'Session');
    for (const id of graph?.nodeSessions[nodeId] ?? []) if (linkable(id) && !sessions.has(id)) sessions.set(id, graph?.sessions[id] || 'Session');
    const lastAgain = Math.max(...flagged.flatMap(c => c.recentAgain), -Infinity);
    topics.push({
      nodeId, nodeName: group[0]!.nodeName,
      inGraph: graph ? graph.nodes.has(nodeId) : null,
      sessions: [...sessions].map(([id, name]) => ({ id, name })),
      totals: {
        lapses: flagged.reduce((s, c) => s + c.lapses, 0),
        recentAgain: flagged.reduce((s, c) => s + c.recentAgain.length, 0),
        leech: flagged.filter(c => c.leech).length,
        cards: flagged.length, cardsChecked: all.length,
      },
      lastAgain: Number.isFinite(lastAgain) ? lastAgain : null,
      cards: flagged,
    });
  }
  topics.sort((a, b) => order({ recentAgain: a.totals.recentAgain, lapses: a.totals.lapses, name: a.nodeName }, { recentAgain: b.totals.recentAgain, lapses: b.totals.lapses, name: b.nodeName }));
  return { topics, notReviewed, quietTopics };
}
