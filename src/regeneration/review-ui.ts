import type { PluginFrontendContext } from '../../sdk/index.d.ts';
import { KIND_NAMES } from '../kinds-ui.ts';
import { button, el, field, textarea } from '../ui.ts';
import { REWRITE_INSTRUCTION_LIMIT, type RegenerationReview, type Replacement } from './types.ts';

export function rewriteForm(ctx: PluginFrontendContext, signal: AbortSignal, queue: (instruction: string) => Promise<void>): HTMLElement {
  const form = el('details', undefined, 'ab-card-source ab-rewrite-form');
  form.append(el('summary', 'Regenerate this card'));
  const instruction = textarea('', 2);
  instruction.maxLength = REWRITE_INSTRUCTION_LIMIT;
  form.append(field('Rewrite instruction (optional)', instruction));
  button(ctx, form, signal, { label: 'Queue rewrite', onClick: () => queue(instruction.value) });
  return form;
}

export function replacementComparison(ctx: PluginFrontendContext, signal: AbortSignal, original: HTMLElement, originalKind: string,
  replacement: Replacement, preview: (field: 'front' | 'back' | 'extra', replacement: Replacement) => string): HTMLElement {
  const comparison = el('div', undefined, 'ab-rewrite-comparison');
  const before = el('section'); before.append(el('h4', `Original · ${originalKind}`, 'ab-field-name'), original);
  const after = el('section'); after.append(el('h4', `Replacement · ${KIND_NAMES[replacement.kind]}`, 'ab-field-name'));
  const fields = el('div', undefined, 'ab-card-fields');
  for (const key of ['front', 'back', 'extra'] as const) {
    if (key === 'extra' && !replacement.extra.trim()) continue;
    const label = key === 'extra' ? 'Extra' : replacement.format === 'cloze' ? (key === 'front' ? 'Text' : 'Hidden part') : key === 'front' ? 'Front' : 'Back';
    const col = el('section', undefined, 'ab-card-field'), markdown = el('div', undefined, 'ab-markdown');
    col.append(el('h4', label, 'ab-field-name'), markdown);
    ctx.ui.mountMarkdown(markdown, { text: preview(key, replacement) || ' ' }, { signal });
    fields.append(col);
  }
  after.append(fields);
  comparison.append(before, after);
  return comparison;
}

export function rewriteDecision(ctx: PluginFrontendContext, signal: AbortSignal, job: RegenerationReview,
  decide: (name: 'acceptRegeneration' | 'keepOriginalCard' | 'retryRegenerationResult') => Promise<void>): HTMLElement {
  const panel = el('div', undefined, 'ab-rewrite-decision');
  if (job.status !== 'ready') {
    const text = job.status === 'queued' ? 'Rewrite queued. The original is unchanged.' : job.status === 'running'
      ? 'Rewriting this card. The original is unchanged.' : job.error ?? 'No replacement is available. The original is unchanged.';
    const progress = el('p', text, 'ab-muted'); progress.setAttribute('role', 'status'); panel.append(progress);
  }
  const actions = el('div', undefined, 'ab-actions');
  if (job.status === 'ready') button(ctx, actions, signal, { label: 'Accept', variant: 'default', onClick: () => decide('acceptRegeneration') });
  if (job.status === 'resultPending') button(ctx, actions, signal, { label: 'Retry saving', onClick: () => decide('retryRegenerationResult') });
  button(ctx, actions, signal, { label: 'Keep original', onClick: () => decide('keepOriginalCard') });
  panel.append(actions);
  return panel;
}
