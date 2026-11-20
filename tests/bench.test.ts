import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LENGTH_TARGETS, writerInstructions } from "../src/writer/index.ts";

const runner = fileURLToPath(new URL("../bench/run.ts", import.meta.url));
const summariser = fileURLToPath(new URL("../bench/summarise.ts", import.meta.url));
// The runner resolves `claude` from PATH. Never inherit a PATH that could
// fall through to an authenticated CLI. These shebang fixtures are POSIX-only.
const posixCli = { skip: process.platform === "win32" ? "POSIX fake CLI fixture" : false };
const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "anki-bench-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// These guard the instruction contract, not semantic correctness of model output.
// Source-based scoring of a fresh run is still needed for that.
test("writer guidance covers the observed factual, assumption and semantic-leak failures", () => {
  const text = writerInstructions();
  for (const rule of ["even by paraphrase", "necessary assumptions explicit", "not an exhaustive claim", "not required", "built-in types", "Never invent a diagnosis", "front, back AND extra", "cap is a maximum, not a quota", "One card per fact", "tests multiplication, not the prefix", "explicit request"]) {
    assert.ok(text.includes(rule), `missing guidance: ${rule}`);
  }
  assert.match(text, /Front: about 30 words/);
  assert.match(text, /Back: about 15 words/);
  const html = readFileSync(new URL("../bench/score.html", import.meta.url), "utf8");
  assert.ok(html.includes(`words(card.frontWords, ${LENGTH_TARGETS.front})`));
  assert.ok(html.includes(`words(card.backWords, ${LENGTH_TARGETS.back})`));
  // A click in the note field must not move focus back to the card (typing was impossible).
  assert.ok(html.includes(`setFocus(el, !ev.target.closest("input, textarea, label"))`));
});

