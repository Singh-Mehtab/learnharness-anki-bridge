import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { canSelectNode, isUncardedNode, MAX_SELECTED_NODES } from "./coverage/flow.ts";
import type { Coverage, CoverageContext, CardCounts } from "./coverage/flow.ts";
import { button, el, pill, plural } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";

export interface CoverageRow {
  id: string; name: string; statement: string; statementHash?: string;
  cards: CardCounts; coverage?: Coverage; flagged?: boolean; flagNotes?: string[];
}
export type CoverageView = Omit<CoverageContext, "nodes" | "missing" | "pairingKey"> & { nodes: CoverageRow[]; missing?: CoverageRow[]; pairingKey?: string };

const DOTS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Short coverage labels for one idea. Tones only colour the text. */
function rowPills(n: CoverageRow): HTMLElement[] {
  const c = n.coverage, out: HTMLElement[] = [];
  if (n.flagged) out.push(pill("Flagged", "warn"));
  if (c?.generating) out.push(pill("Writing…", "info"));
  if (c?.dismissed) out.push(pill("Not carding", "neutral"));
  else if (c?.state === "source-changed") out.push(pill("Changed since carded", "warn"));
  if (n.cards.waiting) out.push(pill(`${n.cards.waiting} to review`, "info"));
  if (n.cards.sent) out.push(pill(`${n.cards.sent} in Anki`, "good"));
  if (n.cards.sentElsewhere) out.push(pill(`${n.cards.sentElsewhere} in another profile`, "neutral"));
  if (c?.unresolved) out.push(pill(`${c.unresolved} unconfirmed`, "bad"));
  if (c?.deletedNotes) out.push(pill(`${c.deletedNotes} deleted in Anki`, "neutral"));
  if (!out.length && !n.cards.sent && !n.cards.waiting && c?.state !== "source-missing") out.push(pill("No cards", "neutral"));
  return out;
}

