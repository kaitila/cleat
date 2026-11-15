// The themes (docs/design.md, "Themes"): every page that follows the setting loads theme.js first,
// as a plain script before its stylesheets, and base.css's [data-theme] sets are the schemes' own
// designed values, so the contrasts design.test.ts checks hold for a forced theme too.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const read = (file: string) => readFileSync(join(WEB, file), "utf8");
const base = read("base.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the block that `selector {` opens. */
function block(selector: string): Map<string, string> {
  const at = base.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} in base.css`);
  const body = base.slice(base.indexOf("{", at) + 1, base.indexOf("}", at));
  return new Map([...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const colours = (m: Map<string, string>) => new Map([...m].filter(([k, v]) => k.startsWith("--") && /^(?:#|rgb|0 0 0)/.test(v)));

describe("every page that follows the theme loads theme.js first", () => {
  // chat.html and dock.html follow in T-0042.
  for (const page of ["prompt.html", "snip.html", "settings.html"]) {
    test(page, () => {
      const head = read(page).split("</head>")[0]!;
      const first = /<(script|link)\b[^>]*>/.exec(head)![0];
      expect(first).toBe('<script src="/assets/theme.js">');
      // A classic script, before any stylesheet: it sets data-theme before the first paint.
      expect(head.indexOf("theme.js")).toBeLessThan(head.indexOf('rel="stylesheet"'));
    });
  }

  test("theme.js is a plain script: no import or export, so it runs before the page is drawn", () => {
    expect(read("theme.js")).not.toMatch(/^\s*(?:import|export)\b/m);
  });
});

describe("the forced themes", () => {
  const light = colours(block(":root"));
  const darkScheme = colours(block("@media (prefers-color-scheme: dark) {\n  :root"));
  const forcedLight = block(':root[data-theme="light"], .light');
  const forcedDark = block(':root[data-theme="dark"]');

  test("light is the light scheme's values, and says it is light", () => {
    expect(light.size).toBeGreaterThan(12);
    for (const [k, v] of light) expect({ k, v: forcedLight.get(k) }).toEqual({ k, v });
    expect(forcedLight.get("color-scheme")).toBe("light");
  });

  test("dark is the dark scheme's values, and says it is dark", () => {
    for (const [k, v] of darkScheme) expect({ k, v: forcedDark.get(k) }).toEqual({ k, v });
    expect([...colours(forcedDark).keys()].sort()).toEqual([...darkScheme.keys()].sort());
    expect(forcedDark.get("color-scheme")).toBe("dark");
  });

  test("both set every colour the light scheme sets", () => {
    for (const k of light.keys()) {
      expect({ k, light: forcedLight.has(k), dark: forcedDark.has(k) }).toEqual({ k, light: true, dark: true });
    }
  });

  /** WCAG contrast of two #rrggbb colours. */
  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const [r, g, bl] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }
  for (const [name, t] of [["light", forcedLight], ["dark", forcedDark]] as const) {
    test(`${name}: text, muted text, the accent and the status colours meet their contrast`, () => {
      const on = (fg: string, bg: string) => contrast(t.get(`--${fg}`)!, t.get(`--${bg}`)!);
      for (const s of ["sunken", "bg", "surface"]) {
        for (const c of ["text", "muted", "accent", "warn", "danger"]) expect({ c, s, ok: on(c, s) >= 4.5 }).toEqual({ c, s, ok: true });
      }
      for (const s of ["hover", "selected"]) expect({ s, ok: on("text", s) >= 4.5 && on("muted", s) >= 3 }).toEqual({ s, ok: true });
      expect(on("accent-text", "accent")).toBeGreaterThanOrEqual(4.5);
    });
  }
});
