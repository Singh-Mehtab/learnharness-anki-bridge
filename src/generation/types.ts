import type { CardKind } from '../anki/state.ts';
import type { WriterInput, WriterResult } from '../writer/types.ts';

export interface GenerationSettings {
  cardsPerNode: number;
  enabledKinds: CardKind[];
  model: { provider: string; id: string } | null;
}
export interface SourceSnapshot {
  nodeId: string;
  name: string;
  statement: string;
  statementHash: string;
  sessionId: string;
  sessionName: string;
  source?: string;
}
export interface GenerationTask {
  requestId: string;
  taskId?: string;
  status: 'pending' | 'running' | 'applied' | 'failed' | 'cancelled' | 'interrupted';
  input: WriterInput;
  sources: SourceSnapshot[];
  outputAllowance: number;
  result?: WriterResult;
  error?: string;
}
export interface Generation {
  id: string;
  createdAt: string;
  nodeIds: string[];
  /** Absent on legacy generations, whose targets were all explicit requests. */
  backfillNodeIds?: string[];
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  settings: GenerationSettings;
  tasks: GenerationTask[];
  skipped: { nodeId: string; reason: string }[];
}
export const defaultGenerationSettings = (): GenerationSettings => ({
  cardsPerNode: 2, enabledKinds: ['recall', 'why', 'compose', 'discriminate'], model: null,
});

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function validGenerationSettings(v: unknown): v is GenerationSettings {
  return object(v) && Number.isInteger(v.cardsPerNode) && Number(v.cardsPerNode) >= 1 && Number(v.cardsPerNode) <= 4
    && strings(v.enabledKinds) && v.enabledKinds.length > 0 && new Set(v.enabledKinds).size === v.enabledKinds.length
    && v.enabledKinds.every(k => ['recall', 'why', 'compose', 'discriminate'].includes(k))
    && (v.model === null || object(v.model) && typeof v.model.provider === 'string' && !!v.model.provider && typeof v.model.id === 'string' && !!v.model.id);
}
export function validSource(v: unknown): v is SourceSnapshot {
  return object(v) && ['nodeId', 'name', 'statement', 'statementHash', 'sessionId', 'sessionName'].every(k => typeof v[k] === 'string') && (v.source === undefined || typeof v.source === 'string');
}
const coreKinds = (v: unknown): v is CardKind[] => strings(v) && v.length > 0 && new Set(v).size === v.length && v.every(k => ['recall', 'why', 'compose', 'discriminate'].includes(k));
const nodeRef = (v: unknown): boolean => object(v) && ['id', 'name', 'statement'].every(k => typeof v[k] === 'string');
function validWriterInput(v: unknown): v is WriterInput {
  if (!object(v) || v.version !== 1 || !Number.isInteger(v.maxCardsPerNode) || Number(v.maxCardsPerNode) < 1 || Number(v.maxCardsPerNode) > 4 || !coreKinds(v.enabledKinds) || !Array.isArray(v.targets) || !v.targets.length) return false;
  const ids = new Set<string>();
  return v.targets.every(t => {
    if (!object(t) || typeof t.nodeId !== 'string' || !t.nodeId || ids.has(t.nodeId) || !['name', 'statement'].every(k => typeof t[k] === 'string') || !strings(t.aliases) || !Array.isArray(t.existingCards) || t.existingCards.some(c => !object(c) || !['recall', 'why', 'compose', 'discriminate'].includes(String(c.kind)) || typeof c.front !== 'string' || typeof c.back !== 'string') || !Array.isArray(t.neighbours) || !t.neighbours.every(nodeRef) || !Array.isArray(t.concludedBy) || t.concludedBy.some(c => !object(c) || typeof c.chainId !== 'string' || !Array.isArray(c.premises) || !c.premises.every(nodeRef)) || !Array.isArray(t.feeds) || t.feeds.some(c => !object(c) || typeof c.chainId !== 'string' || !nodeRef(c.conclusion) || !Array.isArray(c.withPremises) || !c.withPremises.every(nodeRef)) || !coreKinds(t.allowedKinds) || t.allowedKinds.some(k => !(v.enabledKinds as string[]).includes(k)) || (t.source !== undefined && typeof t.source !== 'string')) return false;
    ids.add(t.nodeId); return true;
  });
}
function validResultShape(result: unknown, input: WriterInput): boolean {
  if (!object(result) || !Array.isArray(result.targets)) return false;
  const ids = new Set(input.targets.map(t => t.nodeId));
  return result.targets.every(t => object(t) && typeof t.nodeId === 'string' && ids.has(t.nodeId) && Array.isArray(t.cards)
    && (t.skipReason === undefined || typeof t.skipReason === 'string')
    && t.cards.every(c => object(c) && ['recall', 'why', 'compose', 'discriminate'].includes(String(c.kind)) && typeof c.front === 'string' && typeof c.back === 'string' && (c.extra === undefined || typeof c.extra === 'string')));
}
export function validateGenerations(settings: unknown, generations: unknown): void {
  if (!validGenerationSettings(settings) || !Array.isArray(generations)) throw new Error('Invalid generation state. The file has not been reset.');
  const ids = new Set<string>(), requests = new Set<string>();
  for (const g of generations) {
    if (!object(g) || typeof g.id !== 'string' || !g.id || ids.has(g.id) || typeof g.createdAt !== 'string' || !strings(g.nodeIds) || !validGenerationSettings(g.settings) || !['running', 'completed', 'cancelled', 'interrupted', 'failed'].includes(String(g.status)) || !Array.isArray(g.tasks) || !Array.isArray(g.skipped) || g.skipped.some(s => !object(s) || typeof s.nodeId !== 'string' || typeof s.reason !== 'string')) throw new Error('Invalid generation batch.');
    if (g.backfillNodeIds !== undefined && (!strings(g.backfillNodeIds) || new Set(g.backfillNodeIds).size !== g.backfillNodeIds.length || g.backfillNodeIds.some(id => !(g.nodeIds as string[]).includes(id)))) throw new Error('Invalid generation backfill targets.');
    ids.add(g.id);
    for (const t of g.tasks) {
      if (!object(t) || typeof t.requestId !== 'string' || !t.requestId || requests.has(t.requestId) || (t.taskId !== undefined && typeof t.taskId !== 'string') || !['pending', 'running', 'applied', 'failed', 'cancelled', 'interrupted'].includes(String(t.status)) || !validWriterInput(t.input) || !Array.isArray(t.sources) || !t.sources.every(validSource) || !Number.isSafeInteger(t.outputAllowance) || Number(t.outputAllowance) <= 0 || (t.error !== undefined && typeof t.error !== 'string') || (t.status === 'applied' && !object(t.result))) throw new Error('Invalid generation task.');
      requests.add(t.requestId);
      const input = t.input as WriterInput, sources = t.sources as SourceSnapshot[];
      if (sources.length !== input.targets.length || new Set(sources.map(s => s.nodeId)).size !== sources.length || input.targets.some(n => !sources.some(s => s.nodeId === n.nodeId && s.statement === n.statement))) throw new Error('Generation sources do not match accepted input.');
      // Content rules are enforced once, at apply time. Persisted results get a shape check only,
      // so a later, stricter writer check never makes an old state file unreadable.
      if (t.status === 'applied' && !validResultShape(t.result, input)) throw new Error('Invalid applied generation result.');
    }
  }
}
