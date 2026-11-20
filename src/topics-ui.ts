// Topics to revisit: what the user's own Anki reviews suggest looking at again.
// Nothing is read from Anki until the user presses Check Anki reviews.
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

export function mountTopics(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): () => void {
  const root = el("div", undefined, "anki-bridge ab-page ab-topics");
  const head = el("header", undefined, "ab-topics-head");
  head.append(el("h2", "Topics to revisit", "ab-step-title"));
  const intro = el("p", "Anki Bridge can look at how the cards it sent are going in Anki and list the topics they came from. A topic is listed when one of its cards has 3 or more lapses, 2 or more Again presses on reviews in the last 30 days, or a leech tag. These are suggestions to look at, not a judgement of what you know: a missed card can mean the card is unclear, the idea needs more practice, or an ordinary slip of memory. Check the card and its source before deciding.", "ab-intro");
  const privacy = el("p", undefined, "ab-note ab-topics-privacy");
  const actions = el("div", undefined, "ab-actions");
  const feedback = status();
  const summary = el("p", undefined, "ab-muted ab-topics-summary");
  const list = el("div", undefined, "ab-topic-list");
  const footer = el("ul", undefined, "ab-note ab-topics-footer");
  root.append(head, intro, privacy, actions, feedback, summary, list, footer);
  container.append(root);

  let disposed = false, busy = false, stale = false;
  let snapshot: Snapshot | undefined, check: ReviewCheck | null = null;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const scope = new RenderScope(signal), barScope = new RenderScope(signal);
  const paired = () => snapshot?.destination && snapshot.destination.url === snapshot.settings.url ? snapshot.destination : null;

  function renderBar(): void {
    const s = barScope.reset();
    actions.replaceChildren();
    const destination = paired();
    privacy.textContent = destination
      ? `Checking reads review results from the paired Anki profile "${destination.profile}", only for notes Anki Bridge sent there. Nothing in Anki changes. Results stay in this window's memory until you clear them or close LearnHarness. They are not saved, added to the graph or sent to a model.`
      : "Choose an Anki profile in settings first. Checking reads review results only for notes Anki Bridge sent to that profile, and changes nothing in Anki.";
    button(ctx, actions, s, { label: busy ? "Checking…" : "Check Anki reviews", variant: "default", disabled: busy || !destination, onClick: () => void runCheck() });
    if (!destination) button(ctx, actions, s, { label: "Open settings", onClick: () => ctx.app.openSettings() });
    if (check) button(ctx, actions, s, { label: "Clear", variant: "ghost", disabled: busy, onClick: () => void clear() });
  }

  function render(): void {
    const s = scope.reset();
    list.replaceChildren(); footer.replaceChildren(); summary.textContent = "";
    if (!check) {
      list.append(el("p", "Not checked yet. Nothing has been read from Anki.", "ab-empty"));
      return;
    }
    const c = check.counts;
    summary.textContent = `${stale ? "Last checked" : "Checked"} at ${time(check.checkedAt)} in profile "${check.destination.profile}". ${plural(c.checked, "card")} read.${stale ? " This result may be out of date." : ""}`;
    if (!c.sent) list.append(el("p", "No cards have been sent to this profile yet.", "ab-empty"));
    else if (!check.topics.length) list.append(el("p", "No topics to revisit right now.", "ab-empty"));
    for (const topic of check.topics) list.append(renderTopic(topic, s));
    const notes: string[] = [];
    if (c.quietTopics) notes.push(`${plural(c.quietTopics, "other topic")} had reviews with nothing to flag.`);
    if (c.notReviewed) notes.push(`${plural(c.notReviewed, "card")} not reviewed in Anki yet.`);
    if (c.changed) notes.push(`${plural(c.changed, "card")} changed in Anki (different note type or delivery ID) and ${c.changed === 1 ? "was" : "were"} skipped.`);
    if (c.missing) notes.push(`${plural(c.missing, "card")} no longer in Anki and ${c.missing === 1 ? "was" : "were"} skipped.`);
    for (const text of notes) footer.append(el("li", text));
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
    if (topic.inGraph === false) title.append(pill("No longer in graph", "neutral"));
    headRow.append(title);
    section.append(headRow);
    const body = el("div", undefined, "ab-topic-body");
    body.append(el("p", topicSummary(topic), "ab-topic-summary"));
    if (topic.sessions.length) {
      const links = el("div", undefined, "ab-actions ab-topic-sessions");
      links.append(el("span", "From", "ab-muted"));
      for (const session of topic.sessions) button(ctx, links, s, { label: `Open session: ${session.name}`, variant: "ghost", onClick: () => ctx.app.openSession(session.id) });
      body.append(links);
    } else body.append(el("p", "No source session recorded for this topic.", "ab-muted"));
    for (const card of topic.cards) body.append(renderCard(card, s));
    section.append(body);
    return section;
  }

  function renderCard(card: CardEvidence, s: AbortSignal): HTMLElement {
    const article = el("article", undefined, "ab-topic-card");
    article.dataset.lhId = card.lhId;
    const reasons = el("div", undefined, "ab-card-title");
    for (const reason of card.reasons) reasons.append(pill(REASON[reason], reason === "leech" ? "bad" : "warn"));
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
    button(ctx, buttons, s, { label: "Show in Anki", onClick: async () => {
      try { await ctx.call("show", { ids: [card.lhId] }); } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    } });
    foot.append(buttons);
    article.append(reasons, grid, foot);
    return article;
  }

  async function runCheck(): Promise<void> {
    const destination = paired();
    if (!alive() || busy || !destination) return;
    busy = true; renderBar(); feedback.show("Reading review results from Anki…");
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
      try {
        const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
        if (alive()) { snapshot = snap; check = last.check; stale = !!check; }
      } catch { check = null; }
    } finally {
      busy = false;
      if (alive()) { renderBar(); render(); }
    }
  }

  async function clear(): Promise<void> {
    const ok = await confirmDialog(ctx, signal, { title: "Clear review results?", body: "This forgets the results of the last check. Nothing in Anki changes.", confirm: "Clear" });
    if (!ok || !alive()) return;
    try { await ctx.call<Answer>("clearReviewCheck", {}); check = null; stale = false; feedback.show("Cleared.", "success"); }
    catch (error) { feedback.show(message(error), "error"); }
    if (alive()) { renderBar(); render(); }
  }

  async function load(): Promise<void> {
    renderBar(); render();
    try {
      // Both reads are local: the saved pairing and any result already in memory. No Anki request.
      const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
      if (!alive()) return;
      snapshot = snap; check = last.check;
      if (last.running) feedback.show("A check is already running. Press Check Anki reviews again when it finishes.");
    } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    if (alive()) { renderBar(); render(); }
  }
  void load();
  const unsubscribe = ctx.onResync(() => { if (!busy) void load(); });
  return () => { disposed = true; unsubscribe(); scope.dispose(); barScope.dispose(); root.remove(); };
}
