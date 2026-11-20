import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { mountDrafting } from "./drafting-ui.ts";
import { mountReview } from "./review-ui.ts";
import { mountSources, registerSessionActions, SessionRequests } from "./session-ui.ts";
import { mountSettings } from "./settings-ui.ts";
import type { Peers } from "./settings-ui.ts";
import { el, stepHeading } from "./ui.ts";

/** Main page: three numbered steps, as in a guided flow. Settings hold connection and upkeep. */
function mount(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, requests: SessionRequests, peers: Peers): () => void {
  const root = el("div", undefined, "anki-bridge ab-page");
  const intro = el("p", "Pick ideas, let a model draft cards, then check each one before it goes to Anki. Nothing is sent without your approval.", "ab-intro");

  const ideas = el("section", undefined, "ab-step");
  const ideasSource = el("div"), ideasList = el("div");
  ideas.append(stepHeading(1, "Choose ideas"), ideasSource, ideasList);

  const write = el("section", undefined, "ab-step");
  const writeBody = el("div");
  write.append(stepHeading(2, "Write cards"), writeBody);

  const review = el("section", undefined, "ab-step");
  const reviewMenu = el("div");
  const reviewBody = el("div");
  review.append(stepHeading(3, "Review and send", reviewMenu), reviewBody);

  root.append(intro, ideas, write, review);
  container.append(root);

  let reviewHandle: ReturnType<typeof mountReview> | undefined;
  const drafting = mountDrafting(ctx, ideasList, writeBody, signal,
    async () => { await reviewHandle?.refresh(); },
    nodeId => { void reviewHandle?.showWaiting(nodeId); }, peers);
  reviewHandle = mountReview(ctx, reviewBody, signal, { peers, headerAside: reviewMenu, onChanged: () => drafting.refresh() });
  const sources = mountSources(ctx, ideasSource, signal, { requests, drafting });
  return () => { sources(); drafting.dispose(); reviewHandle?.dispose(); root.remove(); };
}

export function activate(ctx: PluginFrontendContext): void {
  const requests = new SessionRequests(), peers: Peers = new Set();
  ctx.cleanup(ctx.registerView({ id: "bridge", name: "Anki Bridge", mount: (container, signal) => mount(ctx, container, signal, requests, peers) }));
  registerSessionActions(ctx, requests);
  ctx.cleanup(ctx.registerAction({ id: "open-bridge", name: "Anki Bridge", run: () => ctx.app.openView("bridge") }));
  ctx.cleanup(ctx.placeAction({ id: "bridge-sidebar", actionId: "open-bridge", location: "sidebar" }));
  ctx.cleanup(ctx.registerSettings((container, signal) => mountSettings(ctx, container, signal, peers)));
}
