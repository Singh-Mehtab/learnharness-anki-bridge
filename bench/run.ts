// 0.1.x card quality bench: run the shared card writer on the bench sets with
// the Claude Code CLI (the user's subscription), validate with the plugin's own
// validator, retry with its correction message, and save every card for scoring.
//
// Usage:
//   node bench/run.ts --mode core            # default kinds (fact, equation), all targets
//   node bench/run.ts --mode core --kinds fact,equation,steps   # choose kinds
//   node bench/run.ts --mode trial           # mini-problem + spot-the-mistake, first 4 targets per set
//   node bench/run.ts --cloze auto           # FI-8: cloze writer, mode auto or prefer (default off)
//   options: --model sonnet --cap 2 --sets qm,humanities,programming --dry-run
//
// The CLI runs in an empty temp directory with no tools, no MCP servers and no
// settings files, so the only context is the writer's instructions and input.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CORE_KINDS,
  DEFAULT_KINDS,
  TRIAL_KINDS,
  findProblems,
  pack,
  resultSchemaFor,
  sourcePassage,
  wordCount,
  writerInstructions,
  writerPrompt,
  duplicateIndexes,
  type Batch,
  type CardKind,
  type WriterResult,
} from "../src/writer/index.ts";
import type { BatchRecord, BenchCard, BenchRun, BenchSet, BenchSkip } from "./types.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "core" },
    kinds: { type: "string" },
    nodes: { type: "string" },
    "timeout-min": { type: "string", default: "10" },
    model: { type: "string", default: "sonnet" },
    effort: { type: "string", default: "medium" },
    cap: { type: "string", default: "2" },
    sets: { type: "string" },
    "trial-targets": { type: "string", default: "4" },
    retries: { type: "string", default: "2" },
    concurrency: { type: "string", default: "3" },
    "max-calls": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    cloze: { type: "string", default: "off" },
    "print-contract": { type: "boolean", default: false },
  },
});

const mode = values.mode === "trial" ? "trial" : "core";
const kinds: CardKind[] = values.kinds
  ? (values.kinds.split(",") as CardKind[])
  : mode === "trial" ? [...TRIAL_KINDS] : [...DEFAULT_KINDS];
for (const k of kinds) if (![...CORE_KINDS, ...TRIAL_KINDS].includes(k as never)) throw new Error(`Unknown kind: ${k}`);
const cap = Number(values.cap);
const retries = Number(values.retries);
const concurrency = Number(values.concurrency);
const maxCalls = values["max-calls"] === undefined ? Infinity : Number(values["max-calls"]);
for (const [name, value, minimum] of [["cap", cap, 1], ["retries", retries, 0], ["concurrency", concurrency, 1], ["trial-targets", Number(values["trial-targets"]), 1]] as const) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
}
if (values["max-calls"] !== undefined && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) {
  throw new Error("--max-calls must be a positive integer");
}
const cloze = values.cloze as "off" | "auto" | "prefer";
if (!["off", "auto", "prefer"].includes(cloze)) throw new Error("--cloze must be off, auto or prefer");
let calls = 0;

const BENCH_COMPLETION = `Return the complete result as structured output matching the schema. If you are told about validation problems, return a corrected complete result.`;
// FI-8: off sends exactly the basic writer's instructions and schema.
const instructions = writerInstructions({ kinds, completion: BENCH_COMPLETION, ...(cloze !== "off" ? { cloze: true } : {}) });
const schema = resultSchemaFor(kinds, { cloze: cloze !== "off" });

function loadSets(): BenchSet[] {
  const files = [
    ...(existsSync("bench/private") ? readdirSync("bench/private").map((f) => join("bench/private", f)) : []),
    ...readdirSync("bench/fixtures").map((f) => join("bench/fixtures", f)),
  ].filter((f) => f.endsWith(".json"));
  const sets = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as BenchSet);
  const wanted = values.sets?.split(",");
  const selected = wanted ? sets.filter((s) => wanted.includes(s.name)) : sets;
  const names = new Set<string>();
  for (const set of selected) {
    if (names.has(set.name)) throw new Error(`Duplicate bench fixture name: ${set.name}. Give each fixture a unique name before running the bench.`);
    names.add(set.name);
  }
  return selected;
}

