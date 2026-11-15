// `intuition doctor`: which layout this is, and whether each prerequisite and part is there, each with a one-line fix.
// The probes are passed in, so tests check the report without the machine's own git, Node or Claude Code.
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../runner/config";
import { isInstalled, login, pidFile } from "../shell/install";
import { autostartFile, autostartOn, currentPlatform, type Layout, type Platform } from "../shell/platform";
import { runnerUrl } from "./runner";

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

/** Every check, in the order doctor prints them. */
export async function checks(platform: Platform, probes: Probes, env: Env = process.env): Promise<Check[]> {
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

  const config = probes.config();
  add({ name: "config", ok: config.ok, needed: true, detail: config.ok ? config.path : config.error, fix: "correct the config file (README, \"Config\")" });

  const unavailable = platform.unavailable(env);
  if (platform.layout === "windows-wsl") {
    add({ name: "Windows", ok: unavailable === null, needed: true, detail: unavailable ?? "the Windows disk is at /mnt/c", fix: "run intuition inside WSL 2, with the Windows disk mounted at /mnt/c" });
  } else if (platform.layout === "linux") {
    add({ name: "display", ok: unavailable === null, needed: false, detail: unavailable ?? (env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` : `DISPLAY=${env.DISPLAY}`), fix: "run intuition from a desktop session: the shell needs a display" });
  }

  const url = config.ok ? await probes.runner() : null;
  add({ name: "runner", ok: url !== null, needed: false, detail: url ? `running at ${url}` : "not running", fix: "`intuition start` (or `intuition up`)" });

  const installed = probes.shellInstalled();
  add({ name: "shell installed", ok: installed, needed: false, detail: installed ? platform.shellPaths().app : `not in ${platform.shellPaths().app}`, fix: "`intuition shell install` (or `intuition up`)" });

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

/** The report's lines: the layout, then one line per check and, under each that is not ok, its fix. */
export function report(platform: Platform, list: Check[]): string[] {
  const lines = [`layout: ${platform.layout} (${LAYOUT_WORDS[platform.layout]})`];
  for (const c of list) {
    const mark = c.ok ? "ok  " : c.needed ? "MISS" : "--  ";
    lines.push(`  ${mark}  ${c.name}: ${c.detail}`);
    if (!c.ok) lines.push(`        fix: ${c.fix}`);
  }
  const missing = list.filter((c) => c.needed && !c.ok);
  lines.push(missing.length === 0 ? "everything needed is there" : `missing: ${missing.map((c) => c.name).join(", ")}`);
  return lines;
}

function firstLine(cmd: string[]): string | null {
  const exe = Bun.which(cmd[0]!);
  if (!exe) return null;
  try {
    const p = Bun.spawnSync([exe, ...cmd.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    if (p.exitCode !== 0) return null;
    const text = p.stdout.toString().trim();
    // A JSON answer (claude auth status) is kept whole, on one line.
    return text.startsWith("{") ? text.replace(/\s+/g, " ") : (text.split("\n")[0] ?? "");
  } catch {
    return null;
  }
}

/** The machine's own answers. */
export function machineProbes(platform: Platform, env: Env = process.env): Probes {
  return {
    output: firstLine,
    config: () => {
      try {
        return { ok: true, path: loadConfig(env).configPath };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    runner: () => runnerUrl(env),
    shellInstalled: () => isInstalled(platform.shellPaths()),
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

/** Prints the report. Returns 1 when something needed is missing, else 0. */
export async function doctor(env: Env = process.env, log: Log = console.log, platform: Platform = currentPlatform(env), probes: Probes = machineProbes(platform, env)): Promise<number> {
  const list = await checks(platform, probes, env);
  for (const line of report(platform, list)) log(line);
  return list.some((c) => c.needed && !c.ok) ? 1 : 0;
}
