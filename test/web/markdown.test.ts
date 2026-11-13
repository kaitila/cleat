// The markdown renderer (src/web/markdown.js), on a fake document that records what is built and
// writes it out as HTML-like text. The fake has no innerHTML: the renderer can only build nodes.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/web/markdown.js";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

class FakeText {
  constructor(public text: string) {}
  toString() {
    return escape(this.text);
  }
}

class FakeElement {
  children: (FakeElement | FakeText)[] = [];
  attributes = new Map<string, string>();
  className = "";
  constructor(public tag: string) {}
  append(...nodes: (FakeElement | FakeText)[]) {
    for (const node of nodes) {
      if (node instanceof FakeFragment) this.children.push(...node.children);
      else if (node instanceof FakeElement || node instanceof FakeText) this.children.push(node);
      else throw new Error(`append: not a node: ${String(node)}`);
    }
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    if (/^on/i.test(name)) throw new Error(`an event handler attribute: ${name}`);
    this.attributes.set(name, String(value));
  }
  set textContent(text: string) {
    this.children = [new FakeText(String(text))];
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join("");
  }
  toString(): string {
    const attrs = [...(this.className ? [["class", this.className]] : []), ...this.attributes].map(([k, v]) => ` ${k}="${escape(v!)}"`).join("");
    if (this.tag === "br" || this.tag === "hr") return `<${this.tag}${attrs}>`;
    return `<${this.tag}${attrs}>${this.children.join("")}</${this.tag}>`;
  }
}

class FakeFragment extends FakeElement {
  constructor() {
    super("#fragment");
  }
  override toString() {
    return this.children.join("");
  }
}

const doc = {
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => new FakeText(text),
  createDocumentFragment: () => new FakeFragment(),
};

const md = (text: string, streaming = false) => String(renderMarkdown(text, doc, { streaming }));
const LINK = 'target="_blank" rel="noopener noreferrer"';

