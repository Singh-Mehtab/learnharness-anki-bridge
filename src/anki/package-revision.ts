// The card-derived content used in package fields and automatic tags.
// Shared with the frontend so a receipt is checked against what was exported,
// rather than a potentially stale view snapshot.
export function packageRevision(card: { id: string; front: string; back: string; extra: string; sessionName: string; nodeName: string; nodeId: string; kind: string; format?: string }): string {
  // FI-8: format joins only for cloze, so basic cards keep their 0.9.0 revisions
  // and existing download receipts stay valid.
  return JSON.stringify([card.id, card.front, card.back, card.extra, card.sessionName, card.nodeName, card.nodeId, card.kind, ...(card.format === 'cloze' ? ['cloze'] : [])]);
}
