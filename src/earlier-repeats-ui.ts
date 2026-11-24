import type { PluginFrontendContext } from '../sdk/index.d.ts';
import type { EarlierRepeatSkipRef, Generation } from './generation/types.ts';
import { BLANK, answerPreview, questionPreview } from './writer/cloze.ts';
import type { EarlierRepeatCandidate } from './writer/types.ts';
import { el } from './ui.ts';

const skipKey = ({ generationId, requestId, nodeId }: EarlierRepeatSkipRef) => JSON.stringify([generationId, requestId, nodeId]);
export function earlierRepeatSkips(generations: readonly Generation[]) {
  const handled = new Set(generations.filter(g => g.repeatOverride && (g.status === 'running' || g.tasks.some(t => t.status === 'applied' || t.resultPending)))
    .map(g => skipKey(g.repeatOverride!)));
  return [...generations].reverse().flatMap(g => g.tasks.flatMap(t => t.result?.targets.flatMap(result => {
    if (!result.earlierRepeatOf || t.status !== 'applied') return [];
    const ref = { generationId: g.id, requestId: t.requestId, nodeId: result.nodeId };
    if (handled.has(skipKey(ref))) return [];
    const target = t.input.targets.find(n => n.nodeId === result.nodeId);
    const covering = target?.earlierRepeatCandidates?.find(c => c.id === result.earlierRepeatOf);
    return target && covering ? [{ ref, covering, name: target.name, reason: result.skipReason }] : [];
  }) ?? []));
}

type Recall = Pick<EarlierRepeatCandidate, 'front' | 'back' | 'format'>;
export function repeatCardPreview(ctx: PluginFrontendContext, title: string, card: Recall, signal: AbortSignal): HTMLElement {
  const section = el('section', undefined, 'ab-card-field');
  section.append(el('h4', title, 'ab-field-name'));
  const cloze = card.format === 'cloze' && card.front.includes(BLANK);
  for (const [side, text] of [['Front', cloze ? questionPreview(card.front) : card.front], ['Back', cloze ? answerPreview(card.front, card.back) : card.back]]) {
    const preview = el('div', undefined, 'ab-markdown');
    section.append(el('h5', side, 'ab-field-name'), preview);
    ctx.ui.mountMarkdown(preview, { text: text || ' ' }, { signal });
  }
  return section;
}
