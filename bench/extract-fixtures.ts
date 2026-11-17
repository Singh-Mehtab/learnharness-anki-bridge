// Copy real graph nodes out of a LearnHarness data folder for the bench.
// Read-only: opens graph/nodes.jsonl, graph/chains.jsonl and the chats the
// chosen nodes came from, and writes bench/private/<name>.json (ignored by Git,
// because it holds the learner's own material).
//
// Usage: node bench/extract-fixtures.ts [--data <dir>] [--name qm] [--count 18]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import type { BenchSet } from "./types.ts";
import type { GraphChainLike, GraphNodeLike, ChatRecordLike } from "../src/writer/index.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: join(homedir(), "Library/Application Support/LearnHarness/data") },
    name: { type: "string", default: "qm" },
    subject: { type: "string", default: "Physics: quantum mechanics (real LearnHarness session)" },
    count: { type: "string", default: "18" },
  },
});

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

const dir = values.data!;
const nodes = readJsonl<GraphNodeLike & { createdAt: string }>(join(dir, "graph/nodes.jsonl"));
const chains = readJsonl<GraphChainLike>(join(dir, "graph/chains.jsonl"));
const count = Number(values.count);

// Stratified, deterministic pick across the session: half nodes that conclude
// a chain (why/compose possible), half that don't, evenly spaced in time.
const ordered = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const concludes = new Set(chains.map((c) => c.conclusion));
const spaced = <T>(list: T[], k: number): T[] =>
  k >= list.length ? list : Array.from({ length: k }, (_, i) => list[Math.floor((i * list.length) / k)]);
const withChain = ordered.filter((n) => concludes.has(n.id));
const without = ordered.filter((n) => !concludes.has(n.id));
const half = Math.ceil(count / 2);
const picked = [...spaced(withChain, Math.min(half, withChain.length))];
picked.push(...spaced(without, count - picked.length));
const pickedIds = new Set(picked.map((n) => n.id));
const targets = ordered.filter((n) => pickedIds.has(n.id)).map((n) => n.id);

// Keep only the teacher messages that nodes point at, to keep the file small.
const wantedMessages = new Map<string, Set<string>>();
for (const n of nodes) {
  for (const p of n.provenance ?? []) {
    if (!p.messageId) continue;
    if (!wantedMessages.has(p.chatId)) wantedMessages.set(p.chatId, new Set());
    wantedMessages.get(p.chatId)!.add(p.messageId);
  }
}
const chats: Record<string, ChatRecordLike> = {};
for (const [chatId, ids] of wantedMessages) {
  const path = join(dir, "chats", `${chatId}.json`);
  if (!existsSync(path)) continue;
  const chat = JSON.parse(readFileSync(path, "utf8")) as ChatRecordLike;
  chats[chatId] = { id: chatId, messages: chat.messages.filter((m) => m.id && ids.has(m.id)) };
}

const set: BenchSet = {
  name: values.name!,
  subject: values.subject!,
  origin: "real",
  graph: {
    propositions: nodes.map(({ id, name, statement, aliases, provenance }) => ({ id, name, statement, aliases, provenance })),
    chains: chains.map(({ id, premises, conclusion }) => ({ id, premises, conclusion })),
  },
  chats,
  targets,
};

mkdirSync("bench/private", { recursive: true });
const out = `bench/private/${values.name}.json`;
writeFileSync(out, `${JSON.stringify(set, null, 2)}\n`);
console.log(`Wrote ${out}: ${targets.length} targets (${targets.filter((id) => concludes.has(id)).length} conclude a chain) from ${nodes.length} nodes, ${chains.length} chains.`);
