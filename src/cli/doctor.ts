// `cleat doctor`: which layout this is, and whether each prerequisite and part is there, each with a one-line fix.
// The probes are passed in, so tests check the report without the machine's own git or Claude Code.
import { existsSync, readFileSync } from "node:fs";
import { claudeBinary } from "../runner/agent-claude";
import { codexBinary } from "../runner/agent-codex";
import { loadConfig } from "../runner/config";
import { isInstalled, login, pidFile } from "../shell/install";
import { autostartFile, autostartOn, currentPlatform, type Layout, type Platform } from "../shell/platform";
import { runnerUrl } from "./runner";
import { makeUi, termOf, type State, type Ui } from "./ui";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

export interface Check {
  name: string;
  ok: boolean;
  /** Something needed: doctor exits 1 when it is not ok. The rest are parts `cleat up` brings up. */
  needed: boolean;
  /** What was found: a version, a path, or why it is missing. */
  detail: string;
  /** One line: what to do when it is not ok. */
  fix: string;
}

/** What doctor asks the machine. */
export interface Probes {
  /** The first line a command prints, or null when it cannot be run or fails. */
  output(cmd: string[]): string | null;
  /** The config's path, or the error reading it gave. */
  config(): { ok: true; path: string } | { ok: false; error: string };
  /** The runner's URL when one answers. */
  runner(): Promise<string | null>;
  shellInstalled(): boolean;
  /** The running shell's pid, or null when none runs. */
  shellPid(): number | null;
  /** Whether the shell starts at login; null when it cannot be told. */
  login(): Promise<boolean | null>;
  /** The codex binary the runner's Codex agent runs (agent-codex.ts codexBinary), or null when it isn't installed. */
  codex(): string | null;
  /** The Claude Code the runner runs: the Agent SDK's own (agent-claude.ts claudeBinary). Without it, or without this probe, `claude` on the PATH. */
  claude?(): string | null;
  /**
   * Runs these commands at once, in the background, so that `output` answers them from what they printed:
   * a spinner keeps turning while they run. Optional; without it `output` runs each when asked.
   */
  warm?(cmds: string[][]): Promise<void>;
}

/** The commands each prerequisite runs, by its name: what `warm` is given before the check. */
export function commandsFor(name: string, codex: string | null = null, claude = "claude"): string[][] {
  const all: Record<string, string[][]> = {
    git: [["git", "--version"]],
    bun: [],
    "Claude Code": [[claude, "--version"]],
    "Claude Code login": [[claude, "auth", "status"]],
    Codex: codex ? [[codex, "--version"]] : [],
    "Codex login": codex ? [[codex, "login", "status"]] : [],
  };
  return all[name] ?? [];
}

/** Every command the prerequisites and Codex's checks run. */
export function allCommands(codex: string | null, claude = "claude"): string[][] {
  return ["git", "Claude Code", "Claude Code login", "Codex", "Codex login"].flatMap((n) => commandsFor(n, codex, claude));
}

/** The Claude Code command the checks run: the Agent SDK's own, else `claude` on the PATH. */
export function claudeCommand(probes: Pick<Probes, "claude">): string {
  return probes.claude?.() ?? "claude";
}

const LAYOUT_WORDS: Record<Layout, string> = {
  "windows-wsl": "the runner in WSL, the shell on Windows",
  macos: "the runner and the shell on this Mac",
  linux: "the runner and the shell on this machine",
};

function gitFix(layout: Layout): string {
  return layout === "macos" ? "install git: `xcode-select --install`, or `brew install git`" : "install git: `sudo apt install git` (or your distribution's package)";
}

/**
 * The prerequisites: bun (this process), Claude Code and its login, and git (optional: only a git checkout
 * needs it, to update). No Node or npm: Electron comes from its release (D0045). Claude Code is the Agent SDK's
 * own, which `bun install` brings; `claude` on the PATH is used only when that one is missing.
 * Setup checks these before it asks anything.
 */
export function prerequisites(platform: Platform, probes: Pick<Probes, "output" | "claude">): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  const git = probes.output(["git", "--version"]);
  add({ name: "git", ok: git !== null, needed: false, detail: git ?? "not found: needed only to update a git checkout", fix: gitFix(platform.layout) });

  add({ name: "bun", ok: true, needed: true, detail: `${Bun.version} (${process.execPath})`, fix: "install bun: https://bun.sh" });

  const cmd = claudeCommand(probes);
  const claude = probes.output([cmd, "--version"]);
  add({
    name: "Claude Code",
    ok: claude !== null,
    needed: true,
    detail: claude === null ? "not found" : cmd === "claude" ? claude : `${claude}, the Agent SDK's`,
    fix: "`cleat update` installs it again with the app (the Agent SDK brings Claude Code)",
  });

  if (claude !== null) {
    const status = probes.output([cmd, "auth", "status"]);
    const loggedIn = status !== null && /"loggedIn"\s*:\s*true/.test(status);
    add({ name: "Claude Code login", ok: loggedIn, needed: true, detail: loggedIn ? "logged in" : "not logged in", fix: "log in: `cleat login`" });
  }
  return out;
}

