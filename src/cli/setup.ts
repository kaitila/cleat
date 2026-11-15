// `intuition setup`: from a fresh clone to a running app. Checks the prerequisites, asks for the workspaces,
// the hotkeys and start at login, writes the config, starts the runner, installs and starts the shell,
// links the command and opens the pop-up. `--yes` takes every default without asking.
// What it does to the machine is passed in (Actions), so tests run the whole flow without installing anything.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { defaultHotkeys, type ShellOs } from "../../shell/src/os";
import { configPath, expandHome, loadConfig, type StoredSettings } from "../runner/config";
import { writeSettings } from "../runner/settings";
import { checkLines, firstLine, layoutLine, prerequisites, type Probes } from "./doctor";
import type { Platform } from "../shell/platform";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
type Workspace = StoredSettings["workspaces"][number];

/** How setup asks: from the terminal, or (--yes) the default at once. */
export interface Ask {
  /** A line of text; the fallback for an empty answer or the end of input. */
  line(question: string, fallback: string): Promise<string>;
  /** Yes or no; the fallback for an empty answer or the end of input. */
  yes(question: string, fallback: boolean): Promise<boolean>;
}

/** --yes: every question takes its default. */
export const DEFAULTS: Ask = {
  line: async (_q, fallback) => fallback,
  yes: async (_q, fallback) => fallback,
};

/** Asks on stdout and reads stdin line by line. At the end of input every question takes its default. */
export function terminalAsk(write: (text: string) => void = (t) => process.stdout.write(t)): Ask {
  const lines = console[Symbol.asyncIterator]();
  let ended = false;
  const read = async (question: string): Promise<string | null> => {
    write(question);
    if (ended) {
      write("\n");
      return null;
    }
    const r = await lines.next();
    if (r.done) {
      ended = true;
      write("\n");
      return null;
    }
    return String(r.value).trim();
  };
  return {
    line: async (question, fallback) => {
      const answer = await read(`${question}${fallback ? ` [${fallback}]` : ""}: `);
      return answer === null || answer === "" ? fallback : answer;
    },
    yes: async (question, fallback) => {
      for (;;) {
        const answer = await read(`${question} [${fallback ? "Y/n" : "y/N"}]: `);
        if (answer === null || answer === "") return fallback;
        if (/^y(es)?$/i.test(answer)) return true;
        if (/^no?$/i.test(answer)) return false;
        write("answer y or n\n");
      }
    },
  };
}

/** Folders in home never looked into for workspaces: caches, OS folders and dependency trees. */
const SKIP = new Set(["node_modules", "Library", "AppData", "Applications", "snap", "go", "venv", "Downloads", "Music", "Pictures", "Movies", "Videos", "Public"]);
const MAX_SUGGESTIONS = 30;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasProject(dir: string): boolean {
  return existsSync(join(dir, ".git")) || existsSync(join(dir, "CLAUDE.md"));
}

/**
 * Folders under home, one or two levels down, that hold a git repository or a CLAUDE.md, sorted. A folder
 * that is one is not looked into; hidden folders and the ones in SKIP are skipped. At most MAX_SUGGESTIONS.
 */
export function suggestWorkspaces(home: string = homedir()): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= MAX_SUGGESTIONS) return;
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const path = join(dir, name);
      if (!isDir(path)) continue;
      if (hasProject(path)) found.push(path);
      else if (depth < 2) walk(path, depth + 1);
    }
  };
  walk(home, 1);
  return found.sort();
}

/**
 * The folders an answer names: numbers pick suggestions, anything else is a path (~ allowed), separated by
 * commas. "none" is no workspaces. Each must be a folder; the error names the first that is not.
 */
export function parseWorkspaceAnswer(answer: string, suggestions: string[], cwd = process.cwd()): { ok: true; paths: string[] } | { ok: false; error: string } {
  const text = answer.trim();
  if (text === "" || text.toLowerCase() === "none") return { ok: true, paths: [] };
  const paths: string[] = [];
  for (const part of text.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    let path: string;
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > suggestions.length) return { ok: false, error: `${part} is not one of the numbers listed` };
      path = suggestions[n - 1]!;
    } else {
      path = resolve(cwd, expandHome(part));
    }
    if (!isDir(path)) return { ok: false, error: `no folder at ${part}` };
    if (!paths.includes(path)) paths.push(path);
  }
  return { ok: true, paths };
}

