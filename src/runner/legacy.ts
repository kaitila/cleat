// The one-time move of the config and data folders from their old names (D0043):
// ~/.config/intuition to ~/.config/holm, and ~/.local/share/intuition to ~/.local/share/holm.
// Only the default folders move: HOLM_CONFIG and HOLM_DATA_DIR (or the old names, adopted by
// adoptLegacyEnv) name folders the person chose, which are left where they are.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { moveFolder, OLD_NAME } from "../shared/legacy";

type Env = Record<string, string | undefined>;

export interface RunnerFolders {
  /** The folder config.json is in. */
  config: string;
  /** The data folder: sessions, events, the runner's pid and log. */
  data: string;
}

/** The default folders under the new name, and under the old one. */
export function defaultFolders(home: string = homedir()): { now: RunnerFolders; old: RunnerFolders } {
  return {
    now: { config: join(home, ".config", "holm"), data: join(home, ".local", "share", "holm") },
    old: { config: join(home, ".config", OLD_NAME), data: join(home, ".local", "share", OLD_NAME) },
  };
}

/** The pid of a runner that still runs from the old data folder, or null. */
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
 * The folders to use, after moving the old ones to the new names when the new ones are missing.
 * While a runner from before the rename still runs from the old data folder, nothing moves (it
 * would lose what that runner writes) and the old folders are used, so `holm stop`, `start` and
 * `restart` find that runner and can stop it; the next command after it has stopped moves them.
 */
export function runnerFolders(env: Env = process.env, home: string = homedir(), say: (line: string) => void = (l) => console.error(l)): RunnerFolders {
  const { now, old } = defaultFolders(home);
  const config = env.HOLM_CONFIG === undefined;
  const data = env.HOLM_DATA_DIR === undefined;
  if (!config && !data) return now;
  const pid = data ? oldRunner(old.data) : null;
  if (pid !== null) {
    sayOnce(`holm: a runner from before the rename (pid ${pid}) still runs from ${old.data}: its folders move to ${now.data} once it has stopped`, say);
    return { config: config ? old.config : now.config, data: old.data };
  }
  for (const [want, from, to] of [
    [config, old.config, now.config],
    [data, old.data, now.data],
  ] as const) {
    if (want && moveFolder(from, to)) sayOnce(`holm: moved ${from} to ${to} (intuition is now called holm)`, say);
  }
  return now;
}
