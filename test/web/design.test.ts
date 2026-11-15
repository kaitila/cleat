// The design system's rules that a reader can't see on a page (docs/design.md): raw values live
// only in base.css, the tokens meet their contrast, hairlines are one device pixel, and the fonts
// are the runner's own files with their licences.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testRunner } from "../runner/helpers";
import { contrast, grounds, over, parse, worst } from "./glass";

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
    if (/^border(?:-[a-z]+)*-radius$/.test(property!) && !/^(?:0|50%|inherit|var\(--radius(?:-[a-z]+)?\)(?: var\(--radius(?:-[a-z]+)?\)){0,3})$/.test(value)) why("a radius that is not a token");
    if (property === "box-shadow" && !/^(?:none|var\(--(?:shadow|glass-edge|snip-edge)\))$/.test(value)) why("a shadow that is not a token");
    if (/^(?:-webkit-)?(?:backdrop-)?filter$/.test(property!) && !/^(?:none|var\(--[a-z0-9-]+\))$/.test(value)) why("a filter that is not a token");
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
    expect(rawValues(".a { backdrop-filter: blur(20px); }")).toHaveLength(2);
    expect(rawValues(".a { border-radius: var(--radius-m) var(--radius-m) var(--radius-xs) var(--radius-m); box-shadow: var(--glass-edge); backdrop-filter: var(--frost); }")).toEqual([]);
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

