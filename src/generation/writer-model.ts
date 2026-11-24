import type { PluginBackendContext, PluginModelSpec } from '../../sdk/index.d.ts';
import type { ModelCatalogEntry } from '../../sdk/src/core/contracts/models.d.ts';
import type { GenerationSettings } from './types.ts';

export function resolveWriterModel(catalog: Awaited<ReturnType<PluginBackendContext['inference']['catalog']>>, settings: GenerationSettings): { model: ModelCatalogEntry; spec: PluginModelSpec } {
  // Like core Flashcards: follow the host's cheap slot unless the learner overrides it.
  const pin = settings.model ? { model: settings.model, thinkingLevel: settings.model.thinkingLevel } : catalog.slots?.cheap;
  if (!pin?.model) throw new Error('Set a cheap model in LearnHarness settings, or choose a model for Anki Bridge.');
  const pinned = pin.model;
  const model = catalog.models.find(m => m.provider === pinned.provider && m.id === pinned.id);
  if (!model || !catalog.providers.some(p => p.id === model.provider && p.keyPresent)) throw new Error(settings.model ? 'The selected model is unavailable. Choose an available model; no fallback is used.' : 'The cheap model slot is unavailable. Fix it in LearnHarness settings or choose a model for Anki Bridge.');
  if (pin.thinkingLevel !== undefined && !model.supportedLevels?.includes(pin.thinkingLevel)) throw new Error(settings.model
    ? `The selected model does not support ${pin.thinkingLevel} reasoning. Choose a supported level or Model default.`
    : `The cheap model does not support its configured thinking level (${pin.thinkingLevel}). Fix it in LearnHarness settings or choose an override.`);
  const spec: PluginModelSpec = { provider: pinned.provider, id: pinned.id, ...(pin.thinkingLevel !== undefined ? { thinkingLevel: pin.thinkingLevel } : {}) };
  return { model, spec };
}
