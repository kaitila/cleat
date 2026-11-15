// The landing page (site/, built by scripts/build-site.ts): it loads nothing from another host, its
// links work from any folder, every colour, length, font and spring is a token of the app's base.css,
// and its images are the screenshots scripts/site-shots.ts made, small enough to serve.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { buildSite, SITE, WEB } from "../scripts/build-site";

const out = mkdtempSync(join(tmpdir(), "intuition-site-test-"));
const files = buildSite(out);
afterAll(() => rmSync(out, { recursive: true, force: true }));
const read = (file: string) => readFileSync(join(out, file), "utf8");
const html = read("index.html");
const css = read("site.css");
const js = read("site.js");
const base = readFileSync(join(WEB, "base.css"), "utf8");
const noComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

/** The repository: the one other place the page links to (links, not loads). */
const REPO = "https://github.com/kaitila/intuition";
/** The SVG namespace in base.css's grain: a name inside a data: URL, not a request. */
const SVG_NS = "http://www.w3.org/2000/svg";

describe("the build", () => {
  test("writes the page, its stylesheet and script, the app's base.css and fonts, and the screenshots", () => {
    for (const file of ["index.html", "site.css", "site.js", "base.css", "fonts/geist-latin.woff2", "fonts/geist-mono-latin.woff2", "fonts/geist-LICENSE.txt"]) expect(files).toContain(file);
    expect(files.filter((f) => f.startsWith("shots/") && f.endsWith(".png")).length).toBeGreaterThanOrEqual(3);
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
      const foreign = urls.filter((u) => !u.startsWith(REPO) && u !== SVG_NS && !u.startsWith(`${SVG_NS}`));
      expect({ file, foreign }).toEqual({ file, foreign: [] });
    }
  });

  test("the only absolute URLs are <a href> links to the repository, never a src, srcset or stylesheet", () => {
    const refs = [...html.matchAll(/\s(href|src|srcset)="([^"]*)"/g)].map((m) => ({ attr: m[1]!, url: m[2]! }));
    expect(refs.length).toBeGreaterThan(5);
    for (const { attr, url } of refs) {
      if (/^[a-z]+:|^\/\//i.test(url)) {
        expect({ attr, url, ok: attr === "href" && url.startsWith(REPO) }).toEqual({ attr, url, ok: true });
      }
    }
  });

  test("every local reference is relative and is a file in the build, so the page works under /intuition/", () => {
    const local = [
      ...[...noComments(html).matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].map((m) => ["index.html", m[1]!] as const),
      ...files.filter((f) => f.endsWith(".css")).flatMap((f) => [...noComments(read(f)).matchAll(/url\("?([^")]+)"?\)/g)].map((m) => [f, m[1]!] as const)),
    ].filter(([, url]) => !/^[a-z]+:/i.test(url) && !url.startsWith("#"));
    expect(local.length).toBeGreaterThan(5);
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

  test("the page is Glass: the backdrop on <body>, frosted glass panels, pill buttons", () => {
    expect(html).toMatch(/<body class="backdrop">/);
    expect((html.match(/class="[^"]*\bglass\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/<button[^>]*class="primary copy"/);
  });
});

describe("the screenshots", () => {
  const shots = readdirSync(join(SITE, "shots")).filter((f) => f.endsWith(".png"));
  const referenced = [...html.matchAll(/(?:src|srcset)="(shots\/[^"]+)"/g)].map((m) => m[1]!);
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "site-shots.ts"), "utf8");

  test("every image on the page is one of site/shots, and every one of those is on the page", () => {
    expect(referenced.length).toBeGreaterThanOrEqual(5);
    expect([...new Set(referenced)].sort()).toEqual(shots.map((f) => `shots/${f}`).sort());
  });

  test("each is a PNG under 300 KB", () => {
    for (const file of shots) {
      const bytes = readFileSync(join(SITE, "shots", file));
      expect({ file, png: bytes.subarray(1, 4).toString("latin1") }).toEqual({ file, png: "PNG" });
      expect({ file, small: statSync(join(SITE, "shots", file)).size < 300 * 1024 }).toEqual({ file, small: true });
    }
  });

  test("each is one site-shots.ts writes, from the fake-agent runner with made-up workspaces", () => {
    expect(script).toContain('INTUITION_FAKE_AGENT: "1"');
    expect(script).toContain("mkdtempSync(join(tmpdir()");
    for (const file of shots) {
      const name = file.replace(/\.png$/, "").replace(/-(light|dark)$/, "-${scheme}");
      expect({ file, made: script.includes(`\`${name}\``) || script.includes(`"${name}"`) }).toEqual({ file, made: true });
    }
  });

  test("the images have their size and alt text, and load lazily below the fold", () => {
    for (const [img] of html.matchAll(/<img [^>]+>/g)) {
      expect(img).toMatch(/\swidth="\d+"/);
      expect(img).toMatch(/\sheight="\d+"/);
      expect(img).toMatch(/\salt="[^"]{20,}"/);
      expect(img).toMatch(/loading="lazy"/);
    }
  });
});
