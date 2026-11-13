// The markdown the chat view and the dock render in the assistant's messages. Pure: text in, a
// DocumentFragment out, built on the document it is given (unit tested with a fake one, test/web/).
//
// The text is the model's and untrusted. Every node is made with createElement and createTextNode,
// and text is only ever set as text: nothing here parses HTML, so markup in the text stays text.
// A link keeps its href only for http:, https: and mailto:; any other link stays as the text it is.
//
// What it understands: paragraphs (a line break is a line break), **bold**, *italic*, _italic_,
// ~~strike~~, `code`, fenced code blocks (the language becomes data-lang), headings, bullet,
// numbered and task lists (nested), block quotes, rules, links (and bare http(s) URLs) and tables
// with a header row and alignment. Anything else stays as plain text.
//
// `streaming: true` is for text that is still arriving: an emphasis or code span that is open at the
// very end of the text is drawn as if it were closed there. An open fence always runs to the end.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TASK = /^\[([ xX])\][ \t]+/;
const DELIMITER_ROW = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const SAFE_HREF = /^(?:https?:|mailto:)/i;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Text in, a DocumentFragment out. `doc` is the document to build on. */
export function renderMarkdown(text, doc, { streaming = false } = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/^\t+/gm, (tabs) => "    ".repeat(tabs.length)).split("\n");
  const fragment = doc.createDocumentFragment();
  const ctx = { doc, streaming, last: null };
  fragment.append(...blocks(lines, ctx));
  if (streaming && ctx.last) finishLast(ctx);
  return fragment;
}

// ---------- blocks ----------

const indentOf = (line) => /^ */.exec(line)[0].length;
const blank = (line) => line.trim() === "";

/** Whether a line starts a block other than a paragraph: it ends a paragraph above it. */
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
}

function el(ctx, tag, className) {
  const node = ctx.doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** The block nodes for these lines. */
function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const indent = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++; // the closing fence, or past the end
      const pre = el(ctx, "pre", "code-block well");
      if (fence[2]) pre.setAttribute("data-lang", fence[2]);
      const code = el(ctx, "code");
      code.textContent = body.join("\n");
      pre.append(code);
      out.push(pre);
      ctx.last = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(leaf(ctx, el(ctx, `h${heading[1].length}`), heading[2] ?? ""));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(el(ctx, "hr"));
      ctx.last = null;
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (!blank(lines[i]) && !startsBlock(lines[i]) && inner.length && !blank(inner.at(-1))))) {
        inner.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      const quote = el(ctx, "blockquote");
      quote.append(...blocks(inner, ctx));
      out.push(quote);
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, ctx, out);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
      if (head.length === aligns.length && (line.trim().startsWith("|") || head.length > 1)) {
        i += 2;
        const rows = [];
        while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !startsBlock(lines[i])) rows.push(cells(lines[i++]));
        out.push(table(ctx, head, aligns, rows));
        continue;
      }
    }
    // A paragraph: up to a blank line or a line that starts another block.
    const para = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1]) && lines[i + 1].includes("-"))) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(leaf(ctx, el(ctx, "p"), para.join("\n")));
  }
  return out;
}

