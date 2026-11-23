import { CORE_KINDS, DEFAULT_KINDS, FLAGGED_CARD_CAP, isCoreKind, isStoredKind, WRITER_NOTES_LIMIT } from '../writer/types.ts';
import type { CoreCardKind, StoredCardKind } from '../writer/types.ts';
import type { WriterInput, WriterResult } from '../writer/types.ts';

interface SettingsBase {
  cardsPerNode: number;
  model: { provider: string; id: string } | null;
}
/** FI-8 cloze setting. */
export type ClozeSetting = 'off' | 'auto' | 'prefer';
export const CLOZE_SETTINGS: readonly ClozeSetting[] = ['off', 'auto', 'prefer'];
/** model null means the host's cheap model slot. */
export interface GenerationSettings extends SettingsBase {
  enabledKinds: CoreCardKind[];
  /** FI-8. Absent in files from 0.9.0 and earlier. In the active settings a
   *  missing value means the default, auto; in generation history it means off,
   *  because those runs predate cloze. New history entries store it explicitly. */
  cloze?: ClozeSetting;
  /** #54: the learner's own card-style preferences, sent with every writer request
   *  below the built-in rules. Absent or blank means none; stored trimmed. */
  writerNotes?: string;
}
export { WRITER_NOTES_LIMIT };
/** Saved form of Writer notes: trimmed, with blank meaning none. */
export const normaliseWriterNotes = (value: string): string | undefined => value.trim() || undefined;
/** The active setting, with a missing value resolved to the default. */
export const activeCloze = (settings: GenerationSettings): ClozeSetting => settings.cloze ?? 'auto';
/** The setting a past generation ran with. Missing means off. */
export const historyCloze = (settings: Generation['settings']): ClozeSetting => ('cloze' in settings && settings.cloze) || 'off';
/** Settings saved by 0.7.2 (state schema 5): compose was offered and constant
 *  values had a toggle. Kept for generation history and migration. */
