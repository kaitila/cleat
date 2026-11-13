// Installing, starting and stopping the Windows shell from WSL.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCK_PRELOAD } from "../../shell/src/dock";
import type { LoginResult } from "../../shell/src/login";
import { PID_FILE, withWsl } from "../../shell/src/settings";
import { parseWsl, type WslSettings } from "../../shell/src/wsl";
import { hasWindows, REPO, settingsFile, SHELL_SRC, type ShellPaths, shellPaths, toWindows } from "./paths";

export const BUNDLE = "main.cjs";
/** Electron is fetched for Windows although npm and node run in WSL. */
const FOR_WINDOWS = { npm_config_platform: "win32", npm_config_arch: "x64" };

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
 * Bundles the shell into outDir: main.ts as main.cjs, and the dock's preload script as its own
 * file beside it, since Electron loads a preload by path. Returns main.cjs's path.
 */
export async function buildShell(outDir: string): Promise<string> {
  await bundle("dock-preload.ts", outDir, DOCK_PRELOAD);
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

function needWindows(): void {
  if (!hasWindows()) throw new Error("the Windows shell needs WSL with the Windows disk at /mnt/c");
}

/** Copies the bundle and package.json into the Windows folder, and installs Electron there unless the pinned version already is. */
export async function install(paths = shellPaths(), log: (line: string) => void = console.log): Promise<void> {
  needWindows();
  mkdirSync(paths.app, { recursive: true });
  await buildShell(paths.app);
  copyFileSync(join(SHELL_SRC, "package.json"), join(paths.app, "package.json"));
  log(`bundle: ${join(paths.app, BUNDLE)} and ${DOCK_PRELOAD}`);
  const wanted = wantedElectron();
  if (installedElectron(paths) === wanted) {
    log(`Electron ${wanted} is already installed`);
    return;
  }
  log(`installing Electron ${wanted} for Windows (a download of about 130 MB the first time)`);
  // WSL's npm and node: the Node on the Windows side is too old for Electron's installer.
  await run(["npm", "install", "--no-audit", "--no-fund", "--no-package-lock"], paths.app, FOR_WINDOWS);
  await run(["node", join("node_modules", "electron", "install.js")], paths.app, FOR_WINDOWS);
  if (installedElectron(paths) !== wanted) throw new Error(`Electron ${wanted} is not at ${paths.electronExe} after the install`);
  log(`Electron ${wanted}: ${paths.electronExe}`);
}

/** True when Electron and both bundles are in the app folder. An install from before the dock lacks the preload, and counts as not installed. */
export function isInstalled(paths: ShellPaths): boolean {
  return existsSync(paths.electronExe) && existsSync(join(paths.app, BUNDLE)) && existsSync(join(paths.app, DOCK_PRELOAD));
}

/** The files an install writes into the app folder, besides Electron. */
const INSTALLED_FILES = [BUNDLE, DOCK_PRELOAD, "package.json"];

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

function needInstalled(paths: ShellPaths): void {
  needWindows();
  if (!isInstalled(paths)) throw new Error("the shell is not installed: run `intuition shell install`");
}

/** Where the runner lives, for the shell to start it: this distribution, this repo and the bun running this command. */
export function runnerLocation(env: Record<string, string | undefined> = process.env, repo = REPO, bun = process.execPath): WslSettings | undefined {
  return parseWsl({ distro: env.WSL_DISTRO_NAME, repo, bun });
}

/** Writes `wsl` into the shell's settings file, keeping what else is there. Returns false when there is nothing usable to write. */
export function writeRunnerLocation(file = settingsFile(), wsl: WslSettings | null = runnerLocation() ?? null, log: (line: string) => void = console.log): boolean {
  if (!wsl) {
    log("WSL_DISTRO_NAME is not set, or the repo's or bun's path is unusable: the shell will not be able to start the runner itself");
    return false;
  }
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const after = withWsl(before, wsl);
  if (after !== before) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    log(`settings: ${file} (the shell starts the runner with ${wsl.bun} ${join(wsl.repo, "src", "cli.ts")} start, in ${wsl.distro})`);
  }
  return true;
}

/** electron.exe on the app folder with extra arguments, run from a Windows folder. */
export function electron(paths: ShellPaths, args: string[], detached = false) {
  needInstalled(paths);
  return Bun.spawn([paths.electronExe, toWindows(paths.app), ...args], { cwd: paths.app, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached });
}

/** Starts the shell and leaves it running. A second start only brings up the first one's chat window. */
export function start(paths = shellPaths()): void {
  electron(paths, [], true).unref();
}

/** Asks the running shell to quit: a second copy hands it --quit and exits. Does nothing when none runs. */
export async function stop(paths = shellPaths()): Promise<void> {
  await electron(paths, ["--quit"]).exited;
}

/** How long `stopAndWait` waits for the shell's process to end. */
const QUIT_MS = 10_000;

/** True while a Windows process has this pid (tasklist.exe). */
export function windowsPidAlive(pid: number): boolean {
  const p = Bun.spawnSync(["/mnt/c/Windows/System32/tasklist.exe", "/NH", "/FI", `PID eq ${pid}`], { cwd: "/mnt/c", stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 && new RegExp(`\\s${pid}\\s`).test(p.stdout.toString());
}

/**
 * Asks the running shell to quit and waits until its process has ended, so files can be replaced and
 * a new shell can take the single-instance lock. The shell writes its pid beside its settings; a shell
 * from before that is given two seconds. `pidFile` is that file, as a WSL path.
 */
export async function stopAndWait(paths: ShellPaths, pidFile: string, alive = windowsPidAlive): Promise<void> {
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  await stop(paths);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    await Bun.sleep(2000);
    return;
  }
  const end = Date.now() + QUIT_MS;
  while (Date.now() < end && alive(pid)) await Bun.sleep(200);
  rmSync(pidFile, { force: true });
}

/** The shell's pid file, as a WSL path: beside its settings file. */
export function pidFile(settings = settingsFile()): string {
  return join(dirname(settings), PID_FILE);
}

/**
 * Start on login: runs the shell's exe with --login on|off|status and returns what it wrote.
 * `on` and `off` change this Windows user's login items; `status` only reads.
 */
export async function login(action: "on" | "off" | "status", paths = shellPaths()): Promise<LoginResult> {
  const resultFile = join(paths.home, "login-result.json");
  rmSync(resultFile, { force: true });
  const shell = electron(paths, ["--login", action, "--login-result", toWindows(resultFile)]);
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
