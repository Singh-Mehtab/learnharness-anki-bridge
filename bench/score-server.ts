// Local scoring page for bench runs. Loopback only; saves scores next to each
// run as scores.json on every change.
//
// Usage: node bench/score-server.ts [bench-output/<run> ...]
// With no arguments, opens the newest core run and the newest trial run.

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import type { BenchRun, Scores } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8790);
const root = resolve("bench-output");

function defaultRuns(): string[] {
  const all = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "run.json"))).sort() : [];
  return ["core", "trial"].map((m) => all.filter((d) => d.includes(`-${m}-`)).at(-1)).filter(Boolean).map((d) => join(root, d!));
}

const runDirs = (process.argv.slice(2).length ? process.argv.slice(2).map((d) => resolve(d)) : defaultRuns());
if (!runDirs.length) {
  console.error("No runs found in bench-output/. Run `npm run bench:run` first.");
  process.exit(1);
}
const runs = new Map<string, string>();
for (const dir of runDirs) {
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as BenchRun;
  runs.set(run.runId, dir);
}

function loadScores(dir: string): Scores {
  const path = join(dir, "scores.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Scores) : { cards: {}, skips: {} };
}

const page = readFileSync(new URL("./score.html", import.meta.url), "utf8");
const mathjax = readFileSync(resolve("node_modules/mathjax/es5/tex-svg.js"));

const server = createServer((req, res) => {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${host}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  } else if (req.method === "GET" && url.pathname === "/mathjax.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end(mathjax);
  } else if (req.method === "GET" && url.pathname === "/data") {
    const data = [...runs.entries()].map(([id, dir]) => ({
      run: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as BenchRun,
      scores: loadScores(dir),
      id,
    }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
  } else if (req.method === "POST" && url.pathname === "/scores" && req.headers["content-type"] === "application/json") {
    const dir = runs.get(url.searchParams.get("run") ?? "");
    if (!dir) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const scores = JSON.parse(body) as Scores;
        const tmp = join(dir, "scores.json.tmp");
        writeFileSync(tmp, `${JSON.stringify(scores, null, 2)}\n`);
        renameSync(tmp, join(dir, "scores.json"));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  } else {
    res.writeHead(404).end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Scoring ${[...runs.keys()].join(", ")} at ${url} (Ctrl-C to stop; scores save as you go).`);
  if (!process.env.NO_OPEN) execFile("open", [url]);
});
