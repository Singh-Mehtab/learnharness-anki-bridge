type CardContent = { kind?: string; front: string; back: string; extra?: string };

/** Exact content only. Wording, whitespace and TeX can change what a card tests. */
export function duplicateIndexes<T extends CardContent>(
  cards: readonly T[], eligible: (current: T, earlier: T) => boolean = () => true,
): number[] {
  const kept = new Map<string, number[]>();
  return cards.map((card, i) => {
    const key = JSON.stringify([card.kind, card.front, card.back, card.extra ?? ""]);
    const matches = kept.get(key) ?? [];
    const earlier = matches.find(j => eligible(card, cards[j]));
    if (earlier !== undefined) return earlier;
    matches.push(i);
    kept.set(key, matches);
    return -1;
  });
}
