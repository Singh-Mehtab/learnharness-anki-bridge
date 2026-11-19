// Minimal stand-in for the host UI kit in DOM tests. Host buttons become plain
// <button> elements with the label as text; menus record their items so a test
// can choose one by label.
type Handle = { update(props: Record<string, unknown>): void; dispose(): void };
export interface FakeMenu { label?: string; items: Array<{ key: string; label: string; disabled?: boolean; onSelect: () => void | Promise<void> }> }

export const menus: FakeMenu[] = [];
/** Select a menu item from the most recently opened menu. */
export async function chooseMenu(label: string | RegExp): Promise<void> {
  const menu = menus.at(-1);
  if (!menu) throw new Error("No menu is open.");
  const item = menu.items.find(i => typeof label === "string" ? i.label === label : label.test(i.label));
  if (!item) throw new Error(`No menu item ${label}. Items: ${menu.items.map(i => i.label).join(", ")}`);
  if (item.disabled) throw new Error(`Menu item ${item.label} is disabled.`);
  // Not awaited: an item may open a dialog that waits for the test to answer it.
  void item.onSelect();
}

function scoped(signal: AbortSignal | undefined, dispose: () => void): void {
  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose, { once: true });
}

export function fakeUi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mountButton: (container: HTMLElement, props: { label: string; onClick: () => unknown; disabled?: boolean; title?: string }, options?: { signal: AbortSignal }): Handle => {
      const node = container.ownerDocument.createElement("button");
      node.type = "button";
      let current = { ...props };
      const apply = () => { node.textContent = current.label; node.disabled = !!current.disabled; if (current.title) node.title = current.title; else node.removeAttribute("title"); };
      node.onclick = () => { if (!node.disabled) void current.onClick(); };
      apply(); container.append(node);
      const handle = { update: (next: Record<string, unknown>) => { current = { ...current, ...next }; apply(); }, dispose: () => { node.remove(); } };
      scoped(options?.signal, handle.dispose);
      return handle;
    },
    mountBadge: (container: HTMLElement, props: { text: string }): Handle => {
      const node = container.ownerDocument.createElement("span"); node.textContent = props.text; container.append(node);
      return { update: next => { if (typeof next.text === "string") node.textContent = next.text; }, dispose: () => node.remove() };
    },
    mountMarkdown: (target: HTMLElement, props: { text: string }): Handle => {
      target.textContent = props.text;
      return { update: next => { if (typeof next.text === "string") target.textContent = next.text; }, dispose: () => {} };
    },
    mountModelPicker: (): Handle => ({ update: () => {}, dispose: () => {} }),
    mountKnowledgePicker: (): Handle => ({ update: () => {}, dispose: () => {} }),
    openMenu: (_anchor: HTMLElement, props: FakeMenu): Handle => { menus.push(props); return { update: () => {}, dispose: () => {} }; },
    openDialog: (props: { content: HTMLElement }): Handle => {
      const doc = props.content.ownerDocument; doc.body.append(props.content);
      return { update: () => {}, dispose: () => props.content.remove() };
    },
    ...overrides,
  };
}
