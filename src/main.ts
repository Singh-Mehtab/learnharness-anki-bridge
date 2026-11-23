import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { mountDrafting } from "./drafting-ui.ts";
import { ICON } from "./icons.ts";
import { mountReview } from "./review-ui.ts";
import { registerPracticeSuggestions } from "./reviews/practice-suggestions.ts";
import { mountSources, registerSessionActions, SessionRequests } from "./session-ui.ts";
import { mountSettings } from "./settings-ui.ts";
import { mountTopics } from "./topics-ui.ts";
import type { Peers } from "./settings-ui.ts";
import { el, stepHeading } from "./ui.ts";

type TabIndex = 0 | 1;

/** Card drafting and Anki review checks share one page. */
function mount(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, requests: SessionRequests, peers: Peers, navigation: { tab: TabIndex }): () => void {
  const root = el("div", undefined, "anki-bridge ab-page");

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

  const tabs = el("div", undefined, "ab-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Anki Bridge");
  const cardsTab = el("button", "Make cards", "ab-tab");
  const topicsTab = el("button", "Check Anki reviews", "ab-tab");
  const cards = el("div"), topics = el("div");
  cards.append(ideas, write, review);
  const topicsActions = el("div"), topicsBody = el("div");
  topics.append(topicsActions, topicsBody);
  const pairs = [[cardsTab, cards], [topicsTab, topics]] as const;
  let reviewHandle: ReturnType<typeof mountReview> | undefined;
  function selectTab(index: TabIndex, focus = false): void {
    navigation.tab = index;
    pairs.forEach(([tab, panel], i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    });
    reviewHandle?.setVisible(index === 0);
    if (focus) pairs[index][0].focus();
  }
  pairs.forEach(([tab, panel], i) => {
    const index = i === 0 ? 0 : 1;
    tab.type = "button";
    tab.id = `ab-tab-${i}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `ab-panel-${i}`);
    panel.id = `ab-panel-${i}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tab.addEventListener("click", () => selectTab(index), { signal });
    tab.addEventListener("keydown", event => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        selectTab(event.key === "Home" ? 0 : event.key === "End" ? 1 : index === 0 ? 1 : 0, true);
      }
    }, { signal });
    tabs.append(tab);
  });
  selectTab(navigation.tab);
  root.append(tabs, cards, topics);
  container.append(root);

  const drafting = mountDrafting(ctx, ideasList, writeBody, signal,
    async () => { await reviewHandle?.refresh(); },
    nodeId => { void reviewHandle?.showWaiting(nodeId); }, peers);
  reviewHandle = mountReview(ctx, reviewBody, signal, { peers, headerAside: reviewMenu, visible: !cards.hidden, onChanged: () => drafting.refresh() });
  const sources = mountSources(ctx, ideasSource, signal, { requests, drafting, onRequested: () => {
    const active = root.ownerDocument.activeElement;
    selectTab(0, !topics.hidden && (topicsTab.contains(active) || topics.contains(active)));
  } });
  const disposeTopics = mountTopics(ctx, topicsBody, signal, peers, topicsActions);
  return () => { sources(); drafting.dispose(); reviewHandle?.dispose(); disposeTopics(); root.remove(); };
}

export function activate(ctx: PluginFrontendContext): void {
  const requests = new SessionRequests(), peers: Peers = new Set();
  const navigation: { tab: TabIndex } = { tab: 0 };
  ctx.cleanup(ctx.registerView({ id: "bridge", name: "Anki Bridge", mount: (container, signal) => mount(ctx, container, signal, requests, peers, navigation) }));
  registerSessionActions(ctx, requests);
  registerPracticeSuggestions(ctx);
  ctx.cleanup(ctx.registerAction({ id: "open-bridge", name: "Anki Bridge", icon: ICON, run: () => ctx.app.openView("bridge") }));
  ctx.cleanup(ctx.placeAction({ id: "bridge-sidebar", actionId: "open-bridge", location: "sidebar" }));
  ctx.cleanup(ctx.registerSettings((container, signal) => mountSettings(ctx, container, signal, peers)));
}
