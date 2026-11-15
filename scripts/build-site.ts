// Builds the landing page: `bun scripts/build-site.ts [out]` writes dist-site/ (or `out`).
// It copies site/ (the page, its stylesheet and script, and the screenshots site-shots.ts made)
// and, beside them, the app's own design system: src/web/base.css (every token the page uses) and
// the fonts it names, with their licences. The page then asks no other host for anything, and
// its links are relative, so it works from any folder (/intuition/ on GitHub Pages).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const SITE = join(ROOT, "site");
export const WEB = join(ROOT, "src", "web");

/** Writes the site into `out`, emptied first. Returns the files written, relative to it. */
export function buildSite(out = join(ROOT, "dist-site")): string[] {
  const target = resolve(out);
  if (target === resolve(ROOT) || target === resolve(SITE) || target === resolve(WEB)) throw new Error(`refusing to build into ${target}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(SITE, target, { recursive: true });
  cpSync(join(WEB, "base.css"), join(target, "base.css"));
  cpSync(join(WEB, "fonts"), join(target, "fonts"), { recursive: true });
  if (!existsSync(join(target, "index.html"))) throw new Error("site/index.html is missing");
  return list(target);
}

function list(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])).sort();
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(ROOT, "dist-site");
  const files = buildSite(out);
  console.log(`built ${files.length} files into ${resolve(out)}`);
}
