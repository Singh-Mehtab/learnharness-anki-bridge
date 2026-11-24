import type { PluginFrontendContext } from "../sdk/index.d.ts";
import { canSelectNode, isUncardedNode, MAX_SELECTED_NODES } from "./coverage/flow.ts";
import type { Coverage, CoverageContext, CardCounts } from "./coverage/flow.ts";
import { button, el, pill, plural } from "./ui.ts";
import type { ButtonHandle } from "./ui.ts";

export interface CoverageRow {
  id: string; name: string; statement: string; statementHash?: string;
  cards: CardCounts; coverage?: Coverage; flagged?: boolean;
}
export interface CoverageFlag { id: string; revision?: string; note: string; nodeIds: string[]; pendingNodeIds: string[] }
export type CoverageView = Omit<CoverageContext, "nodes" | "missing" | "pairingKey"> & { nodes: CoverageRow[]; missing?: CoverageRow[]; pairingKey?: string; flags?: CoverageFlag[] };

const DOTS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Short coverage labels for one idea. Tones only colour the text. */
function rowPills(n: CoverageRow): HTMLElement[] {
  const c = n.coverage, out: HTMLElement[] = [];
  if (c?.generating) out.push(pill("Writing…", "info"));
  if (c?.dismissed) out.push(pill("Not carding", "neutral"));
  else if (c?.state === "source-changed") out.push(pill("Changed since carded", "warn"));
  if (n.cards.waiting) out.push(pill(`${n.cards.waiting} to review`, "info"));
  if (n.cards.sent) out.push(pill(`${n.cards.sent} in Anki`, "good"));
  if (n.cards.sentElsewhere) out.push(pill(`${n.cards.sentElsewhere} in another profile`, "neutral"));
  if (c?.unresolved) out.push(pill(`${c.unresolved} unconfirmed`, "bad"));
  if (c?.deletedNotes) out.push(pill(`${c.deletedNotes} deleted in Anki`, "neutral"));
  // Flagged says nothing about cards, so a flagged idea without any still shows No cards (#17).
  if (!out.length && !n.cards.sent && !n.cards.waiting && c?.state !== "source-missing") out.push(pill("No cards", "neutral"));
  return n.flagged ? [pill("Flagged", "warn"), ...out] : out;
}

