// `intuition doctor`: which layout this is, and whether each prerequisite and part is there, each with a one-line fix.
// The probes are passed in, so tests check the report without the machine's own git, Node or Claude Code.
import { existsSync, readFileSync } from "node:fs";
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
  /** Something needed: doctor exits 1 when it is not ok. The rest are parts `intuition up` brings up. */
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
  /**
   * Runs these commands at once, in the background, so that `output` answers them from what they printed:
   * a spinner keeps turning while they run. Optional; without it `output` runs each when asked.
   */
  warm?(cmds: string[][]): Promise<void>;
}

/** The commands each prerequisite runs, by its name: what `warm` is given before the check. */
export function commandsFor(name: string, codex: string | null = null): string[][] {
  const all: Record<string, string[][]> = {
    git: [["git", "--version"]],
    bun: [],
    "node and npm": [["node", "--version"], ["npm", "--version"]],
    "Claude Code": [["claude", "--version"]],
    "Claude Code login": [["claude", "auth", "status"]],
    Codex: codex ? [[codex, "--version"]] : [],
    "Codex login": codex ? [[codex, "login", "status"]] : [],
  };
  return all[name] ?? [];
}

/** Every command the prerequisites and Codex's checks run. */
export function allCommands(codex: string | null): string[][] {
  return ["git", "node and npm", "Claude Code", "Claude Code login", "Codex", "Codex login"].flatMap((n) => commandsFor(n, codex));
}

/** Electron's installer needs this Node (node_modules/electron's engines). */
export const MIN_NODE = [22, 12] as const;

/** True when a `node -v` string is at least MIN_NODE. */
export function nodeIsNew(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const LAYOUT_WORDS: Record<Layout, string> = {
  "windows-wsl": "the runner in WSL, the shell on Windows",
  macos: "the runner and the shell on this Mac",
  linux: "the runner and the shell on this machine",
};

function gitFix(layout: Layout): string {
  return layout === "macos" ? "install git: `xcode-select --install`, or `brew install git`" : "install git: `sudo apt install git` (or your distribution's package)";
}

/** The prerequisites: git, bun, Node with npm, Claude Code and its login. Setup checks these before it asks anything. */
export function prerequisites(platform: Platform, probes: Pick<Probes, "output">): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  const git = probes.output(["git", "--version"]);
  add({ name: "git", ok: git !== null, needed: true, detail: git ?? "not found", fix: gitFix(platform.layout) });

  add({ name: "bun", ok: true, needed: true, detail: `${Bun.version} (${process.execPath})`, fix: "install bun: https://bun.sh" });

  const node = probes.output(["node", "--version"]);
  const npm = probes.output(["npm", "--version"]);
  const nodeOk = node !== null && nodeIsNew(node) && npm !== null;
  add({
    name: "node and npm",
    ok: nodeOk,
    needed: true,
    detail: node === null ? "node not found" : !nodeIsNew(node) ? `node ${node} is older than ${MIN_NODE.join(".")}` : npm === null ? `node ${node}, but npm not found` : `node ${node}, npm ${npm}`,
    fix: `install Node ${MIN_NODE.join(".")} or later, with npm (https://nodejs.org, or nvm): Electron's installer needs it`,
  });

  const claude = probes.output(["claude", "--version"]);
  add({ name: "Claude Code", ok: claude !== null, needed: true, detail: claude ?? "not found", fix: "install Claude Code: https://docs.claude.com/en/docs/claude-code/setup" });

  if (claude !== null) {
    const status = probes.output(["claude", "auth", "status"]);
    const loggedIn = status !== null && /"loggedIn"\s*:\s*true/.test(status);
    add({ name: "Claude Code login", ok: loggedIn, needed: true, detail: loggedIn ? "logged in" : "not logged in", fix: "log in: `claude auth login`" });
  }
  return out;
}

/** Codex, the second agent (docs/agents.md), and its login: optional, as sessions run on Claude Code unless the config says codex. */
export function codexChecks(probes: Pick<Probes, "output" | "codex">): Check[] {
  const out: Check[] = [];
  const codex = probes.codex();
  const codexVersion = codex === null ? null : probes.output([codex, "--version"]);
  out.push({ name: "Codex", ok: codexVersion !== null, needed: false, detail: codexVersion ?? "not installed", fix: "`bun install` in the repo installs it (@openai/codex-sdk); only needed for sessions on Codex" });
  if (codexVersion !== null) {
    const status = probes.output([codex!, "login", "status"]);
    const loggedIn = status !== null && /^logged in/i.test(status);
    out.push({ name: "Codex login", ok: loggedIn, needed: false, detail: loggedIn ? status! : "not logged in", fix: "log in: `codex login` (only needed for sessions on Codex)" });
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
    add({ name: "Windows", ok: unavailable === null, needed: true, detail: unavailable ?? "the Windows disk is at /mnt/c", fix: "run intuition inside WSL 2, with the Windows disk mounted at /mnt/c" });
  } else if (platform.layout === "linux") {
    add({ name: "display", ok: unavailable === null, needed: false, detail: unavailable ?? (env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` : `DISPLAY=${env.DISPLAY}`), fix: "run intuition from a desktop session: the shell needs a display" });
  }

  out.push(...codexChecks(probes));

  const url = config.ok ? await probes.runner() : null;
  add({ name: "runner", ok: url !== null, needed: false, detail: url ? `running at ${url}` : "not running", fix: "`intuition start` (or `intuition up`)" });

  const installed = probes.shellInstalled();
  // windows-wsl asks Windows for the folder: without Windows there is none to name.
  let folder: string;
  try {
    folder = platform.shellPaths().app;
  } catch {
    folder = "the shell's folder (Windows could not be asked)";
  }
  add({ name: "shell installed", ok: installed, needed: false, detail: installed ? folder : `not in ${folder}`, fix: "`intuition shell install` (or `intuition up`)" });

  const pid = installed ? probes.shellPid() : null;
  add({ name: "shell running", ok: pid !== null, needed: false, detail: pid !== null ? `pid ${pid}` : "not running", fix: "`intuition shell start` (or `intuition up`)" });

  const onAtLogin = installed ? await probes.login() : null;
  add({
    name: "start at login",
    ok: onAtLogin === true,
    needed: false,
    detail: onAtLogin === null ? (installed ? "could not be read" : "the shell is not installed") : onAtLogin ? (platform.login === "xdg-autostart" ? `on (${autostartFile(env)})` : "on") : "off",
    fix: "`intuition shell login on`",
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
  await probes.warm?.(allCommands(probes.codex()));
  const list = await checks(platform, probes, env);
  spinner?.clear();
  if (options.json) log(reportJson(platform, list));
  else for (const line of report(platform, list, ui)) log(line);
  return list.some((c) => c.needed && !c.ok) ? 1 : 0;
}
