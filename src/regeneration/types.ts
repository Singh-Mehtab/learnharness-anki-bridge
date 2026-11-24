import type { Card, State } from '../anki/state.ts';
import { packageRevision } from '../anki/package-revision.ts';
import { CLOZE_KINDS, isStoredKind, type EarlierRepeatCandidate, type StoredCardKind } from '../writer/types.ts';

export const REWRITE_INSTRUCTION_LIMIT = 300;
export type Replacement = Pick<Card, 'front' | 'back' | 'extra' | 'format' | 'possibleRepeatOf' | 'possibleRepeatFingerprint'> & { kind: StoredCardKind };
export interface RegenerationReview {
  requestId: string;
  status: 'queued' | 'running' | 'ready' | 'repeatSkipped' | 'resultPending' | 'failed';
  replacement?: Replacement;
  repeatSkip?: EarlierRepeatCandidate;
  error?: string;
}
export interface Regeneration extends RegenerationReview {
  cardId: string;
  revision: string;
  instruction: string;
  workerBinding?: string;
  writeAnyway?: true;
}

export function canRegenerate(card: Card): boolean {
  if (card.noteId !== undefined || card.presence !== undefined || !['draft', 'approved', 'failed'].includes(card.status)) return false;
  // An editable format conflict can still correspond to an existing Anki note.
  return card.deliveryAbsent === true || (card.status !== 'failed' && card.destination === undefined && card.deck === undefined && card.lastError === undefined);
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
      || !['queued', 'running', 'ready', 'repeatSkipped', 'resultPending', 'failed'].includes(r.status)
      || r.writeAnyway !== undefined && r.writeAnyway !== true
      || ((r.status === 'repeatSkipped') !== (r.repeatSkip !== undefined))
      || r.workerBinding !== undefined && (typeof r.workerBinding !== 'string' || !/^[\da-f]{64}$/.test(r.workerBinding))
      || (['running', 'ready', 'resultPending'].includes(r.status) && !r.workerBinding)
      || ((r.status === 'ready') !== (r.replacement !== undefined))) return false;
    if (r.repeatSkip !== undefined) {
      const c = r.repeatSkip;
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || c.id === r.cardId || !cardIds.has(c.id)
        || typeof c.front !== 'string' || typeof c.back !== 'string' || c.format !== undefined && c.format !== 'cloze') return false;
    }
    if (r.replacement !== undefined) {
      const c = r.replacement;
      if (!c || typeof c !== 'object' || !isStoredKind(c.kind) || typeof c.front !== 'string' || !c.front.trim()
        || typeof c.back !== 'string' || !c.back.trim() || typeof c.extra !== 'string'
        || c.possibleRepeatOf !== undefined && (typeof c.possibleRepeatOf !== 'string' || !c.possibleRepeatOf || c.possibleRepeatOf === r.cardId)
        || c.possibleRepeatFingerprint !== undefined && (!c.possibleRepeatOf || typeof c.possibleRepeatFingerprint !== 'string' || !/^[\da-f]{64}$/.test(c.possibleRepeatFingerprint))
        || (c.format !== undefined && (c.format !== 'cloze' || !(CLOZE_KINDS as readonly string[]).includes(c.kind)))) return false;
    }
    cards.add(r.cardId); requests.add(r.requestId);
    return true;
  })) throw new Error('Invalid card regeneration state.');
}
