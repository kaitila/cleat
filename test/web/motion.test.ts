// The springs (src/web/motion.js) and the motion tokens base.css holds from them (docs/design.md,
// "Motion"): the maths, that the pasted tokens are what the module makes, and that the snip and the
// pop-up move only on those tokens and turn them into plain fades for prefers-reduced-motion.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { position, REST, SAMPLES, settleTime, springCurve, SPRINGS, springTokens } from "../../src/web/motion.js";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const read = (file: string) => readFileSync(join(WEB, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const base = read("base.css");

/** The largest value the spring reaches in its first second. */
function peak(spring: { stiffness: number; damping: number }): number {
  let max = 0;
  for (let t = 0; t <= 1; t += 0.0005) max = Math.max(max, position(spring, t));
  return max;
}

describe("a spring", () => {
  test("starts at 0 at rest and ends at 1", () => {
    for (const spring of Object.values(SPRINGS)) {
      expect(position(spring, 0)).toBeCloseTo(0, 10);
      expect(position(spring, 5)).toBeCloseTo(1, 6);
    }
  });

  test("starts still: it leaves 0 slowly, with no jump", () => {
    for (const spring of Object.values(SPRINGS)) expect(position(spring, 0.001)).toBeLessThan(0.001);
  });

  test("critical and overdamped springs are continuous with the underdamped one", () => {
    const at = (damping: number) => position({ stiffness: 400, damping }, 0.05);
    expect(at(40)).toBeCloseTo(at(39.999), 4);
    expect(at(40)).toBeCloseTo(at(40.001), 4);
    // Overdamped: never past 1.
    expect(peak({ stiffness: 400, damping: 80 })).toBeLessThanOrEqual(1);
  });

  test("the bouncy one overshoots visibly, the gentle one barely, the snappy one hardly at all", () => {
    expect(peak(SPRINGS.bouncy)).toBeGreaterThan(1.08);
    expect(peak(SPRINGS.bouncy)).toBeLessThan(1.15);
    expect(peak(SPRINGS.gentle)).toBeLessThan(1.01);
    expect(peak(SPRINGS.snappy)).toBeLessThan(1.002);
  });

  test("settles, and stays settled, within REST after its settle time", () => {
    for (const spring of Object.values(SPRINGS)) {
      const t = settleTime(spring);
      for (let s = t; s < t + 1; s += 0.001) expect(Math.abs(position(spring, s) - 1)).toBeLessThanOrEqual(REST);
      expect(Math.abs(position(spring, t - 0.002) - 1)).toBeGreaterThan(REST);
    }
  });

  test("the bouncy spring, for the snip's prompt box, settles in about 350ms; snappy is the quickest", () => {
    expect(springCurve(SPRINGS.bouncy).ms).toBeGreaterThanOrEqual(300);
    expect(springCurve(SPRINGS.bouncy).ms).toBeLessThanOrEqual(400);
    expect(springCurve(SPRINGS.snappy).ms).toBeLessThan(springCurve(SPRINGS.gentle).ms);
    expect(springCurve(SPRINGS.snappy).ms).toBeLessThan(springCurve(SPRINGS.bouncy).ms);
  });
});

describe("its curve", () => {
  test("is a CSS linear() from 0 to 1 with evenly spaced points to three decimals", () => {
    for (const spring of Object.values(SPRINGS)) {
      const { points, css, ms } = springCurve(spring);
      expect(points).toHaveLength(SAMPLES + 1);
      expect(points[0]).toBe(0);
      expect(points.at(-1)).toBe(1);
      for (const p of points) expect(Number(p.toFixed(3))).toBe(p);
      expect(css).toBe(`linear(${points.join(", ")})`);
      expect(ms % 10).toBe(0);
      // Each point is where the spring is at its share of the duration.
      expect(points[SAMPLES / 2]).toBeCloseTo(position(spring, ms / 2000), 3);
    }
  });

  test("the bouncy curve passes 1 and comes back", () => {
    const { points } = springCurve(SPRINGS.bouncy);
    const top = points.indexOf(Math.max(...points));
    expect(points[top]).toBeGreaterThan(1.08);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(SAMPLES / 2);
  });

  test("a softer spring settles later", () => {
    expect(settleTime({ stiffness: 200, damping: 12 })).toBeGreaterThan(settleTime({ stiffness: 200, damping: 28 }));
  });
});

