// Browser-safe coverage rules. Hashing and graph access belong to the backend.
import type { Card, State } from '../anki/state.ts';
import { sameDestination } from '../anki/destination.ts';

export const MAX_SELECTED_NODES = 1000;
export interface Dismissal { nodeId: string; statementHash: string; dismissedAt: string }
export interface CardCounts { waiting: number; sent: number; sentElsewhere: number }
export type BaseCoverage = 'no-cards' | 'drafts-waiting' | 'sent' | 'dismissed';
export type CoverageState = BaseCoverage | 'source-changed' | 'source-missing';
export interface Coverage {
  state: CoverageState;
  base: BaseCoverage;
  selectable: boolean;
  uncarded: boolean;
  canDismiss: boolean;
  dismissed: boolean;
  historicalDismissal?: boolean;
  generating: boolean;
  unresolved: number;
  olderSourceCards: number;
  unknownSourceCards: number;
  deletedNotes: number;
  skipReason?: string;
}
export interface CoverageSource { id: string; name: string; statement: string; statementHash: string }
export interface CoverageNode extends CoverageSource { cards: CardCounts; coverage: Coverage }
export interface CoverageContext {
  nodes: CoverageNode[];
  missing: CoverageNode[];
  cardsPerNode: number;
  paired: boolean;
  pairingWarning: boolean;
  pairingKey: string;
}
export interface CoverageSelectable { id: string; cards: CardCounts; coverage?: Coverage }
export const isWaitingCard = (card: Pick<Card, 'status' | 'noteId'>): boolean =>
  card.status === 'sending' || (['draft', 'approved', 'failed'].includes(card.status) && card.noteId === undefined);
export const hasCards = (cards: CardCounts): boolean => cards.waiting > 0 || cards.sent > 0;
export const canSelectNode = (node: CoverageSelectable): boolean => node.coverage?.selectable ?? true;
export const isUncardedNode = (node: CoverageSelectable): boolean => node.coverage?.uncarded ?? !hasCards(node.cards);
export const coverageLabel = (state: CoverageState): string => ({
  'no-cards': 'No cards', 'drafts-waiting': 'Drafts waiting', sent: 'Sent', dismissed: 'Dismissed',
  'source-changed': 'Source changed', 'source-missing': 'Source missing',
})[state];

export function validateDismissals(value: unknown): asserts value is Dismissal[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('Invalid dismissals. The file has not been reset.');
  const ids = new Set<string>();
  for (const d of value) {
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.nodeId !== 'string' || !d.nodeId || d.nodeId.length > 500 || d.nodeId.includes('\0') || ids.has(d.nodeId) ||
        typeof d.statementHash !== 'string' || !/^[a-f0-9]{64}$/.test(d.statementHash) || typeof d.dismissedAt !== 'string' || !Number.isFinite(Date.parse(d.dismissedAt))) {
      throw new Error('Invalid dismissal. The file has not been reset.');
    }
    ids.add(d.nodeId);
  }
}

/** Exact IDs only. Aliases and statement text never transfer coverage to another ID. */
export function projectCoverage(sources: readonly CoverageSource[], state: Pick<State, 'cards' | 'destination' | 'dismissals' | 'generations' | 'generationSettings' | 'settings'>): CoverageContext {
  const byNode = new Map<string, Card[]>(), dismissals = new Map(state.dismissals.map(d => [d.nodeId, d]));
  const active = new Set<string>(), skips = new Map<string, string>();
  for (const card of state.cards) {
    const list = byNode.get(card.nodeId) ?? []; list.push(card); byNode.set(card.nodeId, list);
  }
  for (const generation of state.generations) {
    for (const skip of generation.skipped) skips.set(skip.nodeId, skip.reason);
    for (const task of generation.tasks) {
      if (generation.status === 'running' && ['pending', 'running'].includes(task.status)) for (const target of task.input.targets) active.add(target.nodeId);
      for (const target of task.result?.targets ?? []) {
        if (target.skipReason) skips.set(target.nodeId, target.skipReason);
        else if (target.cards.length) skips.delete(target.nodeId);
      }
    }
  }
  const same = (card: Card) => sameDestination(card.destination, state.destination);
  function row(source: CoverageSource, missing = false): CoverageNode {
    const cards: CardCounts = { waiting: 0, sent: 0, sentElsewhere: 0 };
    let unresolved = 0, olderSourceCards = 0, unknownSourceCards = 0, deletedNotes = 0, current = 0, currentOrUnknownSent = 0;
    for (const card of byNode.get(source.id) ?? []) {
      if (card.status === 'dropped') continue;
      if (card.status === 'sent') {
        if (!same(card)) { cards.sentElsewhere++; continue; }
        cards.sent++; if (card.presence === 'deleted') deletedNotes++;
      } else {
        if (!isWaitingCard(card)) continue;
        cards.waiting++; if (card.status === 'sending') unresolved++;
      }
      const snapshot = card.sourceSnapshot;
      if (!snapshot || snapshot.nodeId !== source.id) { unknownSourceCards++; if (card.status === 'sent') currentOrUnknownSent++; }
      else if (missing) continue;
      else if (snapshot.statementHash === source.statementHash) { current++; if (card.status === 'sent') currentOrUnknownSent++; }
      else olderSourceCards++;
    }
    const dismissal = dismissals.get(source.id), dismissed = !missing && dismissal?.statementHash === source.statementHash;
    const generating = active.has(source.id);
    const base: BaseCoverage = dismissed && !cards.waiting && !currentOrUnknownSent ? 'dismissed' : cards.sent ? 'sent' : cards.waiting ? 'drafts-waiting' : 'no-cards';
    const changed = (olderSourceCards > 0 || !!dismissal && !dismissed) && !current && !unknownSourceCards && !dismissed;
    const status: CoverageState = missing ? 'source-missing' : changed ? 'source-changed' : base;
    const selectable = !missing && !dismissed && !unresolved && !generating;
    return { ...source, cards, coverage: { state: status, base, selectable, uncarded: status === 'no-cards' && selectable,
      canDismiss: !missing && !dismissed && !currentOrUnknownSent && !generating && !byNode.get(source.id)?.some(c => c.status !== 'sent' && c.status !== 'dropped'),
      dismissed, generating, unresolved, olderSourceCards, unknownSourceCards, deletedNotes,
      ...(missing && dismissal ? { historicalDismissal: true } : {}),
      ...(skips.has(source.id) ? { skipReason: skips.get(source.id) } : {}) } };
  }
  const present = new Set(sources.map(n => n.id)), missingSources = new Map<string, CoverageSource>();
  for (const card of state.cards) if (card.sourceSnapshot && !present.has(card.nodeId) && card.sourceSnapshot.nodeId === card.nodeId) {
    const s = card.sourceSnapshot; missingSources.set(card.nodeId, { id: card.nodeId, name: s.name, statement: s.statement, statementHash: s.statementHash });
  }
  for (const d of state.dismissals) if (!present.has(d.nodeId) && !missingSources.has(d.nodeId)) missingSources.set(d.nodeId, { id: d.nodeId, name: d.nodeId, statement: '', statementHash: d.statementHash });
  return { nodes: sources.map(n => row(n)), missing: [...missingSources.values()].map(n => row(n, true)),
    cardsPerNode: state.generationSettings.cardsPerNode, paired: !!state.destination,
    pairingWarning: !!state.destination && state.destination.url !== state.settings.url,
    pairingKey: JSON.stringify([state.settings.url, state.destination?.url, state.destination?.profile]) };
}
