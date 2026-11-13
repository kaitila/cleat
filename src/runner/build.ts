// The build id: a hash of the code the runner serves, so `start` and `up` can tell a runner that runs
// older code (started before a pull) from one that runs the repo as it is now.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REPO = join(import.meta.dir, "..", "..");
/** What the runner process loads or serves: its own code, the contract, the pages, and the dependencies. */
const SOURCES = ["src/runner", "src/shared", "src/web", "package.json", "bun.lock"];
const LENGTH = 12;

function files(path: string): string[] {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) return [];
  if (s.isFile()) return [path];
  if (!s.isDirectory()) return [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => files(join(path, name)));
}

/**
 * A hash over the names and contents of the files in SOURCES. It changes whenever one of them does
 * (a pull, a checkout, an edit), and not when a file is only touched. `override` replaces it: the
 * tests' INTUITION_BUILD_ID, read in config.ts.
 */
export function buildId(override?: string | null, repo = REPO): string {
  if (override) return override;
  const hash = createHash("sha256");
  for (const source of SOURCES) {
    for (const file of files(join(repo, source))) {
      hash.update(relative(repo, file)).update("\0").update(readFileSync(file)).update("\0");
    }
  }
  return hash.digest("hex").slice(0, LENGTH);
}
