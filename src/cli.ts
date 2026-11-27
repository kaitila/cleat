#!/usr/bin/env bun
// The app's own commands: `cleat <command>` once `bun src/cli.ts link` has put it on the PATH, or `bun src/cli.ts <command>`.
// Every command prints through src/cli/ui.ts: the same marks, colours and spinners, and plain lines without a terminal.
import { join } from "node:path";
import { pick } from "./cli/command";
import { link, unlink } from "./cli/link";
import { newPlugin } from "./cli/plugin";
import { resume } from "./cli/resume";
import * as runner from "./cli/runner";
import { parseLogin } from "../shell/src/login";
import { doctor, machineProbes, parseDoctorArgs } from "./cli/doctor";
import { clackAsk, DEFAULTS, firstRun, parseSetupArgs, setup } from "./cli/setup";
import { parseUninstallArgs, uninstall } from "./cli/uninstall";
import { installCurrentShell } from "./cli/up";
import { agentLogin, installKind, packageName, parseLoginAgent, update } from "./cli/update";
import { errorText, makeUi, promptOutput, termOf, type State } from "./cli/ui";
import { install, isInstalled, login, pidFile, prompt, removeShell, start, stop, stopAndWait, writeRunnerLocation } from "./shell/install";
import { currentPlatform } from "./shell/platform";
import { adoptLegacyEnv } from "./shared/legacy";

// The environment variables' names from before the renames, for one release (D0043, D0048, shared/legacy.ts). Before anything reads the environment.
adoptLegacyEnv();

const term = termOf();
const ui = makeUi({ term });
const { c } = ui;

/** The help, grouped and aligned like gh's: headings, then a command and what it does on each line. */
function usage(): string {
  const h = (s: string) => c.bold(s);
  const rows = (list: [string, string][]) => list.map(([name, what]) => `  ${name.padEnd(32)}${what}`).join("\n");
  return `Cleat: fire tasks at Claude Code from a hotkey, a pop-up and a chat.

${h("USAGE")}
  cleat <command> [flags]
  cleat                       up, or setup while there is no config yet

${h("GET STARTED")}
${rows([
  ["setup", "from a fresh install to a running app"],
  ["up", "start the runner, install and start the shell"],
  ["login [claude|codex]", "log the agent in (Claude Code's own login)"],
  ["doctor [--json]", "check what it needs, with a fix for each"],
  ["update", "get the newest version, then up"],
])}

${h("RUNNER")}
${rows([
  ["start [--login-env]", "start the runner in the background"],
  ["restart [--force]", "stop and start it (--force: cut off sessions)"],
  ["stop", "stop the runner"],
  ["status", "say whether the runner runs (exit 1 when not)"],
  ["logs", "print the end of the runner's log"],
  ["resume [id]", "continue a session here (no id: the newest)"],
])}

${h("SHELL")}  the tray app
${rows([
  ["shell install", "install the shell and Electron in its folder"],
  ["shell start", "start it: tray icon, hotkeys and dock"],
  ["shell stop", "quit the shell"],
  ["shell login on|off|status", "start the shell when you log in"],
  ["shell selftest", "install it and run its self-test"],
])}

${h("PLUGINS")}  tabs in the dock (docs/plugins.md)
${rows([
  ["plugin new <name>", "write a plugin to start from, beside the config"],
])}

${h("MORE")}
${rows([
  ["link [dir]", "put cleat on the PATH (default: bun's)"],
  ["unlink [dir]", "remove that link"],
  ["uninstall [--purge]", "undo setup (--purge: config and sessions too)"],
  ["help", "print this"],
])}

${h("SETUP FLAGS")}  without a terminal: --yes, or all of these
${rows([
  ["-y, --yes", "take every default without asking"],
  ["--workspace [name=]<folder>", "a workspace, repeatable; the first is default"],
  ["--hotkey <keys>", "new task hotkey, such as Control+Alt+Space"],
  ["--snip-hotkey <keys>", "the snip hotkey"],
  ["--chat-hotkey <keys>", "the chat's hotkey (optional)"],
  ["--permission-mode auto|default", "default asks for everything"],
  ["--no-login", "start at login off (else on)"],
  ["--link-dir <folder>", "where the command's link goes"],
])}

${h("EXAMPLES")}
  $ cleat setup
  $ cleat setup --yes --workspace web=~/code/web --no-login
  $ cleat doctor --json

${h("LEARN MORE")}
  README.md and docs/platforms.md. Colour follows NO_COLOR and FORCE_COLOR.`;
}

