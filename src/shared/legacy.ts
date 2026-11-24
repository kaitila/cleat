// The names the app had before it was called cleat, and the one-time move away from them: intuition
// until D0043, then holm until D0048. Only the files named legacy say the old names: the rename script
// leaves them alone.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** What an old name called each thing that is named after the app. */
export interface OldName {
  /** The folders, the CLI's command link and the storage keys' prefix were called this. */
  name: string;
  /** The shell's package name, which Electron named its user data folder after. */
  shell: string;
  /** The launch agent's label (macOS). */
  launchAgent: string;
  /** The XDG autostart file's name (Linux). */
  autostart: string;
  /** The app id: Electron named the Windows login item's registry value after it. */
  appId: string;
  /** `SessionMeta.source` as that runner stored it for its own sessions. */
  source: string;
  /** The environment variables' prefix. */
  envPrefix: string;
}

function oldName(name: string): OldName {
  return { name, shell: `${name}-shell`, launchAgent: `dev.${name}.shell`, autostart: `${name}.desktop`, appId: name, source: name, envPrefix: `${name.toUpperCase()}_` };
}

/**
 * The old names, newest first: holm (D0043 to D0048), then intuition (until D0043). Each moves straight
 * to cleat. Where both left the same thing, the newer one's moves first and is the one kept.
 */
export const OLD_NAMES: readonly OldName[] = [oldName("holm"), oldName("intuition")];

const NEW_PREFIX = "CLEAT_";

/**
 * The old environment variables, for one release: each HOLM_X or INTUITION_X that is set becomes
 * CLEAT_X where that is not set (HOLM_X first). Changes `env` in place, so child processes get the new
 * names. Returns the names taken.
 */
export function adoptLegacyEnv(env: Record<string, string | undefined> = process.env): string[] {
  const taken: string[] = [];
  for (const { envPrefix } of OLD_NAMES) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(envPrefix) || value === undefined) continue;
      const name = NEW_PREFIX + key.slice(envPrefix.length);
      if (env[name] !== undefined) continue;
      env[name] = value;
      taken.push(name);
    }
  }
  return taken;
}

/** A stored session's source: an old runner's "holm" or "intuition" (and none, from before `source`) is the runner's own, "cleat". */
export function storedSource<T extends string>(source: T | undefined, own: T): T {
  return source === undefined || OLD_NAMES.some((o) => o.source === (source as string)) ? own : source;
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
