import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AnkiClient, AnkiError, normalizeUrl } from "../src/anki/client.ts";

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  assert.notEqual(address.port, 8766);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function kind(expected: string) {
  return (error: unknown) => error instanceof AnkiError && error.kind === expected;
}

test("normalizeUrl accepts only root HTTP(S) endpoints", () => {
  assert.equal(normalizeUrl(" HTTP://LOCALHOST:8765/ "), "http://localhost:8765/");
  assert.equal(normalizeUrl("https://[::1]:8765"), "https://[::1]:8765/");
  for (const bad of ["file:///tmp", "localhost:8765", "http://a/p", "http://a/..", "http://a?", "http://a#", "http://user@a", "http://@a", "http://a\\p", "http://a/pa th"]) {
    assert.throws(() => normalizeUrl(bad), Error, bad);
  }
});

test("connection sends v6 POST requests with body key for an open profile", async () => {
  const requests: Record<string, unknown>[] = [];
  const http = await server((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      const result = { version: 6, getActiveProfile: "Scratch", deckNames: ["Default", "Test"] }[request.action as string];
      res.end(JSON.stringify({ result, error: null }));
    });
  });
  try {
    const client = new AnkiClient({ url: http.url, apiKey: "secret" });
    assert.deepEqual(await client.connection(), { profile: "Scratch", decks: ["Default", "Test"] });
    assert.deepEqual(requests, ["version", "getActiveProfile", "deckNames"].map((action) => ({ action, version: 6, key: "secret", params: {} })));
  } finally { await http.close(); }
});

test("connection returns null profile without requesting decks from a closed collection", async () => {
  const actions: string[] = [];
  const http = await server((req, res) => {
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      const { action } = JSON.parse(body) as { action: string };
      actions.push(action);
      if (action === "deckNames") {
        res.end(JSON.stringify({ result: null, error: "collection is not available" }));
      } else {
        res.end(JSON.stringify({ result: action === "version" ? 6 : null, error: null }));
      }
    });
  });
  try {
    const client = new AnkiClient({ url: http.url });
    assert.deepEqual(await client.connection(), { profile: null, decks: [] });
    assert.deepEqual(actions, ["version", "getActiveProfile"]);
    await assert.rejects(client.call("deckNames"), kind("api"));
  } finally { await http.close(); }
});

test("client accepts current and older legacy createModel and notesInfo shapes", async () => {
  let result: unknown;
  const http = await server((_req, res) => res.end(JSON.stringify({ result, error: null })));
  try {
    const client = new AnkiClient({ url: http.url });
    // Both implementations return the native model dictionary, not a null result.
    result = { id: 1, name: "LearnHarness Basic", flds: [{ name: "Front", ord: 0 }], tmpls: [] };
    assert.deepEqual(await client.call("createModel"), result);
    const oldNote = {
      noteId: 123,
      tags: ["learnharness"],
      fields: { Front: { value: "Question", order: 0 } },
      modelName: "LearnHarness Basic",
      cards: [456],
    };
    // Current legacy projections add profile/mod; missing notes remain {} in both.
    for (const note of [oldNote, { ...oldNote, profile: "Scratch", mod: 1_800_000_000 }]) {
      result = [note, {}];
      assert.deepEqual(await client.call("notesInfo", { notes: [123, 999] }), result);
    }
  } finally { await http.close(); }
});

test("client rejects malformed envelopes and important invalid results", async () => {
  let body: unknown;
  const http = await server((_req, res) => res.end(typeof body === "string" ? body : JSON.stringify(body)));
  const client = new AnkiClient({ url: http.url });
  try {
    for (body of ["not JSON", {}, { result: 6 }, { result: 6, error: false }, { result: 6, error: "oops" }]) {
      await assert.rejects(client.call("version"), kind("not-anki-connect"));
    }
    for (const [action, result] of [
      ["version", 5], ["getActiveProfile", 5], ["getActiveProfile", ""], ["deckNames", [1]],
      ["modelNames", null], ["modelStyling", {}], ["modelFieldNames", [1]],
      ["modelTemplates", { Card: {} }], ["findNotes", [null]], ["addNote", null],
      ["addNote", 1.5], ["createDeck", -1], ["notesInfo", [{} , { noteId: 1 }]],
      ["updateModelStyling", false], ["createModel", null],
    ]) {
      body = { result, error: null };
      await assert.rejects(client.call(action as string), kind("not-anki-connect"), String(action));
    }
    body = { result: { anything: true }, error: null };
    assert.deepEqual(await client.call("customAction"), { anything: true });
  } finally { await http.close(); }
});

test("API rejection differs from key rejection and uncertain socket failure", async () => {
  let mode = "api";
  const http = await server((req, res) => {
    if (mode === "drop") { req.socket.destroy(); return; }
    if (mode === "http") { res.writeHead(403).end("no"); return; }
    res.end(JSON.stringify({ result: null, error: mode === "key" ? "valid api key must be provided" : "duplicate note" }));
  });
  try {
    const client = new AnkiClient({ url: http.url });
    await assert.rejects(client.call("addNote"), kind("api"));
    mode = "key";
    await assert.rejects(client.call("addNote"), kind("key-rejected"));
    mode = "drop";
    await assert.rejects(client.call("addNote"), kind("transport"));
    mode = "http";
    await assert.rejects(client.call("version"), kind("not-anki-connect"));
  } finally { await http.close(); }
  const closed = await server((_req, res) => res.end());
  await closed.close();
  await assert.rejects(new AnkiClient({ url: closed.url }).call("version"), kind("refused"));
});

test("timeouts abort stalled bodies and cancellation propagates", async () => {
  let disconnected = false;
  let started!: () => void;
  let ready = new Promise<void>((resolve) => { started = resolve; });
  const http = await server((req, res) => {
    req.socket.on("close", () => { disconnected = true; });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"result":');
    started();
  });
  try {
    const pending = new AnkiClient({ url: http.url, timeoutMs: 50 }).call("version");
    await ready;
    await assert.rejects(pending, kind("timeout"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(disconnected);
    const controller = new AbortController();
    ready = new Promise<void>((resolve) => { started = resolve; });
    const client = new AnkiClient({ url: http.url, signal: controller.signal });
    const cancelled = client.call("version");
    await ready;
    controller.abort();
    await assert.rejects(cancelled, kind("cancelled"));
    await assert.rejects(client.call("version"), kind("cancelled"));
  } finally { await http.close(); }
  assert.throws(() => new AnkiClient({ url: http.url, timeoutMs: 0 }));
});
