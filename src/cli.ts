// The app's own commands: `bun src/cli.ts <command>`.
import * as runner from "./cli/runner";
import { parseLogin } from "../shell/src/login";
import { install, isInstalled, login, start, stop, writeRunnerLocation } from "./shell/install";
import { hasWindows, shellPaths } from "./shell/paths";

const USAGE = `usage: bun src/cli.ts <command>

  up              start the runner, install the Windows shell if it is not, and start it: the one command to run
  start           start the runner in the background and print its URL (--login-env: with the login shell's environment)
  stop            stop the runner
  status          say whether the runner runs (exit code 0 when it does, 1 when not)
  logs            print the end of the runner's log

  shell install   bundle the Windows shell and install it, with Electron, under the Windows user's AppData\\Local\\intuition
  shell start     start the Windows shell (tray icon, hotkey and dock)
  shell stop      quit the Windows shell
  shell login on|off|status
                  start the shell when you log in to Windows: turn it on, turn it off, or say which it is
  shell selftest  install the shell and run its self-test against a stub runner`;

function startShell(): void {
  start();
  console.log("the shell is starting: look for its icon in the tray");
}

function usageError(): never {
  console.error(USAGE);
  process.exit(1);
}

/** Each command gets the words after its name and may return an exit code. */
const commands: Record<string, (rest: string[]) => Promise<number | void> | number | void> = {
  start: (rest) => {
    if (rest.some((a) => a !== "--login-env")) usageError();
    return runner.start(process.env, console.log, { loginEnv: rest.includes("--login-env") });
  },
  stop: () => runner.stop(),
  status: () => runner.status(),
  logs: () => runner.logs(),
  up: async () => {
    const code = await runner.start();
    if (code !== 0) return code;
    if (!hasWindows()) {
      console.log("the Windows shell needs WSL with the Windows disk at /mnt/c: only the runner was started");
      return 0;
    }
    const paths = shellPaths();
    if (!isInstalled(paths)) await install(paths);
    writeRunnerLocation();
    startShell();
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
  "shell selftest": async () => {
    process.exitCode = await (await import("./shell/selftest-run")).selfTestRun();
  },
};

const words = process.argv.slice(2);
const name = [words.slice(0, 2).join(" "), words[0] ?? ""].find((n) => n in commands);
if (name === undefined) {
  console.error(USAGE);
  process.exit(words.length ? 1 : 0);
}
const rest = words.slice(name.split(" ").length);
if (rest.length && name !== "start" && name !== "shell login") usageError();
try {
  const code = await commands[name]!(rest);
  if (typeof code === "number") process.exitCode = code;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
