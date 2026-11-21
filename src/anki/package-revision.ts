// The card-derived content used in package fields and automatic tags.
// Shared with the frontend so a receipt is checked against what was exported,
// rather than a potentially stale view snapshot.
export function packageRevision(card: { id: string; front: string; back: string; extra: string; sessionName: string; nodeName: string; nodeId: string; kind: string }): string {
  return JSON.stringify([card.id, card.front, card.back, card.extra, card.sessionName, card.nodeName, card.nodeId, card.kind]);
}
