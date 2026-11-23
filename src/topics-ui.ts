// Topics to revisit: what the user's own Anki reviews suggest looking at again.
// Nothing is read from Anki until the user presses Check Anki reviews.
import type { Peers } from "./settings-ui.ts";
import type { PluginFrontendContext } from "../sdk/index.d.ts";
import type { CardEvidence, ReviewCheck, Topic, TopicSession } from "./reviews/signals.ts";
import type { Destination } from "./settings-ui.ts";
import { button, confirmDialog, el, pill, plural, RenderScope, status } from "./ui.ts";
import { answerPreview, questionPreview } from "./writer/cloze.ts";
import type { PracticeNodes } from "./reviews/service.ts";
import { PRACTICE_LIMIT, startPracticeSession } from "./reviews/practice-start.ts";

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

/** Count distinct destinations across the whole results list, not repeated links to the same session. */
function sessionButtonName(topics: Topic[]): (session: TopicSession) => string {
  const byTitle = new Map<string, Map<string, string>>();
  const title = (session: TopicSession) => session.name.trim().replace(/\s+/g, " ") || "Session";
  for (const { sessions } of topics) for (const session of sessions) {
    const name = title(session);
    const dates = byTitle.get(name) ?? new Map<string, string>();
    const created = new Date(session.createdAt ?? "");
    dates.set(session.id, Number.isNaN(created.getTime()) ? "" : created.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    byTitle.set(name, dates);
  }
  return session => {
    const name = title(session), dates = byTitle.get(name)!;
    const label = `Open session: ${name}`;
    if (dates.size < 2) return label;
    const created = dates.get(session.id);
    const unique = created && [...dates.values()].filter(date => date === created).length === 1;
    return `${label} (${unique ? `created ${created}` : `ID ${session.id}`})`;
  };
}

export function mountTopics(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, peers: Peers = new Set(), actions: HTMLElement = el("div")): () => void {
  const root = el("div", undefined, "ab-topics");
  const intro = el("p", undefined, "ab-muted ab-topics-intro");
  if (!actions.isConnected) root.append(actions);
  actions.classList.add("ab-actions");
  const feedback = status();
  const summary = el("p", undefined, "ab-muted ab-topics-summary");
  const practiseHint = el("p", undefined, "ab-muted ab-topics-practise");
  const list = el("div", undefined, "ab-topic-list");
  const footer = el("p", undefined, "ab-muted ab-topics-footer");
  root.append(intro, feedback, summary, practiseHint, list, footer);
  container.append(root);

  let disposed = false, busy = false, stale = false, refreshPending = false, loads = 0, starting = false, clearing = false;
  // Keep picks and graph deletions local to this view.
  const chosen = new Set<string>(), missing = new Set<string>();
  const selectable = (t: Topic) => t.inGraph !== false && !missing.has(t.nodeId);
  const locked = () => busy || starting || clearing;
  let snapshot: Snapshot | undefined, check: ReviewCheck | null = null;
  const alive = () => !disposed && !signal.aborted && !ctx.signal.aborted;
  const scope = new RenderScope(signal), barScope = new RenderScope(signal);
  const paired = () => snapshot?.destination && snapshot.destination.url === snapshot.settings.url ? snapshot.destination : null;

  function setCheck(next: ReviewCheck | null): void {
    if (next?.destination.url !== check?.destination.url || next?.destination.profile !== check?.destination.profile) {
      chosen.clear();
      missing.clear();
    }
    if (next?.checkedAt !== check?.checkedAt) missing.clear();
    check = next;
  }

  function renderAll(): void {
    const available = new Set(check?.topics.filter(selectable).map(t => t.nodeId));
    for (const id of chosen) if (!available.has(id)) chosen.delete(id);
    renderBar();
    render();
  }

  function renderBar(): void {
    const s = barScope.reset();
    actions.replaceChildren();
    const destination = paired();
    const criteria = "Checks only cards sent by Bridge. Lists cards with 3+ lapses, 2+ Again presses in 30 days, or a leech tag. Again counts in review and relearning, not initial learning. Results are kept in memory only.";
    const profile = destination ? (check ? "" : ` Paired profile: "${destination.profile}".`) : " Pair an Anki profile in Settings first.";
    intro.textContent = criteria + profile;
    if (check) button(ctx, actions, s, { label: "Clear", variant: "ghost", disabled: locked(), onClick: () => void clear() });
    if (!destination) button(ctx, actions, s, { label: "Open settings", onClick: () => ctx.app.openSettings() });
    if (check?.topics.some(selectable)) {
      button(ctx, actions, s, { label: starting ? "Starting…" : chosen.size ? `Practise selected (${chosen.size})` : "Practise selected",
        disabled: locked() || !chosen.size, onClick: () => void practise() });
    }
    button(ctx, actions, s, { label: busy ? "Checking…" : "Check Anki reviews", variant: "default", disabled: locked() || !destination, onClick: () => void runCheck() });
  }

  function render(): void {
    const s = scope.reset();
    list.replaceChildren(); footer.textContent = ""; summary.textContent = ""; practiseHint.textContent = "";
    if (!check) { summary.textContent = "Not checked yet."; return; }
    if (check.topics.some(selectable)) practiseHint.textContent = "Tick ideas, then press Practise selected to start a Practice session with them attached. Practice gets the ideas, not their review counts.";
    const c = check.counts;
    summary.textContent = `${stale ? "Last checked" : "Checked"} at ${time(check.checkedAt)} in "${check.destination.profile}". ${plural(c.checked, "card")} read.${stale ? " May be out of date." : ""}`;
    if (!c.sent) list.append(el("p", "No cards sent to this profile yet.", "ab-empty"));
    else if (!check.topics.length) list.append(el("p", c.checked ? "No review signals found." : "No cards could be checked.", "ab-empty"));
    const sessionName = sessionButtonName(check.topics);
    for (const topic of check.topics) list.append(renderTopic(topic, s, sessionName));
    const notes: string[] = [];
    if (c.quietTopics) notes.push(`Nothing flagged in ${plural(c.quietTopics, "other topic")}.`);
    if (c.notReviewed) notes.push(`${plural(c.notReviewed, "card")} not reviewed yet.`);
    if (c.changed) notes.push(`Skipped ${plural(c.changed, "card")} with a different note type or delivery ID.`);
    if (c.missing) notes.push(`Skipped ${plural(c.missing, "card")} no longer in Anki.`);
    footer.textContent = notes.join(" ");
  }

  function renderTopic(topic: Topic, s: AbortSignal, sessionName: (session: TopicSession) => string): HTMLElement {
    const section = el("section", undefined, "ab-card ab-topic");
    section.dataset.nodeId = topic.nodeId;
    const headRow = el("header", undefined, "ab-card-head");
    const title = el("div", undefined, "ab-card-title");
    if (selectable(topic)) {
      const box = el("input"); box.type = "checkbox"; box.checked = chosen.has(topic.nodeId); box.disabled = starting;
      box.setAttribute("aria-label", `Select ${topic.nodeName || "idea"} for Practice`);
      box.onchange = () => {
        if (box.checked && chosen.size >= PRACTICE_LIMIT) {
          box.checked = false;
          feedback.show(`Practice takes up to ${PRACTICE_LIMIT} ideas at a time.`, "error");
          return;
        }
        if (box.checked) chosen.add(topic.nodeId); else chosen.delete(topic.nodeId);
        renderBar();
      };
      title.append(box);
    }
    title.append(el("h3", topic.nodeName || "Idea", "ab-card-idea"));
    if (topic.totals.lapses) title.append(pill(plural(topic.totals.lapses, "lapse"), "warn"));
    if (topic.totals.recentAgain) title.append(pill(`${topic.totals.recentAgain} Again in 30 days`, "warn"));
    if (topic.totals.leech) title.append(pill("Leech", "bad"));
    if (!selectable(topic)) title.append(pill("Missing from this graph read", "neutral"));
    headRow.append(title);
    section.append(headRow);
    const body = el("div", undefined, "ab-topic-body");
    // The source session is the main way back: a missed card points at the idea, not at Anki.
    for (const session of topic.sessions) {
      const row = el("div", undefined, "ab-actions ab-topic-sessions");
      row.append(el("span", `From ${session.name}`, "ab-muted"));
      const { root } = button(ctx, row, s, { label: "Open session", variant: "default", onClick: () => ctx.app.openSession(session.id) });
      // The host only supports a separate accessible label for icon-only buttons.
      // Its visible button may be committed asynchronously, so watch this wrapper.
      const name = sessionName(session);
      const nameButton = () => root.querySelector("button")?.setAttribute("aria-label", name);
      const Observer = root.ownerDocument.defaultView!.MutationObserver;
      const observer = new Observer(nameButton);
      observer.observe(root, { childList: true, subtree: true });
      s.addEventListener("abort", () => observer.disconnect(), { once: true });
      nameButton();
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
    // FI-8: a cloze card shows its question with [...] and its answer filled in, never the raw placeholder.
    const sides = card.format === "cloze"
      ? [["Question", questionPreview(card.front)], ["Answer", answerPreview(card.front, card.back)]] as const
      : [["Front", card.front], ["Back", card.back]] as const;
    for (const [name, text] of sides) {
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
    if (!alive() || locked() || !destination) return;
    busy = true; loads++; renderBar(); feedback.show("Reading review results from Anki…");
    try {
      const answer = await ctx.call<Answer>("checkReviews", { expectedDestination: destination });
      if (!alive()) return;
      missing.clear(); setCheck(answer.check); stale = false;
      feedback.show(check?.topics.length ? `${plural(check.topics.length, "topic")} to revisit.` : "Check finished.", "success");
    } catch (error) {
      if (!alive()) return;
      feedback.show(message(error), "error");
      // A failed check keeps an earlier result only if the backend still has it for this profile.
      // Re-read the pairing too, so a change made elsewhere is shown before the next press.
      const sequence = ++loads;
      try {
        const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
        if (alive() && sequence === loads) { snapshot = snap; setCheck(last.check); stale = !!check; }
      } catch { if (sequence === loads) setCheck(null); }
    } finally {
      busy = false;
      if (alive()) renderAll();
      // A Settings save or resync that arrived during the check is applied now.
      if (refreshPending && alive()) { refreshPending = false; void load(); }
    }
  }

  async function practise(): Promise<void> {
    if (!alive() || locked() || !check || !chosen.size) return;
    starting = true; renderAll(); feedback.show("Starting a Practice session…");
    try {
      // Keep the order of the list on screen.
      const nodeIds = check.topics.map(t => t.nodeId).filter(id => chosen.has(id));
      const nodes = await ctx.call<PracticeNodes>("practiceNodes", { nodeIds });
      if (!alive()) return;
      if (nodeIds.some(id => !chosen.has(id))) {
        feedback.show("The review results changed. Select the ideas again.", "error");
        return;
      }
      if (nodes.missing.length) {
        for (const id of nodes.missing) { chosen.delete(id); missing.add(id); }
        const retry = chosen.size ? " Press Practise selected again to continue." : "";
        feedback.show(`Unticked ${plural(nodes.missing.length, "idea")} no longer in your graph.${retry}`, "error");
        return;
      }
      const id = await startPracticeSession(nodes.propositions);
      // If the learner left this page meanwhile, don't pull them into the new session.
      if (!alive()) return;
      chosen.clear();
      feedback.show("Practice session started.", "success");
      ctx.app.openSession(id);
    } catch (error) {
      if (alive()) feedback.show(message(error), "error");
    } finally {
      starting = false;
      if (alive()) renderAll();
    }
  }

  async function clear(): Promise<void> {
    if (!alive() || locked() || !check) return;
    const ok = await confirmDialog(ctx, signal, { title: "Clear review results?", body: "This forgets the results of the last check. Nothing in Anki changes.", confirm: "Clear" });
    if (!ok || !alive() || locked() || !check) return;
    // Invalidate any in-flight reload that could bring the old result back.
    clearing = true; loads++; renderBar();
    try {
      await ctx.call<Answer>("clearReviewCheck", {});
      setCheck(null); stale = false; refreshPending = true; feedback.show("Cleared.", "success");
    } catch (error) { if (alive()) feedback.show(message(error), "error"); }
    finally {
      clearing = false;
      if (alive()) {
        if (refreshPending) { refreshPending = false; void load(); }
        else renderAll();
      }
    }
  }

  async function load(): Promise<void> {
    const sequence = ++loads;
    renderAll();
    try {
      // Both reads are local: the saved pairing and any result already in memory. No Anki request.
      const [snap, last] = await Promise.all([ctx.call<Snapshot>("snapshot"), ctx.call<Answer>("lastReviewCheck", {})]);
      // Overlapping reloads (resync and a Settings save) apply only the newest answer.
      if (!alive() || sequence !== loads) return;
      snapshot = snap; setCheck(last.check);
      if (last.running) feedback.show("A check is already running. Press Check Anki reviews again when it finishes.");
    } catch (error) { if (alive() && sequence === loads) feedback.show(message(error), "error"); }
    if (alive() && sequence === loads) renderAll();
  }
  void load();
  // Reload the local pairing after a host resync or a Settings save in another pane.
  const refresh = () => { if (busy || clearing) refreshPending = true; else void load(); };
  const unsubscribe = ctx.onResync(refresh);
  peers.add(refresh);
  return () => { disposed = true; unsubscribe(); peers.delete(refresh); scope.dispose(); barScope.dispose(); root.remove(); };
}
