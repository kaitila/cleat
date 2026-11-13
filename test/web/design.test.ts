// The design system's rules that a reader can't see on a page (docs/design.md): raw values live
// only in base.css, the tokens meet their contrast, hairlines are one device pixel, and the fonts
// are the runner's own files with their licences.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const read = (file: string) => readFileSync(join(WEB, file), "utf8");
const files = readdirSync(WEB).filter((f) => /\.(css|html|js)$/.test(f));
const base = read("base.css");
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const COLOUR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-[a-z]+)*-color|outline-color|caret-color|fill|stroke|scrollbar-color)$/;

/** What breaks the rule in a page's stylesheet, as "property: value (why)" lines. */
function rawValues(css: string): string[] {
  const found: string[] = [];
  const text = noComments(css);
  if (/@import|url\(/.test(text)) found.push("@import or url(): a page's stylesheet loads nothing");
  // Declarations only: the conditions of @media rules may name a width.
  for (const [, property, raw] of text.replace(/@media[^{]*\{/g, "{").matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const value = raw!.trim();
    const why = (reason: string) => found.push(`${property}: ${value} (${reason})`);
    if (COLOUR.test(value)) why("a raw colour");
    if (/\d(?:px|pt|rem|cm|mm|in)\b/.test(value)) why("a raw length: use a token");
    if (COLOUR_PROPERTY.test(property!) && !/^(?:var\(--[a-z0-9-]+\)|transparent|inherit|none)$/.test(value)) why("a colour that is not a token");
    if (/^(?:border|outline)(?:-(?:top|right|bottom|left|block|inline))?$/.test(property!) && !/^(?:0|none|var\(--[a-z0-9-]+\) (?:solid|dashed) (?:var\(--[a-z0-9-]+\)|transparent))$/.test(value)) {
      why("a border that is not `width-token style colour-token`");
    }
    if (property === "font-size" && !/^var\(--text-[a-z]+\)$/.test(value)) why("a font size that is not on the scale");
    if (property === "font" || property === "font-family") why("pages don't set fonts");
    if (property === "font-weight" && !/^var\(--(?:regular|medium|semibold)\)$/.test(value)) why("a weight that is not a token");
    if (/^border(?:-[a-z]+)*-radius$/.test(property!) && !/^(?:0|50%|inherit|var\(--radius(?:-s)?\))$/.test(value)) why("a radius that is not a token");
    if (property === "box-shadow" && !/^(?:none|var\(--(?:shadow|glow)\))$/.test(value)) why("a shadow that is not a token");
    if (/^(?:transition|animation)(?:-duration)?$/.test(property!) && /\d(?:ms|s)\b/.test(value.replace(/var\(--[a-z0-9-]+\)/g, ""))) why("a duration that is not the token");
  }
  return found;
}

describe("raw values live only in base.css", () => {
  const defined = new Set([...base.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  test("the lint catches a raw colour, a px font size, a raw border, radius and shadow", () => {
    expect(rawValues(".a { color: #fff; }")).toHaveLength(2);
    expect(rawValues(".a { color: red; }")).toHaveLength(1);
    expect(rawValues(".a { background: rgb(0 0 0 / 0.1); }")).toHaveLength(2);
    expect(rawValues(".a { font-size: 13px; }")).toHaveLength(2);
    expect(rawValues(".a { font-size: 1.2em; }")).toHaveLength(1);
    expect(rawValues(".a { border: 1px solid var(--line); }")).toHaveLength(2);
    expect(rawValues(".a { border-top: var(--hairline) solid grey; }")).toHaveLength(1);
    expect(rawValues(".a { border-radius: 6px; }")).toHaveLength(2);
    expect(rawValues(".a { box-shadow: 0 1px 2px var(--line); }")).toHaveLength(2);
    expect(rawValues(".a { padding: 4px; }")).toHaveLength(1);
    expect(rawValues(".a { transition: color 200ms; }")).toHaveLength(1);
    expect(rawValues("@media (max-width: 700px) { .a { border-bottom: var(--hairline) solid var(--line); border-radius: var(--radius-s); color: var(--muted); font-size: var(--text-s); padding: 0 var(--space-2); } }")).toEqual([]);
  });

  for (const file of files.filter((f) => f.endsWith(".css") && f !== "base.css")) {
    test(`${file} has no raw colour, length, font size, border width, radius or shadow`, () => {
      expect(rawValues(read(file))).toEqual([]);
    });
    test(`${file} uses only tokens that base.css defines`, () => {
      const used = [...noComments(read(file)).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((token) => !defined.has(token))).toEqual([]);
    });
  }

  test("no page styles itself in its markup or from its script", () => {
    for (const file of files.filter((f) => f.endsWith(".html"))) expect({ file, styled: /<style|\sstyle\s*=/i.test(read(file)) }).toEqual({ file, styled: false });
    for (const file of files.filter((f) => f.endsWith(".js"))) {
      const js = read(file);
      expect({ file, colour: /["'`]#[0-9a-f]{3,8}["'`]|\b(?:rgba?|hsla?|oklch)\(/i.test(js) }).toEqual({ file, colour: false });
      expect({ file, fontSize: /fontSize|font-size|\.style\.(?:color|background|border|font)/.test(js) }).toEqual({ file, fontSize: false });
    }
  });

  test("every token base.css uses is one it defines", () => {
    const used = [...noComments(base).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.filter((token) => !defined.has(token))).toEqual([]);
  });
});

// ---------- the tokens ----------

/** The custom properties of the first `:root { }` after `from`. */
function tokens(from: number): Map<string, string> {
  const start = base.indexOf(":root", from);
  const block = base.slice(base.indexOf("{", start) + 1, base.indexOf("}", start));
  return new Map([...noComments(block).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = tokens(0);
const dark = new Map([...light, ...tokens(base.indexOf("@media (prefers-color-scheme: dark)"))]);

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the tokens", () => {
  test("dark defines every colour that light does", () => {
    const darkOnly = tokens(base.indexOf("@media (prefers-color-scheme: dark)"));
    const colours = [...light].filter(([, value]) => /^(?:#|rgb)/.test(value)).map(([name]) => name);
    expect(colours.length).toBeGreaterThan(12);
    expect(colours.filter((name) => !darkOnly.has(name))).toEqual([]);
  });

  for (const [scheme, t] of [["light", light], ["dark", dark]] as const) {
    const on = (fg: string, bg: string) => contrast(t.get(`--${fg}`)!, t.get(`--${bg}`)!);
    const surfaces = ["sunken", "bg", "surface", "hover", "selected"];
    test(`${scheme}: text is at least 4.5:1 on every surface`, () => {
      for (const s of surfaces) expect({ s, ok: on("text", s) >= 4.5 }).toEqual({ s, ok: true });
    });
    test(`${scheme}: muted text is at least 4.5:1 on the three surfaces, and 3:1 on a hovered or selected row`, () => {
      for (const s of ["sunken", "bg", "surface"]) expect({ s, ok: on("muted", s) >= 4.5 }).toEqual({ s, ok: true });
      for (const s of ["hover", "selected"]) expect({ s, ok: on("muted", s) >= 3 }).toEqual({ s, ok: true });
    });
    test(`${scheme}: the accent, amber and red are readable as text, and the primary button's label on the accent`, () => {
      for (const c of ["accent", "warn", "danger"]) for (const s of ["sunken", "bg", "surface"]) expect({ c, s, ok: on(c, s) >= 4.5 }).toEqual({ c, s, ok: true });
      expect(on("accent-text", "accent")).toBeGreaterThanOrEqual(4.5);
    });
    test(`${scheme}: the status dots are at least 3:1 on what they sit on`, () => {
      for (const c of ["running", "warn", "danger"]) for (const s of surfaces) expect({ c, s, ok: on(c, s) >= 3 }).toEqual({ c, s, ok: true });
    });
    test(`${scheme}: a hairline is quiet: under 2:1 on the page`, () => {
      expect(on("line", "bg")).toBeLessThan(2);
      expect(on("line", "bg")).toBeGreaterThan(1.15);
    });
  }

  test("a hairline is 1px, and 0.5px from two device pixels per CSS pixel", () => {
    expect(light.get("--hairline")).toBe("1px");
    expect(noComments(base)).toMatch(/@media \(min-resolution: 2dppx\) \{\s*:root \{ --hairline: 0\.5px; \}\s*\}/);
  });

  test("the type scale is four sizes, and there are two radii", () => {
    expect([...light.keys()].filter((k) => k.startsWith("--text-")).map((k) => light.get(k))).toEqual(["11px", "12px", "13px", "16px"]);
    expect([...light.keys()].filter((k) => k.startsWith("--radius"))).toEqual(["--radius", "--radius-s"]);
  });

  test("motion is 150ms and stops for prefers-reduced-motion", () => {
    expect(light.get("--motion")).toBe("150ms");
    expect(noComments(base)).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none !important; transition: none !important;/);
  });
});

// ---------- the fonts ----------

describe("the fonts", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());
  const faces = [...noComments(base).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  const urls = faces.flatMap((face) => [...face.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!));

  test("are four woff2 files under src/web/fonts, each family with its licence beside it", () => {
    expect(urls.sort()).toEqual(["fonts/inter-latin-ext.woff2", "fonts/inter-latin.woff2", "fonts/jetbrains-mono-latin-ext.woff2", "fonts/jetbrains-mono-latin.woff2"]);
    for (const url of urls) expect(readFileSync(join(WEB, url)).subarray(0, 4).toString("latin1")).toBe("wOF2");
    for (const family of ["inter", "jetbrains-mono"]) {
      const licence = join(WEB, "fonts", `${family}-LICENSE.txt`);
      expect(existsSync(licence)).toBe(true);
      expect(readFileSync(licence, "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
    expect(readdirSync(join(WEB, "fonts")).filter((f) => f.endsWith(".woff2")).map((f) => `fonts/${f}`).sort()).toEqual(urls);
  });

  test("every face that loads a file swaps, and is variable", () => {
    const loaded = faces.filter((face) => face.includes("url("));
    expect(loaded).toHaveLength(4);
    for (const face of loaded) {
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/font-weight:\s*100 [89]00/);
    }
  });

  test("the runner serves them and their licences", async () => {
    for (const url of urls) {
      const res = await runner.get(`/assets/${url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("font/woff2");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    }
    for (const family of ["inter", "jetbrains-mono"]) expect((await runner.get(`/assets/fonts/${family}-LICENSE.txt`)).status).toBe(200);
  });

  test("no file of the pages names another host", () => {
    for (const file of files) {
      const text = read(file);
      expect({ file, elsewhere: text.match(/(?:https?:)?\/\/(?!127\.0\.0\.1|localhost|\$\{location\.host\})[a-z0-9.-]+\.[a-z]{2,}/gi)?.filter((u) => !/^\/\/\s/.test(u)) ?? [] }).toEqual({ file, elsewhere: [] });
    }
    for (const page of ["chat.html", "prompt.html"]) {
      for (const [, url] of read(page).matchAll(/(?:href|src)="([^"]+)"/g)) expect(url).toMatch(/^\/(?!\/)/);
    }
  });
});
