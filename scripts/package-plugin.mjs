import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "./build.mjs";

const installPath = "anki-bridge/dist";
const entries = { main: "main.js", backend: "backend.cjs", styles: "styles.css" };
const files = ["manifest.json", ...Object.values(entries), "LICENSE", "THIRD_PARTY_NOTICES.md"];
const projectRoot = path.resolve(import.meta.dirname, "..");

export async function packagePlugin(project = projectRoot) {
  const root = path.resolve(project);
  const json = (name) => {
    const file = path.join(root, name);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw Error(`Expected a regular package metadata file: ${name}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const manifest = json("manifest.json");
  const lock = json("package-lock.json");
  const { version } = manifest;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      [json("package.json").version, lock.version, lock.packages?.[""]?.version].some(value => value !== version)) {
    throw Error("Expected matching numeric versions in the plugin manifest, package.json and package-lock.json");
  }
  if (manifest.id !== "anki-bridge" || manifest.apiVersion !== 1 ||
      Object.entries(entries).some(([key, value]) => manifest[key] !== value)) {
    throw Error("Plugin manifest does not match the distributable layout");
  }

  await buildPlugin(root);
  const stage = fs.mkdtempSync(path.join(root, ".package-"));
  try {
    const members = files.map(file => `${installPath}/${file}`);
    fs.mkdirSync(path.join(stage, installPath), { recursive: true });
    for (const [i, file] of files.entries()) {
      const built = path.join(root, "dist", file);
      if (!fs.lstatSync(built).isFile()) throw Error(`Expected a regular build output: ${file}`);
      fs.copyFileSync(built, path.join(stage, members[i]));
    }
    const archive = `anki-bridge-v${version}.zip`;
    // `zip` reads flags from the environment. Use only the options and members here.
    const { ZIPOPT: _zipopt, ZIP: _zip, ...env } = process.env;
    execFileSync("zip", ["-q", "-X", archive, ...members], { cwd: stage, env });
    const output = path.join(root, archive);
    fs.renameSync(path.join(stage, archive), output);
    return output;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(`Built ${await packagePlugin()}`);
  } catch (error) {
    console.error(`[package:plugin] ${error.message}`);
    process.exitCode = 1;
  }
}