interface ClaudeReply {
  sessionId: string;
  output: unknown;
  costUsd?: number;
  outputTokens?: number;
}

const cwd = join(tmpdir(), "anki-bridge-bench-cwd");
mkdirSync(cwd, { recursive: true });

function callClaude(prompt: string, resume?: string): Promise<ClaudeReply> {
  // Reserve synchronously before spawning, including correction calls. The pool
  // cannot overspend the shared limit even with concurrent batches.
  if (calls >= maxCalls) throw new Error(`Model call budget exhausted (${maxCalls}); no CLI launched.`);
  calls++;
  const args = [
    "-p",
    "--model", values.model!,
    "--effort", values.effort!,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--tools", "",
    "--system-prompt", instructions,
    "--json-schema", JSON.stringify(schema),
    "--output-format", "json",
    ...(resume ? ["--resume", resume] : []),
    prompt,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), Number(values["timeout-min"]) * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error(`claude: ${env.subtype}: ${String(env.result).slice(0, 300)}`));
        resolve({
          sessionId: env.session_id,
          output: env.structured_output ?? JSON.parse(env.result),
          costUsd: env.total_cost_usd,
          outputTokens: env.usage?.output_tokens,
        });
      } catch {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
    });
  });
}

async function runBatch(set: BenchSet, batch: Batch): Promise<{ record: BatchRecord; result: WriterResult | null }> {
  const record: BatchRecord = {
    set: set.name,
    nodeIds: batch.input.targets.map((t) => t.nodeId),
    inputTokens: batch.inputTokens,
    attempts: [],
    accepted: false,
  };
  let prompt = writerPrompt(batch.input);
  let session: string | undefined;
  let last: WriterResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const reply = await callClaude(prompt, session);
      session = reply.sessionId;
      last = reply.output as WriterResult;
      const problems = findProblems(last, batch.input);
      record.attempts.push({ durationMs: Date.now() - started, problems, costUsd: reply.costUsd, outputTokens: reply.outputTokens, output: reply.output });
      if (!problems.length) {
        record.accepted = true;
        break;
      }
      prompt = `Fix these problems and return the complete corrected result:\n- ${problems.join("\n- ")}`;
    } catch (error) {
      record.attempts.push({ durationMs: Date.now() - started, problems: [], error: (error as Error).message });
      break;
    }
  }
  return { record, result: last };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const sets = loadSets();
const jobs: Array<{ set: BenchSet; batch: Batch }> = [];
const skips: BenchSkip[] = [];
for (const set of sets) {
  const only = values.nodes?.split(",");
  const chosen = only ? set.targets.filter((id) => only.includes(id)) : set.targets;
  const targets = mode === "trial" ? chosen.slice(0, Number(values["trial-targets"])) : chosen;
  const byId = new Map(set.graph.propositions.map((n) => [n.id, n]));
  const { batches, skipped } = pack(
    set.graph,
    targets,
    (id) => ({
      source: sourcePassage(byId.get(id)!, (chatId) => set.chats[chatId]),
      ...(set.flags?.[id] ? { flagged: true, flagNote: set.flags[id].note } : {}),
    }),
    { maxCardsPerNode: cap, enabledKinds: kinds },
  );
  for (const s of skipped) {
    const n = byId.get(s.nodeId);
    skips.push({ set: set.name, nodeId: s.nodeId, nodeName: n?.name ?? s.nodeId, statement: n?.statement ?? "", reason: s.reason, by: "packer" });
  }
  for (const batch of batches) {
    if (cloze !== "off") batch.input.cloze = cloze;
    jobs.push({ set, batch });
  }
}

