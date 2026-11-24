import { createHash } from 'node:crypto';
import type { Card } from '../anki/state.ts';
import type { EarlierRepeatCandidate } from '../writer/types.ts';
import { isEarlierRepeatCard } from './earlier-repeats.ts';

type RepeatReference = Pick<Card, 'possibleRepeatOf' | 'possibleRepeatFingerprint'>;
const fingerprint = ({ front, back, format }: EarlierRepeatCandidate) =>
  createHash('sha256').update(JSON.stringify([front, back, format])).digest('hex');

export function repeatReference(id: string | undefined, cards: readonly Card[]): RepeatReference {
  const card = id && cards.find(c => c.id === id);
  return card ? { possibleRepeatOf: card.id, possibleRepeatFingerprint: fingerprint(card) } : {};
}

export function currentRepeat(ref: RepeatReference, byId: ReadonlyMap<string, Card>): string | undefined {
  const card = ref.possibleRepeatOf && byId.get(ref.possibleRepeatOf);
  return card && isEarlierRepeatCard(card) && ref.possibleRepeatFingerprint === fingerprint(card) ? card.id : undefined;
}