/** A list from line `start`, appended to `out`; returns the line after it. */
function list(lines, start, ctx, out) {
  const first = ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const kind = (marker) => (/\d/.test(marker) ? `o${marker.at(-1)}` : `u${marker}`);
  const listKind = kind(first[2]);
  const node = el(ctx, ordered ? "ol" : "ul");
  const number = Number.parseInt(first[2], 10);
  if (ordered && number !== 1) node.setAttribute("start", String(number));
  let i = start;
  let tasks = false;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i]);
    if (!match || match[1].length !== indent || kind(match[2]) !== listKind) break;
    const contentIndent = indent + match[2].length + 1;
    const body = [match[3] ?? ""];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        // A blank line stays in the item only when the item goes on after it.
        let next = i;
        while (next < lines.length && blank(lines[next])) next++;
        if (next < lines.length && indentOf(lines[next]) > indent) {
          body.push(...lines.slice(i, next));
          i = next;
          continue;
        }
        break;
      }
      const lineIndent = indentOf(line);
      if (lineIndent > indent) {
        body.push(line.slice(Math.min(lineIndent, contentIndent)));
      } else if (!startsBlock(line) && !blank(body.at(-1))) {
        body.push(line); // a lazy continuation of the item's paragraph
      } else {
        break;
      }
      i++;
    }
    const li = el(ctx, "li");
    const task = TASK.exec(body[0]);
    if (task) {
      tasks = true;
      const done = task[1] !== " ";
      li.className = "task";
      li.setAttribute("data-done", String(done));
      const mark = el(ctx, "span", "task-mark");
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", done ? "done" : "not done");
      mark.textContent = done ? "✓" : "";
      li.append(mark);
      body[0] = body[0].slice(task[0].length);
    }
    li.append(...blocks(body, ctx));
    node.append(li);
    // A blank line between items keeps the list going.
    let next = i;
    while (next < lines.length && blank(lines[next])) next++;
    const after = next < lines.length ? ITEM.exec(lines[next]) : null;
    if (after && after[1].length === indent && kind(after[2]) === listKind) i = next;
  }
  if (tasks) node.className = "tasks";
  out.push(node);
  return i;
}

/** A table row's cells, trimmed, without the outer pipes. An escaped \| stays in its cell. */
function cells(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function table(ctx, head, aligns, rows) {
  const wrap = el(ctx, "div", "table");
  const tableEl = el(ctx, "table");
  const row = (tag, values) => {
    const tr = el(ctx, "tr");
    aligns.forEach((align, column) => {
      const cell = el(ctx, tag);
      if (align) cell.setAttribute("data-align", align);
      tr.append(leaf(ctx, cell, values[column] ?? ""));
    });
    return tr;
  };
  const thead = el(ctx, "thead");
  thead.append(row("th", head));
  tableEl.append(thead);
  if (rows.length) {
    const tbody = el(ctx, "tbody");
    tbody.append(...rows.map((values) => row("td", values)));
    tableEl.append(tbody);
  }
  wrap.append(tableEl);
  return wrap;
}

/** A block whose content is inline text. The last one drawn is remembered for `streaming`. */
function leaf(ctx, node, text) {
  node.append(...inline(text, ctx, false));
  ctx.last = { node, text };
  return node;
}

/** Streaming: draws the last leaf block again, with spans still open at the end closed there. */
function finishLast(ctx) {
  const { node, text } = ctx.last;
  node.replaceChildren(...inline(text, ctx, true));
}

// ---------- inline ----------

const EMPHASIS = { "***": ["strong", "em"], "**": ["strong"], __: ["strong"], "*": ["em"], _: ["em"], "~~": ["del"] };
const wordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const space = (c) => c === undefined || /\s/.test(c);

/** The length of the run of `c` at `i`. */
function runAt(s, i) {
  let n = 0;
  while (s[i + n] === s[i]) n++;
  return n;
}

/** The index of the backtick run that closes a code span opened by `n` backticks at `from`, or -1. */
function codeClose(s, from, n) {
  for (let j = s.indexOf("`", from); j !== -1; j = s.indexOf("`", j)) {
    const run = runAt(s, j);
    if (run === n) return j;
    j += run;
  }
  return -1;
}

/** The index of the delimiter that closes an emphasis opened with `delim`, or -1. Code spans and escapes are skipped. */
function emphasisClose(s, from, delim) {
  const c = delim[0];
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "`") {
      const run = runAt(s, j);
      const close = codeClose(s, j + run, run);
      j = close === -1 ? j + run - 1 : close + run - 1;
      continue;
    }
    if (s[j] !== c) continue;
    const run = runAt(s, j);
    if (run === delim.length && !space(s[j - 1]) && !(c === "_" && wordChar(s[j + run]))) return j;
    j += run - 1;
  }
  return -1;
}

