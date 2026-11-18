// Session flow logic shared by the frontend and backend. Pure and browser-safe:
// no host runtime imports, no Node built-ins. Transcripts and graph text are
// untrusted data; nothing here interprets them beyond reading IDs and prose.

export const SEND_TO_USER_TOOL = 'send_to_user';
export const MAX_FLAG_NOTE = 300;
export const MAX_FLAG_MESSAGES = 50;
export const MAX_FLAGS = 5000;

/** A flag on one settled teaching turn. `messageIds` are the saved record IDs of
 * the turn's assistant messages that carry learner-facing prose. */
export interface Flag {
  id: string;
  sessionId: string;
  sessionTitle: string;
  messageIds: string[];
  note: string;
  flaggedAt: string;
}

/** Structural subset of LhMessage that this module reads. */
export interface MessageLike {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
}
export interface ProvenanceLike { chatId: string; messageId: string }
export interface NodeLike { id: string; name: string; statement: string; provenance?: readonly ProvenanceLike[] }
export interface GraphLike {
  propositions: readonly NodeLike[];
  nodeSessions: Readonly<Record<string, readonly string[]>>;
  sessions?: Readonly<Record<string, string>>;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

/** send_to_user calls that did not deliver: an error result, or a call inside an
 * errored/aborted generation. Mirrors the host's coverage selection. */
export function failedOutputCallIds(messages: readonly MessageLike[]): Set<string> {
  const failed = new Set<string>();
  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolName === SEND_TO_USER_TOOL && m.isError === true && text(m.toolCallId)) failed.add(m.toolCallId);
    else if (m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted') && Array.isArray(m.content)) {
      for (const block of m.content) if (object(block) && block.type === 'toolCall' && block.name === SEND_TO_USER_TOOL && text(block.id)) failed.add(block.id);
    }
  }
  return failed;
}

/** Learner-facing prose of one message: text blocks and delivered send_to_user
 * messages, in content order. Thinking and other tool inputs are excluded. */
export function teacherProse(message: MessageLike, failed: ReadonlySet<string> = failedOutputCallIds([message])): string[] {
  if (message.role !== 'assistant') return [];
  const content = message.content;
  if (text(content)) return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!object(block)) continue;
    if (block.type === 'toolCall' && text(block.id) && failed.has(block.id)) continue;
    let prose: unknown;
    if (block.type === 'text') prose = block.text;
    else if (block.type === 'toolCall' && block.name === SEND_TO_USER_TOOL && object(block.arguments)) prose = block.arguments.message;
    if (text(prose) && prose.trim()) out.push(prose);
  }
  return out;
}

export interface TeacherTurn { messageIds: string[]; excerpt: string }

/** The most recent learner-visible teaching turn: every assistant message with
 * prose between two learner messages. One reply can span several assistant
 * messages (tool loops), and extraction anchors nodes to each of them. Returns
 * null when no teacher prose exists. Call only on settled transcripts. */
export function latestTeacherTurn(messages: readonly MessageLike[]): TeacherTurn | null {
  const failed = failedOutputCallIds(messages);
  let end = messages.length;
  while (end > 0) {
    let start = end;
    while (start > 0 && messages[start - 1].role !== 'user') start--;
    const ids: string[] = [], prose: string[] = [];
    for (let i = start; i < end; i++) {
      const m = messages[i], lines = teacherProse(m, failed);
      if (lines.length && text(m.id) && m.id) { ids.push(m.id); prose.push(...lines); }
    }
    if (ids.length) return { messageIds: ids, excerpt: excerpt(prose.join('\n\n')) };
    end = start - 1; // Skip this learner message and look at the previous turn.
  }
  return null;
}

export function excerpt(value: string, limit = 240): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/** Notes are one line, trimmed and capped. Untrusted: the writer treats them as data. */
export function normalizeNote(value: unknown): string {
  if (value === undefined) return '';
  if (!text(value)) throw new Error('Flag note must be text.');
  if (value.includes('\0')) throw new Error('Flag note contains a null character.');
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length > MAX_FLAG_NOTE) throw new Error(`Flag note is longer than ${MAX_FLAG_NOTE} characters.`);
  return flat;
}

