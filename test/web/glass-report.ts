// Prints the worst contrast of each colour token on each ground, per scheme: `bun test/web/glass-report.ts`.
// For tuning the palette in base.css; design.test.ts holds the limits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grounds, worst } from "./glass";

const base = readFileSync(join(import.meta.dir, "..", "..", "src", "web", "base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const block = (from: number) => {
  const start = base.indexOf(":root", from);
  const body = base.slice(base.indexOf("{", start) + 1, base.indexOf("}", start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
};
const light = block(0);
const dark = new Map([...light, ...block(base.indexOf("@media (prefers-color-scheme: dark)"))]);
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  const g = grounds(t);
  console.log(`\n${name}`.padEnd(10) + Object.keys(g).map((k) => k.padStart(9)).join(""));
  for (const fg of ["text", "muted", "accent", "warn", "danger", "running", "line"]) console.log(fg.padEnd(9) + Object.keys(g).map((k) => worst(t, g, fg, k).toFixed(2).padStart(9)).join(""));
}
