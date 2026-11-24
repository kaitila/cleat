// `holm link` and `unlink`: a symlink named holm, in a folder on the PATH, to src/cli.ts.
// bun runs a linked script from its real path, so the command finds the repo from any folder.
import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export const LINK_NAME = "holm";
/** The script the link points to: this checkout's src/cli.ts. */
export const CLI = join(import.meta.dir, "..", "cli.ts");

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/** The folder bun itself is in: on the PATH wherever `bun` can be typed. */
export function defaultDir(): string {
  return dirname(process.execPath);
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** What is at the link's place: nothing, our link, or something else, with words for it. */
function found(path: string): { kind: "nothing" } | { kind: "ours" } | { kind: "other"; what: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "nothing" };
  }
  if (!stat.isSymbolicLink()) return { kind: "other", what: stat.isDirectory() ? "a folder" : "a file that is not a link" };
  const to = resolve(dirname(path), readlinkSync(path));
  // Ours only when it ends at this checkout's script: a link to another checkout is someone else's.
  if (real(to) === real(CLI)) return { kind: "ours" };
  return { kind: "other", what: `a link to ${to}${existsSync(to) ? "" : " (which does not exist)"}` };
}

export function onPath(dir: string, env: Env = process.env): boolean {
  const want = real(dir) ?? resolve(dir);
  return (env.PATH ?? "").split(delimiter).some((p) => p !== "" && (real(p) ?? resolve(p)) === want);
}

/** Makes the link in `dir`. Returns the exit code: 1 when something that is not ours is in its place. */
export function link(dir = defaultDir(), env: Env = process.env, log: Log = console.log): number {
  const folder = resolve(dir);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    log(`${folder} is not a folder`);
    return 1;
  }
  const path = join(folder, LINK_NAME);
  const there = found(path);
  if (there.kind === "other") {
    log(`${path} is ${there.what}: not replaced. Remove it yourself, or give link another folder`);
    return 1;
  }
  if (there.kind === "ours") rmSync(path);
  symlinkSync(CLI, path);
  log(`${path} -> ${CLI}`);
  log(
    onPath(folder, env)
      ? `${folder} is on the PATH: type \`${LINK_NAME}\` in any folder`
      : `${folder} is not on the PATH: add it to the PATH, or run link with a folder that is on it`,
  );
  return 0;
}

/** Removes the link in `dir` if it is ours. Returns the exit code: 1 when something else is in its place. */
export function unlink(dir = defaultDir(), log: Log = console.log): number {
  const path = join(resolve(dir), LINK_NAME);
  const there = found(path);
  if (there.kind === "nothing") {
    log(`no link at ${path}`);
    return 0;
  }
  if (there.kind === "other") {
    log(`${path} is ${there.what}: not removed`);
    return 1;
  }
  rmSync(path);
  log(`removed ${path}`);
  return 0;
}
