import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const copiedInputs = ["manifest.json", "src/styles.css", "LICENSE", "THIRD_PARTY_NOTICES.md"];

export async function buildPlugin(project = path.resolve(import.meta.dirname, "..")) {
  const root = path.resolve(project);
  const dist = path.join(root, "dist");
  const stat = fs.lstatSync(dist, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error("Refusing non-directory or symlink dist");
  if (fs.lstatSync(path.join(dist, "data"), { throwIfNoEntry: false })) throw Error("Refusing misplaced dist/data; move it to sibling data before building");
  if (!fs.lstatSync(path.join(root, "src"), { throwIfNoEntry: false })?.isDirectory()) throw Error("Expected a regular source directory: src");
  for (const file of copiedInputs) {
    if (!fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) throw Error(`Expected a regular build input: ${file}`);
  }
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);
  await Promise.all([
    build({ absWorkingDir: root, entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true, platform: "browser", format: "esm", target: "es2022", legalComments: "eof" }),
    build({ absWorkingDir: root, entryPoints: ["src/backend.ts"], outfile: "dist/backend.cjs", bundle: true, platform: "node", format: "cjs", target: "node24", external: [...builtinModules, "node:*"], legalComments: "eof" }),
  ]);
  for (const file of copiedInputs) {
    fs.copyFileSync(path.join(root, file), path.join(dist, path.basename(file)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildPlugin();
  console.log("Built anki-bridge/dist. No plugin data included.");
}
