#!/usr/bin/env bun
// The app's own commands: `intuition <command>` once `bun src/cli.ts link` has put it on the PATH, or `bun src/cli.ts <command>`.
import { pick } from "./cli/command";
import { link, unlink } from "./cli/link";
import { resume } from "./cli/resume";
import * as runner from "./cli/runner";
import { parseLogin } from "../shell/src/login";
import { doctor } from "./cli/doctor";
import { firstRun, parseSetupArgs, setup, DEFAULTS, terminalAsk } from "./cli/setup";
import { parseUninstallArgs, uninstall } from "./cli/uninstall";
import { installCurrentShell } from "./cli/up";
import { install, isInstalled, login, pidFile, prompt, removeShell, start, stop, stopAndWait, writeRunnerLocation } from "./shell/install";
import { currentPlatform } from "./shell/platform";

const USAGE = `usage: intuition <command>     (no command: intuition up, or intuition setup when there is no config yet)

  setup [--yes] [--workspace <folder>]... [--link-dir <folder>]
                  from a fresh clone to a running app: checks what it needs (each with a fix), asks for the
                  workspaces, the hotkeys and start at login, writes the config, starts the runner, installs and
                  starts the shell, links the command and opens the pop-up. --yes takes every default without asking
  uninstall [--purge] [--link-dir <folder>]
                  start at login off, the shell stopped and removed, the runner stopped, the command unlinked.
                  The config and the sessions stay, unless --purge
  up              start the runner, install the shell, and start it: the one command to run. A runner or
                  shell that runs older code than this repo's is restarted (a runner with sessions running is kept)
  start           start the runner in the background and print its URL (--login-env: with the login shell's environment).
                  A runner already running older code is restarted, unless a session is running or waits for approval:
                  then it is kept, the sessions are named, and the exit code is 3
  restart         stop the runner and start it again, with the same guard (--force: cut those sessions off)
  stop            stop the runner
  status          say whether the runner runs (exit code 0 when it does, 1 when not)
  logs            print the end of the runner's log
  resume [id]     continue a session in this terminal, in Claude Code itself: runs claude --resume in its folder.
                  No id: the newest session. An id may be the runner's or Claude Code's, or the start of one;
                  one that matches no session, or several, prints them

  doctor          say which layout this is (windows-wsl, macos, linux) and check each prerequisite and part, with a fix
                  for each one missing (exit code 1 when something needed is missing)

  shell install   bundle the shell and install it, with Electron, in its folder: the Windows user's AppData\\Local\\intuition
                  from WSL, ~/Library/Application Support/intuition on macOS, ~/.local/share/intuition on Linux
  shell start     start the shell (tray icon, hotkey and dock)
  shell stop      quit the shell
  shell login on|off|status
                  start the shell when you log in: turn it on, turn it off, or say which it is
  shell selftest  install the shell and run its self-test against a stub runner (Windows)

  link [dir]      put this command on the PATH: a link named intuition, in dir or else in the folder bun is in
  unlink [dir]    remove that link
  help            print this`;

function startShell(): void {
  start();
  console.log("the shell is starting: look for its icon in the tray");
}

function usageError(): never {
  console.error(USAGE);
  process.exit(2);
}

/** Each command gets the words after its name and may return an exit code. */
const commands: Record<string, (rest: string[]) => Promise<number | void> | number | void> = {
  start: (rest) => {
    if (rest.some((a) => a !== "--login-env")) usageError();
    return runner.start(process.env, console.log, { loginEnv: rest.includes("--login-env") });
  },
  restart: (rest) => {
    if (rest.some((a) => a !== "--force")) usageError();
    return runner.restart(process.env, console.log, { force: rest.includes("--force") });
  },
  stop: () => runner.stop(),
  status: () => runner.status(),
  logs: () => runner.logs(),
  resume: (rest) => resume(rest[0]),
  up: async () => {
    // A runner kept because sessions are in the way still serves: the shell is brought up to date, and the exit code says so.
    const code = await runner.start();
    if (code !== 0 && code !== runner.KEPT) return code;
    const platform = currentPlatform();
    const unavailable = platform.unavailable();
    if (unavailable) {
      console.log(`${unavailable}: only the runner was started`);
      return code;
    }
    await installCurrentShell(platform);
    startShell();
    return code;
  },
  setup: (rest) => {
    const options = parseSetupArgs(rest);
    if (!options) usageError();
    const platform = currentPlatform();
    return setup(options, platform, {
      claudeLogin: async () => {
        await Bun.spawn(["claude", "auth", "login"], { stdio: ["inherit", "inherit", "inherit"] }).exited;
      },
      startRunner: () => runner.start(),
      installShell: () => installCurrentShell(platform),
      startShell: (open) => (open ? prompt(undefined, platform) : start(undefined, platform)),
      login: async (on) => (await login(on ? "on" : "off", undefined, platform)).openAtLogin === true,
      link: (dir) => link(dir),
    }, options.yes ? DEFAULTS : terminalAsk());
  },
  uninstall: (rest) => {
    const options = parseUninstallArgs(rest);
    if (!options) usageError();
    const platform = currentPlatform();
    const installed = () => {
      try {
        return isInstalled(platform.shellPaths());
      } catch {
        return false;
      }
    };
    return uninstall(options, platform, {
      shellInstalled: installed,
      loginOff: async () => {
        await login("off", undefined, platform);
      },
      stopShell: () => stopAndWait(platform.shellPaths(), pidFile(platform.settingsFile()), undefined, platform),
      removeShell: () => removeShell(undefined, platform),
      stopRunner: () => runner.stop(),
      unlink: (dir) => unlink(dir),
    });
  },
  "shell install": async () => {
    await install();
    writeRunnerLocation();
  },
  "shell start": startShell,
  doctor: () => doctor(),
  "shell stop": async () => {
    await stop();
    console.log("the shell was asked to quit");
  },
  "shell login": async (rest) => {
    const action = parseLogin(rest[0]);
    if (!action || rest.length !== 1) usageError();
    const { openAtLogin } = await login(action);
    console.log(`start on login is ${openAtLogin ? "on" : "off"}`);
  },
  link: (rest) => link(rest[0]),
  unlink: (rest) => unlink(rest[0]),
  help: () => console.log(USAGE),
  "shell selftest": async () => {
    process.exitCode = await (await import("./shell/selftest-run")).selfTestRun();
  },
};

const words = process.argv.slice(2);
// The first plain `intuition`, before there is a config: setup.
const picked = words.length === 0 && firstRun() ? { name: "setup", rest: [] } : pick(words, Object.keys(commands));
if (!picked) usageError();
const { name, rest } = picked;
/** How many words each command takes after its name; the others take none. */
const takes: Record<string, number> = { setup: Infinity, uninstall: Infinity, start: 1, restart: 1, resume: 1, "shell login": 1, link: 1, unlink: 1 };
if (rest.length > (takes[name] ?? 0)) usageError();
try {
  const code = await commands[name]!(rest);
  if (typeof code === "number") process.exitCode = code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