describe("blocks", () => {
  test("paragraphs split at blank lines; a line break is a line break", () => {
    expect(md("one\ntwo\n\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
    expect(md("")).toBe("");
  });
  test("headings 1 to 6, and a # without a space is text", () => {
    expect(md("# One\n### Three ###\n###### Six")).toBe("<h1>One</h1><h3>Three</h3><h6>Six</h6>");
    expect(md("#hashtag")).toBe("<p>#hashtag</p>");
  });
  test("a fenced block keeps its text as it is, with its language as data-lang", () => {
    expect(md("Before:\n```ts\nconst a = `x`;\n\n  **indented**\n```\nafter")).toBe(
      '<p>Before:</p><pre class="code-block well" data-lang="ts"><code>const a = `x`;\n\n  **indented**</code></pre><p>after</p>',
    );
    expect(md("~~~\nplain\n~~~")).toBe('<pre class="code-block well"><code>plain</code></pre>');
  });
  test("a fence still open runs to the end", () => {
    expect(md("```py\nhalf")).toBe('<pre class="code-block well" data-lang="py"><code>half</code></pre>');
  });
  test("rules and block quotes", () => {
    expect(md("a\n\n---\n\n***")).toBe("<p>a</p><hr><hr>");
    expect(md("> quoted\nlazy\n> > deeper\n\nafter")).toBe("<blockquote><p>quoted<br>lazy</p><blockquote><p>deeper</p></blockquote></blockquote><p>after</p>");
  });
});

describe("lists", () => {
  test("bullets, right after a paragraph line, the owner's screenshot", () => {
    expect(md("**CREANDUM DAY ZERO DRINKS**\n- **FR8 Demo Day**, 17:00-19:00\n- Dinner")).toBe(
      "<p><strong>CREANDUM DAY ZERO DRINKS</strong></p><ul><li><p><strong>FR8 Demo Day</strong>, 17:00-19:00</p></li><li><p>Dinner</p></li></ul>",
    );
  });
  test("numbered, with a start, and nested lists of both kinds", () => {
    expect(md("3. three\n4. four\n   - sub\n     1. deep\n5. five")).toBe(
      '<ol start="3"><li><p>three</p></li><li><p>four</p><ul><li><p>sub</p><ol><li><p>deep</p></li></ol></li></ul></li><li><p>five</p></li></ol>',
    );
    expect(md("- a\n  - b\n- c")).toBe("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>");
  });
  test("a blank line between items keeps one list; a different marker starts another", () => {
    expect(md("- a\n\n- b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(md("- a\n1. b")).toBe("<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>");
  });
  test("an item's lazy continuation and its code block", () => {
    expect(md("- one\ngoes on\n- two\n  ```sh\n  ls\n  ```")).toBe(
      '<ul><li><p>one<br>goes on</p></li><li><p>two</p><pre class="code-block well" data-lang="sh"><code>ls</code></pre></li></ul>',
    );
  });
  test("task lists are marks, not inputs", () => {
    expect(md("- [ ] todo\n- [x] done")).toBe(
      '<ul class="tasks"><li class="task" data-done="false"><span class="task-mark" role="img" aria-label="not done"></span><p>todo</p></li>' +
        '<li class="task" data-done="true"><span class="task-mark" role="img" aria-label="done">✓</span><p>done</p></li></ul>',
    );
  });
});

describe("inline", () => {
  test("bold, italic, strike, code and both together", () => {
    expect(md("**b** __b__ *i* _i_ ~~s~~ `c` ***bi***")).toBe("<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>c</code> <strong><em>bi</em></strong></p>");
    expect(md("**bold *and it* more**")).toBe("<p><strong>bold <em>and it</em> more</strong></p>");
  });
  test("what isn't emphasis stays text", () => {
    expect(md("snake_case_name and 2 * 3 * 4 and a lone ` and **open")).toBe("<p>snake_case_name and 2 * 3 * 4 and a lone ` and **open</p>");
    expect(md("\\*not\\* and `**in code**`")).toBe("<p>*not* and <code>**in code**</code></p>");
    expect(md("``a ` b``")).toBe("<p><code>a ` b</code></p>");
  });
  test("links, autolinks and bare URLs", () => {
    expect(md('[the docs](https://example.com/a_(b) "title")')).toBe(`<p><a href="https://example.com/a_(b)" ${LINK}>the docs</a></p>`);
    expect(md("see https://example.com/x. and (http://a.io/y)")).toBe(
      `<p>see <a href="https://example.com/x" ${LINK}>https://example.com/x</a>. and (<a href="http://a.io/y" ${LINK}>http://a.io/y</a>)</p>`,
    );
    expect(md("<mailto:a@b.c> [**bold** link](mailto:a@b.c)")).toBe(`<p><a href="mailto:a@b.c" ${LINK}>a@b.c</a> <a href="mailto:a@b.c" ${LINK}><strong>bold</strong> link</a></p>`);
    expect(md("[https://x.io](https://x.io)")).toBe(`<p><a href="https://x.io" ${LINK}>https://x.io</a></p>`);
  });
  test("an image is not drawn", () => {
    expect(md("![alt](picture.png)")).toBe("<p>![alt](picture.png)</p>");
  });
});

describe("tables", () => {
  test("a header row, alignment and body rows, with a short row filled", () => {
    expect(md("| Name | Time | N |\n|:-----|:----:|--:|\n| `a` | 17:00 | 1 |\n| b \\| c |")).toBe(
      '<div class="table"><table><thead><tr><th data-align="left">Name</th><th data-align="center">Time</th><th data-align="right">N</th></tr></thead>' +
        '<tbody><tr><td data-align="left"><code>a</code></td><td data-align="center">17:00</td><td data-align="right">1</td></tr>' +
        '<tr><td data-align="left">b | c</td><td data-align="center"></td><td data-align="right"></td></tr></tbody></table></div>',
    );
  });
  test("without a delimiter row it is a paragraph", () => {
    expect(md("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
  });
});

describe("streaming", () => {
  test("a span open at the very end is drawn closed there", () => {
    expect(md("Some **bol", true)).toBe("<p>Some <strong>bol</strong></p>");
    expect(md("run `bun te", true)).toBe("<p>run <code>bun te</code></p>");
    expect(md("- item *it", true)).toBe("<ul><li><p>item <em>it</em></p></li></ul>");
  });
  test("only at the end: earlier blocks and the final render are as usual", () => {
    expect(md("**open\n\nnext", true)).toBe("<p>**open</p><p>next</p>");
    expect(md("Some **bol")).toBe("<p>Some **bol</p>");
    expect(md("ends with **", true)).toBe("<p>ends with **</p>");
  });
});

describe("untrusted text stays text", () => {
  test("HTML is text, in prose, headings, code spans and code blocks", () => {
    const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror="alert(1)">\n# <b>h</b>\n`<i>`\n```html\n<script>x()</script>\n```', doc) as unknown as FakeElement;
    expect(String(out)).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p><h1>&lt;b&gt;h&lt;/b&gt;</h1><p><code>&lt;i&gt;</code></p>" +
        '<pre class="code-block well" data-lang="html"><code>&lt;script&gt;x()&lt;/script&gt;</code></pre>',
    );
    const tags = (node: FakeElement | FakeText): string[] => (node instanceof FakeElement ? [node.tag, ...node.children.flatMap(tags)] : []);
    expect(tags(out).filter((t) => ["script", "img", "b", "i"].includes(t))).toEqual([]);
  });
  test("a link keeps its href only for http:, https: and mailto:", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:x", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "relative/path.md", "//evil.example"]) {
      const source = `[click](${url})`;
      const out = md(source);
      expect({ url, out }).toEqual({ url, out: `<p>${escape(source)}</p>` });
    }
    expect(md("<javascript:alert(1)>")).toBe("<p>&lt;javascript:alert(1)&gt;</p>");
  });
  test("the renderer never uses HTML parsing", async () => {
    const source = await Bun.file(new URL("../../src/web/markdown.js", import.meta.url)).text();
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
  });
});
