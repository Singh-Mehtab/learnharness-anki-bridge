import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/anki/render.ts";

test("renderMarkdown escapes untrusted HTML including attributes and media", () => {
  const html = renderMarkdown('<script>alert("x")</script>\n<img src=x onerror="evil()"> & <b>text</b>');
  assert.doesNotMatch(html, /<script|<img|<b>|onerror="/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.equal(renderMarkdown("<iframe src='x'>"), "<p>&lt;iframe src=&#39;x&#39;&gt;</p>");
});

test("renderMarkdown preserves fenced code whitespace, indentation and dollars", () => {
  const code = 'function test() {\n\tif (a < b) {\n    return "$x_i$ & <tag>";\n\t}\n}';
  assert.equal(renderMarkdown('```js\n' + code + '\n```'), '<pre><code>function test() {\n\tif (a &lt; b) {\n    return &quot;$x_i$ &amp; &lt;tag&gt;&quot;;\n\t}\n}\n</code></pre>');
  assert.equal(renderMarkdown('~~~\n  unfinished'), '<pre><code>  unfinished\n</code></pre>');
  assert.equal(renderMarkdown('````\n```\n````'), '<pre><code>```\n</code></pre>');
  assert.equal(renderMarkdown('$$unclosed\n```\n  $x$\n```'), '<p>$$unclosed</p>\n<pre><code>  $x$\n</code></pre>');
});

test("renderMarkdown protects inline code from Markdown, TeX and HTML conversion", () => {
  assert.equal(renderMarkdown('Use `$x_i$ <b> *literal*` then ``a`b``.'), '<p>Use <code>$x_i$ &lt;b&gt; *literal*</code> then <code>a`b</code>.</p>');
});

test("renderMarkdown converts maths before emphasis and preserves aligned newlines", () => {
  assert.equal(renderMarkdown('Find $x_i*y_j$ and $$a_b**c$$.'), '<p>Find \\(x_i*y_j\\) and \\[a_b**c\\].</p>');
  const tex = String.raw`$$
\begin{aligned}
x_i &= y_j \\
**z** &= 2
\end{aligned}
$$`;
  assert.equal(renderMarkdown(tex), '<p>\\[\n\\begin{aligned}\nx_i &amp;= y_j \\\\\n**z** &amp;= 2\n\\end{aligned}\n\\]</p>');
  assert.equal(renderMarkdown(String.raw`\(x_i\) and \[y_j\]`), '<p>\\(x_i\\) and \\[y_j\\]</p>');
});

test("renderMarkdown converts numeric-leading inline math without consuming surrounding currency", () => {
  assert.equal(renderMarkdown('$2 x + 1$'), String.raw`<p>\(2 x + 1\)</p>`);
  assert.equal(renderMarkdown('Cost $5 and $10 then $2 x + 1$.'), String.raw`<p>Cost $5 and $10 then \(2 x + 1\).</p>`);
  assert.equal(renderMarkdown(String.raw`$2 x + \$5$`), String.raw`<p>\(2 x + \$5\)</p>`);
});

test("renderMarkdown does not close currency with a math opener inside emphasis", () => {
  for (const [marker, tag] of [['**', 'strong'], ['*', 'em'], ['__', 'strong'], ['_', 'em'], ['~~', 'del']]) {
    assert.equal(renderMarkdown(`Cost $5 and ${marker}$x$${marker}.`), `<p>Cost $5 and <${tag}>\\(x\\)</${tag}>.</p>`);
  }
  assert.equal(renderMarkdown(String.raw`Cost $5 and **$\alpha$**.`), String.raw`<p>Cost $5 and <strong>\(\alpha\)</strong>.</p>`);
  assert.equal(renderMarkdown('$2 x^*$ and $*$.'), String.raw`<p>\(2 x^*\) and \(*\).</p>`);
});

test("renderMarkdown bounds emphasis detection to the next unescaped dollar", () => {
  assert.equal(renderMarkdown('$2 x^ *$ and $3 y^ *$.'), String.raw`<p>\(2 x^ *\) and \(3 y^ *\).</p>`);
  assert.equal(renderMarkdown('$2 x^ *$ and *$3 y$*.'), String.raw`<p>\(2 x^ *\) and <em>\(3 y\)</em>.</p>`);
  assert.equal(renderMarkdown(String.raw`Cost $5 and **$x + \$5$**.`), String.raw`<p>Cost $5 and <strong>\(x + \$5\)</strong>.</p>`);
});

test("renderMarkdown keeps currency, escaped dollars, unmatched dollars and identifiers literal", () => {
  assert.equal(renderMarkdown(String.raw`Cost $5 and $10; pay \$20. An unmatched $ remains. foo_bar_baz`), '<p>Cost $5 and $10; pay $20. An unmatched $ remains. foo_bar_baz</p>');
  assert.equal(renderMarkdown(String.raw`\$x\$ and $x + \$5$`), '<p>$x$ and \\(x + \\$5\\)</p>');
});

test("renderMarkdown formats common Markdown without unsafe link schemes", () => {
  assert.equal(renderMarkdown('# Title\n\n**bold** *em* ~~old~~\n\n- one\n- two\n\n1. first\n2. second'), '<h1>Title</h1>\n<p><strong>bold</strong> <em>em</em> <del>old</del></p>\n<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('[site](https://example.com/?a=1&b=2)'), '<p><a href="https://example.com/?a=1&amp;b=2">site</a></p>');
  for (const link of ['[x](javascript:evil)', '[x](data:text/html,evil)', '[x](jav&#x61;script:evil)']) assert.doesNotMatch(renderMarkdown(link), /<a /);
  assert.doesNotMatch(renderMarkdown('[x](https://example.com/"onmouseover="evil)'), /"onmouseover="/);
});

test("renderMarkdown keeps protected TeX/code intact inside emphasis without token collisions", () => {
  assert.equal(renderMarkdown('*$a*b$* and **`a**b`**'), String.raw`<p><em>\(a*b\)</em> and <strong><code>a**b</code></strong></p>`);
  assert.equal(renderMarkdown('Cost $5 and $10 then $x_i$.'), String.raw`<p>Cost $5 and $10 then \(x_i\).</p>`);
  assert.equal(renderMarkdown('Before $ then `code$` after'), '<p>Before $ then <code>code$</code> after</p>');
  assert.equal(renderMarkdown('\u00000\u0000 **text**'), '<p>\uFFFD0\uFFFD <strong>text</strong></p>');
});

test("renderMarkdown rejects Markdown images, Mermaid and executable TeX", () => {
  for (const input of ['![x](https://example.com/x.png)', '```mermaid\ngraph LR; A-->B\n```', String.raw`$\href{javascript:evil}{x}$`, String.raw`\(\require{html}\)`]) assert.throws(() => renderMarkdown(input), /not supported/);
  assert.equal(renderMarkdown('`![x](url)`'), '<p><code>![x](url)</code></p>');
});