/** Selectable idea list. Selection belongs to the view, never to an asynchronous read. */
export class CoveragePicker {
  readonly root = el("div", undefined, "ab-ideas");
  private readonly toolbar = el("div", undefined, "ab-ideas-toolbar");
  private readonly quick = el("div", undefined, "ab-ideas-quick");
  private readonly rows = el("ul", undefined, "ab-idea-list");
  private readonly history = el("details", undefined, "ab-ideas-history");
  private readonly historySummary = el("summary");
  private readonly historicalRows = el("ul", undefined, "ab-idea-list");
  private readonly footer = el("div", undefined, "ab-ideas-footer");
  private readonly summary = el("span", undefined, "ab-ideas-summary");
  private readonly warning = el("p", undefined, "ab-note");
  private readonly selectionWarning = el("p", undefined, "ab-note");
  private readonly search = el("input", undefined, "ab-input ab-search");
  private readonly scope = el("select", undefined, "ab-input ab-select");
  private bulk?: ButtonHandle;
  private flagged?: ButtonHandle;
  private clear?: ButtonHandle;
  private view: CoverageView = { nodes: [], missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
  private selected = new Set<string>();
  private backfill = new Set<string>();
  private touched = new Set<string>();
  private stale = false;
  private defaults: boolean;
  private readonly options: {
    ctx?: PluginFrontendContext; signal?: AbortSignal;
    changed(source: "read" | "user"): void; defaults?: boolean;
    mutate(name: "dismissNode" | "restoreNode", node: CoverageRow): void; reviewWaiting?: (nodeId: string) => void;
    empty?: () => string;
  };
  constructor(options: CoveragePicker["options"]) {
    this.options = options;
    this.defaults = !!options.defaults;
    this.warning.setAttribute("role", "status");
    this.selectionWarning.setAttribute("role", "status");
    for (const [value, text] of [["all", "All ideas"], ["uncarded", "Without cards"]]) {
      const option = el("option", text); option.value = value; this.scope.append(option);
    }
    this.scope.setAttribute("aria-label", "Show");
    this.search.type = "search"; this.search.placeholder = "Search ideas"; this.search.setAttribute("aria-label", "Search ideas");
    const filter = () => { if (this.stale) return; this.selectionWarning.textContent = ""; this.prune(); this.options.changed("user"); this.render(); };
    this.search.oninput = filter; this.scope.onchange = filter;
    this.toolbar.append(this.search, this.scope);
    const { ctx, signal } = options;
    if (ctx && signal) {
      this.bulk = button(ctx, this.quick, signal, { label: "Select ideas without cards", onClick: () => this.selectUncarded() });
      if (options.defaults !== undefined) this.flagged = button(ctx, this.quick, signal, { label: "Select flagged", onClick: () => this.selectFlagged() });
      this.clear = button(ctx, this.footer, signal, { label: "Clear", onClick: () => this.select([]) });
    }
    this.footer.prepend(this.summary);
    this.history.append(this.historySummary, el("p", "These ideas are missing from the current graph read. Their cards are kept.", "ab-muted ab-history-note"), this.historicalRows);
    this.root.append(this.toolbar, this.quick, this.warning, this.selectionWarning, this.rows, this.history, this.footer);
    this.render();
  }
  get ids(): string[] { return [...this.selected]; }
  get backfillNodeIds(): string[] { return this.ids.filter(id => this.backfill.has(id)); }
  get isStale(): boolean { return this.stale; }
  get size(): number { return this.view.nodes.length; }
  /** Session scope preselects flagged ideas; the whole graph does not. */
  setDefaults(on: boolean): void { this.defaults = on; }
  selectUncarded(): void {
    const ids = this.visible().filter(n => this.eligible(n) && isUncardedNode(n)).map(n => n.id);
    this.select(ids, ids);
  }
  selectFlagged(): void { this.select(this.visible().filter(n => n.flagged && this.eligible(n)).map(n => n.id)); }
  private visible(): CoverageRow[] {
    const query = this.search.value.trim().toLocaleLowerCase();
    return [...this.view.nodes, ...(this.view.missing ?? [])].filter(n =>
      (this.scope.value !== "uncarded" || isUncardedNode(n)) && `${n.name} ${n.statement}`.toLocaleLowerCase().includes(query));
  }
  private historical(n: CoverageRow): boolean { return !!this.view.missing?.includes(n) || n.coverage?.state === "source-missing"; }
  private eligible(n: CoverageRow): boolean { return !this.historical(n) && canSelectNode(n); }
  private prune(): void {
    const allowed = new Set(this.visible().filter(n => this.eligible(n)).map(n => n.id));
    for (const id of this.selected) if (!allowed.has(id)) { this.selected.delete(id); this.backfill.delete(id); this.touched.add(id); }
  }
  update(view: CoverageView, reset = false): void {
    if (reset) { this.selected.clear(); this.backfill.clear(); this.touched.clear(); this.search.value = ""; this.scope.value = "all"; }
    const changed = JSON.stringify(this.view) !== JSON.stringify(view) || this.stale;
    this.view = view; this.stale = false;
    this.selectionWarning.textContent = "";
    this.prune();
    if (this.defaults) {
      const defaults = new Set(this.selected);
      for (const n of this.visible()) {
        if (!this.touched.has(n.id)) { if (n.flagged && this.eligible(n)) defaults.add(n.id); else defaults.delete(n.id); }
      }
      if (this.withinLimit(defaults.size)) this.selected = defaults;
    }
    if (changed) this.options.changed("read"); this.render();
  }
  setCardsPerNode(cap: number): void { this.view = { ...this.view, cardsPerNode: cap }; this.render(); }
  markStale(): void { this.stale = true; this.options.changed("read"); this.render(); }
  private withinLimit(count: number): boolean {
    this.selectionWarning.textContent = count > MAX_SELECTED_NODES
      ? `That would select ${count} ideas. The limit is ${MAX_SELECTED_NODES}. Narrow the search first.` : "";
    return count <= MAX_SELECTED_NODES;
  }
  select(ids: readonly string[], backfillNodeIds: readonly string[] = [], resetFilters = false): void {
    if (this.stale) return;
    const allowed = new Set((resetFilters ? this.view.nodes : this.visible()).filter(n => this.eligible(n)).map(n => n.id));
    const selected = new Set(ids.filter(id => allowed.has(id)));
    if (!this.withinLimit(selected.size)) { this.render(); return; }
    if (resetFilters) { this.search.value = ""; this.scope.value = "all"; }
    this.selected = selected;
    this.backfill = new Set(backfillNodeIds.filter(id => selected.has(id)));
    for (const n of this.view.nodes) this.touched.add(n.id);
    this.options.changed("user"); this.render();
  }
  private openMenu(anchor: HTMLElement, n: CoverageRow): void {
    const { ctx, signal } = this.options;
    const c = n.coverage;
    const items: Array<{ key: string; label: string; disabled?: boolean; onSelect: () => void }> = [];
    if (c?.dismissed) items.push({ key: "restore", label: "Make cards for this idea again", disabled: this.stale, onSelect: () => { this.options.changed("user"); this.options.mutate("restoreNode", n); } });
    else if (c?.canDismiss) items.push({ key: "dismiss", label: "Don't make cards for this idea", disabled: this.stale, onSelect: () => { this.options.changed("user"); this.options.mutate("dismissNode", n); } });
    if (n.cards.waiting && this.options.reviewWaiting) items.push({ key: "review", label: "Show its cards to review", onSelect: () => this.options.reviewWaiting?.(n.id) });
    if (!ctx || !signal || !items.length) return;
    ctx.ui.openMenu(anchor, { label: `Actions for ${n.name}`, items }, { signal });
  }
  private hasMenu(n: CoverageRow): boolean {
    const c = n.coverage;
    return !this.historical(n) && !!n.statementHash && (!!c?.dismissed || !!c?.canDismiss) || (!!n.cards.waiting && !!this.options.reviewWaiting);
  }
  private renderRow(n: CoverageRow): HTMLLIElement {
    const row = el("li", undefined, "ab-idea");
    const historical = this.historical(n), eligible = this.eligible(n), chosen = this.selected.has(n.id);
    if (chosen) row.dataset.selected = "true";
    if (!eligible) row.dataset.inactive = "true";
    const label = el("label", undefined, "ab-idea-main");
    if (!historical) {
      const box = el("input"); box.type = "checkbox"; box.checked = chosen; box.disabled = this.stale || !eligible;
      box.setAttribute("aria-label", `Select ${n.name}`);
      box.onchange = () => {
        if (this.stale) return;
        if (box.checked && !this.withinLimit(this.selected.size + (this.selected.has(n.id) ? 0 : 1))) { this.render(); return; }
        this.selectionWarning.textContent = "";
        this.touched.add(n.id); this.backfill.delete(n.id);
        if (box.checked) this.selected.add(n.id); else this.selected.delete(n.id);
        this.options.changed("user"); this.render();
      };
      label.append(box);
    }
    const body = el("span", undefined, "ab-idea-body");
    body.append(el("span", n.name, "ab-idea-name"), el("span", n.statement, "ab-idea-statement"));
    if (n.coverage?.skipReason && !n.cards.waiting) body.append(el("span", `Skipped last time: ${n.coverage.skipReason}`, "ab-idea-note"));
    label.append(body);
    const side = el("span", undefined, "ab-idea-side");
    side.append(...rowPills(n));
    row.append(label, side);
    if (this.hasMenu(n)) {
      // Plain icon button: one per row would be too many host widget mounts for a long graph.
      const more = el("button", undefined, "ab-icon-button");
      more.type = "button"; more.innerHTML = DOTS; more.title = "More actions";
      more.setAttribute("aria-label", `More actions for ${n.name}`);
      more.disabled = this.stale && !n.cards.waiting;
      more.onclick = () => this.openMenu(more, n);
      row.append(more);
    }
    return row;
  }
  private render(): void {
    this.rows.replaceChildren(); this.historicalRows.replaceChildren();
    this.warning.textContent = this.stale ? "This list may be out of date. Refresh to update it before writing cards." : this.view.pairingWarning
      ? "The Anki address changed since you chose a profile. Choose the profile again in settings." : "";
    this.search.disabled = this.scope.disabled = this.stale;
    const visible = this.visible();
    const historical = visible.filter(n => this.historical(n));
    this.history.hidden = !historical.length;
    this.historySummary.textContent = `Ideas no longer in the graph (${historical.length})`;
    const uncarded = visible.filter(n => this.eligible(n) && isUncardedNode(n));
    this.bulk?.update({ label: `Select ideas without cards (${uncarded.length})`, disabled: this.stale || !uncarded.length });
    const flagged = visible.filter(n => n.flagged && this.eligible(n));
    this.flagged?.update({ label: `Select flagged (${flagged.length})`, disabled: this.stale || !flagged.length });
    if (this.flagged) this.flagged.root.hidden = !this.view.nodes.some(n => n.flagged);
    this.clear?.update({ disabled: this.stale || !this.selected.size });
    const cap = this.view.cardsPerNode;
    this.summary.textContent = this.selected.size
      ? `${plural(this.selected.size, "idea")} selected, up to ${plural(this.selected.size * cap, "card")}`
      : "No ideas selected";
    this.footer.dataset.empty = String(!this.selected.size);
    const current = visible.filter(n => !this.historical(n));
    if (!current.length) {
      const empty = el("li", this.view.nodes.length ? "No ideas match this search." : this.options.empty?.() ?? "No ideas yet.", "ab-empty");
      this.rows.append(empty);
    }
    for (const n of current) this.rows.append(this.renderRow(n));
    for (const n of historical) this.historicalRows.append(this.renderRow(n));
  }
}
