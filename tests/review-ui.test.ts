import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { activate } from "../src/main.ts";
import { renderMarkdown } from "../src/anki/render.ts";
import type { PluginFrontendContext, PluginView } from "../sdk/index.d.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup() {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  const controller = new AbortController();
  const cards = ["one", "two"].map(id => ({ id, front: `Question ${id}`, back: "Answer", extra: "", kind: "recall", status: "draft", sourceStatement: "<script>Untrusted source</script>", sourceChanged: true }));
  const calls: Array<{ name: string; input: any }> = [];
  const state = { settings: { url: "http://127.0.0.1:18766", lastDeck: "Scratch", hasApiKey: false }, destination: null, cards,
    generationSettings: { cardsPerNode: 2, enabledKinds: ["recall"], model: null }, generations: [] };
  let view!: PluginView, dialog: HTMLElement | undefined;
  let previewDisposals = 0;
  const ctx = {
    signal: controller.signal, cleanup: () => {}, registerView: (v: PluginView) => { view = v; return () => {}; },
    registerSettings: () => () => {}, registerAction: () => () => {}, placeAction: () => () => {}, onResync: () => () => {}, onAppEvent: () => () => {},
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "edit") Object.assign(cards.find(c => c.id === input.id)!, input, { status: "draft" });
      if (name === "drop") cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "dropped"; });
      if (name === "coverageContext") return { nodes: [], catalog: {} };
      if (name === "sessions") return { sessions: [], unresolved: [] };
      if (name === "approve") cards.filter(c => input.ids.includes(c.id)).forEach(c => { c.status = "approved"; });
      return structuredClone(state);
    },
    ui: {
      mountKnowledgePicker: () => ({ update: () => {}, dispose: () => {} }),
      mountModelPicker: () => ({ update: () => {}, dispose: () => {} }),
      mountMarkdown: (target: HTMLElement, props: { text: string }) => {
        target.textContent = props.text;
        return { update: (next: { text: string }) => { target.textContent = next.text; }, dispose: () => { previewDisposals++; } };
      },
      openDialog: (props: { content: HTMLElement }) => { dialog = props.content; return { dispose: () => { dialog = undefined; } }; },
    },
  } as unknown as PluginFrontendContext;
  activate(ctx);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const cleanup = await view.mount(container as unknown as HTMLElement, controller.signal); await tick();
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(b => b.textContent === label);
    assert.ok(found, label); return found;
  };
  return { window, container, cards, calls, button, dialog: () => dialog, disposals: () => previewDisposals,
    close: async () => { controller.abort(); if (typeof cleanup === "function") await cleanup(); await window.happyDOM.close(); } };
}

test("review shows source beside safe preview, live length warning, and preserves unsaved text on refresh", async () => {
  const f = await setup();
  try {
    assert.match(f.container.textContent!, /Source has changed/);
    assert.equal(f.container.querySelector("script"), null);
    const editor = f.container.querySelector("article textarea")! as unknown as HTMLTextAreaElement;
    editor.value = "word ".repeat(32);
    editor.dispatchEvent(new f.window.Event("input") as unknown as Event);
    assert.match(f.container.textContent!, /Long card: 32 front words/);
    assert.match(f.container.querySelector(".anki-bridge-preview")!.textContent!, /word word/);
    const frame = f.container.querySelector('iframe[title="Anki field formatting"]')!;
    const formatting = frame.parentElement!;
    formatting.setAttribute("open", "");
    formatting.dispatchEvent(new f.window.Event("toggle"));
    assert.equal(frame.getAttribute("sandbox"), "");
    assert.ok(frame.getAttribute("srcdoc")?.includes(renderMarkdown(editor.value)));
    editor.value = "    # Indented front";
    editor.dispatchEvent(new f.window.Event("input") as unknown as Event);
    assert.ok(frame.getAttribute("srcdoc")?.includes(renderMarkdown(editor.value)));
    assert.doesNotMatch(frame.getAttribute("srcdoc")!, /<h1>/);
    editor.value = "word ".repeat(32);
    editor.dispatchEvent(new f.window.Event("input") as unknown as Event);
    f.button("Refresh cards").click(); await tick();
    assert.equal((f.container.querySelector("article textarea")! as unknown as HTMLTextAreaElement).value, "word ".repeat(32));
    assert.ok(f.disposals() >= 6);
    f.button("Approve all drafts, 2").click(); await tick();
    assert.equal(f.dialog(), undefined);
    assert.match(f.container.textContent!, /Save edits before/);
    assert.equal(f.calls.some(c => c.name === "approve"), false);
    f.button("Save edits").click(); await tick();
    f.button("Approve all drafts, 2").click(); await tick();
    assert.ok(f.dialog());
    assert.equal(f.calls.some(c => c.name === "approve"), false);
    f.dialog()!.querySelectorAll("button")[1]!.click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "approve")!.input, { ids: ["one", "two"] });
  } finally { await f.close(); }
});

test("review drops unsent cards and bulk send excludes dropped cards", async () => {
  const f = await setup();
  try {
    f.button("Drop card").click(); await tick();
    assert.equal(f.container.querySelectorAll("article").length, 1);
    assert.deepEqual(f.calls.find(c => c.name === "drop")!.input, { ids: ["one"] });
    f.button("Approve card").click(); await tick();
    f.button("Send approved cards, 1").click(); await tick();
    assert.deepEqual(f.calls.find(c => c.name === "send")!.input, { ids: ["two"], deck: "Scratch", expectedDestination: null });
  } finally { await f.close(); }
});

test("background draft refresh keeps unsaved hand-written text, open sections and review edits", async () => {
  const f = await setup();
  try {
    const details = f.container.querySelector("details")! as unknown as HTMLDetailsElement;
    details.open = true;
    const manualFront = details.querySelector("textarea")! as unknown as HTMLTextAreaElement;
    manualFront.value = "Half-typed question";
    const reviewFront = f.container.querySelector("article textarea")! as unknown as HTMLTextAreaElement;
    reviewFront.value = "Unsaved review edit";
    reviewFront.dispatchEvent(new f.window.Event("input") as unknown as Event);
    f.cards.push({ id: "three", front: "Question three", back: "Answer", extra: "", kind: "recall", status: "draft", sourceStatement: "S", sourceChanged: false });
    f.button("Refresh generation").click(); await tick(); await tick();
    assert.equal(f.container.querySelectorAll("article").length, 3);
    const nextDetails = f.container.querySelector("details")! as unknown as HTMLDetailsElement;
    assert.equal(nextDetails.open, true);
    assert.equal((nextDetails.querySelector("textarea")! as unknown as HTMLTextAreaElement).value, "Half-typed question");
    assert.equal((f.container.querySelector("article textarea")! as unknown as HTMLTextAreaElement).value, "Unsaved review edit");
  } finally { await f.close(); }
});

test("a draft refresh that arrives while the view is busy runs afterwards instead of being skipped", async () => {
  const f = await setup();
  try {
    f.button("Approve all drafts, 2").click(); await tick();
    assert.ok(f.dialog(), "confirmation keeps the view busy");
    f.cards.push({ id: "three", front: "Question three", back: "Answer", extra: "", kind: "recall", status: "draft", sourceStatement: "S", sourceChanged: false });
    f.button("Refresh generation").click(); await tick();
    assert.equal(f.container.querySelectorAll("article").length, 2);
    f.dialog()!.querySelectorAll("button")[0]!.click(); await tick(); await tick();
    assert.equal(f.container.querySelectorAll("article").length, 3);
  } finally { await f.close(); }
});
