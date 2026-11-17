// Which card kinds a target's graph context supports. Pure.

import type { CardKind, WriterTarget } from "./types.ts";

type KindContext = Pick<WriterTarget, "concludedBy" | "neighbours">;

/** Null when the kind fits; otherwise the reason it doesn't. */
export function kindMisfit(kind: CardKind, target: KindContext): string | null {
  if ((kind === "why" || kind === "compose") && !target.concludedBy.length) {
    return `a ${kind} card needs a chain that concludes in the target, and this target has none`;
  }
  if (kind === "discriminate" && !target.neighbours.length) {
    return "a discriminate card needs a listed neighbour, and this target has none";
  }
  return null;
}

export const allowedKindsFor = (target: KindContext, enabled: readonly CardKind[]): CardKind[] =>
  enabled.filter((k) => !kindMisfit(k, target));
