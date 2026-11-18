import { canSelectNode, coverageLabel, hasCards, isUncardedNode, MAX_SELECTED_NODES } from "./coverage/flow.ts";
import type { Coverage, CoverageContext, CardCounts } from "./coverage/flow.ts";

export interface CoverageRow {
  id: string; name: string; statement: string; statementHash?: string;
  cards: CardCounts; coverage?: Coverage; flagged?: boolean; flagNotes?: string[];
}
export type CoverageView = Omit<CoverageContext, "nodes" | "missing" | "pairingKey"> & { nodes: CoverageRow[]; missing?: CoverageRow[]; pairingKey?: string };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}

/** Selection belongs to the view, never to an asynchronous read or a native picker. */
export class CoveragePicker {
  readonly root = el("div");
  private readonly rows = el("ul");
  private readonly history = el("section");
  private readonly historicalRows = el("ul");
  private readonly summary = el("p");
  private readonly warning = el("p");
  private readonly selectionWarning = el("p");
  private readonly bulk = el("button");
  private readonly flagged = el("button");
  private readonly clear = el("button", "Clear selection");
  private readonly search = el("input");
  private readonly scope = el("select");
  private view: CoverageView = { nodes: [], missing: [], cardsPerNode: 2, paired: false, pairingWarning: false };
  private selected = new Set<string>();
  private backfill = new Set<string>();
  private touched = new Set<string>();
  private stale = false;
  private readonly options: { changed(source: "read" | "user"): void; defaults?: boolean; mutate(name: "dismissNode" | "restoreNode", node: CoverageRow): void; reviewWaiting?: (nodeId: string) => void };
  constructor(options: CoveragePicker["options"]) {
    this.options = options;
    this.root.className = "anki-bridge-coverage";
    this.rows.className = this.historicalRows.className = "anki-bridge-nodes";
    this.history.append(el("h4", "Historical sources (absent from returned snapshot, not proven deleted; the host may silently omit partial data)"), this.historicalRows);
    this.warning.setAttribute("role", "status");
    this.selectionWarning.setAttribute("role", "status");
    for (const [value, text] of [["all", "All nodes"], ["uncarded", "No cards"]]) {
      const option = el("option", text); option.value = value; this.scope.append(option);
    }
    this.scope.setAttribute("aria-label", "Coverage view");
    this.search.type = "search"; this.search.placeholder = "Search nodes"; this.search.setAttribute("aria-label", "Search nodes");
    const filter = () => { if (this.stale) return; this.selectionWarning.textContent = ""; this.prune(); this.options.changed("user"); this.render(); };
    this.search.oninput = filter; this.scope.onchange = filter;
    this.bulk.type = this.clear.type = "button";
    this.bulk.onclick = () => {
      const ids = this.visible().filter(n => this.eligible(n) && isUncardedNode(n)).map(n => n.id);
      this.select(ids, ids);
    };
    this.clear.onclick = () => this.select([]);
    this.root.append(this.scope, this.search, this.warning, this.selectionWarning);
    if (options.defaults) {
      this.flagged.type = "button";
      this.flagged.onclick = () => this.select(this.visible().filter(n => n.flagged && this.eligible(n)).map(n => n.id));
      this.root.append(this.flagged);
    }
    this.root.append(this.bulk, this.clear, this.rows, this.history, this.summary);
    this.render();
  }
  get ids(): string[] { return [...this.selected]; }
  get backfillNodeIds(): string[] { return this.ids.filter(id => this.backfill.has(id)); }
  get isStale(): boolean { return this.stale; }
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
    if (this.options.defaults) {
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
      ? `${count} eligible nodes would be selected. The limit is ${MAX_SELECTED_NODES} nodes. Narrow the search or scope before selecting.` : "";
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
  private render(): void {
    this.rows.replaceChildren(); this.historicalRows.replaceChildren();
    this.warning.textContent = this.stale ? "Coverage is stale. Refresh the graph before selecting or drafting." : this.view.pairingWarning
      ? "Pairing warning: the configured Anki address differs from the paired destination." : !this.view.paired ? "Not paired with an Anki profile. Coverage does not require a live connection." : "";
    this.search.disabled = this.scope.disabled = this.stale;
    const visible = this.visible(); this.history.hidden = !visible.some(n => this.historical(n));
    const uncarded = visible.filter(n => this.eligible(n) && isUncardedNode(n));
    this.bulk.textContent = `Select all uncarded: ${uncarded.length} ${uncarded.length === 1 ? "idea" : "ideas"}, up to ${uncarded.length * this.view.cardsPerNode} cards`;
    const flagged = visible.filter(n => n.flagged && this.eligible(n));
    this.flagged.textContent = `Select flagged: ${flagged.length} ${flagged.length === 1 ? "idea" : "ideas"}`;
    this.flagged.disabled = this.stale || !flagged.length;
    this.bulk.disabled = this.stale || !uncarded.length; this.clear.disabled = this.stale || !this.selected.size;
    this.summary.textContent = `${this.selected.size} ${this.selected.size === 1 ? "node" : "nodes"} selected. Up to ${this.selected.size * this.view.cardsPerNode} cards. This is a maximum, not a quota.`;
    if (!visible.length) this.rows.append(el("li", "No nodes match this view."));
    for (const n of visible) {
      const row = el("li"), label = el("label"), body = el("span"); label.className = "anki-bridge-node";
      if (hasCards(n.cards)) row.className = "anki-bridge-carded";
      if (!this.historical(n)) {
        const box = el("input"); box.type = "checkbox"; box.checked = this.selected.has(n.id); box.disabled = this.stale || !this.eligible(n);
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
      body.append(el("strong", n.name), el("span", n.statement));
      const c = n.coverage, badges: string[] = [];
      if (n.flagged) badges.push("Flagged");
      if (c) { badges.push(coverageLabel(c.state)); if (c.state !== c.base) badges.push(`Base: ${coverageLabel(c.base)}`); }
      if (c?.dismissed) badges.push("Dismissed for current statement");
      if (c?.historicalDismissal) badges.push("Historical dismissal");
      if (n.cards.sent) badges.push(`${n.cards.sent} sent`);
      if (n.cards.waiting) badges.push(`${n.cards.waiting} not yet sent`);
      if (n.cards.sentElsewhere) badges.push(`${n.cards.sentElsewhere} sent to another profile`);
      if (c?.olderSourceCards) badges.push(`${c.olderSourceCards} older-source cards`);
      if (c?.unknownSourceCards) badges.push(`${c.unknownSourceCards} unknown-source cards`);
      if (c?.deletedNotes) badges.push(`${c.deletedNotes} deleted Anki notes (still sent)`);
      if (c?.unresolved) badges.push(`${c.unresolved} unresolved deliveries`);
      if (c?.generating) badges.push("Generating");
      const badge = el("span", badges.join(" · ")); badge.className = "anki-bridge-badges"; body.append(badge);
      for (const note of n.flagNotes ?? []) body.append(el("span", `Note: ${note}`));
      if (c?.skipReason) body.append(el("span", `Writer skipped: ${c.skipReason}`));
      label.append(body); row.append(label);
      if ((c?.dismissed || c?.canDismiss) && n.statementHash && !this.historical(n)) {
        const action = el("button", c.dismissed ? "Restore" : "Don't card this"); action.type = "button"; action.disabled = this.stale;
        action.onclick = () => { this.options.changed("user"); this.options.mutate(c.dismissed ? "restoreNode" : "dismissNode", n); }; row.append(action);
      }
      if (n.cards.sent && n.cards.waiting && this.options.reviewWaiting) {
        const action = el("button", "Review waiting cards"); action.type = "button";
        action.onclick = () => this.options.reviewWaiting?.(n.id); row.append(action);
      }
      (this.historical(n) ? this.historicalRows : this.rows).append(row);
    }
  }
}
