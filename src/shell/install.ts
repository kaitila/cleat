// Installing, starting and stopping the shell: the Windows shell from WSL, or the shell on this machine (macOS, Linux).
// What differs per layout comes from ./platform.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCK_PRELOAD } from "../../shell/src/dock";
import type { LoginResult } from "../../shell/src/login";
import { SNIP_PRELOAD } from "../../shell/src/snip";
import { DEFAULT_SETTINGS, PID_FILE, withWsl } from "../../shell/src/settings";
import type { WslSettings } from "../../shell/src/wsl";
import { REPO, SHELL_SRC, type ShellPaths } from "./paths";
import { autostartEntry, autostartFile, currentPlatform, type LocalRunner, type Platform, platformFor, type RunnerLocation, windowsPidAlive } from "./platform";

export { windowsPidAlive };

export const BUNDLE = "main.cjs";

/** One entry point bundled into one CommonJS file in outDir. Electron stays a require(). */
async function bundle(entry: string, outDir: string, name: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(SHELL_SRC, "src", entry)],
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error(`bundling ${entry} failed:\n${result.logs.join("\n")}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  await Bun.write(file, await output.text());
  return file;
}

/**
 * Bundles the shell into outDir: main.ts as main.cjs, and the dock's and the snip's preload
 * scripts as their own files beside it, since Electron loads a preload by path. Returns main.cjs's path.
 */
export async function buildShell(outDir: string): Promise<string> {
  await bundle("dock-preload.ts", outDir, DOCK_PRELOAD);
  await bundle("snip-preload.ts", outDir, SNIP_PRELOAD);
  return bundle("main.ts", outDir, BUNDLE);
}

/** The Electron version shell/package.json pins. */
export function wantedElectron(): string {
  return JSON.parse(readFileSync(join(SHELL_SRC, "package.json"), "utf8")).devDependencies.electron;
}

/** The version of the Electron installed in the app folder, or null. */
export function installedElectron(paths: ShellPaths): string | null {
  const versionFile = join(paths.app, "node_modules", "electron", "dist", "version");
  if (!existsSync(paths.electronExe) || !existsSync(versionFile)) return null;
  return readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
}

/** Throws when the shell cannot be installed or run on this layout: windows-wsl without the Windows disk, or (to start it) Linux without a display. */
function needPlatform(platform: Platform, starting: boolean): void {
  const why = platform.layout === "linux" && !starting ? null : platform.unavailable();
  if (why) throw new Error(why);
}

/** Copies the bundle and package.json into the shell's folder, and installs Electron there for the shell's OS unless the pinned version already is. */
export async function install(paths?: ShellPaths, log: (line: string) => void = console.log, platform: Platform = currentPlatform()): Promise<void> {
  needPlatform(platform, false);
  paths ??= platform.shellPaths();
  mkdirSync(paths.app, { recursive: true });
  await buildShell(paths.app);
  copyFileSync(join(SHELL_SRC, "package.json"), join(paths.app, "package.json"));
  log(`bundle: ${join(paths.app, BUNDLE)}, ${DOCK_PRELOAD} and ${SNIP_PRELOAD}`);
  const wanted = wantedElectron();
  if (installedElectron(paths) === wanted) {
    log(`Electron ${wanted} is already installed`);
    return;
  }
  log(`installing Electron ${wanted} for ${platform.os} (a download of about 130 MB the first time)`);
  // This machine's npm and node. For windows-wsl, WSL's: the Node on the Windows side is too old for Electron's installer.
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-package-lock"], paths.app, platform.electronEnv);
  await run(["node", join("node_modules", "electron", "install.js")], paths.app, platform.electronEnv);
  if (installedElectron(paths) !== wanted) throw new Error(`Electron ${wanted} is not at ${paths.electronExe} after the install`);
  log(`Electron ${wanted}: ${paths.electronExe}`);
}

/** True when Electron and every bundle are in the app folder. An install from before the dock or the snip lacks a preload, and counts as not installed. */
export function isInstalled(paths: ShellPaths): boolean {
  return existsSync(paths.electronExe) && [BUNDLE, DOCK_PRELOAD, SNIP_PRELOAD].every((name) => existsSync(join(paths.app, name)));
}

/** The files an install writes into the app folder, besides Electron. */
const INSTALLED_FILES = [BUNDLE, DOCK_PRELOAD, SNIP_PRELOAD, "package.json"];

function same(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/**
 * True when the app folder holds exactly what `shell install` would write now: the same bundles, the
 * same package.json and the pinned Electron. False after a pull that changed `shell/src/`, so `up`
 * installs again instead of starting the old bundle.
 */
export async function isCurrent(paths: ShellPaths): Promise<boolean> {
  if (!isInstalled(paths) || installedElectron(paths) !== wantedElectron()) return false;
  const fresh = mkdtempSync(join(tmpdir(), "intuition-shell-bundle-"));
  try {
    await buildShell(fresh);
    copyFileSync(join(SHELL_SRC, "package.json"), join(fresh, "package.json"));
    return INSTALLED_FILES.every((name) => same(join(fresh, name), join(paths.app, name)));
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

function needInstalled(paths: ShellPaths, platform: Platform): void {
  needPlatform(platform, true);
  if (!isInstalled(paths)) throw new Error("the shell is not installed: run `intuition shell install`");
}

/** Where the runner lives in WSL, for the Windows shell to start it: this distribution, this repo and the bun running this command. */
export function runnerLocation(env: Record<string, string | undefined> = process.env, repo = REPO, bun = process.execPath): WslSettings | undefined {
  const location = platformFor("windows-wsl").runnerLocation(env, repo, bun);
  return location?.kind === "wsl" ? location.wsl : undefined;
}

/** The settings file's text with `runner` set to a local runner and everything else kept, as withWsl does: text that is not a JSON object starts from the defaults. */
export function withLocalRunner(text: string | null, runner: LocalRunner): string {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    // Missing or broken: the defaults.
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : DEFAULT_SETTINGS;
  return JSON.stringify({ ...o, runner }, null, 2) + "\n";
}

/**
 * Writes where the runner lives into the shell's settings file, keeping what else is there: `wsl` for the
 * Windows shell (a WslSettings, as before), or `runner: { kind: "local", repo, bun }` for a shell on this
 * machine, which starts the runner itself as a detached child process. Returns false when there is nothing usable to write.
 */
export function writeRunnerLocation(file?: string, location?: WslSettings | RunnerLocation | null, log: (line: string) => void = console.log, platform: Platform = currentPlatform()): boolean {
  file ??= platform.settingsFile();
  const where = location === undefined ? (platform.runnerLocation() ?? null) : location;
  if (!where) {
    log(
      platform.layout === "windows-wsl"
        ? "WSL_DISTRO_NAME is not set, or the repo's or bun's path is unusable: the shell will not be able to start the runner itself"
        : "the repo's or bun's path is unusable: the shell will not be able to start the runner itself",
    );
    return false;
  }
  const wsl = !("kind" in where) ? where : where.kind === "wsl" ? where.wsl : null;
  const local = "kind" in where && where.kind === "local" ? where : null;
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const after = wsl ? withWsl(before, wsl) : withLocalRunner(before, local!);
  if (after !== before) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    const r = wsl ?? local!;
    log(`settings: ${file} (the shell starts the runner with ${r.bun} ${join(r.repo, "src", "cli.ts")} start${wsl ? `, in ${wsl.distro}` : ""})`);
  }
  return true;
}

/** The installed Electron on the app folder with extra arguments, run from the app folder (for windows-wsl, a Windows folder). */
export function electron(paths: ShellPaths, args: string[], detached = false, platform: Platform = currentPlatform()) {
  needInstalled(paths, platform);
  return Bun.spawn([paths.electronExe, ...platform.electronFlags(), platform.appArg(paths.app), ...args], { cwd: paths.app, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached });
}

/** Starts the shell and leaves it running. A second start only brings up the first one's chat window. */
export function start(paths?: ShellPaths, platform: Platform = currentPlatform()): void {
  electron(paths ?? platform.shellPaths(), [], true, platform).unref();
}

/** Asks the running shell to quit: a second copy hands it --quit and exits. Does nothing when none runs. */
export async function stop(paths?: ShellPaths, platform: Platform = currentPlatform()): Promise<void> {
  await electron(paths ?? platform.shellPaths(), ["--quit"], false, platform).exited;
}

/** How long `stopAndWait` waits for the shell's process to end. */
const QUIT_MS = 10_000;

/**
 * Asks the running shell to quit and waits until its process has ended, so files can be replaced and
 * a new shell can take the single-instance lock. The shell writes its pid beside its settings; a shell
 * from before that is given two seconds. `pidFile` is that file (for windows-wsl, as a WSL path).
 */
export async function stopAndWait(paths: ShellPaths, pidFile: string, alive?: (pid: number) => boolean, platform: Platform = currentPlatform()): Promise<void> {
  const isAlive = alive ?? platform.pidAlive;
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  await stop(paths, platform);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    await Bun.sleep(2000);
    return;
  }
  const end = Date.now() + QUIT_MS;
  while (Date.now() < end && isAlive(pid)) await Bun.sleep(200);
  rmSync(pidFile, { force: true });
}

/** The shell's pid file (for windows-wsl, as a WSL path): beside its settings file. */
export function pidFile(settings = currentPlatform().settingsFile()): string {
  return join(dirname(settings), PID_FILE);
}

/**
 * Start on login. Windows and macOS: runs the shell's exe with --login on|off|status and returns what it
 * wrote; `on` and `off` change this user's login items. Linux: writes or removes an XDG autostart file.
 * `status` only reads.
 */
export async function login(action: "on" | "off" | "status", paths?: ShellPaths, platform: Platform = currentPlatform()): Promise<LoginResult> {
  paths ??= platform.shellPaths();
  if (platform.login === "xdg-autostart") return autostart(action, paths, platform);
  const resultFile = join(paths.home, "login-result.json");
  rmSync(resultFile, { force: true });
  const shell = electron(paths, ["--login", action, "--login-result", platform.appArg(resultFile)], false, platform);
  const timer = setTimeout(() => shell.kill(), 30_000);
  await shell.exited;
  clearTimeout(timer);
  try {
    if (!existsSync(resultFile)) throw new Error("the shell wrote no answer: an older bundle may be installed (run `intuition shell install`)");
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as LoginResult;
    if (result.error || typeof result.openAtLogin !== "boolean") throw new Error(`the shell could not ${action === "status" ? "read" : "set"} start on login: ${result.error}`);
    return result;
  } finally {
    rmSync(resultFile, { force: true });
  }
}

/**
 * Start on login for the linux layout: an XDG autostart file that runs the installed Electron on the app
 * folder, as `shell start` does. `on` needs the shell installed; `off` removes the file; `status` only reads.
 */
export function autostart(action: "on" | "off" | "status", paths: ShellPaths, platform: Platform, file = autostartFile()): LoginResult {
  if (action === "on") {
    if (!isInstalled(paths)) throw new Error("the shell is not installed: run `intuition shell install`");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, autostartEntry(paths.electronExe, [...platform.electronFlags(), platform.appArg(paths.app)]));
  } else if (action === "off") {
    rmSync(file, { force: true });
  }
  return { openAtLogin: existsSync(file), error: null };
}
