// Which layout this machine is, and each layout's paths and commands for installing, starting and stopping the shell.
// windows-wsl: the runner in WSL, the shell on Windows (installed from WSL). macos and linux: the runner and the shell on one machine.
// Every Windows-specific step of `shell install`, `shell start`, `shell login` and `doctor` goes through here.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SETTINGS_FILE } from "../../shell/src/settings";
import { parseWsl, type WslSettings } from "../../shell/src/wsl";
import { hasWindows, REPO, settingsFile as windowsSettingsFile, SHELL_SRC, type ShellPaths, shellPaths as windowsShellPaths, toWindows } from "./paths";

export type Layout = "windows-wsl" | "macos" | "linux";
export const LAYOUTS: readonly Layout[] = ["windows-wsl", "macos", "linux"];

type Env = Record<string, string | undefined>;

/**
 * The layout: INTUITION_PLATFORM when it names one (tests, and trying the linux layout under WSLg), else
 * windows-wsl inside WSL (WSL_DISTRO_NAME, or "microsoft" in /proc/version), else from process.platform.
 * Throws for an INTUITION_PLATFORM that names none, and for a platform intuition has no layout for.
 */
export function detectLayout(env: Env = process.env, platform: string = process.platform, procVersion: () => string = readProcVersion): Layout {
  const forced = env.INTUITION_PLATFORM;
  if (forced !== undefined && forced !== "") {
    if ((LAYOUTS as readonly string[]).includes(forced)) return forced as Layout;
    throw new Error(`INTUITION_PLATFORM is ${JSON.stringify(forced)}: it must be one of ${LAYOUTS.join(", ")}`);
  }
  if (platform === "darwin") return "macos";
  if (platform === "linux") return env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion()) ? "windows-wsl" : "linux";
  throw new Error(`intuition has no layout for ${platform}: on Windows, run it inside WSL`);
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

/** Where a native shell starts the runner: this repo with this bun, as a detached child process. */
export interface LocalRunner {
  kind: "local";
  repo: string;
  bun: string;
}

/** What `shell install` writes into the shell's settings: `wsl` for windows-wsl (as before), `runner` for the native layouts. */
export type RunnerLocation = { kind: "wsl"; wsl: WslSettings } | LocalRunner;

/** An absolute path without control characters: it starts with a slash, so it is never read as an option. */
function absolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096 && !/[\u0000-\u001f]/.test(value);
}

/** The `runner` object of a native layout's settings, or undefined unless it is whole. */
export function parseLocalRunner(value: unknown): LocalRunner | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, repo, bun } = value as Record<string, unknown>;
  return kind === "local" && absolute(repo) && absolute(bun) ? { kind, repo, bun } : undefined;
}

/** How start on login is set: through the shell's own Electron login item, or an XDG autostart file the command line writes. */
export type LoginKind = "electron" | "xdg-autostart";

export interface Platform {
  layout: Layout;
  /** The OS the shell runs on, in words: "Windows", "macOS", "Linux". */
  os: string;
  /** Why the shell cannot be installed or started here, or null when it can. */
  unavailable(env?: Env): string | null;
  /** <home>/shell holds the installed app: main.cjs, the preloads, package.json and node_modules/electron. */
  shellPaths(): ShellPaths;
  /** The shell's settings file: Electron's user data folder is <appData>/<the name in shell/package.json>. */
  settingsFile(): string;
  /** npm's environment for fetching Electron for the shell's OS and architecture. */
  electronEnv: Record<string, string>;
  /** The app folder as the Electron executable is given it (a Windows path for windows-wsl). */
  appArg(app: string): string;
  /** Extra Electron arguments before the shell's own. */
  electronFlags(): string[];
  /** Where the shell should find the runner, for the settings; undefined when nothing usable can be written. */
  runnerLocation(env?: Env, repo?: string, bun?: string): RunnerLocation | undefined;
  /** True while the shell's process (pid from its pid file) lives. */
  pidAlive(pid: number): boolean;
  login: LoginKind;
}

/** The Electron executable inside an app folder's node_modules, per OS. */
export function electronExe(app: string, layout: Layout): string {
  const dist = join(app, "node_modules", "electron", "dist");
  if (layout === "windows-wsl") return join(dist, "electron.exe");
  if (layout === "macos") return join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  return join(dist, "electron");
}

/** The name Electron gives the shell's user data folder: shell/package.json's name. */
function shellName(): string {
  return JSON.parse(readFileSync(join(SHELL_SRC, "package.json"), "utf8")).name as string;
}

function nativePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it lives, as another user's process.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while a Windows process has this pid (tasklist.exe). */
export function windowsPidAlive(pid: number): boolean {
  const p = Bun.spawnSync(["/mnt/c/Windows/System32/tasklist.exe", "/NH", "/FI", `PID eq ${pid}`], { cwd: "/mnt/c", stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && new RegExp(`\\s${pid}\\s`).test(p.stdout.toString());
}

/** npm's names for the architectures Electron ships. */
function npmArch(arch: string = process.arch): string {
  return arch === "arm64" ? "arm64" : arch === "arm" ? "armv7l" : "x64";
}

/** True when the process runs as root, where Chromium refuses to start without --no-sandbox. */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

const windowsWsl: Platform = {
  layout: "windows-wsl",
  os: "Windows",
  unavailable: () => (hasWindows() ? null : "the Windows shell needs WSL with the Windows disk at /mnt/c"),
  shellPaths: () => windowsShellPaths(),
  settingsFile: () => windowsSettingsFile(),
  // Electron is fetched for Windows although npm and node run in WSL.
  electronEnv: { npm_config_platform: "win32", npm_config_arch: "x64" },
  appArg: (app) => toWindows(app),
  electronFlags: () => [],
  runnerLocation: (env = process.env, repo = REPO, bun = process.execPath) => {
    const wsl = parseWsl({ distro: env.WSL_DISTRO_NAME, repo, bun });
    return wsl ? { kind: "wsl", wsl } : undefined;
  },
  pidAlive: windowsPidAlive,
  login: "electron",
};

function native(layout: "macos" | "linux", home: () => string): Platform {
  const nativePaths = (h: string): ShellPaths => {
    const app = join(h, "shell");
    return { home: h, app, electronExe: electronExe(app, layout) };
  };
  return {
    layout,
    os: layout === "macos" ? "macOS" : "Linux",
    unavailable: (env = process.env) => (layout === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY ? "the Linux shell needs a display: neither DISPLAY nor WAYLAND_DISPLAY is set" : null),
    shellPaths: () => nativePaths(home()),
    settingsFile: () => join(appData(layout), shellName(), SETTINGS_FILE),
    electronEnv: { npm_config_platform: layout === "macos" ? "darwin" : "linux", npm_config_arch: npmArch() },
    appArg: (app) => app,
    // Chromium will not start as root with its sandbox (WSL's default user is root): the one case it is turned off.
    electronFlags: () => (layout === "linux" && isRoot() ? ["--no-sandbox"] : []),
    runnerLocation: (_env = process.env, repo = REPO, bun = process.execPath) => parseLocalRunner({ kind: "local", repo, bun }),
    pidAlive: nativePidAlive,
    login: layout === "macos" ? "electron" : "xdg-autostart",
  };
}

/** Electron's appData folder on a native layout: the folder its user data folder is in. */
function appData(layout: "macos" | "linux", env: Env = process.env): string {
  if (layout === "macos") return join(homedir(), "Library", "Application Support");
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** Where the shell is installed on a native layout: <home>/shell beneath it. */
export function nativeHome(layout: "macos" | "linux", env: Env = process.env): string {
  if (layout === "macos") return join(homedir(), "Library", "Application Support", "intuition");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "intuition");
}

const PLATFORMS: Record<Layout, Platform> = {
  "windows-wsl": windowsWsl,
  macos: native("macos", () => nativeHome("macos")),
  linux: native("linux", () => nativeHome("linux")),
};

export function platformFor(layout: Layout): Platform {
  return PLATFORMS[layout];
}

/** This machine's platform, from detectLayout. */
export function currentPlatform(env: Env = process.env): Platform {
  return platformFor(detectLayout(env));
}

/** The XDG autostart file the linux layout writes for start on login. */
export function autostartFile(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "intuition.desktop");
}

/** One argument of a .desktop file's Exec line: quoted, with ", `, $ and \ escaped, and % doubled. */
function execArg(arg: string): string {
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, "%%")}"`;
}

/** The autostart entry: the installed Electron on the app folder, as `shell start` runs it. */
export function autostartEntry(exe: string, args: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=intuition",
    "Comment=Fire tasks at Claude Code from a hotkey",
    `Exec=${[exe, ...args].map(execArg).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** True when the autostart file exists: start on login is on. */
export function autostartOn(file = autostartFile()): boolean {
  return existsSync(file);
}