/** Workspaces for folders: each named after its folder, with -2, -3 for a name taken; one already in the config keeps its name and permission mode. */
export function workspacesFor(paths: string[], existing: Workspace[] = []): Workspace[] {
  const out: Workspace[] = [];
  const taken = new Set<string>();
  for (const path of paths) {
    const before = existing.find((w) => resolve(expandHome(w.path)) === path);
    let name = before?.name ?? (basename(path) || "home");
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    taken.add(name);
    out.push({ name, path, ...(before?.permissionMode ? { permissionMode: before.permissionMode } : {}) });
  }
  return out;
}

/** The OS the shell runs on, for its hotkeys' defaults. */
export function shellOsOf(platform: Platform): ShellOs {
  return platform.layout === "windows-wsl" ? "windows" : platform.layout;
}

/** What setup does to the machine. */
export interface Actions {
  /** Runs `claude auth login` in this terminal. */
  claudeLogin(): Promise<void>;
  /** Starts the runner; returns start's exit code. */
  startRunner(): Promise<number>;
  /** Installs the shell, or installs it again when it is older than the repo's, and writes where the runner lives. */
  installShell(): Promise<void>;
  /** Starts the shell; with `prompt` it opens the pop-up (a running shell is handed it). */
  startShell(prompt: boolean): void;
  /** Turns start at login on or off; returns whether it is on. */
  login(on: boolean): Promise<boolean>;
  /** Puts the command on the PATH; returns link's exit code. */
  link(dir?: string): number;
}

export interface SetupOptions {
  /** Take every default without asking. */
  yes: boolean;
  /** --workspace: these folders, without asking. */
  workspaces?: string[];
  /** --link-dir: where the command's link goes (else the folder bun is in). */
  linkDir?: string;
}

/** The exit code of start that means a runner with other code was kept (runner.KEPT): setup goes on. */
const KEPT = 3;

/** The words after `setup`: --yes, --workspace <folder> (any number), --link-dir <folder>. Null when they are not those. */
export function parseSetupArgs(words: string[]): SetupOptions | null {
  const options: SetupOptions = { yes: false };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--yes" || w === "-y") options.yes = true;
    else if (w === "--workspace" || w === "--link-dir") {
      const v = words[++i];
      if (v === undefined || v.startsWith("--")) return null;
      if (w === "--workspace") (options.workspaces ??= []).push(v);
      else options.linkDir = v;
    } else return null;
  }
  return options;
}

/** True when there is no config yet: plain `intuition` then runs setup. */
export function firstRun(env: Env = process.env): boolean {
  return !existsSync(configPath(env));
}

/** The prerequisites without which setup stops: everything but the login, which it offers and otherwise only warns about. */
const BLOCKING = ["git", "bun", "node and npm", "Claude Code"];

