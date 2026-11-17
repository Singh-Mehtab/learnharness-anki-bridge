import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the exact browser renderer without adding a browser dependency.
const page = readFileSync(new URL("../bench/score.html", import.meta.url), "utf8");
const start = page.indexOf("function esc(");
const end = page.indexOf("function words(", start);
assert.ok(start >= 0 && end > start);
const md = runInNewContext(`${page.slice(start, end)}; md`) as (text: string) => string;

test("preview preserves fenced code whitespace and escapes HTML, dollars and emphasis", () => {
  const code = 'if ready:\n    print("$x$ **bold** <img src=x onerror=alert(1)> `x`")\n';
  for (const fence of ["```", "~~~"]) {
    const rendered = md(`What prints?\n${fence}python\n${code}${fence}`);
    assert.ok(rendered.includes('<pre><code>if ready:\n    print(&quot;$x$ **bold** &lt;img src=x onerror=alert(1)&gt; `x`&quot;)\n</code></pre>'));
    assert.ok(!rendered.includes("<img") && !rendered.includes("<b>"));
    assert.equal((rendered.match(/<code>/g) ?? []).length, 1);
  }
});

test("preview protects inline code before maths and still renders surrounding Markdown", () => {
  assert.equal(md('`$x$ **raw**` and **bold**\n$x_1$'), '<code>$x$ **raw**</code> and <b>bold</b><br>$x_1$');
  assert.equal(md('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(md('Use \\$5 or $\\alpha$').includes('\\$5 or $\\alpha$'));
});
