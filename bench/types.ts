import type { CardKind, ChatRecordLike, DraftCard, GraphLike } from "../src/writer/index.ts";

/** One subject's slice of graph for the bench. */
export interface BenchSet {
  name: string;
  subject: string;
  /** "real": copied from a LearnHarness graph. "hand-written": authored fixture. */
  origin: "real" | "hand-written";
  graph: GraphLike;
  chats: Record<string, ChatRecordLike>;
  /** Node IDs to write cards for. The rest of the graph is context. */
  targets: string[];
  /** Flagged targets, with the learner's note when there is one. */
  flags?: Record<string, { note?: string }>;
  /** FI-8: targets where cloze is clearly better than a question. An auto run
   *  passes only if at least one cloze card is accepted on them. */
  clozePositive?: string[];
}

export interface Attempt {
  durationMs: number;
  problems: string[];
  costUsd?: number;
  outputTokens?: number;
  error?: string;
  /** Raw structured output of this attempt, for diagnosis. */
  output?: unknown;
}

export interface BatchRecord {
  set: string;
  nodeIds: string[];
  inputTokens: number;
  attempts: Attempt[];
  accepted: boolean;
}

export interface BenchCard extends DraftCard {
  id: string;
  set: string;
  subject: string;
  origin: BenchSet["origin"];
  nodeId: string;
  nodeName: string;
  statement: string;
  kind: CardKind;
  frontWords: number;
  backWords: number;
  /** True when the batch's last attempt still failed validation. */
  unvalidated: boolean;
}

export interface BenchSkip {
  set: string;
  nodeId: string;
  nodeName: string;
  statement: string;
  reason: string;
  by: "model" | "packer";
}

export interface BenchRun {
  runId: string;
  mode: "core" | "trial";
  model: string;
  createdAt: string;
  maxCardsPerNode: number;
  enabledKinds: CardKind[];
  /** FI-8 cloze mode the run used. Absent on older runs (off). */
  cloze?: "off" | "auto" | "prefer";
  /** FI-8: "set:nodeId" of positive cloze fixtures in this run. */
  clozePositive?: string[];
  instructions: string;
  /** Present on 0.1.1+ runs; older runs counted attempts, not CLI launches. */
  modelCalls?: number;
  writerVersion?: string;
  batches: BatchRecord[];
  cards: BenchCard[];
  skips: BenchSkip[];
}

export type Verdict = "keep" | "small-edit" | "big-edit" | "drop";

export interface CardScore {
  verdict?: Verdict;
  leak?: boolean;
  error?: boolean;
  unclear?: boolean;
  /** FI-8: should have been the other format (cloze vs basic). */
  otherFormat?: boolean;
  note?: string;
}

export interface Scores {
  cards: Record<string, CardScore>;
  /** For model skips: did skipping make sense? */
  skips: Record<string, { agree?: boolean; note?: string }>;
}
