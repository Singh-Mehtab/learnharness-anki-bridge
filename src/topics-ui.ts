// Topics to revisit: what the user's own Anki reviews suggest looking at again.
// Nothing is read from Anki until the user presses Check Anki reviews.
import type { Peers } from "./settings-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { CardEvidence, ReviewCheck, Topic } from "./reviews/signals.ts";
import type { Destination } from "./settings-ui.ts";
import { button, confirmDialog, el, pill, plural, RenderScope, status } from "./ui.ts";

type Answer = { check: ReviewCheck | null; running: boolean };
interface Snapshot { settings: { url: string }; destination: Destination | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });

/** Plain counts and dates only. The wording never says what the learner knows. */
export function topicSummary(t: Topic): string {
  const parts: string[] = [];
  if (t.totals.lapses) parts.push(`${plural(t.totals.lapses, "lapse")} on ${plural(t.totals.cards, "card")}.`);
  if (t.totals.recentAgain) parts.push(`${plural(t.totals.recentAgain, "Again press", "Again presses")} on reviews in the last 30 days.`);
  if (t.totals.leech) parts.push(t.totals.leech === 1 ? "1 card tagged leech in Anki." : `${t.totals.leech} cards tagged leech in Anki.`);
  return parts.join(" ");
}

export function cardEvidence(c: CardEvidence): string {
  const parts = [plural(c.lapses, "lapse"), plural(c.reps, "review")];
  if (c.recentAgain.length) parts.push(`Again on ${c.recentAgain.slice().reverse().map(day).join(", ")}`);
  if (c.leech) parts.push("tagged leech");
  if (c.suspended) parts.push("suspended in Anki");
  if (c.decks.length) parts.push(`deck ${c.decks.join(", ")}`);
  return parts.join(" · ");
}

const REASON: Record<CardEvidence["reasons"][number], string> = { lapses: "3+ lapses", again: "2+ Again in 30 days", leech: "Leech" };