/** Runs setup. Returns the exit code: 1 when a prerequisite is missing or the config cannot be written. */
export async function setup(options: SetupOptions, platform: Platform, actions: Actions, ask: Ask, env: Env = process.env, log: Log = console.log, probes: Pick<Probes, "output"> = { output: firstLine }, home: string = homedir()): Promise<number> {
  log(`intuition setup, ${layoutLine(platform)}`);
  log("");
  log("1. what it needs");
  let list = prerequisites(platform, probes);
  for (const line of checkLines(list)) log(line);
  const login = list.find((c) => c.name === "Claude Code login");
  if (login && !login.ok && (await ask.yes("log in to Claude Code now (runs `claude auth login`)?", !options.yes))) {
    await actions.claudeLogin();
    list = prerequisites(platform, probes);
    const again = list.find((c) => c.name === "Claude Code login")!;
    log(`  ${again.ok ? "ok  " : "MISS"}  Claude Code login: ${again.detail}`);
  }
  const blocking = list.filter((c) => BLOCKING.includes(c.name) && !c.ok);
  if (blocking.length > 0) {
    log(`missing: ${blocking.map((c) => c.name).join(", ")}. Each has its fix above; then run setup again`);
    return 1;
  }
  if (list.some((c) => c.name === "Claude Code login" && !c.ok)) log("  sessions will fail until you log in: run `claude auth login`, then go on as you like");

  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    log(`the config cannot be read: ${e instanceof Error ? e.message : e}`);
    log("correct it or move it away, then run setup again");
    return 1;
  }
  const current = config.settings;

  log("");
  log("2. workspaces: the folders sessions run in");
  let paths: string[];
  if (options.workspaces) {
    const given = parseWorkspaceAnswer(options.workspaces.join(","), []);
    if (!given.ok) {
      log(`  --workspace: ${given.error}`);
      return 1;
    }
    paths = given.paths;
  } else {
    const kept = current.workspaces.map((w) => resolve(expandHome(w.path))).filter(isDir);
    const suggestions = [...new Set([...kept, ...suggestWorkspaces(home)])];
    if (!options.yes) {
      if (suggestions.length === 0) log("  none found in your home folder (none holds a .git or a CLAUDE.md): type paths");
      suggestions.forEach((p, i) => log(`  ${String(i + 1).padStart(2)}  ${p}`));
    }
    const fallback = kept.map((p) => String(suggestions.indexOf(p) + 1)).join(",");
    for (;;) {
      const answer = await ask.line("numbers or paths, separated by commas (none: add them later in Settings)", fallback);
      const parsed = parseWorkspaceAnswer(answer, suggestions);
      if (parsed.ok) {
        paths = parsed.paths;
        break;
      }
      log(`  ${parsed.error}`);
      if (options.yes) return 1;
    }
  }
  const workspaces = workspacesFor(paths, current.workspaces);
  for (const w of workspaces) log(`  ${w.name}: ${w.path}`);
  if (workspaces.length === 0) log("  none: add them in the Settings window, or run setup again");

  log("");
  log("3. hotkeys");
  const defaults = defaultHotkeys(shellOsOf(platform));
  const hotkey = await ask.line("  new task", current.shell?.hotkey ?? defaults.hotkey);
  const snipHotkey = await ask.line("  snip a part of the screen", current.shell?.snipHotkey ?? defaults.snipHotkey);
  log(`  new task: ${hotkey}, snip: ${snipHotkey}`);

  log("");
  log("4. start at login");
  const startOnLogin = await ask.yes("  start intuition when you log in?", true);
  log(`  ${startOnLogin ? "on" : "off"}`);

  writeSettings(config.configPath, { ...current, workspaces, shell: { hotkey, snipHotkey, dock: current.shell?.dock ?? true, startOnLogin } });
  log(`  config: ${config.configPath}`);

  log("");
  log("5. the runner");
  const code = await actions.startRunner();
  if (code !== 0 && code !== KEPT) return code;

  const unavailable = platform.unavailable(env);
  log("");
  log("6. the tray app");
  if (unavailable) {
    log(`  ${unavailable}: the tray app is not installed. The chat view is a web page meanwhile; run setup again from a desktop`);
  } else {
    await actions.installShell();
    try {
      const on = await actions.login(startOnLogin);
      log(`  start at login is ${on ? "on" : "off"}`);
    } catch (e) {
      log(`  start at login was not changed: ${e instanceof Error ? e.message : e} (\`intuition shell login ${startOnLogin ? "on" : "off"}\` later)`);
    }
  }

  log("");
  log("7. the intuition command");
  if (actions.link(options.linkDir) !== 0) log("  not linked: `bun src/cli.ts` does the same as `intuition`");

  log("");
  if (!unavailable) {
    // --yes is for scripts: the shell starts, but nobody is there for a pop-up.
    actions.startShell(!options.yes);
    log(options.yes ? "the tray app is starting" : "the tray app is starting and opens the pop-up");
  }
  log(`done. Press ${hotkey} anywhere for a new task, ${snipHotkey} to snip. \`intuition doctor\` checks everything`);
  return code;
}
