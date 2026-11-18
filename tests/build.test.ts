import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const { buildPlugin } = await import(new URL("../scripts/build.mjs", import.meta.url).href) as { buildPlugin: (project: string) => Promise<void> };
const { packagePlugin } = await import(new URL("../scripts/package-plugin.mjs", import.meta.url).href) as { packagePlugin: (project: string) => Promise<string> };
const { installPluginLocal } = await import(new URL("../scripts/install-plugin-local.mjs", import.meta.url).href) as { installPluginLocal: (options: { project: string; pluginsDirectory: string }) => { copied: boolean } };
const source = path.resolve(import.meta.dirname, "..");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anki-bridge-build-"));
  const project = path.join(root, "project"), plugins = path.join(root, "plugins");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(plugins);
  for (const file of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) fs.copyFileSync(path.join(source, file), path.join(project, file));
  // Real frontend source and its imports, synthetic backend only. Never write the parent's backend file.
  fs.cpSync(path.join(source, "src"), path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src/backend.ts"), 'import { basename } from "node:path"; export function activate() { return basename("/scratch/fixture"); }\n');
  fs.mkdirSync(path.join(project, "data"));
  fs.writeFileSync(path.join(project, "data/keep"), "private fixture");
  return { root, project, plugins, dist: path.join(project, "dist"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("build emits the public API1 layout with real ESM frontend and CJS backend, excludes data and preserves sibling data", async () => {
  const f = fixture();
  try {
    await buildPlugin(f.project);
    assert.deepEqual(fs.readdirSync(f.dist).sort(), ["LICENSE", "THIRD_PARTY_NOTICES.md", "backend.cjs", "main.js", "manifest.json", "styles.css"].sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8"));
    assert.equal(manifest.id, "anki-bridge");
    assert.equal(manifest.apiVersion, 1);
    assert.equal(manifest.minAppVersion, "0.6.1");
    assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version);
    const frontend = await import(pathToFileURL(path.join(f.dist, "main.js")).href);
    assert.equal(typeof frontend.activate, "function");
    const backend = createRequire(import.meta.url)(path.join(f.dist, "backend.cjs"));
    assert.equal(backend.activate(), "fixture");
    assert.equal(fs.readFileSync(path.join(f.project, "data/keep"), "utf8"), "private fixture");
    assert.equal(fs.readFileSync(path.join(f.dist, "main.js"), "utf8").includes("sdk/index"), false);
    assert.equal(installPluginLocal({ project: f.project, pluginsDirectory: f.plugins }).copied, true);
    const installed = path.join(f.plugins, "anki-bridge");
    fs.mkdirSync(path.join(installed, "data"));
    fs.writeFileSync(path.join(installed, "data/keep"), "installed state");
    installPluginLocal({ project: f.project, pluginsDirectory: f.plugins });
    assert.equal(fs.readFileSync(path.join(installed, "data/keep"), "utf8"), "installed state");
  } finally { f.cleanup(); }
});

test("install zip contains only the built plugin and replaces 0.5.0 code without changing stored data", async () => {
  const f = fixture();
  try {
    const archive = await packagePlugin(f.project);
    const version = JSON.parse(fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8")).version;
    assert.equal(path.basename(archive), `anki-bridge-v${version}.zip`);
    const members = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(members.sort(), ["LICENSE", "THIRD_PARTY_NOTICES.md", "backend.cjs", "main.js", "manifest.json", "styles.css"]
      .map(file => `anki-bridge/dist/${file}`).sort());

    const extracted = path.join(f.root, "extracted");
    fs.mkdirSync(extracted);
    execFileSync("unzip", ["-q", archive, "-d", extracted]);
    const plugin = path.join(extracted, "anki-bridge");
    const installed = path.join(f.plugins, "anki-bridge");
    fs.cpSync(plugin, installed, { recursive: true });
    const installedDist = path.join(installed, "dist");
    assert.equal(fs.existsSync(path.join(installed, "data")), false);
    const installedManifest = path.join(installedDist, "manifest.json");
    assert.equal(JSON.parse(fs.readFileSync(installedManifest, "utf8")).version, version);
    const old = JSON.parse(fs.readFileSync(installedManifest, "utf8"));
    fs.writeFileSync(installedManifest, JSON.stringify({ ...old, version: "0.5.0" }));
    fs.writeFileSync(path.join(installedDist, "stale.js"), "old bundle");
    const state = path.join(installed, "data", "state.json");
    fs.mkdirSync(path.dirname(state));
    fs.writeFileSync(state, '{"schemaVersion":4,"fixture":"synthetic"}\n');
    const before = fs.readFileSync(state);
    fs.renameSync(installedDist, path.join(f.root, "previous-dist"));
    fs.cpSync(path.join(plugin, "dist"), installedDist, { recursive: true });
    assert.deepEqual(fs.readFileSync(state), before);
    assert.equal(fs.existsSync(path.join(installedDist, "stale.js")), false);
    assert.equal(JSON.parse(fs.readFileSync(installedManifest, "utf8")).version, version);
  } finally { f.cleanup(); }
});

test("packaging rejects version skew before changing any existing build", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.dist);
    fs.writeFileSync(path.join(f.dist, "keep"), "previous build");
    const lockfile = path.join(f.project, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
    lock.packages[""].version = "0.0.0";
    fs.writeFileSync(lockfile, JSON.stringify(lock));
    await assert.rejects(packagePlugin(f.project), /matching numeric versions/);
    assert.equal(fs.readFileSync(path.join(f.dist, "keep"), "utf8"), "previous build");
    assert.equal(fs.readdirSync(f.project).some(name => name.endsWith(".zip")), false);
  } finally { f.cleanup(); }
});

test("build refuses symlink dist and misplaced dist/data, including dangling links, before removing anything", async () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "keep");
    fs.symlinkSync(outside, f.dist);
    await assert.rejects(buildPlugin(f.project), /symlink dist/);
    assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
    fs.unlinkSync(f.dist); fs.mkdirSync(f.dist);
    fs.writeFileSync(path.join(f.dist, "keep"), "old build");
    for (const kind of ["directory", "file", "symlink"]) {
      const data = path.join(f.dist, "data");
      if (kind === "directory") fs.mkdirSync(data);
      if (kind === "file") fs.writeFileSync(data, "misplaced");
      if (kind === "symlink") fs.symlinkSync(path.join(f.root, "missing"), data);
      await assert.rejects(buildPlugin(f.project), /misplaced dist\/data/);
      assert.equal(fs.readFileSync(path.join(f.dist, "keep"), "utf8"), "old build");
      fs.rmSync(data, { recursive: true });
    }
  } finally { f.cleanup(); }
});

test("official local installer refuses target dist symlinks, misplaced data and source data", async () => {
  const f = fixture();
  try {
    await buildPlugin(f.project);
    const installed = path.join(f.plugins, "anki-bridge"); fs.mkdirSync(installed);
    const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    const target = path.join(installed, "dist"); fs.symlinkSync(outside, target);
    assert.throws(() => installPluginLocal({ project: f.project, pluginsDirectory: f.plugins }), /symlink/);
    fs.unlinkSync(target); fs.mkdirSync(target);
    fs.symlinkSync(path.join(f.root, "missing"), path.join(target, "data"));
    assert.throws(() => installPluginLocal({ project: f.project, pluginsDirectory: f.plugins }), /misplaced dist\/data/);
    fs.unlinkSync(path.join(target, "data"));
    fs.mkdirSync(path.join(f.dist, "data"));
    assert.throws(() => installPluginLocal({ project: f.project, pluginsDirectory: f.plugins }), /non-distributable/);
  } finally { f.cleanup(); }
});
