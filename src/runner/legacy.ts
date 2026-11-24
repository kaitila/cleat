// The one-time move of the config and data folders from their old names (D0043, D0048):
// ~/.config/holm and ~/.config/intuition to ~/.config/cleat, and ~/.local/share/holm and
// ~/.local/share/intuition to ~/.local/share/cleat. Only the default folders move: CLEAT_CONFIG and
// CLEAT_DATA_DIR (or the old names, adopted by adoptLegacyEnv) name folders the person chose, which are
// left where they are.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { moveFolder, OLD_NAMES } from "../shared/legacy";

type Env = Record<string, string | undefined>;

export interface RunnerFolders {
  /** The folder config.json is in. */
  config: string;
  /** The data folder: sessions, events, the runner's pid and log. */
  data: string;
}

function foldersFor(home: string, name: string): RunnerFolders {
  return { config: join(home, ".config", name), data: join(home, ".local", "share", name) };
}

/** The default folders under the new name, and under each old one, newest first. */
export function defaultFolders(home: string = homedir()): { now: RunnerFolders; old: (RunnerFolders & { name: string })[] } {
  return { now: foldersFor(home, "cleat"), old: OLD_NAMES.map(({ name }) => ({ name, ...foldersFor(home, name) })) };
}

/** The pid of a runner that still runs from an old data folder, or null. */
export function oldRunner(oldData: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(join(oldData, "runner.pid"), "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  // The number may have been given to another process since: only a runner counts.
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    return command.includes(join("runner", "main.ts")) ? pid : null;
  } catch {
    // No /proc (macOS): ps.
  }
  const p = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const command = p.stdout.toString();
  return p.exitCode !== 0 || !command.trim() || command.includes(join("runner", "main.ts")) ? pid : null;
}

const said = new Set<string>();

/** Says a line once per process: on stderr, which the runner's log and the terminal both get. */
function sayOnce(line: string, say: (line: string) => void): void {
  if (said.has(line)) return;
  said.add(line);
  say(line);
}

/**
 * The folders to use, after moving the old ones to the new names. While a runner from before a rename
 * still runs from an old data folder, nothing moves (it would lose what that runner writes) and that
 * name's folders are used, so `cleat stop`, `start` and `restart` find that runner and can stop it; the
 * next command after it has stopped moves them. The newer old name moves first, so where both had the
 * same file the newer one is kept; nothing already under the new name is overwritten.
 */
export function runnerFolders(env: Env = process.env, home: string = homedir(), say: (line: string) => void = (l) => console.error(l)): RunnerFolders {
  const { now, old } = defaultFolders(home);
  const config = env.CLEAT_CONFIG === undefined;
  const data = env.CLEAT_DATA_DIR === undefined;
  if (!config && !data) return now;
  if (data) {
    for (const o of old) {
      const pid = oldRunner(o.data);
      if (pid === null) continue;
      sayOnce(`cleat: a runner from before the rename (pid ${pid}) still runs from ${o.data}: its folders move to ${now.data} once it has stopped`, say);
      return { config: config ? o.config : now.config, data: o.data };
    }
  }
  for (const o of old) {
    for (const [want, from, to] of [
      [config, o.config, now.config],
      [data, o.data, now.data],
    ] as const) {
      if (want && moveFolder(from, to)) sayOnce(`cleat: moved ${from} to ${to} (${o.name} is now called cleat)`, say);
    }
  }
  return now;
}