/** Selectable idea list. Selection belongs to the view, never to an asynchronous read. */
export class CoveragePicker {
  readonly root = el("div", undefined, "ab-ideas");
  private readonly toolbar = el("div", undefined, "ab-ideas-toolbar");
  private readonly quick = el("div", undefined, "ab-ideas-quick");
  private readonly groupHelp = el("p", "Idea checkboxes select ideas separately from the reply requests.", "ab-muted ab-flag-group-help");
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
  private independent = new Set<string>();
  private backfill = new Set<string>();
  private scopes = new Map<string, Set<string>>();
  private overriddenFlags = new Set<string>();
  private prunedDefaults = new Map<string, Set<string>>();
  private stale = false;
  private readonly options: {
    ctx?: PluginFrontendContext; signal?: AbortSignal;
    changed(source: "read" | "user"): void;
    mutate(name: "dismissNode" | "restoreNode", node: CoverageRow): void; reviewWaiting?: (nodeId: string) => void;
    empty?: () => string;
  };
  constructor(options: CoveragePicker["options"]) {
    this.options = options;
    this.warning.setAttribute("role", "status");
    this.selectionWarning.setAttribute("role", "status");
    for (const [value, text] of [["all", "All ideas"], ["uncarded", "Without cards"]]) {
      const option = el("option", text); option.value = value; this.scope.append(option);
    }
    this.scope.setAttribute("aria-label", "Show");
    this.search.type = "search"; this.search.placeholder = "Search ideas"; this.search.setAttribute("aria-label", "Search ideas");
    const filter = () => { if (this.stale) return; this.selectionWarning.textContent = ""; this.prune(true); this.options.changed("user"); this.render(); };
    this.search.oninput = filter; this.scope.onchange = filter;
    this.toolbar.append(this.search, this.scope);
    const { ctx, signal } = options;
    if (ctx && signal) {
      this.bulk = button(ctx, this.quick, signal, { label: "Select ideas without cards", onClick: () => this.selectUncarded() });
      this.flagged = button(ctx, this.quick, signal, { label: "Select flagged", onClick: () => this.selectFlagged() });
      this.clear = button(ctx, this.footer, signal, { label: "Clear", onClick: () => this.select([]) });
    }
    this.footer.prepend(this.summary);
    this.history.append(this.historySummary, el("p", "Their cards are kept.", "ab-muted ab-history-note"), this.historicalRows);
    this.root.append(this.toolbar, this.quick, this.warning, this.selectionWarning, this.groupHelp, this.rows, this.history, this.footer);
    this.render();
  }
  private selection(independent = this.independent, scopes = this.scopes): Set<string> {
    const ids = new Set(independent);
    for (const nodes of scopes.values()) for (const id of nodes) ids.add(id);
    return ids;
  }
  get ids(): string[] { return [...this.selection()]; }
  get independentNodeIds(): string[] { return [...this.independent]; }
  get backfillNodeIds(): string[] { return this.independentNodeIds.filter(id => this.backfill.has(id)); }
  get flagScopes(): { id: string; revision?: string; nodeIds: string[] }[] {
    return [...this.scopes].map(([id, nodes]) => {
      const revision = this.view.flags?.find(f => f.id === id)?.revision;
      return { id, ...(revision && { revision }), nodeIds: [...nodes] };
    });
  }
  get isStale(): boolean { return this.stale; }
  get size(): number { return this.view.nodes.length; }
  selectUncarded(): void {
    const ids = this.visible().filter(n => this.eligible(n) && isUncardedNode(n)).map(n => n.id);
    this.replaceIndependent(ids, ids, false, true);
  }
  selectFlagged(): void { this.select(this.visible().filter(n => n.flagged && this.eligible(n)).map(n => n.id)); }
  private visible(): CoverageRow[] {
    const query = this.search.value.trim().toLocaleLowerCase();
    return [...this.view.nodes, ...(this.view.missing ?? [])].filter(n =>
      (this.scope.value !== "uncarded" || isUncardedNode(n)) && `${n.name} ${n.statement}`.toLocaleLowerCase().includes(query));
  }
  private historical(n: CoverageRow): boolean { return !!this.view.missing?.includes(n) || n.coverage?.state === "source-missing"; }
  private eligible(n: CoverageRow): boolean { return !this.historical(n) && canSelectNode(n); }
  private prune(userFiltered: boolean, allowed = new Set(this.visible().filter(n => this.eligible(n)).map(n => n.id))): void {
    for (const id of this.independent) if (!allowed.has(id)) { this.independent.delete(id); this.backfill.delete(id); }
    const flags = new Map(this.view.flags?.map(f => [f.id, f]));
    for (const [id, nodes] of this.scopes) {
      const flag = flags.get(id), manual = this.overriddenFlags.has(id);
      const matches = new Set(manual ? flag?.nodeIds : flag?.pendingNodeIds);
      for (const nodeId of nodes) {
        if (matches.has(nodeId) && allowed.has(nodeId)) continue;
        if (userFiltered && !manual && matches.has(nodeId)) {
          const pruned = this.prunedDefaults.get(id) ?? new Set<string>();
          pruned.add(nodeId); this.prunedDefaults.set(id, pruned);
        }
        nodes.delete(nodeId);
      }
      if (!nodes.size) this.scopes.delete(id);
    }
  }
  update(view: CoverageView, reset = false): void {
    if (reset) {
      this.independent.clear(); this.backfill.clear(); this.scopes.clear(); this.overriddenFlags.clear(); this.prunedDefaults.clear();
      this.search.value = ""; this.scope.value = "all";
    }
    const changed = JSON.stringify(this.view) !== JSON.stringify(view) || this.stale;
    const previousScopes = JSON.stringify(this.flagScopes);
    const oldFlags = new Map(this.view.flags?.map(f => [f.id, f.revision]));
    for (const flag of view.flags ?? []) if (oldFlags.has(flag.id) && oldFlags.get(flag.id) !== flag.revision) {
      this.scopes.delete(flag.id); this.overriddenFlags.delete(flag.id); this.prunedDefaults.delete(flag.id);
    }
    this.view = view; this.stale = false;
    this.selectionWarning.textContent = "";
    const allowed = new Set(this.visible().filter(n => this.eligible(n)).map(n => n.id));
    this.prune(false, allowed);
    const scopes = new Map(this.scopes);
    for (const flag of view.flags ?? []) {
      if (this.overriddenFlags.has(flag.id)) continue;
      const pruned = this.prunedDefaults.get(flag.id);
      const defaults = new Set(flag.pendingNodeIds.filter(id => allowed.has(id) && !pruned?.has(id)));
      if (defaults.size) scopes.set(flag.id, defaults);
    }
    if (this.withinLimit(this.selection(this.independent, scopes).size)) this.scopes = scopes;
    if (changed || previousScopes !== JSON.stringify(this.flagScopes)) this.options.changed("read");
    this.render();
  }
  markStale(): void { this.stale = true; this.options.changed("read"); this.render(); }
  private withinLimit(count: number): boolean {
    this.selectionWarning.textContent = count > MAX_SELECTED_NODES
      ? `Limit is ${MAX_SELECTED_NODES} ideas. Narrow the search.` : "";
    return count <= MAX_SELECTED_NODES;
  }
  select(ids: readonly string[], backfillNodeIds: readonly string[] = [], resetFilters = false): void {
    this.replaceIndependent(ids, backfillNodeIds, resetFilters, false);
  }
  private replaceIndependent(ids: readonly string[], backfillNodeIds: readonly string[], resetFilters: boolean, keepScopes: boolean): void {
    if (this.stale) return;
    const allowed = new Set((resetFilters ? this.view.nodes : this.visible()).filter(n => this.eligible(n)).map(n => n.id));
    const independent = new Set(ids.filter(id => allowed.has(id)));
    const scopes = keepScopes ? this.scopes : new Map<string, Set<string>>();
    if (!this.withinLimit(this.selection(independent, scopes).size)) { this.render(); return; }
    if (resetFilters) { this.search.value = ""; this.scope.value = "all"; }
    this.independent = independent;
    this.backfill = new Set(backfillNodeIds.filter(id => independent.has(id)));
    this.scopes = scopes;
    if (!keepScopes) for (const flag of this.view.flags ?? []) this.overriddenFlags.add(flag.id);
    this.options.changed("user"); this.render();
  }
  private toggleFlag(id: string, nodeIds: string[]): void {
    if (this.stale) return;
    const scopes = new Map(this.scopes);
    if (nodeIds.length) scopes.set(id, new Set(nodeIds)); else scopes.delete(id);
    if (!this.withinLimit(this.selection(this.independent, scopes).size)) { this.render(); return; }
    this.scopes = scopes;
    this.overriddenFlags.add(id);
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
  private renderRow(n: CoverageRow, flagId?: string): HTMLLIElement {
    const row = el("li", undefined, "ab-idea");
    const historical = this.historical(n), eligible = this.eligible(n), direct = this.independent.has(n.id);
    const inRequest = flagId !== undefined && this.scopes.get(flagId)?.has(n.id);
    if (direct || inRequest) row.dataset.selected = "true";
    if (!eligible) row.dataset.inactive = "true";
    const label = el("label", undefined, "ab-idea-main");
    if (!historical) {
      const box = el("input"); box.type = "checkbox"; box.checked = direct; box.disabled = this.stale || !eligible;
      box.setAttribute("aria-label", flagId === undefined ? `Select ${n.name}` : `Select ${n.name} directly`);
      if (flagId !== undefined) box.dataset.selectionControl = JSON.stringify([flagId, n.id]);
      box.onchange = () => {
        if (this.stale) return;
        const selected = this.selection();
        if (box.checked && !this.withinLimit(selected.size + (selected.has(n.id) ? 0 : 1))) { this.render(); return; }
        this.selectionWarning.textContent = "";
        this.backfill.delete(n.id);
        if (box.checked) this.independent.add(n.id); else this.independent.delete(n.id);
        this.options.changed("user"); this.render();
      };
      label.append(box);
    }
    const body = el("span", undefined, "ab-idea-body");
    body.append(el("span", n.name, "ab-idea-name"), el("span", n.statement, "ab-idea-statement"));
    if (n.coverage?.skipReason && !n.cards.waiting) body.append(el("span", `Skipped last time: ${n.coverage.skipReason}`, "ab-idea-note"));
    label.append(body);
    const side = el("span", undefined, "ab-idea-side");
    if (inRequest) side.append(pill("In this request", "info"));
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
  private renderFlag(flag: CoverageFlag, number: number, candidates: CoverageRow[]): HTMLLIElement {
    const included = this.scopes.get(flag.id)?.size ?? 0;
    const eligible = candidates.filter(n => this.eligible(n)).map(n => n.id);
    const row = el("li", undefined, "ab-flag-group-row");
    const group = el("fieldset", undefined, "ab-flag-group");
    const legend = el("legend", `Flag ${number} · ${plural(candidates.length, "candidate")}`);
    const note = el("p", flag.note ? `Note: ${flag.note}` : "No note: request cards for the included ideas.", "ab-flag-group-note");
    const label = el("label", undefined, "ab-flag-group-toggle");
    const box = el("input"); box.type = "checkbox"; box.checked = included > 0; box.disabled = this.stale || !eligible.length;
    box.setAttribute("aria-label", `Include flag ${number} request`);
    box.dataset.selectionControl = JSON.stringify([flag.id]);
    box.onchange = () => this.toggleFlag(flag.id, box.checked ? eligible : []);
    label.append(box, el("span", "Include request"), el("span", `${included} of ${candidates.length} included`, "ab-muted"));
    const ideas = el("ul", undefined, "ab-flag-group-ideas");
    for (const n of candidates) ideas.append(this.renderRow(n, flag.id));
    group.append(legend, note, label, ideas);
    row.append(group);
    return row;
  }
  private render(): void {
    const focusKey = this.root.ownerDocument.activeElement?.getAttribute("data-selection-control");
    this.rows.replaceChildren(); this.historicalRows.replaceChildren();
    this.warning.textContent = this.stale ? "List may be out of date. Refresh it." : this.view.pairingWarning
      ? "Anki address changed. Choose the profile again in settings." : "";
    this.search.disabled = this.scope.disabled = this.stale;
    const visible = this.visible();
    const historical = visible.filter(n => this.historical(n));
    this.history.hidden = !historical.length;
    this.historySummary.textContent = `Ideas missing from this graph read (${historical.length})`;
    const uncarded = visible.filter(n => this.eligible(n) && isUncardedNode(n));
    this.bulk?.update({ label: `Select ideas without cards (${uncarded.length})`, disabled: this.stale || !uncarded.length });
    const flagged = visible.filter(n => n.flagged && this.eligible(n));
    this.flagged?.update({ label: `Select flagged (${flagged.length})`, disabled: this.stale || !flagged.length });
    if (this.flagged) this.flagged.root.hidden = !!this.view.flags || !this.view.nodes.some(n => n.flagged);
    const count = this.selection().size;
    this.clear?.update({ disabled: this.stale || !count });
    this.summary.textContent = count ? `${plural(count, "idea")} selected` : "No ideas selected";
    this.footer.dataset.empty = String(!count);
    const current = visible.filter(n => !this.historical(n));
    const byId = new Map(current.map(n => [n.id, n]));
    const grouped = new Set<string>();
    this.view.flags?.forEach((flag, index) => {
      const candidates = [...new Set(flag.nodeIds)].flatMap(id => {
        const n = byId.get(id);
        return n ? [n] : [];
      });
      if (!candidates.length) return;
      for (const n of candidates) grouped.add(n.id);
      this.rows.append(this.renderFlag(flag, index + 1, candidates));
    });
    this.groupHelp.hidden = !grouped.size;
    if (!current.length) {
      const empty = el("li", this.view.nodes.length ? "No matches." : this.options.empty?.() ?? "No ideas yet.", "ab-empty");
      this.rows.append(empty);
    }
    for (const n of current) if (!grouped.has(n.id)) this.rows.append(this.renderRow(n));
    for (const n of historical) this.historicalRows.append(this.renderRow(n));
    if (focusKey) [...this.rows.querySelectorAll<HTMLInputElement>("input[data-selection-control]")]
      .find(input => input.dataset.selectionControl === focusKey)?.focus({ preventScroll: true });
  }
}