function usageError(why?: string): never {
  if (why) console.error(`${ui.mark("fail")} ${why}\n`);
  console.error(usage());
  process.exit(2);
}

type Log = (line: string) => void;

/**
 * Runs a command under a spinner on a terminal: what it logs is the spinner's progress line. When it ends,
 * the last thing it logged (or `text`) gets the mark for its exit code (0 a tick, KEPT a warning, else a
 * cross, unless `states` says otherwise), with the rest of that and what it logged before under it.
 * Without a terminal it prints the same lines, once, when it ends.
 */
async function stepped(title: string, run: (log: Log) => Promise<number | void> | number | void, text?: (code: number) => string | undefined, states: Record<number, State> = {}): Promise<number> {
  const calls: string[] = [];
  const s = ui.spin(title);
  const lines = (list: string[]) => list.flatMap((l) => l.split("\n"));
  let code: number;
  try {
    code =
      (await run((l) => {
        calls.push(l);
        if (term.interactive) s.update(l);
      })) ?? 0;
  } catch (e) {
    s.end("fail", `${title}: ${errorText(e)}`, lines(calls));
    return 1;
  }
  const state = states[code] ?? (code === 0 ? "ok" : code === runner.KEPT ? "warn" : "fail");
  const head = text?.(code);
  if (head !== undefined) s.end(state, head, lines(calls));
  else {
    const [first = title, ...rest] = lines(calls.slice(-1));
    s.end(state, first, [...rest, ...lines(calls.slice(0, -1))]);
  }
  return code;
}

function startShell(): void {
  start();
  ui.line(`${ui.mark("ok")} the shell is starting: look for its icon in the tray`);
}

const shellInstall = (platform = currentPlatform()) =>
  stepped("Installing the shell", (log) => installCurrentShell(platform, log), (code) => (code === 0 ? "shell installed" : undefined));

