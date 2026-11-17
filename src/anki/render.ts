function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function escaped(text: string, index: number): boolean {
  let count = 0;
  while (index > 0 && text[--index] === "\\") count++;
  return count % 2 === 1;
}

function math(text: string, index: number): { html: string; end: number } | undefined {
  let open: string;
  let close: string;
  let display: boolean;
  if (text.startsWith("\\[", index)) { open = "\\["; close = "\\]"; display = true; }
  else if (text.startsWith("\\(", index)) { open = "\\("; close = "\\)"; display = false; }
  else if (text.startsWith("$$", index)) { open = close = "$$"; display = true; }
  else if (text[index] === "$" && !/\s|\$/.test(text[index + 1] ?? " ")) {
    if (/^\$\d[\d,.]*(?=\s+(?:[A-Za-z]|\$)|[;:!?](?:\s|$)|$)/.test(text.slice(index))) return;
    open = close = "$"; display = false;
  }
  else return;
  let end = index + open.length;
  while ((end = text.indexOf(close, end)) !== -1) {
    if (!escaped(text, end) && (close !== "$" || (!/\s/.test(text[end - 1]!) && !/\d/.test(text[end + 1] ?? "")))) break;
    end += close.length;
  }
  if (end === -1) return;
  const content = text.slice(index + open.length, end);
  if (!content.trim() || content.includes("\0") || (!display && content.includes("\n"))) return;
  // MathJax can create links/styles too. Only mathematical TeX belongs in cards.
  if (/\\(?:href|url|style|class|cssId|html\w*|includegraphics|require|newcommand|renewcommand|def|gdef|let)\b/i.test(content)) {
    throw new Error("HTML, links, extensions and macro definitions in TeX are not supported.");
  }
  return { html: `${display ? "\\[" : "\\("}${escapeHtml(content)}${display ? "\\]" : "\\)"}`, end: end + close.length };
}

function inline(source: string): string {
  const tokens: string[] = [];
  const protect = (html: string) => `\0${tokens.push(html) - 1}\0`;
  const text = source.replace(/\0/g, "\uFFFD");
  let codeProtected = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && index + 1 < text.length) {
      codeProtected += text.slice(index, index + 2); index += 2; continue;
    }
    if (text[index] === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      let end = index + run.length;
      while ((end = text.indexOf(run, end)) !== -1) {
        if (text[end - 1] !== "`" && text[end + run.length] !== "`") break;
        end += run.length;
      }
      if (end !== -1) {
        codeProtected += protect(`<code>${escapeHtml(text.slice(index + run.length, end))}</code>`);
        index = end + run.length;
        continue;
      }
    }
    codeProtected += text[index++];
  }
  let protectedText = "";
  for (let index = 0; index < codeProtected.length;) {
    const tex = math(codeProtected, index);
    if (tex) { protectedText += protect(tex.html); index = tex.end; continue; }
    if (codeProtected[index] === "\\" && /[\\`*_{}\[\]()#+\-.!$>]/.test(codeProtected[index + 1] ?? "")) {
      protectedText += protect(escapeHtml(codeProtected[index + 1]!)); index += 2; continue;
    }
    protectedText += codeProtected[index++];
  }
  function format(input: string, depth = 0): string {
    if (depth > 20) return escapeHtml(input).replace(/\0(\d+)\0/g, (_match, id: string) => tokens[Number(id)]!);
    let html = "";
    let index = 0;
    while (index < input.length) {
      const rest = input.slice(index);
      const token = /^\0(\d+)\0/.exec(rest);
      if (token) { html += tokens[Number(token[1])]!; index += token[0].length; continue; }
      if (/^!\[/.test(rest)) throw new Error("Markdown images are not supported.");
      const link = /^\[([^\]\n]+)\]\(([^\s()]+)\)/.exec(rest);
      if (link) {
        const href = link[2]!;
        if (/^(?:https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href)) {
          html += `<a href="${escapeHtml(href)}">${format(link[1]!, depth + 1)}</a>`;
        } else html += escapeHtml(link[0]).replace(/\0(\d+)\0/g, (_match, id: string) => tokens[Number(id)]!);
        index += link[0].length;
        continue;
      }
      let emphasized = false;
      for (const marker of ["**", "__", "~~", "*", "_"]) {
        if (!rest.startsWith(marker) || /\s/.test(rest[marker.length] ?? " ")) continue;
        if (marker.includes("_") && /[\p{L}\p{N}]/u.test(input[index - 1] ?? "")) continue;
        let end = index + marker.length;
        while ((end = input.indexOf(marker, end)) !== -1) {
          if (!/\s/.test(input[end - 1]!) &&
              !(marker.includes("_") && /[\p{L}\p{N}]/u.test(input[end + marker.length] ?? ""))) break;
          end += marker.length;
        }
        if (end === -1) continue;
        const tag = marker.length === 1 ? "em" : marker === "~~" ? "del" : "strong";
        html += `<${tag}>${format(input.slice(index + marker.length, end), depth + 1)}</${tag}>`;
        index = end + marker.length;
        emphasized = true;
        break;
      }
      if (emphasized) continue;
      html += input[index] === "\n" ? "<br>\n" : escapeHtml(input[index]!);
      index++;
    }
    return html;
  }
  return format(protectedText);
}

/** Safe Markdown subset: raw HTML is always text; no images or executable media. */
export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flush = () => {
    if (paragraph.length) { blocks.push(`<p>${inline(paragraph.join("\n"))}</p>`); paragraph = []; }
    if (list) { blocks.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`); list = undefined; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flush();
      if (/\bmermaid\b/i.test(fence[2]!)) throw new Error("Mermaid diagrams are not supported.");
      const code: string[] = [];
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i]!)) code.push(lines[i]!);
      blocks.push(`<pre><code>${escapeHtml(code.join("\n") + (code.length ? "\n" : ""))}</code></pre>`);
      continue;
    }
    // Keep a display-math block intact even when it contains Markdown-like lines.
    if (/^\s*(?:\$\$|\\\[)/.test(line)) {
      flush();
      const open = line.trimStart().startsWith("$$") ? "$$" : "\\[";
      const close = open === "$$" ? "$$" : "\\]";
      let body = line;
      let end = i;
      while (body.indexOf(close, body.indexOf(open) + open.length) === -1 && end + 1 < lines.length) body += `\n${lines[++end]}`;
      if (body.indexOf(close, body.indexOf(open) + open.length) !== -1) {
        blocks.push(`<p>${inline(body)}</p>`);
        i = end;
        continue;
      }
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); const level = heading[1]!.length; blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); continue; }
    if (/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line)) { flush(); blocks.push("<hr>"); continue; }
    const item = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const tag = /^\d/.test(item[1]!) ? "ol" : "ul";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[2]!);
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks.join("\n");
}
