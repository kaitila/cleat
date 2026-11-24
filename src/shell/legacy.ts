// The one-time move of the installed shell from its old name (D0043), done by `shell install` (and so `up` and `setup`):
//   - the shell's home: <home>/shell under ...\intuition to ...\holm (Electron is moved, not downloaded again);
//   - Electron's user data folder intuition-shell to holm-shell (the shell's settings, and the pages' localStorage);
//   - start on login: the old launch agent (macOS) or XDG autostart file (Linux) gives way to the new one.
// A shell from before the rename that still runs is asked to quit first: Electron writes into its user data folder.
// On Windows the old login item is a registry value that only Electron can remove: the new shell does that (shell/src/legacy.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autostartEntry, autostartFile, launchAgentFile, launchAgentPlist } from "../../shell/src/login";
import { PID_FILE } from "../../shell/src/settings";
import { moveFolder, OLD_AUTOSTART, OLD_LAUNCH_AGENT, OLD_NAME, OLD_SHELL_NAME } from "../shared/legacy";
import type { ShellPaths } from "./paths";
import { electronExe, type Platform } from "./platform";

type Log = (line: string) => void;

/** Where the shell was installed under the old name, beside where it goes now. */
export function oldShellPaths(now: ShellPaths, userData: string, platform: Platform): { paths: ShellPaths; userData: string } {
  const home = join(dirname(now.home), OLD_NAME);
  const app = join(home, "shell");
  return { paths: { home, app, electronExe: electronExe(app, platform.layout) }, userData: join(dirname(userData), OLD_SHELL_NAME) };
}

/** The old login files, by layout: the launch agent on macOS, the autostart file on Linux; none on Windows. */
export function oldLoginFile(platform: Platform, home: string = homedir(), env: Record<string, string | undefined> = process.env): { old: string; now: string } | null {
  if (platform.layout === "macos") {
    const now = launchAgentFile(home);
    return { old: join(dirname(now), `${OLD_LAUNCH_AGENT}.plist`), now };
  }
  if (platform.layout === "linux") {
    const now = autostartFile(home, env);
    return { old: join(dirname(now), OLD_AUTOSTART), now };
  }
  return null;
}

export interface ShellMigration {
  now: ShellPaths;
  /** Electron's user data folder under the new name. */
  userData: string;
  platform: Platform;
  log: Log;
  /** The user's home, for the login files (tests give a temp folder). */
  home?: string;
  env?: Record<string, string | undefined>;
  /** Asks the old shell to quit and waits for it: install.ts's stopAndWait on the old paths. */
  stopOld: (old: ShellPaths, pidFile: string) => Promise<void>;
}

/** Moves an installed shell from its old name to the new one, once. Returns true when anything moved or was replaced. */
export async function migrateShell(m: ShellMigration): Promise<boolean> {
  const old = oldShellPaths(m.now, m.userData, m.platform);
  const login = oldLoginFile(m.platform, m.home, m.env);
  const hasOld = existsSync(old.paths.app) || existsSync(old.userData);
  if (!hasOld && !(login && existsSync(login.old))) return false;

  if (hasOld) {
    const pidFile = join(old.userData, PID_FILE);
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0 && m.platform.pidAlive(pid)) {
      m.log(`stopping the shell from before the rename (pid ${pid}), to move it`);
      try {
        await m.stopOld(old.paths, pidFile);
      } catch (e) {
        m.log(`it could not be asked to quit (${e instanceof Error ? e.message : String(e)}): quit it from its tray, then run \`holm shell install\` again`);
        return false;
      }
      if (m.platform.pidAlive(pid)) {
        m.log("it is still running: quit it from its tray, then run `holm shell install` again");
        return false;
      }
    }
    if (moveFolder(old.paths.app, m.now.app)) m.log(`moved the shell: ${old.paths.app} to ${m.now.app} (intuition is now called holm)`);
    if (moveFolder(old.userData, m.userData)) m.log(`moved the shell's settings: ${old.userData} to ${m.userData}`);
    // The old home goes once nothing of the shell's is left in it (on Linux it is also the old data folder, moved by the runner).
    try {
      if (existsSync(old.paths.home) && readdirSync(old.paths.home).every((f) => f === "login-result.json")) rmSync(old.paths.home, { recursive: true, force: true });
    } catch {
      // Left: an unreadable folder is not in the way.
    }
  }

  if (login && existsSync(login.old)) {
    // The new item runs the installed Electron on the app folder, as the shell itself writes it (main.ts), so it reads as on.
    if (!existsSync(login.now)) {
      const argv = [...m.platform.electronFlags(), m.platform.appArg(m.now.app)];
      mkdirSync(dirname(login.now), { recursive: true });
      writeFileSync(login.now, m.platform.layout === "macos" ? launchAgentPlist(m.now.electronExe, argv) : autostartEntry(m.now.electronExe, argv));
    }
    rmSync(login.old, { force: true });
    m.log(`start on login: ${login.old} replaced by ${login.now}`);
  }
  return true;
}