/** A [label](url "title") at `i`: { label, url, end } or null. */
function linkAt(s, i) {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const label = s.slice(i + 1, j);
  let k = j + 2;
  let parens = 0;
  for (; k < s.length; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === "(") parens++;
    else if (s[k] === ")" && parens-- === 0) break;
    else if (s[k] === "\n") return null;
  }
  if (k >= s.length) return null;
  const inside = s.slice(j + 2, k).trim();
  const target = /^<([^>]*)>|^(\S*)/.exec(inside);
  return { label, url: target[1] ?? target[2], end: k + 1 };
}

/** A bare URL at `i`: its length, without trailing punctuation or an unmatched ")". */
function bareUrl(s, i) {
  const match = /^https?:\/\/[^\s<>"]+/i.exec(s.slice(i));
  if (!match) return 0;
  let url = match[0];
  for (;;) {
    const strip = /[.,:;!?'*_~]$/.test(url) || (url.endsWith(")") && url.split("(").length < url.split(")").length);
    if (!strip) break;
    url = url.slice(0, -1);
  }
  return /^https?:\/\/[^/]/i.test(url) ? url.length : 0;
}

function anchor(ctx, href, children) {
  const a = el(ctx, "a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.append(...children);
  return a;
}

/**
 * The inline nodes for `s`. `open`: the text is still streaming and `s` reaches its end, so a span
 * opened and not yet closed is drawn closed at the end.
 */
function inline(s, ctx, open, inLink = false) {
  const out = [];
  let text = "";
  const flush = () => {
    if (text) out.push(ctx.doc.createTextNode(text));
    text = "";
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\" && PUNCTUATION.test(s[i + 1] ?? "")) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push(el(ctx, "br"));
      i++;
      continue;
    }
    if (c === "`") {
      const run = runAt(s, i);
      let close = codeClose(s, i + run, run);
      if (close === -1 && open) close = s.length;
      if (close !== -1) {
        let body = s.slice(i + run, close).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(body)) body = body.slice(1, -1);
        flush();
        const code = el(ctx, "code");
        code.textContent = body;
        out.push(code);
        i = close + run;
        continue;
      }
      text += s.slice(i, i + run);
      i += run;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      // Images aren't drawn (the pages ask no other host for anything): the text stays.
      text += "![";
      i += 2;
      continue;
    }
    if (c === "[") {
      const link = linkAt(s, i);
      if (link) {
        const source = s.slice(i, link.end);
        flush();
        if (SAFE_HREF.test(link.url) && !inLink) out.push(anchor(ctx, link.url, inline(link.label, ctx, false, true)));
        else out.push(ctx.doc.createTextNode(source));
        i = link.end;
        continue;
      }
    }
    if (c === "<" && !inLink) {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (auto) {
        flush();
        out.push(anchor(ctx, auto[1], [ctx.doc.createTextNode(auto[1].replace(/^mailto:/i, ""))]));
        i += auto[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !inLink && !wordChar(s[i - 1])) {
      const length = bareUrl(s, i);
      if (length) {
        const url = s.slice(i, i + length);
        flush();
        out.push(anchor(ctx, url, [ctx.doc.createTextNode(url)]));
        i += length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const run = runAt(s, i);
      const delim = s.slice(i, i + run);
      const canOpen = Object.hasOwn(EMPHASIS, delim) && !space(s[i + run]) && !(c === "_" && wordChar(s[i - 1]));
      if (canOpen) {
        let close = emphasisClose(s, i + run, delim);
        if (close === -1 && open && i + run < s.length) close = s.length;
        if (close !== -1) {
          flush();
          const tags = EMPHASIS[delim];
          const outer = el(ctx, tags[0]);
          let inner = outer;
          for (const tag of tags.slice(1)) {
            const node = el(ctx, tag);
            inner.append(node);
            inner = node;
          }
          inner.append(...inline(s.slice(i + run, close), ctx, open && close === s.length, inLink));
          out.push(outer);
          i = close + run;
          continue;
        }
      }
      text += delim;
      i += run;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}
