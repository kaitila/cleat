// The one-time move of the installed shell from its old names (D0043, D0048), done by `shell install` (and so `up` and `setup`):
//   - the shell's home: <home>/shell under ...\holm or ...\intuition to ...\cleat (Electron is moved, not downloaded again);
//   - Electron's user data folder holm-shell or intuition-shell to cleat-shell (the shell's settings, and the pages' localStorage);
//   - start on login: the old launch agents (macOS) or XDG autostart files (Linux) give way to the new one.
// A shell from before a rename that still runs is asked to quit first: Electron writes into its user data folder.
// The newer old name moves first, so where both left the same file the newer one is kept; nothing under the new name is overwritten.
// On Windows the old login items are registry values that only Electron can remove: the new shell does that (shell/src/legacy.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autostartEntry, autostartFile, launchAgentFile, launchAgentPlist } from "../../shell/src/login";
import { PID_FILE } from "../../shell/src/settings";
import { moveFolder, OLD_NAMES } from "../shared/legacy";
import type { ShellPaths } from "./paths";
import { electronExe, type Platform } from "./platform";

type Log = (line: string) => void;

export interface OldShell {
  /** The old name: holm or intuition. */
  name: string;
  paths: ShellPaths;
  userData: string;
}

/** Where the shell was installed under each old name, newest first, beside where it goes now. */
export function oldShellPaths(now: ShellPaths, userData: string, platform: Platform): OldShell[] {
  return OLD_NAMES.map((o) => {
    const home = join(dirname(now.home), o.name);
    const app = join(home, "shell");
    return { name: o.name, paths: { home, app, electronExe: electronExe(app, platform.layout) }, userData: join(dirname(userData), o.shell) };
  });
}

/** The old login files, by layout: the launch agents on macOS, the autostart files on Linux; none on Windows. */
export function oldLoginFiles(platform: Platform, home: string = homedir(), env: Record<string, string | undefined> = process.env): { old: string[]; now: string } | null {
  if (platform.layout === "macos") {
    const now = launchAgentFile(home);
    return { old: OLD_NAMES.map((o) => join(dirname(now), `${o.launchAgent}.plist`)), now };
  }
  if (platform.layout === "linux") {
    const now = autostartFile(home, env);
    return { old: OLD_NAMES.map((o) => join(dirname(now), o.autostart)), now };
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
  /** Asks an old shell to quit and waits for it: install.ts's stopAndWait on the old paths. */
  stopOld: (old: ShellPaths, pidFile: string) => Promise<void>;
}

/** Moves an installed shell from its old names to the new one, once. Returns true when anything moved or was replaced. */
export async function migrateShell(m: ShellMigration): Promise<boolean> {
  const olds = oldShellPaths(m.now, m.userData, m.platform).filter((o) => existsSync(o.paths.app) || existsSync(o.userData));
  const login = oldLoginFiles(m.platform, m.home, m.env);
  const oldLogins = login ? login.old.filter((f) => existsSync(f)) : [];
  if (olds.length === 0 && oldLogins.length === 0) return false;

  // Every old shell that still runs quits before anything moves.
  for (const old of olds) {
    const pidFile = join(old.userData, PID_FILE);
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !m.platform.pidAlive(pid)) continue;
    m.log(`stopping the shell from before the rename (${old.name}, pid ${pid}), to move it`);
    try {
      await m.stopOld(old.paths, pidFile);
    } catch (e) {
      m.log(`it could not be asked to quit (${e instanceof Error ? e.message : String(e)}): quit it from its tray, then run \`cleat shell install\` again`);
      return false;
    }
    if (m.platform.pidAlive(pid)) {
      m.log("it is still running: quit it from its tray, then run `cleat shell install` again");
      return false;
    }
  }

  for (const old of olds) {
    if (moveFolder(old.paths.app, m.now.app)) m.log(`moved the shell: ${old.paths.app} to ${m.now.app} (${old.name} is now called cleat)`);
    if (moveFolder(old.userData, m.userData)) m.log(`moved the shell's settings: ${old.userData} to ${m.userData}`);
    // The old home goes once nothing of the shell's is left in it (on Linux it is also the old data folder, moved by the runner).
    try {
      if (existsSync(old.paths.home) && readdirSync(old.paths.home).every((f) => f === "login-result.json")) rmSync(old.paths.home, { recursive: true, force: true });
    } catch {
      // Left: an unreadable folder is not in the way.
    }
  }

  if (login && oldLogins.length > 0) {
    // The new item runs the installed Electron on the app folder, as the shell itself writes it (main.ts), so it reads as on.
    if (!existsSync(login.now)) {
      const argv = [...m.platform.electronFlags(), m.platform.appArg(m.now.app)];
      mkdirSync(dirname(login.now), { recursive: true });
      writeFileSync(login.now, m.platform.layout === "macos" ? launchAgentPlist(m.now.electronExe, argv) : autostartEntry(m.now.electronExe, argv));
    }
    for (const file of oldLogins) {
      rmSync(file, { force: true });
      m.log(`start on login: ${file} replaced by ${login.now}`);
    }
  }
  return true;
}