describe("the tokens", () => {
  test("dark defines every colour that light does", () => {
    const darkOnly = tokens(base.indexOf("@media (prefers-color-scheme: dark)"));
    const colours = [...light].filter(([, value]) => /^(?:#|rgb)/.test(value)).map(([name]) => name);
    expect(colours.length).toBeGreaterThan(12);
    expect(colours.filter((name) => !darkOnly.has(name))).toEqual([]);
  });

  // Glass is translucent: each contrast is on the colour a reader sees, the token composited over
  // every ground it can sit on (test/web/glass.ts): the backdrop with its fields and its grain, the
  // frosted panel over that, the floating glass over a black, grey or white desktop.
  for (const [scheme, t] of [["light", light], ["dark", dark]] as const) {
    const g = grounds(t);
    const at = (fg: string, ground: string, least: number) => expect({ fg, ground, ok: worst(t, g, fg, ground) >= least }).toEqual({ fg, ground, ok: true });
    test(`${scheme}: text is at least 4.5:1 on every ground`, () => {
      for (const ground of Object.keys(g)) at("text", ground, 4.5);
    });
    test(`${scheme}: muted text is at least 4.5:1 on the backdrop, the glass, its wells and inputs, and 3:1 on a hovered or selected row`, () => {
      for (const ground of ["backdrop", "glass", "float", "surface", "sunken"]) at("muted", ground, 4.5);
      for (const ground of ["hover", "selected"]) at("muted", ground, 3);
    });
    test(`${scheme}: the accent, amber and red are readable as text, and the primary button's and the chip's labels`, () => {
      for (const c of ["accent", "warn", "danger"]) for (const ground of ["backdrop", "glass", "float", "surface", "sunken"]) at(c, ground, 4.5);
      expect(contrast(parse(t.get("--accent-text")!), parse(t.get("--accent")!))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parse(t.get("--ink-text")!), parse(t.get("--ink")!))).toBeGreaterThanOrEqual(4.5);
    });
    test(`${scheme}: the status dots are at least 3:1 on what they sit on`, () => {
      for (const c of ["running", "warn", "danger"]) for (const ground of ["backdrop", "glass", "float", "surface", "hover", "selected"]) at(c, ground, 3);
    });
    test(`${scheme}: a hairline is quiet: under 2:1 on the glass, but there`, () => {
      expect(worst(t, g, "line", "glass")).toBeGreaterThan(1.1);
      expect(Math.max(...g.glass!.map((c) => contrast(over(parse(t.get("--line")!), c), c)))).toBeLessThan(2);
    });
    test(`${scheme}: the glass is translucent, the floating glass denser, and the grain is light`, () => {
      expect(parse(t.get("--glass")!).a).toBeLessThan(0.7);
      expect(parse(t.get("--glass-float")!).a).toBeGreaterThan(parse(t.get("--glass")!).a);
      expect(parse(t.get("--glass-float")!).a).toBeLessThan(1);
      expect(Number(t.get("--grain-strength"))).toBeGreaterThan(0.1);
      expect(Number(t.get("--grain-strength"))).toBeLessThanOrEqual(0.34);
    });
  }

  test("the grain is the reference's: fractal noise near 0.85, two octaves, desaturated, an overlay; lighter in light", () => {
    const grain = decodeURIComponent(light.get("--grain")!);
    expect(grain).toContain("<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>");
    expect(grain).toContain("<feColorMatrix type='saturate' values='0'/>");
    expect(noComments(base)).toMatch(/body\.backdrop::after \{[^}]*background: var\(--grain\); opacity: var\(--grain-strength\); mix-blend-mode: overlay;/);
    expect(dark.get("--grain-strength")).toBe("0.34");
    expect(Number(light.get("--grain-strength"))).toBeLessThan(0.34);
    expect(light.get("--grain-dim")).toBe("0.28");
    expect(light.get("--frost")).toBe("blur(26px) saturate(180%)");
  });

  test("a hairline is 1px, and 0.5px from two device pixels per CSS pixel", () => {
    expect(light.get("--hairline")).toBe("1px");
    expect(noComments(base)).toMatch(/@media \(min-resolution: 2dppx\) \{\s*:root \{ --hairline: 0\.5px; \}\s*\}/);
  });

  test("the type scale is four sizes, and the radii run from a key hint to the pill", () => {
    expect([...light.keys()].filter((k) => k.startsWith("--text-")).map((k) => light.get(k))).toEqual(["11px", "12px", "13px", "16px"]);
    expect([...light.keys()].filter((k) => k.startsWith("--radius")).map((k) => `${k} ${light.get(k)}`)).toEqual(["--radius-xs 6px", "--radius-s 10px", "--radius-m 14px", "--radius 18px", "--radius-l 22px", "--radius-pill 999px"]);
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

  test("are four woff2 files under src/web/fonts, Geist and Geist Mono, each family with its licence beside it", () => {
    expect(urls.sort()).toEqual(["fonts/geist-latin-ext.woff2", "fonts/geist-latin.woff2", "fonts/geist-mono-latin-ext.woff2", "fonts/geist-mono-latin.woff2"]);
    for (const url of urls) expect(readFileSync(join(WEB, url)).subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(faces.filter((face) => face.includes("url(")).map((face) => /font-family:\s*"([^"]+)"/.exec(face)![1]).sort()).toEqual(["Geist Mono Variable", "Geist Mono Variable", "Geist Variable", "Geist Variable"]);
    expect(light.get("--font")).toMatch(/^"Geist Variable"/);
    expect(light.get("--mono")).toMatch(/^"Geist Mono Variable"/);
    for (const family of ["geist", "geist-mono"]) {
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
    for (const family of ["geist", "geist-mono"]) expect((await runner.get(`/assets/fonts/${family}-LICENSE.txt`)).status).toBe(200);
  });

  test("no file of the pages names another host", () => {
    for (const file of files) {
      // The grain's SVG names its namespace, which is an identifier and never fetched.
      const text = read(file).replaceAll("xmlns='http://www.w3.org/2000/svg'", "");
      expect({ file, elsewhere: text.match(/(?:https?:)?\/\/(?!127\.0\.0\.1|localhost|\$\{location\.host\})[a-z0-9.-]+\.[a-z]{2,}/gi)?.filter((u) => !/^\/\/\s/.test(u)) ?? [] }).toEqual({ file, elsewhere: [] });
    }
    for (const page of ["chat.html", "prompt.html"]) {
      for (const [, url] of read(page).matchAll(/(?:href|src)="([^"]+)"/g)) expect(url).toMatch(/^\/(?!\/)/);
    }
  });
});
