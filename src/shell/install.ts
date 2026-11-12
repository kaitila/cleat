// Installing, starting and stopping the Windows shell from WSL.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasWindows, SHELL_SRC, type ShellPaths, shellPaths, toWindows } from "./paths";

export const BUNDLE = "main.cjs";
/** Electron is fetched for Windows although npm and node run in WSL. */
const FOR_WINDOWS = { npm_config_platform: "win32", npm_config_arch: "x64" };

/** Bundles shell/src/main.ts into one CommonJS file in outDir. Electron stays a require(). */
export async function buildShell(outDir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(SHELL_SRC, "src", "main.ts")],
    target: "node",
    format: "cjs",
    external: ["electron"],
  });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error(`bundling the shell failed:\n${result.logs.join("\n")}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, BUNDLE);
  await Bun.write(file, await output.text());
  return file;
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
  log(`bundle: ${join(paths.app, BUNDLE)}`);
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

function needInstalled(paths: ShellPaths): void {
  needWindows();
  if (!existsSync(paths.electronExe) || !existsSync(join(paths.app, BUNDLE))) {
    throw new Error("the shell is not installed: run `bun src/cli.ts shell install`");
  }
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