test("runner caps concurrent CLI launches, including failed/budget-limited jobs, without real model calls", posixCli, (t) => {
  const dir = scratch(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const log = join(dir, "calls.log");
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_CALL_LOG, 'call\\n');
const input = process.env.FAKE_BAD ? {targets:[]} : JSON.parse(process.argv.at(-1).split('\\n\\n').at(-1));
process.stdout.write(JSON.stringify({session_id:'fake',structured_output:{targets:process.env.FAKE_BAD ? [] : input.targets.map(t=>({nodeId:t.nodeId,cards:[{kind:'fact',front:'Which consequence follows here?',back:'Distinct result'}]}))}}));
`, { mode: 0o755 });
  mkdirSync(join(dir, "bench/private"), { recursive: true });
  mkdirSync(join(dir, "bench/fixtures"));
  const nodes = Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, name: `Topic ${i}`, statement: "Supported fact. ".repeat(800) }));
  writeFileSync(join(dir, "bench/private/fake.json"), JSON.stringify({ name: "fake", subject: "test", origin: "hand-written", graph: { propositions: nodes, chains: [] }, chats: {}, targets: nodes.map(n => n.id) }));
  const env = { PATH: bin, FAKE_CALL_LOG: log };
  const r = spawnSync(process.execPath, [runner, "--sets", "fake", "--max-calls", "2", "--concurrency", "3", "--retries", "0"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(readFileSync(join(dir, "bench-output", readdirSync(join(dir, "bench-output"))[0], "run.json"), "utf8"));
  assert.equal(run.batches.length, 4);
  assert.equal(run.modelCalls, 2);
  assert.equal(readFileSync(log, "utf8"), "call\ncall\n");
  assert.equal(run.batches.filter((b: { accepted: boolean }) => b.accepted).length, 2);
  assert.match(JSON.stringify(run), /budget exhausted/);
  const invalid = spawnSync(process.execPath, [runner, "--max-calls", "0"], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.equal(readFileSync(log, "utf8"), "call\ncall\n");
  const correction = spawnSync(process.execPath, [runner, "--sets", "fake", "--max-calls", "2", "--concurrency", "1"], { cwd: dir, env: { ...env, FAKE_BAD: "1" }, encoding: "utf8" });
  assert.equal(correction.status, 0, correction.stderr);
  assert.equal(readFileSync(log, "utf8"), "call\ncall\ncall\ncall\n");
  assert.match(correction.stdout, /FAILED after 3 attempt/);
});

test("bench dedupe keeps separate fixtures, same-request cards and failed-validation cards", posixCli, (t) => {
  const dir = scratch(t), bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(dir, "bench/private"), { recursive: true });
  mkdirSync(join(dir, "bench/fixtures"));
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const input = JSON.parse(process.argv.at(-1).split('\\n\\n').at(-1));
const targets = input.targets.map(t => ({nodeId:t.nodeId,cards:[{kind:'fact',front:'Which consequence follows here?',back:'Distinct result'}]}));
if (input.targets.some(t => t.nodeId === 'bad')) targets.push({nodeId:'unknown',cards:[],skipReason:'Not a requested target.'});
process.stdout.write(JSON.stringify({session_id:'fake',structured_output:{targets}}));
`, { mode: 0o755 });
  for (const [name, ids] of [["a", ["bad", "first", "same", "later"]], ["b", ["other"]]] as const) {
    const nodes = ids.map(id => ({ id, name: `Topic ${id}`, statement: "Supported fact. ".repeat(id === 'first' || id === 'same' ? 5 : 1100) }));
    writeFileSync(join(dir, `bench/private/${name}.json`), JSON.stringify({ name, subject: "test", origin: "hand-written", graph: { propositions: nodes, chains: [] }, chats: {}, targets: nodes.map(n => n.id) }));
  }
  const env = { PATH: bin };
  const r = spawnSync(process.execPath, [runner, "--sets", "a,b", "--max-calls", "10", "--retries", "0"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(readFileSync(join(dir, "bench-output", readdirSync(join(dir, "bench-output"))[0], "run.json"), "utf8"));
  assert.deepEqual(run.batches.map((b: { nodeIds: string[] }) => b.nodeIds), [["bad"], ["first", "same"], ["later"], ["other"]]);
  assert.deepEqual(run.cards.map((c: {nodeId: string; unvalidated: boolean}) => [c.nodeId, c.unvalidated]), [["bad", true], ["first", false], ["same", false], ["other", false]]);
  const other = JSON.parse(readFileSync(join(dir, "bench/private/b.json"), "utf8"));
  writeFileSync(join(dir, "bench/private/b.json"), JSON.stringify({ ...other, name: "a" }));
  const duplicateSet = spawnSync(process.execPath, [runner, "--sets", "a", "--dry-run"], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(duplicateSet.status, 0);
  assert.match(duplicateSet.stderr, /Duplicate bench fixture name: a/);
});

function summaryFixture(dir: string) {
  const cards = Array.from({ length: 3 }, (_, i) => ({ id: `s:n:${i}`, set: "s", nodeId: "n", nodeName: "Name", origin: "hand-written", kind: "recall", front: "Question?", back: "Answer", frontWords: 1, backWords: 1 }));
  const run = { runId: "test-core", mode: "core", model: "fake", maxCardsPerNode: 2, enabledKinds: ["recall"], cards, skips: [], batches: [{ accepted: true, attempts: [{}] }] };
  const scores = { cards: Object.fromEntries(cards.map(c => [c.id, { verdict: "keep" }])), skips: {} };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  writeFileSync(join(dir, "scores.json"), JSON.stringify(scores));
  return { run, scores };
}

const summarise = (dir: string, args: string[] = []) => {
  const r = spawnSync(process.execPath, [summariser, ...args, dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("summary keeps model and human scores and reports separate", (t) => {
  const dir = scratch(t);
  const { scores } = summaryFixture(dir);
  writeFileSync(join(dir, "scores.sol.json"), JSON.stringify(scores));
  for (const s of Object.values(scores.cards)) s.verdict = "drop";
  const human = JSON.stringify(scores);
  writeFileSync(join(dir, "scores.json"), human);
  assert.match(summarise(dir, ["--scores", "sol"]), /Verdict: PASS/);
  assert.match(readFileSync(join(dir, "summary.sol.md"), "utf8"), /automated Sol scores, not human acceptance/);
  assert.equal(readFileSync(join(dir, "scores.json"), "utf8"), human);
  assert.match(summarise(dir), /Verdict: FAIL/);
});

test("summary cannot pass incomplete generation, an empty run, a leak, or a kept factual error", (t) => {
  const dir = scratch(t);
  const { run, scores } = summaryFixture(dir);
  assert.match(summarise(dir), /Verdict: PASS/);
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...run, skips: [{ set: "s", nodeId: "skipped", by: "model", reason: "Known already" }] }));
  assert.match(summarise(dir), /Verdict: FAIL/);
  run.batches[0].accepted = false;
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  assert.match(summarise(dir), /FAIL \(incomplete generation/);
  run.batches[0].accepted = true;
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  writeFileSync(join(dir, "scores.json"), JSON.stringify({ ...scores, cards: { ...scores.cards, "s:n:0": { verdict: "drop", leak: true } } }));
  assert.match(summarise(dir), /Verdict: FAIL/);
  writeFileSync(join(dir, "scores.json"), JSON.stringify({ ...scores, cards: { ...scores.cards, "s:n:0": { verdict: "keep", error: true } } }));
  assert.match(summarise(dir), /Verdict: FAIL/);
  run.cards = [];
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  assert.match(summarise(dir), /FAIL \(incomplete generation or no cards\)/);
});
