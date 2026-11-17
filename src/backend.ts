import type { PluginBackendContext } from '../sdk/index.d.ts';
import { DeliveryService } from './anki/delivery.ts';
import { StateStore } from './anki/state.ts';

export async function activate(ctx: PluginBackendContext): Promise<() => Promise<void>> {
  const store = await StateStore.open(ctx.dataDirectory);
  const service = new DeliveryService(store, { signal: ctx.signal });
  try {
    await service.activate();
    if (ctx.signal.aborted) throw new Error('Anki Bridge activation was cancelled.');
    for (const name of ['snapshot', 'settings', 'connection', 'pair', 'draft', 'edit', 'approve', 'send', 'reconcile', 'presence', 'show', 'repairFields', 'updateStyling']) {
      ctx.handle(name, input => service.command(name, input ?? {}));
    }
    return () => service.close();
  } catch (error) {
    await service.close();
    throw error;
  }
}
