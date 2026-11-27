// `cleat up`'s shell half, shared with `setup`: install the shell when it is missing or older than the repo's.
import { existsSync, readFileSync } from "node:fs";
import { install, isCurrent, isInstalled, pidFile, stopAndWait, writeRunnerLocation } from "../shell/install";
import type { Platform } from "../shell/platform";

type Log = (line: string) => void;

/** Whether the shell's pid file names a process that is alive. */
export function shellRunning(file: string, alive: (pid: number) => boolean): boolean {
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 0 && alive(pid);
}

/**
 * Installs the shell when it is missing, or stops and installs it again when it is older than this
 * repo's, then writes where the runner lives. An install that lacks a file a newer shell has (a new
 * preload, as the pop-up's in D0056) counts as missing, yet its shell may still be running the old
 * bundle: a running shell is stopped before that install too, so the shell started after it is new.
 */
export async function installCurrentShell(platform: Platform, log: Log = console.log): Promise<void> {
  const paths = platform.shellPaths();
  const pids = pidFile(platform.settingsFile());
  if (!isInstalled(paths)) {
    if (shellRunning(pids, platform.pidAlive)) {
      log("a shell from an older install is running: stopping it, installing the shell and starting it");
      await stopAndWait(paths, pids, undefined, platform);
    }
    await install(paths, log, platform);
  } else if (!(await isCurrent(paths))) {
    log("the installed shell is older than this repo's: stopping it, installing it again and starting it");
    await stopAndWait(paths, pids, undefined, platform);
    await install(paths, log, platform);
  }
  writeRunnerLocation(undefined, undefined, log, platform);
}
