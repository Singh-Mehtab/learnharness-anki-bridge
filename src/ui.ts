// Shared view helpers. Controls come from the host UI kit so they match the app,
// as core Flashcards does. Layout and text use scoped classes and host theme variables.
import type { PluginFrontendContext } from "../sdk/index.d.ts";

type ButtonProps = Parameters<PluginFrontendContext["ui"]["mountButton"]>[1];
export type ButtonHandle = ReturnType<PluginFrontendContext["ui"]["mountButton"]> & { readonly root: HTMLElement };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Host button inside a wrapper span. Defaults match Flashcards: small outline. */
export function button(ctx: PluginFrontendContext, parent: HTMLElement, signal: AbortSignal, props: Partial<ButtonProps> & Pick<ButtonProps, "label" | "onClick">): ButtonHandle {
  const root = el("span", undefined, "ab-button");
  parent.append(root);
  const handle = ctx.ui.mountButton(root, { size: "sm", variant: "outline", ...props }, { signal });
  return Object.assign(handle, { root });
}

/** Decodes base64 from the call bridge into bytes. */
export function base64Bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Saves bytes as a browser download, as the host's own artifact downloads do. */
export function saveFile(name: string, bytes: Uint8Array<ArrayBuffer>, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = el("a");
  link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  // Chromium keeps a started download past the revoke; the delay covers browsers that don't.
  const timer: unknown = setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // Node timers (tests) would otherwise hold the process open.
  (timer as { unref?: () => void }).unref?.();
}

/** Labelled field: small bold label, control, optional muted hint. */
export function field(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const label = el("label", undefined, "ab-field");
  label.append(el("span", text, "ab-label"), control);
  if (hint) label.append(el("span", hint, "ab-muted"));
  return label;
}

export function input(value = "", type = "text"): HTMLInputElement {
  const node = el("input", undefined, "ab-input");
  node.type = type; node.value = value;
  return node;
}

export function textarea(value = "", rows = 3): HTMLTextAreaElement {
  const node = el("textarea", undefined, "ab-input");
  node.value = value; node.rows = rows;
  return node;
}

/** Live status line. Tone sets colour only; text carries the meaning. */
export function status(className = "ab-status"): HTMLParagraphElement & { show(text: string, tone?: "error" | "success" | "muted"): void } {
  const node = el("p", undefined, className) as HTMLParagraphElement & { show(text: string, tone?: "error" | "success" | "muted"): void };
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.show = (text, tone = "muted") => { node.textContent = text; node.dataset.tone = tone; };
  return node;
}

/** Small tinted label for card state, kind or coverage. */
export function pill(text: string, tone: "neutral" | "good" | "warn" | "bad" | "info" = "neutral"): HTMLSpanElement {
  const node = el("span", text, "ab-pill");
  node.dataset.tone = tone;
  return node;
}

/** Numbered step heading, as in a guided flow. */
export function stepHeading(n: number | null, title: string, aside?: HTMLElement): HTMLElement {
  const head = el("header", undefined, "ab-step-head");
  if (n !== null) {
    const number = el("span", String(n), "ab-step-number");
    number.setAttribute("aria-hidden", "true");
    head.append(number);
  }
  head.append(el("h2", title, "ab-step-title"));
  if (aside) { aside.classList.add("ab-step-aside"); head.append(aside); }
  return head;
}

/** Confirmation dialog in the Flashcards style: heading, body, ghost Cancel and a primary action. */
export function confirmDialog(ctx: PluginFrontendContext, signal: AbortSignal, options: {
  title: string; body: string | HTMLElement; confirm: string; destructive?: boolean;
}): Promise<boolean> {
  if (signal.aborted || ctx.signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const content = el("div", undefined, "anki-bridge ab-dialog");
    content.append(el("h3", options.title, "ab-dialog-heading"));
    content.append(typeof options.body === "string" ? el("p", options.body) : options.body);
    const actions = el("div", undefined, "ab-actions ab-dialog-actions");
    content.append(actions);
    const scope = new AbortController();
    let handle: ReturnType<PluginFrontendContext["ui"]["openDialog"]> | undefined;
    let finished = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      ctx.signal.removeEventListener("abort", abort);
      scope.abort();
      handle?.dispose();
      resolve(accepted);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    ctx.signal.addEventListener("abort", abort, { once: true });
    button(ctx, actions, scope.signal, { label: "Cancel", variant: "ghost", onClick: () => finish(false) });
    button(ctx, actions, scope.signal, { label: options.confirm, variant: options.destructive ? "destructive" : "default", onClick: () => finish(true) });
    try { handle = ctx.ui.openDialog({ title: options.title, content, onClose: () => finish(false) }, { signal }); }
    catch (error) { finish(false); throw error; }
  });
}

const DOTS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Icon button that opens a host menu. Disabled items stay visible. */
export function moreMenu(ctx: PluginFrontendContext, parent: HTMLElement, signal: AbortSignal, label: string, items: () => Array<{ key: string; label: string; disabled?: boolean; onSelect: () => void | Promise<void> }>): ButtonHandle {
  const handle = button(ctx, parent, signal, {
    label, icon: DOTS, title: label,
    onClick: () => { ctx.ui.openMenu(handle.root, { label, items: items() }, { signal }); },
  });
  return handle;
}

/** Disposes every host widget mounted during one render when the next render starts. */
export class RenderScope {
  private controller: AbortController;
  private readonly parent: AbortSignal;
  constructor(parent: AbortSignal) { this.parent = parent; this.controller = this.next(); }
  private next(): AbortController {
    const controller = new AbortController();
    if (this.parent.aborted) controller.abort();
    else this.parent.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal });
    return controller;
  }
  get signal(): AbortSignal { return this.controller.signal; }
  reset(): AbortSignal { this.controller.abort(); this.controller = this.next(); return this.controller.signal; }
  dispose(): void { this.controller.abort(); }
}
