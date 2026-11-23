// Input builder and batch packer for the card writer. Pure: no host imports.
//
// Budget rules (plan, "Batches and budget"):
// - Pack targets into tasks by estimated input tokens, about 4,000 per task.
// - Per target: every chain that concludes in it, in full; up to 3 chains it
//   feeds; up to 3 neighbours; the newest 6 existing cards; the source passage.
// - Chains are dropped whole, never truncated, so joint premises stay joint.
// - A target too big for the budget rides alone, up to a hard ceiling
//   (12,000 tokens, or the context window minus the output allowance).
// - A target whose statement, concluding chains and source still exceed the
//   ceiling is skipped with a reason. Nothing is truncated except the source
//   passage, which is capped at about 1,500 characters when it is read.

import type {
  CardKind,
  ConcludingChain,
  ExistingCard,
  FeedingChain,
  GraphLike,
  GraphNodeLike,
  NodeRef,
  WriterInput,
  WriterTarget,
} from "./types.ts";
import { FLAGGED_CARD_CAP } from "./types.ts";
import { allowedKindsFor, capFor } from "./kinds.ts";

export const SOURCE_CHAR_CAP = 1500;
export const MAX_FEEDS = 3;
export const MAX_NEIGHBOURS = 3;
export const MAX_EXISTING_CARDS = 6;
export const DEFAULT_CHUNK_BUDGET = 4000;
export const HARD_INPUT_CEILING = 12000;
export const OUTPUT_TOKENS_PER_CARD = 300;
export const OUTPUT_TOKENS_PER_NODE = 200;

/** Rough token estimate: about 4 characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const outputAllowance = (nodeCount: number, maxCardsPerNode: number): number =>
  nodeCount * (OUTPUT_TOKENS_PER_CARD * maxCardsPerNode + OUTPUT_TOKENS_PER_NODE);

/** Output allowance for actual targets, counting flagged targets' larger cap. */
export const targetsAllowance = (targets: readonly Pick<WriterTarget, "maxCards">[], maxCardsPerNode: number): number =>
  targets.reduce((n, t) => n + outputAllowance(1, capFor(t, maxCardsPerNode)), 0);

// ---------------------------------------------------------------------------
// Source passage

interface MessagePart {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

export interface ChatMessageLike {
  id?: string;
  role?: string;
  content?: string | MessagePart[];
}

export interface ChatRecordLike {
  id?: string;
  messages: ChatMessageLike[];
}

/** Text the learner saw in one teacher message. `send_to_user` tool calls
 *  carry the teaching text in LearnHarness 0.6.1; plain text parts are the
 *  fallback. Thinking and other tool calls are ignored. */
export function messageText(message: ChatMessageLike): string {
  if (typeof message.content === "string") return message.content.trim();
  const parts = Array.isArray(message.content) ? message.content : [];
  const sent = parts
    .filter((p) => p?.type === "toolCall" && p.name === "send_to_user")
    .map((p) => {
      const args = p.arguments as { message?: unknown } | undefined;
      return typeof args?.message === "string" ? args.message : "";
    })
    .filter(Boolean);
  if (sent.length) return sent.join("\n\n").trim();
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n\n")
    .trim();
}

/** Cap text near `cap` characters, cutting at a paragraph or sentence end
 *  when one falls in the last 40% of the window. */
export function capText(text: string, cap = SOURCE_CHAR_CAP): string {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);
  const floor = Math.floor(cap * 0.6);
  const paragraph = window.lastIndexOf("\n\n");
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
  const cut = paragraph >= floor ? paragraph : sentence >= floor ? sentence + 1 : cap;
  return `${text.slice(0, cut).trimEnd()}\n[…]`;
}

/** The source passage for a node: the first provenance entry with a
 *  non-empty messageId, looked up in its chat. Returns undefined when the
 *  chat or message is missing or has no text. */
export function sourcePassage(
  node: GraphNodeLike,
  getChat: (chatId: string) => ChatRecordLike | null | undefined,
  cap = SOURCE_CHAR_CAP,
): string | undefined {
  const point = (node.provenance ?? []).find((p) => p.messageId);
  if (!point) return undefined;
  const chat = getChat(point.chatId);
  const message = chat?.messages.find((m) => m.id === point.messageId);
  if (!message) return undefined;
  const text = messageText(message);
  return text ? capText(text, cap) : undefined;
}

// ---------------------------------------------------------------------------
// Targets

const ref = (n: GraphNodeLike): NodeRef => ({ id: n.id, name: n.name, statement: n.statement });

export interface TargetExtras {
  source?: string;
  /** The learner flagged this idea; it may exceed the per-node cap. */
  flagged?: boolean;
  flagNote?: string;
  /** Newest first. */
  existingCards?: ExistingCard[];
}

/** Full target with all optional context, before budget trimming. Throws if
 *  the node or a chain member is missing from the graph. */
