// The motion system's springs as CSS linear() curves (docs/design.md, "Motion"). A spring here is
// a unit mass on a spring of `stiffness`, slowed by `damping`, let go at 0 and pulled to 1; its
// curve is where it is over time, sampled evenly, and its duration is when it has come to rest.
// base.css holds the results as tokens: `bun src/web/motion.js` prints them, to paste there, and
// test/web/motion.test.ts fails when the two differ. Pages don't load this file.

/** How close to 1, and for good, the spring must be to count as at rest: a 40px move is then within 0.2px. */
export const REST = 0.005;
/** Samples per curve: one about every 10ms, close enough that the polyline reads as the curve. */
export const SAMPLES = 40;

/**
 * The springs, by name: stiffness and damping with a mass of 1.
 * - gentle: near critical (under 1% overshoot); things that appear or slide without fuss.
 * - bouncy: a visible overshoot, about 11%; something that arrives (the snip's prompt box).
 * - snappy: critical in effect (under 0.2%); quick answers to a key or a click.
 */
export const SPRINGS = {
  gentle: { stiffness: 300, damping: 30 },
  bouncy: { stiffness: 700, damping: 30 },
  snappy: { stiffness: 900, damping: 54 },
};

/** Where the spring is at `t` seconds: 0 at the start, 1 at rest. Exact, for any damping. */
export function position({ stiffness, damping }, t) {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  // Overdamped: two decays.
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  return 1 - (r1 * Math.exp(r2 * t) - r2 * Math.exp(r1 * t)) / (r1 - r2);
}

/** The time in seconds after which the spring stays within REST of 1, to the millisecond. */
export function settleTime(spring, rest = REST) {
  const step = 0.001;
  let last = 0;
  // Ten seconds is far beyond any spring worth drawing.
  for (let t = 0; t <= 10; t += step) if (Math.abs(position(spring, t) - 1) > rest) last = t;
  return Math.round((last + step) * 1000) / 1000;
}

/**
 * A spring as a CSS easing: `linear(0, …, 1)` with SAMPLES evenly spaced points over its settle
 * time, each to three decimals, and that time in whole milliseconds (rounded up to ten).
 */
export function springCurve(spring, samples = SAMPLES) {
  const ms = Math.ceil((settleTime(spring) * 1000) / 10) * 10;
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const p = i === samples ? 1 : position(spring, (ms / 1000) * (i / samples));
    points.push(Number(p.toFixed(3)));
  }
  return { points, ms, css: `linear(${points.join(", ")})` };
}

/** The tokens base.css holds: `--ease-<name>` and `--dur-<name>` for each spring. */
export function springTokens(springs = SPRINGS) {
  const lines = [];
  for (const [name, spring] of Object.entries(springs)) {
    const { css, ms } = springCurve(spring);
    lines.push(`--ease-${name}: ${css};`, `--dur-${name}: ${ms}ms;`);
  }
  return lines;
}

if (import.meta.main) console.log(springTokens().map((l) => `  ${l}`).join("\n"));