export function mountTopics(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, peers: Peers = new Set(), actions: HTMLElement = el("div")): () => void {
  const root = el("div", undefined, "ab-topics");
  const intro = el("p", undefined, "ab-muted ab-topics-intro");
  if (!actions.isConnected) root.append(actions);
  actions.classList.add("ab-actions");
  const feedback = status();
  const summary = el("p", undefined, "ab-muted ab-topics-summary");
  const list = el("div", undefined, "ab-topic-list");
  const footer = el("p", undefined, "ab-muted ab-topics-footer");
  root.append(intro, feedback, summary, list, footer);
  container.append(root);

  let disposed = false, busy = false, stale = false, refreshPending = false, loads = 0;
  let snapshot: Snapshot | undefined, check: ReviewCheck | null = null;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const scope = new RenderScope(signal), barScope = new RenderScope(signal);
  const paired = () => snapshot?.destination && snapshot.destination.url === snapshot.settings.url ? snapshot.destination : null;

  function renderBar(): void {
    const s = barScope.reset();
    actions.replaceChildren();
    const destination = paired();
    const criteria = "Ideas whose cards have 3+ lapses, 2+ Again presses in 30 days, or a leech tag.";
    intro.textContent = `${criteria} ${destination ? `Checks profile "${destination.profile}".` : "Connect to Anki in settings first."}`;
    if (check) button(ctx, actions, s, { label: "Clear", variant: "ghost", disabled: busy, onClick: () => void clear() });
    if (!destination) button(ctx, actions, s, { label: "Open settings", onClick: () => ctx.app.openSettings() });
    button(ctx, actions, s, { label: busy ? "Checking…" : "Check Anki reviews", variant: "default", disabled: busy || !destination, onClick: () => void runCheck() });
  }

  function render(): void {
    const s = scope.reset();
    list.replaceChildren(); footer.textContent = ""; summary.textContent = "";
    if (!check) { summary.textContent = "Not checked yet."; return; }
    const c = check.counts;
    summary.textContent = `${stale ? "Last checked" : "Checked"} at ${time(check.checkedAt)} in "${check.destination.profile}". ${plural(c.checked, "card")} read.${stale ? " May be out of date." : ""}`;
    if (!c.sent) list.append(el("p", "No cards sent to this profile yet.", "ab-empty"));
    else if (!check.topics.length) list.append(el("p", c.checked ? "No review signals found." : "No cards could be checked.", "ab-empty"));
    for (const topic of check.topics) list.append(renderTopic(topic, s));
    const notes: string[] = [];
    if (c.quietTopics) notes.push(`Nothing flagged in ${plural(c.quietTopics, "other topic")}.`);
    if (c.notReviewed) notes.push(`${plural(c.notReviewed, "card")} not reviewed yet.`);
    if (c.changed) notes.push(`Skipped ${plural(c.changed, "card")} with a different note type or delivery ID.`);
    if (c.missing) notes.push(`Skipped ${plural(c.missing, "card")} no longer in Anki.`);
    footer.textContent = notes.join(" ");
  }

  function renderTopic(topic: Topic, s: AbortSignal): HTMLElement {
    const section = el("section", undefined, "ab-card ab-topic");
    section.dataset.nodeId = topic.nodeId;
    const headRow = el("header", undefined, "ab-card-head");
    const title = el("div", undefined, "ab-card-title");
    title.append(el("h3", topic.nodeName || "Idea", "ab-card-idea"));
    if (topic.totals.lapses) title.append(pill(plural(topic.totals.lapses, "lapse"), "warn"));
    if (topic.totals.recentAgain) title.append(pill(`${topic.totals.recentAgain} Again in 30 days`, "warn"));
    if (topic.totals.leech) title.append(pill("Leech", "bad"));
    if (topic.inGraph === false) title.append(pill("Missing from this graph read", "neutral"));
    headRow.append(title);
    section.append(headRow);
    const body = el("div", undefined, "ab-topic-body");
    // The source session is the main way back: a missed card points at the idea, not at Anki.
    for (const session of topic.sessions) {
      const row = el("div", undefined, "ab-actions ab-topic-sessions");
      row.append(el("span", `From ${session.name}`, "ab-muted"));
      button(ctx, row, s, { label: "Open session", variant: "default", onClick: () => ctx.app.openSession(session.id) });
      body.append(row);
    }
    for (const card of topic.cards) body.append(renderCard(card, s));
    section.append(body);
    return section;
  }

  function renderCard(card: CardEvidence, s: AbortSignal): HTMLElement {
    const article = el("article", undefined, "ab-topic-card");
    article.dataset.lhId = card.lhId;
    const grid = el("div", undefined, "ab-card-fields");
    for (const [name, text] of [["Front", card.front], ["Back", card.back]] as const) {
      const col = el("section", undefined, "ab-card-field");
      const view = el("div", undefined, "ab-markdown");
      col.append(el("h4", name, "ab-field-name"), view);
      ctx.ui.mountMarkdown(view, { text: text || " " }, { signal: s });
      grid.append(col);
    }
    const foot = el("div", undefined, "ab-card-foot");
    foot.append(el("p", cardEvidence(card), "ab-muted ab-topic-evidence"));
    const buttons = el("div", undefined, "ab-actions");
    button(ctx, buttons, s, { label: "Show in Anki", variant: "ghost", onClick: async () => {
      try { await ctx.call("show", { ids: [card.lhId] }); } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    } });
    foot.append(buttons);
    article.append(grid, foot);
    return article;
  }

  async function runCheck(): Promise<void> {
    const destination = paired();
    if (!alive() || busy || !destination) return;
    busy = true; loads++; renderBar(); feedback.show("Reading review results from Anki…");
    try {
      const answer = await ctx.call<Answer>("checkReviews", { expectedDestination: destination });
      if (!alive()) return;
      check = answer.check; stale = false;
      feedback.show(check?.topics.length ? `${plural(check.topics.length, "topic")} to revisit.` : "Check finished.", "success");
    } catch (error) {
      if (!alive()) return;
      feedback.show(message(error), "error");
      // A failed check keeps an earlier result only if the backend still has it for this profile.
      // Re-read the pairing too, so a change made elsewhere is shown before the next press.
      const sequence = ++loads;
      try {
        const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
        if (alive() && sequence === loads) { snapshot = snap; check = last.check; stale = !!check; }
      } catch { if (sequence === loads) check = null; }
    } finally {
      busy = false;
      if (alive()) { renderBar(); render(); }
      // A Settings save or resync that arrived during the check is applied now.
      if (refreshPending && alive()) { refreshPending = false; void load(); }
    }
  }

  async function clear(): Promise<void> {
    const ok = await confirmDialog(ctx, signal, { title: "Clear review results?", body: "This forgets the results of the last check. Nothing in Anki changes.", confirm: "Clear" });
    if (!ok || !alive()) return;
    try {
      await ctx.call<Answer>("clearReviewCheck", {});
      check = null; stale = false; feedback.show("Cleared.", "success");
      // Start a fresh local reload so a reload begun before Clear cannot bring the old result back.
      if (alive()) { void load(); return; }
    } catch (error) { feedback.show(message(error), "error"); }
    if (alive()) { renderBar(); render(); }
  }

  async function load(): Promise<void> {
    const sequence = ++loads;
    renderBar(); render();
    try {
      // Both reads are local: the saved pairing and any result already in memory. No Anki request.
      const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
      // Overlapping reloads (resync and a Settings save) apply only the newest answer.
      if (!alive() || sequence !== loads) return;
      snapshot = snap; check = last.check;
      if (last.running) feedback.show("A check is already running. Press Check Anki reviews again when it finishes.");
    } catch (error) { if (alive() && sequence === loads) feedback.show(message(error), "error"); }
    if (alive() && sequence === loads) { renderBar(); render(); }
  }
  void load();
  // Reload the local pairing after a host resync or a Settings save in another pane.
  const refresh = () => { if (busy) refreshPending = true; else void load(); };
  const unsubscribe = ctx.onResync(refresh);
  peers.add(refresh);
  return () => { disposed = true; unsubscribe(); peers.delete(refresh); scope.dispose(); barScope.dispose(); root.remove(); };
}
