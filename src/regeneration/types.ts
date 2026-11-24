import type { Card, State } from '../anki/state.ts';
import type { SourceSnapshot } from '../generation/types.ts';
import { packageRevision } from '../anki/package-revision.ts';
import { CLOZE_KINDS, isStoredKind, type StoredCardKind } from '../writer/types.ts';

export const REWRITE_INSTRUCTION_LIMIT = 300;
export type Replacement = Pick<Card, 'front' | 'back' | 'extra' | 'format' | 'possibleRepeatOf'> & { kind: StoredCardKind };
export interface RegenerationReview {
  requestId: string;
  status: 'queued' | 'running' | 'ready' | 'resultPending' | 'failed';
  replacement?: Replacement;
  error?: string;
}
export interface Regeneration extends RegenerationReview {
  cardId: string;
  revision: string;
  instruction: string;
  workerBinding?: string;
  repeatFingerprint?: string;
}

export function canRegenerate(card: Card): card is Card & { sourceSnapshot: SourceSnapshot } {
  // Delivery metadata survives edits/approval after a delivery attempt. Do not
  // replace an identity that may already exist in a collection.
  return (card.status === 'draft' || card.status === 'approved') && card.noteId === undefined
    && card.destination === undefined && card.deck === undefined && card.presence === undefined && card.lastError === undefined
    && card.sourceSnapshot?.nodeId === card.nodeId && card.sourceSnapshot.statementHash === card.statementHash
    && !!card.sourceSnapshot.statement.trim();
}

export const regenerationRevision = (card: Parameters<typeof packageRevision>[0] & { status: string; statementHash: string }): string =>
  JSON.stringify([packageRevision(card), card.status, card.statementHash]);

export function assertNotRegenerating(state: State, ids: readonly string[]): void {
  if (state.regenerations?.some(r => ids.includes(r.cardId))) throw new Error('Accept the replacement or keep the original before changing or sending this card.');
}

export function validateRegenerations(value: unknown, cardIds: ReadonlySet<string>): void {
  if (value === undefined) return;
  const cards = new Set<string>(), requests = new Set<string>();
  if (!Array.isArray(value) || !value.every(r => {
    if (!r || typeof r !== 'object' || !cardIds.has(r.cardId) || cards.has(r.cardId) || typeof r.requestId !== 'string'
      || !r.requestId || requests.has(r.requestId) || typeof r.revision !== 'string' || !r.revision
      || typeof r.instruction !== 'string' || r.instruction.length > REWRITE_INSTRUCTION_LIMIT || r.instruction.includes('\0')
      || r.error !== undefined && typeof r.error !== 'string'
      || !['queued', 'running', 'ready', 'resultPending', 'failed'].includes(r.status)
      || r.workerBinding !== undefined && (typeof r.workerBinding !== 'string' || !/^[\da-f]{64}$/.test(r.workerBinding))
      || (['running', 'ready', 'resultPending'].includes(r.status) && !r.workerBinding)
      || r.repeatFingerprint !== undefined && (typeof r.repeatFingerprint !== 'string' || !/^[\da-f]{64}$/.test(r.repeatFingerprint))
      || ((r.status === 'ready') !== (r.replacement !== undefined))) return false;
    if (r.replacement !== undefined) {
      const c = r.replacement;
      if (!c || typeof c !== 'object' || !isStoredKind(c.kind) || typeof c.front !== 'string' || !c.front.trim()
        || typeof c.back !== 'string' || !c.back.trim() || typeof c.extra !== 'string'
        || c.possibleRepeatOf !== undefined && (typeof c.possibleRepeatOf !== 'string' || !c.possibleRepeatOf || c.possibleRepeatOf === r.cardId)
        || (c.format !== undefined && (c.format !== 'cloze' || !(CLOZE_KINDS as readonly string[]).includes(c.kind)))) return false;
    }
    cards.add(r.cardId); requests.add(r.requestId);
    return true;
  })) throw new Error('Invalid card regeneration state.');
}
