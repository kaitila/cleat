// Where the Windows shell lives, seen from WSL (the windows-wsl layout of ./platform). Windows is asked through cmd.exe; wslpath converts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_FILE } from "../../shell/src/settings";

export const REPO = join(import.meta.dir, "..", "..");
export const SHELL_SRC = join(REPO, "shell");

/** True on a machine where the shell can be installed and run: WSL with the Windows disk mounted. */
export function hasWindows(): boolean {
  return existsSync("/mnt/c/Windows");
}

function run(cmd: string[], cwd?: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/**
 * True when Windows shows its lock or sign-in screen (LogonUI.exe runs then). Programs cannot use the
 * clipboard behind it, so the self-test's clipboard steps fail there. False when it cannot be told.
 */
export function desktopLocked(): boolean {
  try {
    const p = Bun.spawnSync(["/mnt/c/Windows/System32/tasklist.exe", "/NH", "/FI", "IMAGENAME eq LogonUI.exe"], { cwd: "/mnt/c", stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 && p.stdout.toString().includes("LogonUI.exe");
  } catch {
    return false;
  }
}

export function toWsl(windowsPath: string): string {
  return run(["wslpath", "-u", windowsPath]);
}

export function toWindows(wslPath: string): string {
  return run(["wslpath", "-w", wslPath]);
}

/** A folder the Windows user's environment names, as a WSL path. */
function windowsFolder(variable: "LOCALAPPDATA" | "APPDATA"): string {
  const cmd = Bun.which("cmd.exe") ?? "/mnt/c/Windows/System32/cmd.exe";
  // Started from a Windows folder: cmd.exe complains about a \\wsl.localhost working directory.
  const answer = run([cmd, "/d", "/c", `echo %${variable}%`], "/mnt/c");
  if (!/^[A-Za-z]:\\/.test(answer)) throw new Error(`cmd.exe did not give ${variable}: ${answer}`);
  return toWsl(answer);
}

/** The Windows user's LocalAppData folder, as a WSL path. */
export function localAppData(): string {
  return windowsFolder("LOCALAPPDATA");
}

/** The shell's settings file, as a WSL path: Electron's user data folder is <AppData>\\<the name in shell/package.json>. */
export function settingsFile(): string {
  const name = JSON.parse(readFileSync(join(SHELL_SRC, "package.json"), "utf8")).name as string;
  return join(windowsFolder("APPDATA"), name, SETTINGS_FILE);
}

export interface ShellPaths {
  /** The shell's own folder: <LocalAppData>\intuition as a WSL path for windows-wsl; for the native layouts, ./platform's nativeHome. */
  home: string;
  /** The installed app: main.cjs, package.json and node_modules/electron. */
  app: string;
  electronExe: string;
}

export function shellPaths(home = join(localAppData(), "intuition")): ShellPaths {
  const app = join(home, "shell");
  return { home, app, electronExe: join(app, "node_modules", "electron", "dist", "electron.exe") };
}
