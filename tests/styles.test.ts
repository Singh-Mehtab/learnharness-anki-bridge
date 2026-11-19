import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("typed text turns off font ligatures so a deck path keeps both colons (#30)", () => {
  const rule = css.match(/\.anki-bridge \.ab-input \{([^}]*)\}/u)?.[1] ?? "";
  assert.match(rule, /font-variant-ligatures:\s*none/u);
});