/** Codex, the second agent (docs/agents.md), and its login: optional, as sessions run on Claude Code unless the config says codex. */
export function codexChecks(probes: Pick<Probes, "output" | "codex">): Check[] {
  const out: Check[] = [];
  const codex = probes.codex();
  const codexVersion = codex === null ? null : probes.output([codex, "--version"]);
  out.push({ name: "Codex", ok: codexVersion !== null, needed: false, detail: codexVersion ?? "not installed", fix: "`cleat update` installs it again with the app (the Codex SDK brings it); only needed for sessions on Codex" });
  if (codexVersion !== null) {
    const status = probes.output([codex!, "login", "status"]);
    const loggedIn = status !== null && /^logged in/i.test(status);
    out.push({ name: "Codex login", ok: loggedIn, needed: false, detail: loggedIn ? status! : "not logged in", fix: "log in: `cleat login codex` (only needed for sessions on Codex)" });
  }
  return out;
}

/** Every check, in the order doctor prints them. */
export async function checks(platform: Platform, probes: Probes, env: Env = process.env): Promise<Check[]> {
  const out: Check[] = prerequisites(platform, probes);
  const add = (c: Check) => out.push(c);

  const config = probes.config();
  add({ name: "config", ok: config.ok, needed: true, detail: config.ok ? config.path : config.error, fix: "correct the config file (README, \"Config\")" });

  const unavailable = platform.unavailable(env);
  if (platform.layout === "windows-wsl") {
    add({ name: "Windows", ok: unavailable === null, needed: true, detail: unavailable ?? "the Windows disk is at /mnt/c", fix: "run cleat inside WSL 2, with the Windows disk mounted at /mnt/c" });
  } else if (platform.layout === "linux") {
    add({ name: "display", ok: unavailable === null, needed: false, detail: unavailable ?? (env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` : `DISPLAY=${env.DISPLAY}`), fix: "run cleat from a desktop session: the shell needs a display" });
  }

  out.push(...codexChecks(probes));

  const url = config.ok ? await probes.runner() : null;
  add({ name: "runner", ok: url !== null, needed: false, detail: url ? `running at ${url}` : "not running", fix: "`cleat start` (or `cleat up`)" });

  const installed = probes.shellInstalled();
  // windows-wsl asks Windows for the folder: without Windows there is none to name.
  let folder: string;
  try {
    folder = platform.shellPaths().app;
  } catch {
    folder = "the shell's folder (Windows could not be asked)";
  }
  add({ name: "shell installed", ok: installed, needed: false, detail: installed ? folder : `not in ${folder}`, fix: "`cleat shell install` (or `cleat up`)" });

  const pid = installed ? probes.shellPid() : null;
  add({ name: "shell running", ok: pid !== null, needed: false, detail: pid !== null ? `pid ${pid}` : "not running", fix: "`cleat shell start` (or `cleat up`)" });

  const onAtLogin = installed ? await probes.login() : null;
  add({
    name: "start at login",
    ok: onAtLogin === true,
    needed: false,
    detail: onAtLogin === null ? (installed ? "could not be read" : "the shell is not installed") : onAtLogin ? (platform.login === "xdg-autostart" ? `on (${autostartFile(env)})` : "on") : "off",
    fix: "`cleat shell login on`",
  });
  return out;
}

/** The line naming the layout. */
export function layoutLine(platform: Platform): string {
  return `layout: ${platform.layout} (${LAYOUT_WORDS[platform.layout]})`;
}

/** The mark a check gets: a tick when it is there, a cross when something needed is not, a dash for the rest. */
export function stateOf(c: Check): State {
  return c.ok ? "ok" : c.needed ? "fail" : "skip";
}

/** One line per check, names in a column, and under each that is not ok its fix. */
export function checkLines(list: Check[], ui: Pick<Ui, "mark" | "c">, indent = ""): string[] {
  const pad = Math.max(...list.map((c) => c.name.length)) + 2;
  const lines: string[] = [];
  for (const c of list) {
    lines.push(`${indent}${ui.mark(stateOf(c))} ${c.name.padEnd(pad)}${c.ok ? c.detail : ui.c.dim(c.detail)}`);
    if (!c.ok) lines.push(`${indent}  ${" ".repeat(pad)}${ui.c.dim("fix:")} ${c.fix}`);
  }
  return lines;
}

/** The summary line: everything needed is there, or what is missing. */
export function summary(list: Check[], ui: Pick<Ui, "mark">): string {
  const missing = list.filter((c) => c.needed && !c.ok);
  return missing.length === 0 ? `${ui.mark("ok")} everything needed is there` : `${ui.mark("fail")} missing: ${missing.map((c) => c.name).join(", ")}`;
}

/** The report's lines: the layout, then one line per check and, under each that is not ok, its fix, then the summary. */
export function report(platform: Platform, list: Check[], ui: Pick<Ui, "mark" | "c"> = makeUi()): string[] {
  return [ui.c.bold(layoutLine(platform)), "", ...checkLines(list, ui), "", summary(list, ui)];
}

/** What `doctor --json` prints: the layout, whether everything needed is there, and every check. */
export function reportJson(platform: Platform, list: Check[]): string {
  return JSON.stringify({ layout: platform.layout, ok: !list.some((c) => c.needed && !c.ok), checks: list }, null, 2);
}

/** What a command printed: its first line, or a JSON answer whole on one line; null when it cannot be run or fails. */
function firstOf(stdout: string, stderr: string): string {
  // Some answer on stderr only (`codex login status`).
  const text = stdout.trim() || stderr.trim();
  // A JSON answer (claude auth status) is kept whole, on one line.
  return text.startsWith("{") ? text.replace(/\s+/g, " ") : (text.split("\n")[0] ?? "");
}

/** firstLine without blocking: the event loop (and a spinner) keeps going while the command runs. */
export async function firstLineAsync(cmd: string[]): Promise<string | null> {
  const exe = Bun.which(cmd[0]!);
  if (!exe) return null;
  try {
    const p = Bun.spawn([exe, ...cmd.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return code === 0 ? firstOf(out, err) : null;
  } catch {
    return null;
  }
}

export function firstLine(cmd: string[]): string | null {
  const exe = Bun.which(cmd[0]!);
  if (!exe) return null;
  try {
    const p = Bun.spawnSync([exe, ...cmd.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    if (p.exitCode !== 0) return null;
    return firstOf(p.stdout.toString(), p.stderr.toString());
  } catch {
    return null;
  }
}

/** A command's answers, warmed in the background and read back without running it again. */
export function warmedOutput(): Pick<Probes, "output" | "warm"> {
  const cache = new Map<string, string | null>();
  const key = (cmd: string[]) => JSON.stringify(cmd);
  return {
    output: (cmd) => (cache.has(key(cmd)) ? cache.get(key(cmd))! : firstLine(cmd)),
    warm: async (cmds) => {
      await Promise.all(cmds.filter((c) => !cache.has(key(c))).map(async (c) => cache.set(key(c), await firstLineAsync(c))));
    },
  };
}

/** The machine's own answers. */
export function machineProbes(platform: Platform, env: Env = process.env): Probes {
  return {
    ...warmedOutput(),
    config: () => {
      try {
        return { ok: true, path: loadConfig(env).configPath };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    runner: () => runnerUrl(env),
    codex: codexBinary,
    claude: claudeBinary,
    shellInstalled: () => {
      try {
        return isInstalled(platform.shellPaths());
      } catch {
        return false;
      }
    },
    shellPid: () => {
      try {
        const file = pidFile(platform.settingsFile());
        if (!existsSync(file)) return null;
        const pid = Number(readFileSync(file, "utf8").trim());
        return Number.isSafeInteger(pid) && pid > 0 && platform.pidAlive(pid) ? pid : null;
      } catch {
        return null;
      }
    },
    login: async () => {
      if (platform.login === "xdg-autostart") return autostartOn(autostartFile(env));
      try {
        return (await login("status", undefined, platform)).openAtLogin;
      } catch {
        return null;
      }
    },
  };
}

export interface DoctorOptions {
  /** Print the checks as JSON (reportJson), for scripts. */
  json?: boolean;
}

/** The words after `doctor`: --json. Null when they are not that. */
export function parseDoctorArgs(words: string[]): DoctorOptions | null {
  if (words.some((w) => w !== "--json")) return null;
  return { json: words.includes("--json") };
}

/** Prints the report (a spinner while the checks run, on a terminal). Returns 1 when something needed is missing, else 0. */
export async function doctor(env: Env = process.env, log: Log = console.log, platform: Platform = currentPlatform(env), probes: Probes = machineProbes(platform, env), options: DoctorOptions = {}, ui: Ui = makeUi({ term: termOf(env) })): Promise<number> {
  const spinner = options.json ? null : ui.spin("checking");
  await probes.warm?.(allCommands(probes.codex(), claudeCommand(probes)));
  const list = await checks(platform, probes, env);
  spinner?.clear();
  if (options.json) log(reportJson(platform, list));
  else for (const line of report(platform, list, ui)) log(line);
  return list.some((c) => c.needed && !c.ok) ? 1 : 0;
}