export function buildTarget(graph: GraphLike, nodeId: string, extras: TargetExtras = {}): WriterTarget {
  const byId = new Map(graph.propositions.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  if (!node) throw new Error(`Node is not in the graph: ${nodeId}`);
  const get = (id: string): GraphNodeLike => {
    const n = byId.get(id);
    if (!n) throw new Error(`Incomplete reasoning chain: ${id} is missing`);
    return n;
  };

  const concludedBy: ConcludingChain[] = graph.chains
    .filter((c) => c.conclusion === nodeId)
    .map((c) => ({ chainId: c.id, premises: c.premises.map((id) => ref(get(id))) }));

  const feedsAll: FeedingChain[] = graph.chains
    .filter((c) => c.premises.includes(nodeId) && c.conclusion !== nodeId)
    .map((c) => ({
      chainId: c.id,
      conclusion: ref(get(c.conclusion)),
      withPremises: c.premises.filter((id) => id !== nodeId).map((id) => ref(get(id))),
    }));

  return {
    nodeId,
    name: node.name,
    statement: node.statement,
    aliases: node.aliases ?? [],
    concludedBy,
    feeds: feedsAll.slice(0, MAX_FEEDS),
    neighbours: neighbours(graph, nodeId).map((id) => ref(get(id))),
    ...(extras.source ? { source: extras.source } : {}),
    ...(extras.flagged || extras.flagNote ? { flagged: true, maxCards: FLAGGED_CARD_CAP } : {}),
    ...(extras.flagNote ? { flagNote: extras.flagNote } : {}),
    existingCards: (extras.existingCards ?? []).slice(0, MAX_EXISTING_CARDS),
  };
}

/** Near neighbours for discriminate cards: nodes that share a chain or
 *  premises with the target. Siblings (other conclusions drawn from the
 *  target's premises) rank first, then co-premises, then direct links. */
export function neighbours(graph: GraphLike, nodeId: string, limit = MAX_NEIGHBOURS): string[] {
  const score = new Map<string, number>();
  const bump = (id: string, s: number) => {
    if (id !== nodeId) score.set(id, Math.max(score.get(id) ?? 0, s));
  };
  const myPremises = new Set(graph.chains.filter((c) => c.conclusion === nodeId).flatMap((c) => c.premises));
  for (const c of graph.chains) {
    if (c.conclusion !== nodeId && c.premises.some((p) => myPremises.has(p))) bump(c.conclusion, 3);
    if (c.premises.includes(nodeId)) {
      for (const p of c.premises) bump(p, 2);
      bump(c.conclusion, 1);
    }
    if (c.conclusion === nodeId) for (const p of c.premises) bump(p, 1);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}

/** Drop optional context until the target fits `limit` tokens: oldest
 *  existing cards, then neighbours, then feeding chains (whole, last first).
 *  Returns null when statement, concluding chains and source alone don't fit. */
export function trimToFit(target: WriterTarget, limit: number): WriterTarget | null {
  return trimTarget(target, candidate => estimateTokens(JSON.stringify(candidate)) <= limit);
}

export function trimTarget(target: WriterTarget, fits: (candidate: WriterTarget) => boolean): WriterTarget | null {
  const t: WriterTarget = {
    ...target,
    feeds: [...target.feeds],
    neighbours: [...target.neighbours],
    existingCards: [...target.existingCards],
  };
  if (fits(t)) return t;
  for (const optional of [t.existingCards, t.neighbours, t.feeds]) {
    while (optional.length) {
      optional.pop();
      if (fits(t)) return t;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packing

export interface PackOptions {
  maxCardsPerNode: number;
  enabledKinds: CardKind[];
  chunkBudget?: number;
  /** Model catalog limits; null or undefined means unknown. */
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export interface Batch {
  input: WriterInput;
  inputTokens: number;
  outputAllowance: number;
}

export interface SkippedTarget {
  nodeId: string;
  reason: string;
}

export function pack(
  graph: GraphLike,
  nodeIds: string[],
  extrasFor: (nodeId: string) => TargetExtras,
  options: PackOptions,
): { batches: Batch[]; skipped: SkippedTarget[] } {
  const { maxCardsPerNode, enabledKinds } = options;
  if (!Number.isInteger(maxCardsPerNode) || maxCardsPerNode < 1 || maxCardsPerNode > 4) {
    throw new Error("Cards per node must be a whole number from 1 to 4.");
  }
  if (!enabledKinds.length) throw new Error("Enable at least one card kind.");
  const budget = options.chunkBudget ?? DEFAULT_CHUNK_BUDGET;
  const perNodeOut = outputAllowance(1, maxCardsPerNode);
  const ceiling = options.contextWindow
    ? Math.min(HARD_INPUT_CEILING, options.contextWindow - perNodeOut)
    : HARD_INPUT_CEILING;

  const batches: Batch[] = [];
  const skipped: SkippedTarget[] = [];
  let current: WriterTarget[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push({
      input: { version: 1, maxCardsPerNode, enabledKinds: [...enabledKinds], targets: current },
      inputTokens: currentTokens,
      outputAllowance: targetsAllowance(current, maxCardsPerNode),
    });
    current = [];
    currentTokens = 0;
  };

  for (const nodeId of [...new Set(nodeIds)]) {
    let target: WriterTarget;
    try {
      target = buildTarget(graph, nodeId, extrasFor(nodeId));
    } catch (error) {
      skipped.push({ nodeId, reason: (error as Error).message });
      continue;
    }
    let tokens = estimateTokens(JSON.stringify(target));
    if (tokens > ceiling) {
      const trimmed = trimToFit(target, ceiling);
      if (!trimmed) {
        skipped.push({
          nodeId,
          reason: `Too large for one request: its statement, reasoning chains and source need about ${tokens} tokens; the limit is ${ceiling}.`,
        });
        continue;
      }
      target = trimmed;
    }
    target = { ...target, allowedKinds: allowedKindsFor(target, enabledKinds) };
    tokens = estimateTokens(JSON.stringify(target));
    if (!target.allowedKinds!.length) {
      skipped.push({ nodeId, reason: `None of the enabled card kinds (${enabledKinds.join(", ")}) fit this node's reasoning chains.` });
      continue;
    }
    const out = targetsAllowance([...current, target], maxCardsPerNode);
    if (current.length && (currentTokens + tokens > budget || (options.maxTokens && out > options.maxTokens))) flush();
    current.push(target);
    currentTokens += tokens;
  }
  flush();
  return { batches, skipped };
}
