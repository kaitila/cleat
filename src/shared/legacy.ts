// The names the app had before it was renamed holm (D0043), and the one-time move away from them.
// Only the files named legacy say "intuition": the rename script leaves them alone.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** The old name: the folders, the CLI, the login items and the storage keys were called this. */
export const OLD_NAME = "intuition";
/** The old shell's package name, which Electron named its user data folder after. */
export const OLD_SHELL_NAME = "intuition-shell";
/** The old launch agent's label (macOS). */
export const OLD_LAUNCH_AGENT = "dev.intuition.shell";
/** The old XDG autostart file's name (Linux). */
export const OLD_AUTOSTART = "intuition.desktop";
/** The old app id: Electron named the Windows login item's registry value after it. */
export const OLD_APP_ID = "intuition";
/** `SessionMeta.source` as the old runner stored it for its own sessions. */
export const OLD_SOURCE = "intuition";

const OLD_PREFIX = "INTUITION_";
const NEW_PREFIX = "HOLM_";

/**
 * The old environment variables, for one release: each INTUITION_X that is set becomes HOLM_X where
 * that is not set. Changes `env` in place, so child processes get the new names. Returns the names taken.
 */
export function adoptLegacyEnv(env: Record<string, string | undefined> = process.env): string[] {
  const taken: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(OLD_PREFIX) || value === undefined) continue;
    const name = NEW_PREFIX + key.slice(OLD_PREFIX.length);
    if (env[name] !== undefined) continue;
    env[name] = value;
    taken.push(name);
  }
  return taken;
}

/** A stored session's source: the old runner's "intuition" (and none, from before `source`) is the runner's own, "holm". */
export function storedSource<T extends string>(source: T | undefined, own: T): T {
  return source === undefined || source === (OLD_SOURCE as string) ? own : source;
}

function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    // Another file system (a separate disk or mount): copy, then remove.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves the folder `from` to `to`, once: the whole folder when `to` does not exist yet; when both do,
 * each entry of `from` that `to` lacks, and `from` goes when nothing is left in it. Nothing is
 * overwritten. Returns true when anything moved.
 */
export function moveFolder(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    move(from, to);
    return true;
  }
  let moved = false;
  for (const name of readdirSync(from)) {
    if (existsSync(join(to, name))) continue;
    move(join(from, name), join(to, name));
    moved = true;
  }
  try {
    if (readdirSync(from).length === 0) rmdirSync(from);
  } catch {
    // Left where it is: it is only an empty folder.
  }
  return moved;
}
