import { randomUUID } from 'node:crypto';
import type { PluginBackendContext } from '../../sdk/index.d.ts';
import type { DeliveryService } from '../anki/delivery.ts';
import type { StateStore } from '../anki/state.ts';
import { graphCoverage, statementHash } from '../coverage/service.ts';
import type { Coverage, CoverageNode } from '../coverage/flow.ts';
import { extractedMessageIds } from './extraction.ts';
import {
  failedOutputCallIds, flagIdeaHandled, matchFlag, MAX_FLAG_MESSAGES, MAX_FLAGS, normalizeNote, sessionNodeIds, teacherProse,
} from './flow.ts';
import type { CardCounts, Flag, GraphLike, MessageLike } from './flow.ts';

export const SESSION_OPERATIONS = ['flag', 'unflag', 'sessions', 'sessionFlow'] as const;
/** Used until 0.3.0's generation settings supply the real cap. */
const MAX_SESSIONS = 200;

/** matched: nodes exist. waiting: extraction hasn't covered the message yet.
 * no-nodes: extraction covered it and produced no node anchored there.
 * missing: the session or a flagged message is gone from the saved record. */
export type FlagStatus = 'matched' | 'waiting' | 'no-nodes' | 'missing';
export interface FlagView extends Flag { status: FlagStatus; nodeIds: string[]; pendingNodeIds: string[] }
/** `created` is false when the call updated an existing flag, so Undo must not remove it. */
export interface FlagResult extends FlagView { created: boolean }
export interface SessionNode { id: string; name: string; statement: string; flagged: boolean; pendingFlag: boolean; flagNotes: string[]; cards: CardCounts; statementHash: string; coverage: Coverage }
export interface SessionFlow {
  session: { id: string; title: string; exists: boolean };
  nodes: SessionNode[];
  flags: FlagView[];
  cardsPerNode: number;
  paired: boolean;
  missing: CoverageNode[];
  pairingWarning: boolean;
  pairingKey: string;
}
export interface SessionSummary { id: string; title: string; updatedAt: string; nodeCount: number; flagCount: number; waitingCount: number }
export interface SessionList { sessions: SessionSummary[]; unresolved: FlagView[] }

type Learning = PluginBackendContext['learning'];
interface Record_ { id: string; title: string; kind?: string; messages: readonly MessageLike[] }

function data(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an input object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) throw new Error(`Unsupported input: ${extra.join(', ')}.`);
}
function sessionIdInput(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) throw new Error('Choose a session.');
  return value;
}
function messageIdsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FLAG_MESSAGES || value.some(id => typeof id !== 'string' || !id || id.length > 500) || new Set(value).size !== value.length) {
    throw new Error('Flag needs one or more distinct message IDs.');
  }
  return value as string[];
}

/** Flags live in the one state snapshot and are written only through the
 * delivery service's writer fence, so they cannot race sends or generation. */
export class SessionService {
  private readonly learning: Learning;
  private readonly store: StateStore;
  private readonly delivery: DeliveryService;
  private readonly cardsPerNode: () => number;
  private readonly signal?: AbortSignal;
  private closed = false;
  constructor(learning: Learning, store: StateStore, delivery: DeliveryService, options: { cardsPerNode?: () => number; signal?: AbortSignal } = {}) {
    this.learning = learning; this.store = store; this.delivery = delivery; this.signal = options.signal;
    this.cardsPerNode = options.cardsPerNode ?? (() => this.store.snapshot().generationSettings.cardsPerNode);
  }
  close(): void { this.closed = true; }

  private session(id: string): Record_ | null {
    // getSession throws on IDs the host considers invalid; treat those as absent.
    try { return this.learning.getSession(id) as unknown as Record_ | null; } catch { return null; }
  }
  private graph(): GraphLike { return this.learning.graph() as unknown as GraphLike; }
  private covered(): ReadonlyArray<{ chatId: string; fp: string }> {
    // A host that refuses the ledger only loses the "no nodes" hint; flags stay waiting.
    try { return this.learning.readGraphFile('coverage.jsonl'); } catch { return []; }
  }

  private views(flags: readonly Flag[], graph: GraphLike): FlagView[] {
    const records = new Map<string, Record_ | null>();
    let ledger: ReadonlyArray<{ chatId: string; fp: string }> | undefined;
    const statements = new Map(graph.propositions.map(n => [n.id, n.statement]));
    return flags.map(flag => {
      const nodeIds = matchFlag(flag, graph);
      const pendingNodeIds = nodeIds.filter(id => !flagIdeaHandled(flag, id, statementHash(statements.get(id)!)));
      if (!records.has(flag.sessionId)) records.set(flag.sessionId, this.session(flag.sessionId));
      const record = records.get(flag.sessionId);
      if (!record || flag.messageIds.some(id => !record.messages.some(m => m.id === id))) return { ...flag, status: 'missing', nodeIds, pendingNodeIds };
      if (nodeIds.length) return { ...flag, status: 'matched', nodeIds, pendingNodeIds };
      ledger ??= this.covered();
      const covered = new Set(ledger.filter(e => e.chatId === flag.sessionId).map(e => e.fp));
      const extracted = extractedMessageIds(record.messages, covered, flag.messageIds);
      return { ...flag, status: flag.messageIds.every(id => extracted.has(id)) ? 'no-nodes' : 'waiting', nodeIds, pendingNodeIds };
    });
  }

