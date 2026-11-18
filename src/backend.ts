import type { PluginBackendContext } from '../sdk/index.d.ts';
import { DeliveryService } from './anki/delivery.ts';
import { StateStore } from './anki/state.ts';
import { GenerationService, GENERATION_OPERATIONS } from './generation/service.ts';

export async function activate(ctx: PluginBackendContext): Promise<() => Promise<void>> {
  const store = await StateStore.open(ctx.dataDirectory);
  const service = new DeliveryService(store, { signal: ctx.signal });
  const generation = new GenerationService(ctx, store, service);
  const handlers: (() => void)[] = [];
  const close = async () => {
    for (const unregister of handlers.splice(0)) unregister();
    try { await generation.close(); } finally { await service.close(); }
  };
  try {
    if (ctx.signal.aborted) throw new Error('Anki Bridge activation was cancelled.');
    await generation.activate();
    await service.activate();
    if (ctx.signal.aborted) throw new Error('Anki Bridge activation was cancelled.');
    for (const name of ['snapshot', 'settings', 'connection', 'pair', 'draft', 'edit', 'approve', 'send', 'reconcile', 'presence', 'show', 'repairFields', 'updateStyling', 'drop']) {
      handlers.push(ctx.handle(name, input => service.command(name, input ?? {})));
    }
    for (const name of GENERATION_OPERATIONS) handlers.push(ctx.handle(name, input => generation.command(name, input ?? {})));
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
