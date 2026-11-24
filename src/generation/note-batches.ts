import { buildTarget, estimateTokens, HARD_INPUT_CEILING, type Batch, type SkippedTarget, type TargetExtras } from '../writer/input.ts';
import { allowedKindsFor, minimumNeighbours } from '../writer/kinds.ts';
import { writerPrompt } from '../writer/prompt.ts';
import type { GraphLike, WriterInput } from '../writer/types.ts';
import type { FlagReference } from '../session/flow.ts';
import { noteComponents, type ResolvedFlag } from './flag-selection.ts';

export function packNoteBatches(options: {
  graph: GraphLike;
  flags: ResolvedFlag[];
  independent: string[];
  extrasFor: (id: string) => TargetExtras;
  base: Omit<WriterInput, 'targets' | 'flagRequests'>;
  batch: (input: WriterInput) => Batch;
  fits: (batch: Batch) => boolean;
}): { batches: Batch[]; skipped: SkippedTarget[]; skippedFlagRequests: { count: number; reason: string }[]; assigned: Set<string> } {
  const { graph, flags, independent, extrasFor, base, batch, fits } = options;
  const blank = new Set(flags.filter(f => !f.note).flatMap(f => f.nodeIds));
  const requested = new Set(independent);
  const assigned = new Set<string>(), batches: Batch[] = [], skipped: SkippedTarget[] = [];
  const skippedFlagRequests: { count: number; reason: string }[] = [];
  for (const component of noteComponents(flags)) {
    const ids = [...new Set(component.flatMap(f => f.nodeIds))];
    const targets: WriterInput['targets'] = [];
    for (const id of ids) {
      try {
        const target = buildTarget(graph, id, { ...extrasFor(id), flagged: true });
        const allowedKinds = allowedKindsFor(target, base.enabledKinds);
        if (!allowedKinds.length) throw new Error('None of the enabled card kinds fit this idea.');
        targets.push({ ...target, allowedKinds, ...(blank.has(id) ? { blankFlag: true } : !requested.has(id) ? { noteOnly: true } : {}) });
      } catch (error) {
        skipped.push({ nodeId: id, reason: `Flag candidate excluded: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (!targets.length) continue;
    const eligible = new Set(targets.map(t => t.nodeId));
    const flagRequests = component.flatMap(({ id, nodeIds, note }) => {
      const selected = nodeIds.filter(n => eligible.has(n));
      return selected.length ? [{ id, note, nodeIds: selected }] : [];
    });
    const input = { ...base, targets, flagRequests };
    const within = (b: Batch) => estimateTokens(writerPrompt(b.input)) <= HARD_INPUT_CEILING && fits(b);
    let prepared = batch(input);
    if (!within(prepared)) {
      // Try the whole group without optional context before giving up. Keep the
      // neighbours needed by a contrast-only target so its allowed kinds still fit.
      prepared = batch({ ...input, targets: targets.map(t => {
        const thin = { ...t, existingCards: [], neighbours: t.neighbours.slice(0, minimumNeighbours(t, base.enabledKinds)), feeds: [] };
        return { ...thin, allowedKinds: allowedKindsFor(thin, base.enabledKinds) };
      }) });
    }
    if (!within(prepared)) {
      const reason = 'The noted flag group cannot fit one request. Select fewer candidates or choose a model with larger limits.';
      skippedFlagRequests.push({ count: flagRequests.length, reason });
      for (const target of targets) skipped.push({ nodeId: target.nodeId, reason });
      continue;
    }
    batches.push(prepared);
    for (const id of eligible) assigned.add(id);
  }
  return { batches, skipped, skippedFlagRequests, assigned };
}

export function refsForBatch(flags: ResolvedFlag[], input: WriterInput): FlagReference[] {
  const targetIds = new Set(input.targets.map(t => t.nodeId));
  const notes = new Map(input.flagRequests?.map(r => [r.id, r.nodeIds]));
  return flags.flatMap(({ id, revision, nodeIds, note }) => {
    const selected = note ? notes.get(id) ?? [] : nodeIds.filter(n => targetIds.has(n));
    return selected.length ? [{ id, revision, nodeIds: selected }] : [];
  });
}
