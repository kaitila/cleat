// Deploys the landing page to Cloudflare, at https://cleat.kaitila.dev/ (D0049):
//   bun scripts/deploy-site.ts
// It builds the site (scripts/build-site.ts) into a temporary folder, writes a Workers config there
// (static assets only, no code, on the custom domain; Cloudflare makes its DNS record and
// certificate) and runs `bunx wrangler deploy` in it. wrangler is fetched by bunx, not a dependency
// of the repo, and it needs `bunx wrangler login` once on the machine. GitHub Pages keeps serving
// the same site at https://kaitila.github.io/cleat/ from its workflow (pages.yml).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "./build-site";

/** The Worker's name and the domain it serves, in the owner's Cloudflare account (zone kaitila.dev). */
export const WORKER = "cleat-site";
export const DOMAIN = "cleat.kaitila.dev";

/** The Workers config: the built site as static assets on the custom domain, and no workers.dev address. */
export function workerConfig(assets: string): string {
  return JSON.stringify({ name: WORKER, compatibility_date: "2026-11-23", workers_dev: false, assets: { directory: assets }, routes: [{ pattern: DOMAIN, custom_domain: true }] }, null, 2);
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "cleat-deploy-"));
  try {
    const files = buildSite(join(dir, "site"));
    writeFileSync(join(dir, "wrangler.jsonc"), workerConfig("./site"));
    console.log(`built ${files.length} files; deploying to https://${DOMAIN}/`);
    const run = Bun.spawnSync(["bunx", "wrangler", "deploy"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    process.exitCode = run.exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