  private async flag(input: Record<string, unknown>): Promise<FlagResult> {
    keys(input, ['sessionId', 'messageIds', 'note']);
    const sessionId = sessionIdInput(input.sessionId), messageIds = messageIdsInput(input.messageIds);
    const note = input.note === undefined ? undefined : normalizeNote(input.note);
    const record = this.session(sessionId);
    if (!record) throw new Error('Session not found.');
    if (record.kind !== undefined && record.kind !== 'teach') throw new Error('Flags are for teaching sessions.');
    // Only saved teacher prose can anchor extracted nodes; streamed or optimistic
    // messages have no saved ID yet.
    const failed = failedOutputCallIds(record.messages);
    for (const id of messageIds) {
      const message = record.messages.find(m => m.id === id);
      if (!message || !teacherProse(message, failed).length) throw new Error('Reply not saved yet. Wait for it to finish, then flag again.');
    }
    let created = false;
    const flag = await this.delivery.exclusive(async () => {
      let result!: Flag;
      await this.delivery.save(state => {
        const overlapping = state.flags.filter(f => f.sessionId === sessionId && f.messageIds.some(id => messageIds.includes(id)));
        if (overlapping.length) {
          // Re-flagging the same turn updates it; it never creates a duplicate.
          const [first, ...rest] = overlapping;
          const ids = [...new Set([...overlapping.flatMap(f => f.messageIds), ...messageIds])].slice(0, MAX_FLAG_MESSAGES);
          const keptNote = note ?? [...new Set(overlapping.map(f => f.note).filter(Boolean))].join(' / ').slice(0, 300);
          result = { ...first, messageIds: ids, note: keptNote, sessionTitle: record.title || first.sessionTitle };
          if (keptNote !== first.note || ids.length !== first.messageIds.length || ids.some((id, i) => id !== first.messageIds[i])) {
            result.revision = randomUUID();
            delete result.handledIdeas;
          }
          state.flags = state.flags.filter(f => !rest.includes(f)).map(f => f === first ? result : f);
        } else {
          if (state.flags.length >= MAX_FLAGS) throw new Error(`Limit is ${MAX_FLAGS} flags. Remove some first.`);
          created = true;
          result = { id: randomUUID(), sessionId, sessionTitle: record.title ?? '', messageIds, note: note ?? '', flaggedAt: new Date().toISOString() };
          state.flags.push(result);
        }
      });
      return result;
    }, true);
    return { ...this.views([flag], this.graph())[0], created };
  }

  private async unflag(input: Record<string, unknown>): Promise<{ removed: string }> {
    keys(input, ['id']);
    if (typeof input.id !== 'string') throw new Error('Invalid flag ID.');
    const id = input.id;
    await this.delivery.exclusive(() => this.delivery.save(state => {
      const before = state.flags.length;
      state.flags = state.flags.filter(f => f.id !== id);
      if (state.flags.length === before) throw new Error('Flag not found.');
    }), true);
    return { removed: id };
  }

  private sessions(): SessionList {
    const state = this.store.snapshot(), graph = this.graph();
    const nodeCount = new Map<string, number>();
    for (const node of graph.propositions) {
      const chats = new Set([...(graph.nodeSessions[node.id] ?? []), ...(node.provenance ?? []).map(p => p.chatId)]);
      for (const chat of chats) nodeCount.set(chat, (nodeCount.get(chat) ?? 0) + 1);
    }
    const views = this.views(state.flags, graph);
    const listed = this.learning.listSessions().filter(s => s.kind === 'teach')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_SESSIONS);
    const sessions = listed.map(s => {
      const own = views.filter(v => v.sessionId === s.id);
      return { id: s.id, title: s.title, updatedAt: s.updatedAt, nodeCount: nodeCount.get(s.id) ?? 0, flagCount: own.length, waitingCount: own.filter(v => v.status !== 'matched').length };
    });
    const listedIds = new Set(sessions.map(s => s.id));
    return { sessions, unresolved: views.filter(v => v.status !== 'matched' || !listedIds.has(v.sessionId)) };
  }

  private sessionFlow(input: Record<string, unknown>): SessionFlow {
    keys(input, ['sessionId']);
    const sessionId = sessionIdInput(input.sessionId);
    const state = this.store.snapshot(), graph = this.graph(), record = this.session(sessionId);
    const flags = this.views(state.flags.filter(f => f.sessionId === sessionId), graph);
    const ids = sessionNodeIds(graph, sessionId, (record?.messages ?? []).map(m => String(m.id)));
    for (const id of flags.flatMap(f => f.nodeIds)) if (!ids.includes(id)) ids.push(id);
    const coverage = graphCoverage(graph, state), byId = new Map(coverage.nodes.map(n => [n.id, n] as const));
    const nodes = ids.map(id => {
      const n = byId.get(id)!, mine = flags.filter(f => f.nodeIds.includes(id));
      return { ...n, flagged: mine.length > 0, pendingFlag: mine.some(f => f.pendingNodeIds.includes(id)),
        flagNotes: [...new Set(mine.map(f => f.note).filter(Boolean))] };
    });
    const title = record?.title || flags[0]?.sessionTitle || graph.sessions?.[sessionId] || '';
    return { session: { id: sessionId, title, exists: !!record }, nodes, flags, cardsPerNode: this.cardsPerNode(), paired: !!state.destination,
      missing: coverage.missing.filter(n => state.cards.some(c => c.nodeId === n.id && c.sessionId === sessionId)), pairingWarning: coverage.pairingWarning, pairingKey: coverage.pairingKey };
  }

  async command(name: string, input: unknown = {}): Promise<unknown> {
    if (this.closed || this.signal?.aborted) throw new Error('Anki Bridge is disabled.');
    const value = data(input);
    if (name === 'flag') return this.flag(value);
    if (name === 'unflag') return this.unflag(value);
    if (name === 'sessions') { keys(value, []); return this.sessions(); }
    if (name === 'sessionFlow') return this.sessionFlow(value);
    throw new Error(`Unknown session operation: ${name}`);
  }
}