export function validFlag(v: unknown): v is Flag {
  return object(v) && text(v.id) && UUID.test(v.id) && text(v.sessionId) && !!v.sessionId && v.sessionId.length <= 500 &&
    text(v.sessionTitle) && v.sessionTitle.length <= 1000 && text(v.note) && v.note.length <= MAX_FLAG_NOTE && !/[\r\n]/.test(v.note) &&
    text(v.flaggedAt) && !Number.isNaN(Date.parse(v.flaggedAt)) &&
    Array.isArray(v.messageIds) && v.messageIds.length > 0 && v.messageIds.length <= MAX_FLAG_MESSAGES &&
    v.messageIds.every(id => text(id) && !!id && id.length <= 500) && new Set(v.messageIds).size === v.messageIds.length;
}

export function validateFlags(value: unknown): asserts value is Flag[] {
  if (!Array.isArray(value) || value.length > MAX_FLAGS) throw new Error('Invalid flag list. The file has not been reset.');
  const ids = new Set<string>(), anchors = new Set<string>();
  for (const flag of value) {
    if (!validFlag(flag) || ids.has(flag.id)) throw new Error('Invalid flag. The file has not been reset.');
    ids.add(flag.id);
    for (const m of flag.messageIds) {
      const key = `${flag.sessionId}\u0000${m}`;
      if (anchors.has(key)) throw new Error('Two flags claim the same message. The file has not been reset.');
      anchors.add(key);
    }
  }
}

/** Nodes extracted from any of the flagged messages, in graph order. */
export function matchFlag(flag: Pick<Flag, 'sessionId' | 'messageIds'>, graph: GraphLike): string[] {
  const wanted = new Set(flag.messageIds.filter(Boolean));
  return graph.propositions.filter(n => n.provenance?.some(p => p.chatId === flag.sessionId && !!p.messageId && wanted.has(p.messageId))).map(n => n.id);
}

/** Nodes the session touched, by nodeSessions, ordered by where they first appear
 * in the transcript (message order), then name. Unanchored nodes go last. */
export function sessionNodeIds(graph: GraphLike, sessionId: string, messageOrder: readonly string[] = []): string[] {
  const index = new Map(messageOrder.map((id, i) => [id, i] as const));
  const position = (n: NodeLike) => Math.min(Infinity, ...(n.provenance ?? []).filter(p => p.chatId === sessionId && index.has(p.messageId)).map(p => index.get(p.messageId)!));
  const nodes = graph.propositions.filter(n => graph.nodeSessions[n.id]?.includes(sessionId) || n.provenance?.some(p => p.chatId === sessionId));
  return nodes.map(n => ({ n, at: position(n) })).sort((a, b) => a.at - b.at || a.n.name.localeCompare(b.n.name)).map(x => x.n.id);
}

/** Flag notes per node for the card writer. A node can sit under several flags. */
export function flagNotesByNode(flags: readonly Flag[], graph: GraphLike): Map<string, string> {
  const notes = new Map<string, string[]>();
  for (const flag of flags) {
    if (!flag.note) continue;
    for (const id of matchFlag(flag, graph)) {
      const list = notes.get(id) ?? [];
      if (!list.includes(flag.note)) list.push(flag.note);
      notes.set(id, list);
    }
  }
  return new Map([...notes].map(([id, list]) => [id, list.join(' / ').slice(0, MAX_FLAG_NOTE * 3)]));
}

export { hasCards } from '../coverage/flow.ts';
export type { CardCounts } from '../coverage/flow.ts';
import { canSelectNode, isUncardedNode } from '../coverage/flow.ts';
import type { CoverageSelectable } from '../coverage/flow.ts';
export interface SelectableNode extends CoverageSelectable { flagged: boolean }

/** Draft screen default: flagged nodes ticked, nothing else. A flag is an explicit
 * request, so a flagged node stays ticked even when it already has cards; the
 * writer sees existing cards and aims for new angles. */
export function defaultSelection(nodes: readonly SelectableNode[]): string[] {
  return nodes.filter(n => n.flagged && canSelectNode(n)).map(n => n.id);
}
/** "Select all uncarded": nodes with no cards waiting or sent to the paired profile. */
export function uncardedIds(nodes: readonly SelectableNode[]): string[] {
  return nodes.filter(isUncardedNode).map(n => n.id);
}