/** Each command gets the words after its name and may return an exit code. */
const commands: Record<string, (rest: string[]) => Promise<number | void> | number | void> = {
  start: (rest) => {
    if (rest.some((a) => a !== "--login-env")) usageError(`start takes --login-env, not ${rest.join(" ")}`);
    return stepped("Starting the runner", (log) => runner.start(process.env, log, { loginEnv: rest.includes("--login-env") }));
  },
  restart: (rest) => {
    if (rest.some((a) => a !== "--force")) usageError(`restart takes --force, not ${rest.join(" ")}`);
    return stepped("Restarting the runner", (log) => runner.restart(process.env, log, { force: rest.includes("--force") }));
  },
  stop: () => stepped("Stopping the runner", (log) => runner.stop(process.env, log)),
  status: () => stepped("Asking the runner", (log) => runner.status(process.env, log), undefined, { 1: "skip" }),
  logs: () => runner.logs(),
  resume: (rest) => resume(rest[0]),
  up: async () => {
    // A runner kept because sessions are in the way still serves: the shell is brought up to date, and the exit code says so.
    const code = await stepped("Starting the runner", (log) => runner.start(process.env, log));
    if (code !== 0 && code !== runner.KEPT) return code;
    const platform = currentPlatform();
    const unavailable = platform.unavailable();
    if (unavailable) {
      ui.line(`${ui.mark("skip")} ${unavailable}: only the runner was started`);
      return code;
    }
    // installCurrentShell(platform, under a spinner): stops an outdated shell first.
    if ((await shellInstall(platform)) !== 0) return 1;
    startShell();
    return code;
  },
  setup: async (rest) => {
    const parsed = parseSetupArgs(rest);
    if (!parsed.ok) usageError(parsed.error);
    const { options } = parsed;
    const platform = currentPlatform();
    const ask = !options.yes && term.interactive ? await clackAsk(promptOutput(term)) : DEFAULTS;
    const version = ((await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version?: string }).version;
    return setup(
      options,
      platform,
      {
        link: (dir, log) => link(dir, process.env, log),
        installShell: (log) => installCurrentShell(platform, log),
        startRunner: (log) => runner.start(process.env, log),
        runnerUrl: () => runner.runnerUrl(),
        startShell: (open) => (open ? prompt(undefined, platform) : start(undefined, platform)),
        login: async (on) => (await login(on ? "on" : "off", undefined, platform)).openAtLogin === true,
        agentLogin: (agent) => agentLogin(agent),
      },
      ask,
      { ui: makeUi({ term, guide: true }), probes: machineProbes(platform), version },
    );
  },
  uninstall: (rest) => {
    const options = parseUninstallArgs(rest);
    if (!options) usageError(`uninstall takes --purge and --link-dir <folder>, not ${rest.join(" ")}`);
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
    }).then((code) => {
      // Installed by `bun install -g`: the package itself is bun's to remove.
      if (installKind() === "package") ui.line(`  the app itself: ${c.cyan(`bun remove --global ${packageName()}`)}`);
      return code;
    });
  },
  "shell install": () =>
    stepped("Installing the shell", async (log) => {
      await install(undefined, log);
      writeRunnerLocation(undefined, undefined, log);
    }, (code) => (code === 0 ? "shell installed" : undefined)),
  "shell start": startShell,
  doctor: (rest) => {
    const options = parseDoctorArgs(rest);
    if (!options) usageError(`doctor takes --json, not ${rest.join(" ")}`);
    return doctor(process.env, console.log, undefined, undefined, options, ui);
  },
  "shell stop": async () => {
    await stop();
    ui.line(`${ui.mark("ok")} the shell was asked to quit`);
  },
  "shell login": async (rest) => {
    const action = parseLogin(rest[0]);
    if (!action || rest.length !== 1) usageError("shell login takes on, off or status");
    const { openAtLogin } = await login(action);
    ui.line(`${ui.mark(openAtLogin ? "ok" : "skip")} start on login is ${openAtLogin ? "on" : "off"}`);
  },
  login: (rest) => {
    const agent = parseLoginAgent(rest);
    if (!agent) usageError(`login takes claude or codex, not ${rest.join(" ")}`);
    return agentLogin(agent);
  },
  update: () => update((l) => ui.line(`${ui.mark("ok")} ${l}`)),
  link: (rest) => link(rest[0]),
  unlink: (rest) => unlink(rest[0]),
  help: () => console.log(usage()),
  "plugin new": async (rest) => {
    if (rest.length !== 1) usageError("plugin new takes a name, such as hacker-news");
    const made = newPlugin(rest[0]!);
    if ("error" in made) {
      ui.line(`${ui.mark("fail")} ${made.error}`);
      return 1;
    }
    ui.line(`${ui.mark("ok")} wrote ${made.file}`);
    // A running runner reads it at once; it starts on, as the person's own plugins do.
    const url = await runner.runnerUrl();
    const reloaded = url
      ? await fetch(new URL("/api/plugins/reload", url), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.ok, () => false)
      : false;
    ui.line(reloaded ? `${ui.mark("ok")} the runner loaded it: its tab is in the dock` : `${ui.mark("skip")} the runner is not running: it loads the plugin when it starts`);
    ui.line(`  edit it, then Settings → Plugins → Reload plugins. How: docs/plugins.md`);
  },
  "shell selftest": async () => {
    process.exitCode = await (await import("./shell/selftest-run")).selfTestRun();
  },
};

const words = process.argv.slice(2);
// The first plain `cleat`, before there is a config: setup.
const picked = words.length === 0 && firstRun() ? { name: "setup", rest: [] } : pick(words, Object.keys(commands));
if (!picked) usageError(`unknown command: ${words.join(" ")}`);
const { name, rest } = picked;
/** How many words each command takes after its name; the others take none. */
const takes: Record<string, number> = { setup: Infinity, uninstall: Infinity, login: 1, start: 1, restart: 1, resume: 1, doctor: 1, "shell login": 1, "plugin new": 1, link: 1, unlink: 1 };
if (rest.length > (takes[name] ?? 0)) usageError(`${name} does not take ${rest.join(" ")}`);
try {
  const code = await commands[name]!(rest);
  if (typeof code === "number") process.exitCode = code;
} catch (e) {
  console.error(`${ui.mark("fail")} ${errorText(e)}`);
  process.exit(1);
}
