// `intuition up`'s shell half, shared with `setup`: install the shell when it is missing or older than the repo's.
import { install, isCurrent, isInstalled, pidFile, stopAndWait, writeRunnerLocation } from "../shell/install";
import type { Platform } from "../shell/platform";

type Log = (line: string) => void;

/** Installs the shell when it is missing, or stops and installs it again when it is older than this repo's, then writes where the runner lives. */
export async function installCurrentShell(platform: Platform, log: Log = console.log): Promise<void> {
  const paths = platform.shellPaths();
  if (!isInstalled(paths)) {
    await install(paths, log, platform);
  } else if (!(await isCurrent(paths))) {
    log("the installed shell is older than this repo's: stopping it, installing it again and starting it");
    await stopAndWait(paths, pidFile(platform.settingsFile()), undefined, platform);
    await install(paths, log, platform);
  }
  writeRunnerLocation(undefined, undefined, log, platform);
}
