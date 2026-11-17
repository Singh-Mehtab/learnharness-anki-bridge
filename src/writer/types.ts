// Shared types for the card writer. Pure data: no host imports.
// Graph shapes mirror LearnHarness plugin API v1 (GraphNode, GraphChain),
// trimmed to the fields the writer reads.

export interface ProvenancePoint {
  chatId: string;
  messageId: string;
}

export interface GraphNodeLike {
  id: string;
  name: string;
  statement: string;
  aliases?: string[];
  provenance?: ProvenancePoint[];
}

export interface GraphChainLike {
  id: string;
  premises: string[];
  conclusion: string;
}

export interface GraphLike {
  propositions: GraphNodeLike[];
  chains: GraphChainLike[];
}

/** Card kinds that ship in v1. */
export const CORE_KINDS = ["recall", "why", "compose", "discriminate"] as const;
/** Kinds on trial in the 0.1.0 bench only. */
export const TRIAL_KINDS = ["mini-problem", "spot-the-mistake"] as const;
export const ALL_KINDS = [...CORE_KINDS, ...TRIAL_KINDS] as const;
export type CardKind = (typeof ALL_KINDS)[number];

export interface NodeRef {
  id: string;
  name: string;
  statement: string;
}

export interface ConcludingChain {
  chainId: string;
  /** All premises, jointly sufficient. Never shown one at a time. */
  premises: NodeRef[];
}

export interface FeedingChain {
  chainId: string;
  conclusion: NodeRef;
  /** The other premises that combine with the target. */
  withPremises: NodeRef[];
}

export interface ExistingCard {
  kind: CardKind;
  front: string;
  back: string;
}

export interface WriterTarget {
  nodeId: string;
  name: string;
  statement: string;
  aliases: string[];
  concludedBy: ConcludingChain[];
  feeds: FeedingChain[];
  neighbours: NodeRef[];
  /** Teacher message the node came from, capped. Untrusted. */
  source?: string;
  /** The learner's flag note ("I got the sign wrong"). Untrusted. */
  flagNote?: string;
  /** Newest first, at most 6. */
  existingCards: ExistingCard[];
  /** Enabled kinds this target's chains and neighbours support. Set by pack. */
  allowedKinds?: CardKind[];
}

export interface WriterInput {
  version: 1;
  maxCardsPerNode: number;
  enabledKinds: CardKind[];
  targets: WriterTarget[];
}

export interface DraftCard {
  kind: CardKind;
  front: string;
  back: string;
  extra?: string;
}

export interface TargetResult {
  nodeId: string;
  cards: DraftCard[];
  skipReason?: string;
}

export interface WriterResult {
  targets: TargetResult[];
}