describe("the motion tokens", () => {
  const root = base.slice(base.indexOf(":root"), base.indexOf("}", base.indexOf(":root")));

  test("base.css holds exactly the curves and durations motion.js makes (paste `bun src/web/motion.js`)", () => {
    for (const line of springTokens()) expect(root).toContain(line);
    expect(Object.keys(SPRINGS).sort()).toEqual(["bouncy", "gentle", "snappy"]);
  });

  test("there are fade and travel tokens to go with them", () => {
    for (const token of ["--dur-fade", "--dur-out", "--rise", "--pop"]) expect(root).toMatch(new RegExp(`${token}:`));
  });

  test("prefers-reduced-motion makes them plain fades: no travel, no pop, linear, short", () => {
    const reduced = [...base.matchAll(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/g)].map((m) => m[1]!).join("");
    expect(reduced).toMatch(/--rise:\s*0px;/);
    expect(reduced).toMatch(/--pop:\s*1;/);
    for (const name of Object.keys(SPRINGS)) {
      expect(reduced).toMatch(new RegExp(`--ease-${name}:\\s*linear;`));
      expect(reduced).toMatch(new RegExp(`--dur-${name}:\\s*var\\(--dur-fade\\);`));
    }
  });

  for (const file of ["snip.css", "prompt.css"]) {
    const css = read(file);
    const motion = [...css.matchAll(/(?:^|[;{\s])((?:animation|transition)(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g)].map((m) => ({ property: m[1]!, value: m[2]!.trim() }));

    test(`${file} moves only on the motion tokens`, () => {
      expect(motion.length).toBeGreaterThan(2);
      for (const { property, value } of motion) {
        // No easing of its own: a spring token, the fade's --ease, or linear.
        expect({ property, value, ok: !/cubic-bezier|steps\(|\bease(?:-in|-out|-in-out)?\b(?![-)])|linear\(/.test(value) }).toEqual({ property, value, ok: true });
        if (/^(?:animation|transition)$/.test(property) && value !== "none") expect({ value, ok: /var\(--(?:dur|motion)/.test(value) }).toEqual({ value, ok: true });
      }
      expect(css).toMatch(/var\(--ease-(?:gentle|bouncy|snappy)\)/);
    });

    // Colour changes on hover keep their 150ms --motion fade (docs/design.md); what moves is these two.
    test(`${file} animates transform and opacity only, and moves only on a spring`, () => {
      for (const [, body] of css.matchAll(/@keyframes [a-z-]+ \{([^@]*?)\}\s*\}/g)) {
        for (const [, property] of body!.matchAll(/([a-z-]+)\s*:/g)) expect(["transform", "opacity"]).toContain(property!);
      }
      for (const { property, value } of motion.filter((m) => m.property.startsWith("transition") && /var\(--(?:dur|ease)-/.test(m.value))) {
        for (const what of value.split(",").map((part) => part.trim().split(/\s+/)[0]!)) expect({ property, what, ok: ["transform", "opacity"].includes(what) || /^var\(/.test(what) }).toEqual({ property, what, ok: true });
      }
    });

    test(`${file} keeps only plain fades for prefers-reduced-motion`, () => {
      const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
      expect(block.length).toBeGreaterThan(0);
      const names = [...block.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]!);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^(?:fade-in|fade-out|dim-in)$/);
      expect(block).not.toMatch(/var\(--ease-/);
    });
  }
});