export interface V072GenerationSettings extends SettingsBase {
  enabledKinds: (CoreCardKind | 'compose')[];
  constantValues: boolean;
}
interface LegacyGenerationSettings extends SettingsBase {
  enabledKinds: ('recall' | 'why' | 'compose' | 'discriminate')[];
  constantValues?: never;
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
export const MAX_BATCH_CONTEXT_TOKENS = 5000;

export interface GenerationTask {
  requestId: string;
  /** FI-8: the worker definition this task runs on. Absent on tasks saved by
   *  0.9.0 and earlier, which all used manual-card-writer. */
  definitionId?: string;
  taskId?: string;
  status: 'pending' | 'running' | 'applied' | 'failed' | 'cancelled' | 'interrupted';
  input: WriterInput;
  sources: SourceSnapshot[];
  outputAllowance: number;
  /** Preflight's input reserve for earlier drafts from this run. */
  batchContextTokens?: number;
  /** Digest of the earlier drafts actually included in the prompt. */
  batchContextDigest?: string;
  result?: WriterResult;
  /** The host finished this request; retry must apply its saved result, not start another worker. */
  resultPending?: true;
  /** Exact duplicates not materialised as cards; the result above is never filtered. */
  duplicatesOmitted?: number;
  error?: string;
}
export interface Generation {
  id: string;
  createdAt: string;
  nodeIds: string[];
  /** Absent on legacy generations, whose targets were all explicit requests. */
  backfillNodeIds?: string[];
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  settings: GenerationSettings | V072GenerationSettings | LegacyGenerationSettings;
  /** Model and thinking level resolved at start (0.7.2). Absent on older batches, which used settings.model. */
  modelSpec?: { provider: string; id: string; thinkingLevel?: string };
  tasks: GenerationTask[];
  skipped: { nodeId: string; reason: string }[];
  /** Dismissed from the page by the learner (0.7.0). */
  hidden?: boolean;
}
export const defaultGenerationSettings = (): GenerationSettings => ({
  cardsPerNode: 2, enabledKinds: [...DEFAULT_KINDS], model: null,
});
/** Current settings from 0.7.2 settings: drop the constant-values toggle (#37)
 *  and compose (#38). Falls back to the defaults if no kind is left. */
export function fromV072Settings(old: V072GenerationSettings): GenerationSettings {
  const kinds = CORE_KINDS.filter(k => (old.enabledKinds as string[]).includes(k));
  return { cardsPerNode: old.cardsPerNode, enabledKinds: kinds.length ? kinds : [...DEFAULT_KINDS], model: old.model };
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const distinctKinds = (v: unknown): v is string[] => strings(v) && v.length > 0 && new Set(v).size === v.length;
function validBaseSettings(v: unknown): v is SettingsBase & Record<string, unknown> {
  return object(v) && Number.isInteger(v.cardsPerNode) && Number(v.cardsPerNode) >= 1 && Number(v.cardsPerNode) <= 4
    && (v.model === null || object(v.model) && typeof v.model.provider === 'string' && !!v.model.provider && typeof v.model.id === 'string' && !!v.model.id);
}
export function validGenerationSettings(v: unknown): v is GenerationSettings {
  return validBaseSettings(v) && distinctKinds(v.enabledKinds) && v.enabledKinds.every(isCoreKind) && !('constantValues' in v)
    && (v.cloze === undefined || CLOZE_SETTINGS.includes(v.cloze as ClozeSetting))
    && validWriterNotes(v.writerNotes);
}
/** Absent, or trimmed non-blank text within the limit. */
const validWriterNotes = (v: unknown): boolean =>
  v === undefined || typeof v === 'string' && !!v && v === v.trim() && v.length <= WRITER_NOTES_LIMIT;
export function validV072GenerationSettings(v: unknown): v is V072GenerationSettings {
  return validBaseSettings(v) && distinctKinds(v.enabledKinds) && v.enabledKinds.every(k => isCoreKind(k) || k === 'compose') && typeof v.constantValues === 'boolean';
}
export function validLegacyGenerationSettings(v: unknown): v is LegacyGenerationSettings {
  return validBaseSettings(v) && distinctKinds(v.enabledKinds) && v.enabledKinds.every(k => ['recall', 'why', 'compose', 'discriminate'].includes(k)) && v.constantValues === undefined;
}
export function validSource(v: unknown): v is SourceSnapshot {
  return object(v) && ['nodeId', 'name', 'statement', 'statementHash', 'sessionId', 'sessionName'].every(k => typeof v[k] === 'string') && (v.source === undefined || typeof v.source === 'string');
}
const storedKinds = (v: unknown): v is StoredCardKind[] => distinctKinds(v) && v.every(isStoredKind);
const nodeRef = (v: unknown): boolean => object(v) && ['id', 'name', 'statement'].every(k => typeof v[k] === 'string');
function validWriterInput(v: unknown): v is WriterInput {
  if (!object(v) || v.version !== 1 || !Number.isInteger(v.maxCardsPerNode) || Number(v.maxCardsPerNode) < 1 || Number(v.maxCardsPerNode) > 4 || !storedKinds(v.enabledKinds) || (v.constantValues !== undefined && typeof v.constantValues !== 'boolean') || (v.cloze !== undefined && v.cloze !== 'auto' && v.cloze !== 'prefer') || !validWriterNotes(v.writerNotes) || !Array.isArray(v.targets) || !v.targets.length) return false;
  const ids = new Set<string>();
  return v.targets.every(t => {
    if (!object(t) || typeof t.nodeId !== 'string' || !t.nodeId || ids.has(t.nodeId) || !['name', 'statement'].every(k => typeof t[k] === 'string') || !strings(t.aliases) || !Array.isArray(t.existingCards) || t.existingCards.some(c => !object(c) || !isStoredKind(c.kind) || typeof c.front !== 'string' || typeof c.back !== 'string' || (c.format !== undefined && c.format !== 'basic' && c.format !== 'cloze')) || !Array.isArray(t.neighbours) || !t.neighbours.every(nodeRef) || !Array.isArray(t.concludedBy) || t.concludedBy.some(c => !object(c) || typeof c.chainId !== 'string' || !Array.isArray(c.premises) || !c.premises.every(nodeRef)) || !Array.isArray(t.feeds) || t.feeds.some(c => !object(c) || typeof c.chainId !== 'string' || !nodeRef(c.conclusion) || !Array.isArray(c.withPremises) || !c.withPremises.every(nodeRef)) || !storedKinds(t.allowedKinds) || t.allowedKinds.some(k => !(v.enabledKinds as string[]).includes(k)) || (t.source !== undefined && typeof t.source !== 'string')) return false;
    if ((t.flagged !== undefined && typeof t.flagged !== 'boolean') || (t.flagNote !== undefined && typeof t.flagNote !== 'string')
      || (t.flagged === true ? t.maxCards !== FLAGGED_CARD_CAP : t.maxCards !== undefined)) return false;
    ids.add(t.nodeId); return true;
  });
}
function validResultShape(result: unknown, input: WriterInput): boolean {
  if (!object(result) || !Array.isArray(result.targets)) return false;
  const ids = new Set(input.targets.map(t => t.nodeId));
  return result.targets.every(t => object(t) && typeof t.nodeId === 'string' && ids.has(t.nodeId) && Array.isArray(t.cards)
    && (t.skipReason === undefined || typeof t.skipReason === 'string')
    && t.cards.every(c => object(c) && isStoredKind(c.kind) && typeof c.front === 'string' && typeof c.back === 'string' && (c.extra === undefined || typeof c.extra === 'string')
      && (c.format === undefined || c.format === 'basic' || c.format === 'cloze')));
}
export function validateGenerations(settings: unknown, generations: unknown): void {
  if (!validGenerationSettings(settings) || !Array.isArray(generations)) throw new Error('Invalid generation state. The file has not been reset.');
  const ids = new Set<string>(), requests = new Set<string>();
  for (const g of generations) {
    if (!object(g) || typeof g.id !== 'string' || !g.id || ids.has(g.id) || typeof g.createdAt !== 'string' || !strings(g.nodeIds) || !(validGenerationSettings(g.settings) || validV072GenerationSettings(g.settings) || validLegacyGenerationSettings(g.settings)) || !validWriterNotes((g.settings as { writerNotes?: unknown }).writerNotes) || !['running', 'completed', 'cancelled', 'interrupted', 'failed'].includes(String(g.status)) || !Array.isArray(g.tasks) || !Array.isArray(g.skipped) || g.skipped.some(s => !object(s) || typeof s.nodeId !== 'string' || typeof s.reason !== 'string')) throw new Error('Invalid generation batch.');
    if (g.backfillNodeIds !== undefined && (!strings(g.backfillNodeIds) || new Set(g.backfillNodeIds).size !== g.backfillNodeIds.length || g.backfillNodeIds.some(id => !(g.nodeIds as string[]).includes(id)))) throw new Error('Invalid generation backfill targets.');
    if (g.hidden !== undefined && typeof g.hidden !== 'boolean') throw new Error('Invalid generation visibility.');
    if (g.modelSpec !== undefined && !(object(g.modelSpec) && typeof g.modelSpec.provider === 'string' && !!g.modelSpec.provider && typeof g.modelSpec.id === 'string' && !!g.modelSpec.id && (g.modelSpec.thinkingLevel === undefined || typeof g.modelSpec.thinkingLevel === 'string'))) throw new Error('Invalid generation model.');
    if (g.modelSpec === undefined && g.status === 'running' && !g.settings.model) throw new Error('Invalid generation model.');
    ids.add(g.id);
    // #54: a build without Writer notes copies saved notes into the run settings but
    // sends none, so its requests carry none. Once any request carries notes, all must
    // carry the run's notes.
    const runNotes = (g.settings as { writerNotes?: unknown }).writerNotes;
    const carriedNotes = g.tasks.some(t => object(t) && object(t.input) && t.input.writerNotes !== undefined);
    for (const t of g.tasks) {
      if (!object(t) || typeof t.requestId !== 'string' || !t.requestId || requests.has(t.requestId) || (t.taskId !== undefined && typeof t.taskId !== 'string') || (t.definitionId !== undefined && typeof t.definitionId !== 'string') || !['pending', 'running', 'applied', 'failed', 'cancelled', 'interrupted'].includes(String(t.status)) || !validWriterInput(t.input) || !Array.isArray(t.sources) || !t.sources.every(validSource) || !Number.isSafeInteger(t.outputAllowance) || Number(t.outputAllowance) <= 0 || (t.error !== undefined && typeof t.error !== 'string') || (t.status === 'applied' && !object(t.result))) throw new Error('Invalid generation task.');
      if (t.batchContextTokens !== undefined && (!Number.isSafeInteger(t.batchContextTokens) || Number(t.batchContextTokens) < 1 || Number(t.batchContextTokens) > MAX_BATCH_CONTEXT_TOKENS)) throw new Error('Invalid batch context budget.');
      if (t.batchContextDigest !== undefined && (t.batchContextTokens === undefined || typeof t.batchContextDigest !== 'string' || !/^[a-f0-9]{64}$/.test(t.batchContextDigest))) throw new Error('Invalid batch context digest.');
      if (t.resultPending !== undefined && (t.resultPending !== true || t.status !== 'interrupted')) throw new Error('Invalid pending generation result.');
      if (t.duplicatesOmitted !== undefined && (t.status !== 'applied' || !Number.isSafeInteger(t.duplicatesOmitted) || Number(t.duplicatesOmitted) < 1)) throw new Error('Invalid duplicate omission count.');
      requests.add(t.requestId);
      const input = t.input as WriterInput, sources = t.sources as SourceSnapshot[];
      if (carriedNotes && input.writerNotes !== runNotes) throw new Error('Invalid generation task.');
      if (sources.length !== input.targets.length || new Set(sources.map(s => s.nodeId)).size !== sources.length || input.targets.some(n => !sources.some(s => s.nodeId === n.nodeId && s.statement === n.statement))) throw new Error('Generation sources do not match accepted input.');
      // Content rules are enforced once, at apply time. Persisted results get a shape check only,
      // so a later, stricter writer check never makes an old state file unreadable.
      if (t.status === 'applied' && !validResultShape(t.result, input)) throw new Error('Invalid applied generation result.');
    }
  }
}