console.log(
  `${mode} run, ${values.model}: ${jobs.length} requests for ${jobs.reduce((n, j) => n + j.batch.input.targets.length, 0)} targets across ${sets.map((s) => s.name).join(", ")}` +
    ` (plus up to ${retries} correction calls per request; total call limit ${maxCalls}).`,
);
if (values["print-contract"]) {
  // No-model check of what the bench would send for this mode.
  console.log(JSON.stringify({ cloze, instructions, schema, firstPrompt: jobs[0] ? writerPrompt(jobs[0].batch.input) : null }, null, 2));
  process.exit(0);
}
if (values["dry-run"]) {
  for (const j of jobs) console.log(`  ${j.set.name}: ${j.batch.input.targets.length} targets, ~${j.batch.inputTokens} input tokens`);
  process.exit(0);
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${mode}-${values.model}${cloze !== "off" ? `-cloze-${cloze}` : ""}`;
const results = await pool(jobs, concurrency, async (job) => {
  const r = await runBatch(job.set, job.batch);
  const a = r.record.attempts;
  console.log(`  ${job.set.name} [${r.record.nodeIds.length}]: ${r.record.accepted ? "ok" : "FAILED"} after ${a.length} attempt(s)${a.at(-1)?.error ? ` (${a.at(-1)!.error})` : ""}`);
  return { ...job, ...r };
});

const cards: BenchCard[] = [];
const requestByCard = new Map<BenchCard, number>();
for (const [request, { set, batch, result, record }] of results.entries()) {
  if (!result || !Array.isArray(result.targets)) continue;
  const byId = new Map(set.graph.propositions.map((n) => [n.id, n]));
  const inBatch = new Set(batch.input.targets.map((t) => t.nodeId));
  for (const row of result.targets) {
    if (!inBatch.has(row.nodeId)) continue;
    const node = byId.get(row.nodeId)!;
    if (!row.cards.length) {
      skips.push({ set: set.name, nodeId: row.nodeId, nodeName: node.name, statement: node.statement, reason: row.skipReason ?? "", by: "model" });
    }
    row.cards.forEach((card, i) => {
      const entry: BenchCard = {
        id: `${set.name}:${row.nodeId}:${i}`,
        set: set.name,
        subject: set.subject,
        origin: set.origin,
        nodeId: row.nodeId,
        nodeName: node.name,
        statement: node.statement,
        kind: card.kind,
        ...(card.format === "cloze" ? { format: "cloze" as const } : {}),
        front: card.front,
        back: card.back,
        ...(card.extra?.trim() ? { extra: card.extra } : {}),
        frontWords: wordCount(card.front),
        backWords: wordCount(card.back),
        unvalidated: !record.accepted,
      };
      requestByCard.set(entry, request);
      cards.push(entry);
    });
  }
}

// Same fact drafted by separate requests: keep the first in set order.
const order = new Map(sets.flatMap((s) => s.targets.map((id, i) => [`${s.name}:${id}`, i] as const)));
cards.sort((a, b) => a.set.localeCompare(b.set) || (order.get(`${a.set}:${a.nodeId}`) ?? 0) - (order.get(`${b.set}:${b.nodeId}`) ?? 0));
const dup = duplicateIndexes(cards, (current, earlier) => !current.unvalidated && !earlier.unvalidated
  && current.set === earlier.set && requestByCard.get(current) !== requestByCard.get(earlier));
const duplicates = cards.flatMap((c, i) => (dup[i] >= 0 ? [{ removed: c.front, kept: cards[dup[i]].front }] : []));
cards.splice(0, cards.length, ...cards.filter((_, i) => dup[i] < 0));

const run: BenchRun = {
  runId,
  mode,
  model: `${values.model!} (effort ${values.effort})`,
  createdAt: new Date().toISOString(),
  maxCardsPerNode: cap,
  enabledKinds: kinds,
  cloze,
  clozePositive: sets.flatMap((s) => (s.clozePositive ?? []).map((id) => `${s.name}:${id}`)),
  instructions,
  modelCalls: calls,
  writerVersion: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
  batches: results.map((r) => r.record),
  cards,
  skips,
};
const dir = join("bench-output", runId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
if (duplicates.length) writeFileSync(join(dir, "duplicates-removed.json"), `${JSON.stringify(duplicates, null, 2)}\n`);
const cost = run.batches.flatMap((b) => b.attempts).reduce((n, a) => n + (a.costUsd ?? 0), 0);
console.log(`Removed ${duplicates.length} duplicates. Saved ${cards.length} cards, ${skips.length} skips to ${dir}/run.json. ${calls} calls; API-equivalent cost $${cost.toFixed(2)} (subscription, not billed).`);
