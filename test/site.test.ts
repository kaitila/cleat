// The landing page (site/, built by scripts/build-site.ts): it loads nothing from another host, its
// links work from any folder, every colour, length, font and spring is a token of the app's base.css,
// and it is one screen around a live notch, with no images and no glass (D0041).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { buildSite, SITE, WEB } from "../scripts/build-site";

const out = mkdtempSync(join(tmpdir(), "cleat-site-test-"));
const files = buildSite(out);
afterAll(() => rmSync(out, { recursive: true, force: true }));
const read = (file: string) => readFileSync(join(out, file), "utf8");
const html = read("index.html");
const css = read("site.css");
const js = read("site.js");
const base = readFileSync(join(WEB, "base.css"), "utf8");
const noComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

/** The repository: the one other place the page links to (links, not loads). */
const REPO = "https://github.com/kaitila/cleat";
/** bun's installer, named in the install line (D0045). */
/** The install line's script, on the site's own address (D0047, D0049). */
const INSTALL_SCRIPT = "https://cleat.kaitila.dev/install.sh";
/** The SVG namespace in base.css's grain: a name inside a data: URL, not a request. */
const SVG_NS = "http://www.w3.org/2000/svg";

describe("the build", () => {
  test("writes the page, its stylesheet and script, the app's base.css, fonts and mark, and no raster images", () => {
    for (const file of ["index.html", "site.css", "site.js", "base.css", "mark.svg", "fonts/geist-latin.woff2", "fonts/geist-mono-latin.woff2", "fonts/geist-LICENSE.txt"]) expect(files).toContain(file);
    expect(files.filter((f) => /\.(png|jpe?g|webp|gif)$/.test(f))).toEqual([]);
  });

  test("the mark is the app's own, its favicon, and beside the name in the text's colour, never a status dot (D0044)", () => {
    expect(read("mark.svg")).toBe(readFileSync(join(WEB, "mark.svg"), "utf8"));
    expect(existsSync(join(SITE, "mark.svg"))).toBe(false);
    expect(html).toContain('<link rel="icon" href="mark.svg" type="image/svg+xml">');
    expect(html).toMatch(/<h1 class="name"><svg class="mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="16.5" cy="10" r="4.5"\/><rect x="2" y="16.5" width="20" height="4" rx="2"\/><\/svg>/);
  });

  test("base.css is the app's own, unchanged: the tokens come from it at build time", () => {
    expect(read("base.css")).toBe(base);
    expect(existsSync(join(SITE, "base.css"))).toBe(false);
  });
});

describe("it loads nothing from outside its own folder", () => {
  const texts = files.filter((f) => /\.(html|css|js)$/.test(f)).map((f) => [f, read(f)] as const);

  test("no http URL in the HTML, CSS or JS other than links to the repository", () => {
    for (const [file, text] of texts) {
      const urls = [...text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'()<>]*/gi)].map((m) => m[0]);
      // bun's installer is text in the install line, to copy, not something the page loads.
      const foreign = urls.filter((u) => !u.startsWith(REPO) && u !== SVG_NS && !u.startsWith(`${SVG_NS}`) && u !== INSTALL_SCRIPT);
      expect({ file, foreign }).toEqual({ file, foreign: [] });
    }
  });

  test("the only absolute URLs are <a href> links to the repository, never a src, srcset or stylesheet", () => {
    const refs = [...html.matchAll(/\s(href|src|srcset)="([^"]*)"/g)].map((m) => ({ attr: m[1]!, url: m[2]! }));
    expect(refs.length).toBeGreaterThanOrEqual(5);
    for (const { attr, url } of refs) {
      if (/^[a-z]+:|^\/\//i.test(url)) {
        expect({ attr, url, ok: attr === "href" && url.startsWith(REPO) }).toEqual({ attr, url, ok: true });
      }
    }
  });

  test("every local reference is relative and is a file in the build, so the page works under /cleat/", () => {
    const local = [
      ...[...noComments(html).matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].map((m) => ["index.html", m[1]!] as const),
      ...files.filter((f) => f.endsWith(".css")).flatMap((f) => [...noComments(read(f)).matchAll(/url\("?([^")]+)"?\)/g)].map((m) => [f, m[1]!] as const)),
    ].filter(([, url]) => !/^[a-z]+:/i.test(url) && !url.startsWith("#"));
    expect(local.length).toBeGreaterThanOrEqual(4);
    for (const [from, url] of local) {
      expect({ url, rooted: url.startsWith("/") }).toEqual({ url, rooted: false });
      const path = url === "./" ? "index.html" : normalize(join(dirname(from), url.split(/[?#]/)[0]!));
      expect({ url, built: files.includes(path) }).toEqual({ url, built: true });
    }
  });

  test("no import, fetch or module from elsewhere in the script", () => {
    expect(/\bimport\s*\(|\bimport\s.+from\s|\bfetch\s*\(/.test(js)).toBe(false);
  });
});

// The same rule as the app's pages (test/web/design.test.ts): a page's stylesheet takes every colour,
// length, font size, weight, border, radius, shadow, filter and duration from a token. Larger type
// is a whole token scaled (calc(var(--text-l) * 3)).
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const COLOUR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-[a-z]+)*-color|outline-color|caret-color|fill|stroke|scrollbar-color)$/;
function rawValues(sheet: string): string[] {
  const found: string[] = [];
  const text = noComments(sheet);
  if (/@import|url\(/.test(text)) found.push("@import or url(): the stylesheet loads nothing");
  for (const [, property, raw] of text.replace(/@media[^{]*\{/g, "{").matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const value = raw!.trim();
    const why = (reason: string) => found.push(`${property}: ${value} (${reason})`);
    if (COLOUR.test(value)) why("a raw colour");
    if (/\d(?:px|pt|rem|em|cm|mm|in|vw|vh)\b/.test(value)) why("a raw length: use a token");
    if (COLOUR_PROPERTY.test(property!) && !/^(?:var\(--[a-z0-9-]+\)|transparent|inherit|none)$/.test(value)) why("a colour that is not a token");
    if (/^(?:border|outline)(?:-(?:top|right|bottom|left|block|inline))?$/.test(property!) && !/^(?:0|none|var\(--[a-z0-9-]+\) (?:solid|dashed) (?:var\(--[a-z0-9-]+\)|transparent))$/.test(value)) why("a border that is not `width-token style colour-token`");
    if (property === "font-size" && !/^(?:var\(--text-[a-z]+\)|calc\(var\(--text-[a-z]+\) \* [\d.]+\))$/.test(value)) why("a font size that is not a type token, or one scaled");
    if (property === "font" || property === "font-family") why("the page doesn't set fonts: base.css does");
    if (property === "font-weight" && !/^var\(--(?:regular|medium|semibold)\)$/.test(value)) why("a weight that is not a token");
    if (/^border(?:-[a-z]+)*-radius$/.test(property!) && !/^(?:0|50%|inherit|var\(--radius(?:-[a-z]+)?\)(?: var\(--radius(?:-[a-z]+)?\)){0,3})$/.test(value)) why("a radius that is not a token");
    if (property === "box-shadow" && !/^(?:none|var\(--(?:shadow|glass-edge)\))$/.test(value)) why("a shadow that is not a token");
    if (/^(?:-webkit-)?(?:backdrop-)?filter$/.test(property!) && !/^(?:none|var\(--[a-z0-9-]+\))$/.test(value)) why("a filter that is not a token");
    if (/^(?:transition|animation)(?:-duration|-delay)?$/.test(property!) && /\d(?:ms|s)\b/.test(value.replace(/var\(--[a-z0-9-]+\)/g, ""))) why("a duration that is not a token");
    if (/^(?:transition|animation)(?:-timing-function)?$/.test(property!) && /cubic-bezier|linear\(|\bease(?:-in|-out|-in-out)?\b|steps\(/.test(value.replace(/var\(--[a-z0-9-]+\)/g, ""))) why("a curve that is not a spring token");
  }
  return found;
}

describe("every colour, font and spring is a base.css token", () => {
  const defined = new Set([...base.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  test("the lint catches raw values", () => {
    expect(rawValues(".a { color: #fff; }").length).toBeGreaterThan(0);
    expect(rawValues(".a { font-size: 48px; }").length).toBeGreaterThan(0);
    expect(rawValues(".a { font-size: 3rem; }").length).toBeGreaterThan(0);
    expect(rawValues(".a { font-family: Inter; }").length).toBeGreaterThan(0);
    expect(rawValues(".a { transition: transform 300ms ease-out; }").length).toBeGreaterThan(0);
    expect(rawValues(".a { animation: x var(--dur-bouncy) cubic-bezier(0.2, 0, 0, 1); }").length).toBeGreaterThan(0);
    expect(rawValues(".a { background: url(https://example.com/x.png); }").length).toBeGreaterThan(0);
    expect(rawValues(".a { font-size: calc(var(--text-l) * 3); transition: --island-h var(--dur-bouncy) var(--ease-bouncy) calc(var(--lag) * 0.75); }")).toEqual([]);
  });

  test("site.css has no raw colour, length, font, weight, border, radius, shadow, filter, duration or curve", () => {
    expect(rawValues(css)).toEqual([]);
  });

  test("site.css uses only tokens that base.css defines (and the two the dock's clip registers)", () => {
    const own = new Set([...noComments(css).matchAll(/@property\s+(--[a-z0-9-]+)/g)].map((m) => m[1]));
    const used = [...noComments(css).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(50);
    expect(used.filter((token) => !defined.has(token) && !own.has(token))).toEqual([]);
    expect([...own].every((t) => defined.has(t))).toBe(true);
  });

  test("the springs and their durations are the app's: bouncy, soft and gentle, each with its own", () => {
    for (const spring of ["bouncy", "soft", "gentle"]) expect(css).toContain(`var(--dur-${spring}) var(--ease-${spring})`);
  });

  test("reduced motion leaves only fades: its rule names no keyframes but the fades", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block.length).toBeGreaterThan(40);
    const named = [...block.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((n) => n === "layer-fade" || n === "layer-out")).toBe(true);
    expect(css).toMatch(/@keyframes layer-fade \{ from \{ opacity: 0; filter: var\(--blur-in\); \} \}/);
    expect(css).toMatch(/@keyframes layer-out \{ to \{ opacity: 0; \} \}/);
  });

  test("the page styles nothing in its markup, and its script sets no colour or font", () => {
    expect(/<style|\sstyle\s*=/i.test(html)).toBe(false);
    expect(/["'`]#[0-9a-f]{3,8}["'`]|\b(?:rgba?|hsla?|oklch)\(|fontFamily|font-family/i.test(js)).toBe(false);
  });

  test("the page is one screen around the notch: the plain ground, no glass, the notch's black and the dock's dark tokens", () => {
    expect(html).toMatch(/<body>/);
    expect(html).not.toMatch(/\bbackdrop\b|class="[^"]*\bglass\b/);
    expect(html).toMatch(/<figure id="island" class="island dark"/);
    expect(css).toContain("background: var(--notch)");
    for (const layer of ["idle", "peek", "open", "chat"]) expect(html).toContain(`data-layer="${layer}"`);
    // Light only, whatever the visitor's system says.
    expect(html).toMatch(/<html lang="en" data-theme="light">/);
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toMatch(/<button[^>]*class="quiet small copy"/);
  });
});

describe("the install script (D0047)", () => {
  const script = read("install.sh");

  test("is built beside the page, so the line's address serves it", () => {
    expect(files).toContain("install.sh");
    expect(script).toBe(readFileSync(join(SITE, "install.sh"), "utf8"));
  });

  test("is POSIX sh that parses, and stops on the first error", () => {
    expect(script).toStartWith("#!/bin/sh\n");
    expect(script).toContain("set -eu");
    const parsed = Bun.spawnSync(["sh", "-n", join(SITE, "install.sh")]);
    expect({ code: parsed.exitCode, err: parsed.stderr.toString() }).toEqual({ code: 0, err: "" });
  });

  test("gets bun only when it is missing, installs cleat from GitHub, and runs setup on the terminal", () => {
    expect(script).toContain("if ! command -v bun >/dev/null 2>&1; then");
    expect(script).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(script).toContain("bun install -g github:kaitila/cleat");
    expect(script).toContain("cleat setup </dev/tty");
    expect(script).toContain("cleat setup --yes");
    // Nothing else is fetched or run: the one other URL in it is the line's own, in a comment.
    const urls = [...script.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
    expect([...new Set(urls)].sort()).toEqual(["https://bun.sh/install", INSTALL_SCRIPT]);
  });
});

describe("what it says", () => {
  test("the keys are the app's defaults, a Mac's in the markup and Ctrl+Alt for the others", () => {
    expect([...html.matchAll(/<kbd data-other="([^"]+)">([^<]+)<\/kbd>/g)].map((m) => `${m[2]}/${m[1]}`)).toEqual(["Cmd/Ctrl", "Shift/Alt", "Cmd/Ctrl", "Shift/Alt", "Cmd/Ctrl", "Shift/Alt"]);
    expect(js).toContain('querySelectorAll("kbd[data-other]")');
  });

  test("the install line is the README's, and Copy copies it", () => {
    // The README's line: the first line of its first sh block, under "Install". It needs only bun's installer (D0045).
    const readme = readFileSync(join(SITE, "..", "README.md"), "utf8");
    const line = /## Install[\s\S]*?```sh\n([^\n]+)\n/.exec(readme)?.[1];
    expect(line).toBe(`curl -fsSL ${INSTALL_SCRIPT} | sh`);
    expect(line).not.toContain("git clone");
    expect(html).toContain(`<code id="install-line" class="install-line">${line!.replace(/&/g, "&amp;")}</code>`);
    expect(js).toContain("navigator.clipboard.writeText(text)");
  });
});
