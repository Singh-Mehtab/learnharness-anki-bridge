import type { PluginFrontendContext } from '../../sdk/index.d.ts';
import type { ReviewCheck } from './signals.ts';

export const PRACTICE_SUGGESTIONS_OPERATION = 'practiceNodeSuggestions';

// Capability from the companion LearnHarness patch. The released SDK does not have it yet.
export interface PracticeNodeSuggestions {
  readonly checkedAt: number | null;
  readonly nodes: readonly { readonly nodeId: string; readonly reason: string }[];
}
interface PracticeNodeSuggestionsProvider {
  readonly label: string;
  read(signal: AbortSignal): Promise<PracticeNodeSuggestions>;
}
type PracticeSuggestionsContext = Pick<PluginFrontendContext, 'call' | 'cleanup'> & {
  registerPracticeNodeSuggestions?(provider: PracticeNodeSuggestionsProvider): () => void;
};

export function registerPracticeSuggestions(ctx: PracticeSuggestionsContext): void {
  if (typeof ctx.registerPracticeNodeSuggestions !== 'function') return;
  ctx.cleanup(ctx.registerPracticeNodeSuggestions({
    label: 'From Anki',
    async read(signal) {
      signal.throwIfAborted();
      const result = await ctx.call<PracticeNodeSuggestions>(PRACTICE_SUGGESTIONS_OPERATION);
      signal.throwIfAborted();
      return result;
    },
  }));
}

/** Keep the Topics to revisit order. The native picker joins IDs against its current graph. */
export function summarizePracticeSuggestions(check: ReviewCheck | null): PracticeNodeSuggestions {
  if (!check) return { checkedAt: null, nodes: [] };
  return {
    checkedAt: check.checkedAt,
    nodes: check.topics.map(({ nodeId, totals }) => ({
      nodeId,
      reason: totals.recentAgain >= check.rules.recentAgain
        ? `${totals.recentAgain} Again reviews in ${check.rules.windowDays} days`
        : totals.lapses >= check.rules.lapses
          ? `${totals.lapses} lapses`
          : totals.leech === 1 ? 'Leech tag' : `${totals.leech} cards tagged leech`,
    })),
  };
}
