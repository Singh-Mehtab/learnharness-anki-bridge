import type { PluginBackendContext } from '../sdk/index.d.ts';
import { exportPackage } from './anki/apkg.ts';
import { DeliveryService } from './anki/delivery.ts';
import { StateStore } from './anki/state.ts';
import { GenerationService, GENERATION_OPERATIONS } from './generation/service.ts';
import { SessionService, SESSION_OPERATIONS } from './session/service.ts';
import { CoverageService, COVERAGE_OPERATIONS } from './coverage/service.ts';
import { ReviewService, REVIEW_OPERATIONS } from './reviews/service.ts';

export async function activate(ctx: PluginBackendContext): Promise<() => Promise<void>> {
  const store = await StateStore.open(ctx.dataDirectory);
  const service = new DeliveryService(store, { signal: ctx.signal });
  const coverage = new CoverageService(ctx, store, service);
  const generation = new GenerationService(ctx, store, service);
  coverage.onChanged = () => generation.invalidatePreflights();
  const session = new SessionService(ctx.learning, store, service, { signal: ctx.signal });
  // Review checks read Anki only when the user asks, and keep results in memory only.
  const reviews = new ReviewService(ctx.learning, store, { signal: ctx.signal });
  // Flag notes are part of the writer prompt, so editing a note makes an open estimate stale.
  generation.flagNotes = () => session.flagNotes();
  const handlers: (() => void)[] = [];
  const close = async () => {
    for (const unregister of handlers.splice(0)) unregister();
    session.close();
    reviews.close();
    // Generation cleanup can still read delivery snapshots while it settles.
    try { await generation.close(); }
    catch (error) {
      coverage.close();
      await service.close().catch(() => {});
      throw error;
    }
    coverage.close();
    await service.close();
  };
  try {
    if (ctx.signal.aborted) throw new Error('Anki Bridge activation was cancelled.');
    await generation.activate();
    await service.activate();
    if (ctx.signal.aborted) throw new Error('Anki Bridge activation was cancelled.');
    for (const name of ['snapshot', 'settings', 'connection', 'pair', 'draft', 'edit', 'approve', 'unapprove', 'send', 'reconcile', 'presence', 'show', 'repairFields', 'updateStyling', 'drop', 'markImported', 'unmarkImported']) {
      handlers.push(ctx.handle(name, async input => {
        if (name === 'settings' || name === 'pair') generation.invalidatePreflights();
        if (name !== 'pair') return service.command(name, input ?? {});
        // Address, key and pairing changes clear review results at the commit (ReviewService.onCommit).
        // Re-pairing to the same profile commits no change, so forget explicitly as the README promises.
        // A failed pairing changed nothing, so the result and any running check are left alone.
        const result = await service.command(name, input ?? {});
        reviews.forget();
        return result;
      }));
    }
    // Read-only and offline: no pairing, no AnkiConnect, no state change. The fence only keeps
    // a package from catching a card halfway through a send.
    handlers.push(ctx.handle('exportPackage', input => service.exclusive(() => exportPackage(store.snapshot(), input ?? {}))));
    for (const name of GENERATION_OPERATIONS) handlers.push(ctx.handle(name, input => generation.command(name, input ?? {})));
    for (const name of SESSION_OPERATIONS) handlers.push(ctx.handle(name, input => session.command(name, input ?? {})));
    for (const name of COVERAGE_OPERATIONS) handlers.push(ctx.handle(name, input => coverage.command(name, input ?? {})));
    for (const name of REVIEW_OPERATIONS) handlers.push(ctx.handle(name, input => reviews.command(name, input ?? {})));
    return close;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
