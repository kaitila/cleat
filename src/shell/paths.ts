// Where the Windows shell lives, seen from WSL. Windows is asked through cmd.exe; wslpath converts.
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
  /** <LocalAppData>\intuition, as a WSL path. */
  home: string;
  /** The installed app: main.cjs, package.json and node_modules/electron. */
  app: string;
  electronExe: string;
}

export function shellPaths(home = join(localAppData(), "intuition")): ShellPaths {
  const app = join(home, "shell");
  return { home, app, electronExe: join(app, "node_modules", "electron", "dist", "electron.exe") };
}
