#!/usr/bin/env bun
// The app's own commands: `intuition <command>` once `bun src/cli.ts link` has put it on the PATH, or `bun src/cli.ts <command>`.
import { pick } from "./cli/command";
import { link, unlink } from "./cli/link";
import { resume } from "./cli/resume";
import * as runner from "./cli/runner";
import { parseLogin } from "../shell/src/login";
import { install, isCurrent, isInstalled, login, pidFile, start, stop, stopAndWait, writeRunnerLocation } from "./shell/install";
import { hasWindows, shellPaths } from "./shell/paths";

const USAGE = `usage: intuition <command>     (no command: intuition up)

  up              start the runner, install the Windows shell, and start it: the one command to run. A runner or
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

  shell install   bundle the Windows shell and install it, with Electron, under the Windows user's AppData\\Local\\intuition
  shell start     start the Windows shell (tray icon, hotkey and dock)
  shell stop      quit the Windows shell
  shell login on|off|status
                  start the shell when you log in to Windows: turn it on, turn it off, or say which it is
  shell selftest  install the shell and run its self-test against a stub runner

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
    if (!hasWindows()) {
      console.log("the Windows shell needs WSL with the Windows disk at /mnt/c: only the runner was started");
      return code;
    }
    const paths = shellPaths();
    if (!isInstalled(paths)) {
      await install(paths);
    } else if (!(await isCurrent(paths))) {
      console.log("the installed shell is older than this repo's: stopping it, installing it again and starting it");
      await stopAndWait(paths, pidFile());
      await install(paths);
    }
    writeRunnerLocation();
    startShell();
    return code;
  },
  "shell install": async () => {
    await install();
    writeRunnerLocation();
  },
  "shell start": startShell,
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

const picked = pick(process.argv.slice(2), Object.keys(commands));
if (!picked) usageError();
const { name, rest } = picked;
/** How many words each command takes after its name; the others take none. */
const takes: Record<string, number> = { start: 1, restart: 1, resume: 1, "shell login": 1, link: 1, unlink: 1 };
if (rest.length > (takes[name] ?? 0)) usageError();
try {
  const code = await commands[name]!(rest);
  if (typeof code === "number") process.exitCode = code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
