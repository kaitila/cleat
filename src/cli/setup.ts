// `intuition setup`: from a fresh clone to a running app, as a guided flow (docs/decisions/D0030).
// 1. Requirements: a spinner per check. 2. Workspaces. 3. Hotkeys. 4. Permissions. 5. Start at login.
// Then the work, a spinner per step and a checklist, and an outro with what to do next.
// Every answer is asked before anything is written; the config is written once, atomically, at the start of the work.
// What it does to the machine (Actions) and how it asks (Ask) are passed in, so tests run the whole flow.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultHotkeys, type ShellOs } from "../../shell/src/os";
import { configPath, DEFAULT_CONFIG, expandHome, loadConfig, SettingsSchema, type StoredSettings } from "../runner/config";
import { writeSettings } from "../runner/settings";
import type { PermissionMode } from "../shared/protocol";
import type { Platform } from "../shell/platform";
import { codexChecks, commandsFor, firstLine, layoutLine, prerequisites, stateOf, type Check, type Probes } from "./doctor";
import { acceleratorError, errorText, keycaps, makeUi, stripAnsi, type State, type Ui } from "./ui";

type Env = Record<string, string | undefined>;
type Workspace = StoredSettings["workspaces"][number];

/** What a prompt gives back when the person pressed Esc or Ctrl+C. */
export const CANCEL: unique symbol = Symbol("cancel");
export type Cancel = typeof CANCEL;

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** How setup asks: clack's prompts on a terminal, or (--yes) each question's initial value at once. */
export interface Ask {
  multiselect<T>(o: { message: string; options: Choice<T>[]; initial: T[] }): Promise<T[] | Cancel>;
  select<T>(o: { message: string; options: Choice<T>[]; initial: T }): Promise<T | Cancel>;
  /** `validate` returns why the text will not do, or undefined when it will. */
  text(o: { message: string; initial?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string | Cancel>;
  confirm(o: { message: string; initial: boolean }): Promise<boolean | Cancel>;
}

/** --yes: every question takes its initial value. */
export const DEFAULTS: Ask = {
  multiselect: async (o) => o.initial,
  select: async (o) => o.initial,
  text: async (o) => o.initial ?? "",
  confirm: async (o) => o.initial,
};

/** The terminal's prompts: @clack/prompts, writing through `output` (colour codes taken out when colour is off). */
export async function clackAsk(output: NodeJS.WritableStream): Promise<Ask> {
  const p = await import("@clack/prompts");
  const out = { output: output as NodeJS.WriteStream };
  const back = <T>(v: T | symbol): T | Cancel => (p.isCancel(v) ? CANCEL : (v as T));
  // clack's Option type is conditional on the value; ours are plain { value, label, hint }.
  type Options = Parameters<typeof p.select>[0]["options"];
  return {
    multiselect: async (o) => back(await p.multiselect({ ...out, message: o.message, options: o.options as unknown as Options, initialValues: o.initial as never, required: false })) as never,
    select: async (o) => back(await p.select({ ...out, message: o.message, options: o.options as unknown as Options, initialValue: o.initial as never })) as never,
    text: async (o) => back<string>(await p.text({ ...out, message: o.message, initialValue: o.initial, placeholder: o.placeholder, validate: o.validate ? (v) => o.validate!(v ?? "") : undefined })),
    confirm: async (o) => back<boolean>(await p.confirm({ ...out, message: o.message, initialValue: o.initial })),
  };
}

// --- Workspaces ---

/** Folders in home never looked into for workspaces: caches, OS folders and dependency trees. */
const SKIP = new Set(["node_modules", "Library", "AppData", "Applications", "snap", "go", "venv", "Downloads", "Music", "Pictures", "Movies", "Videos", "Public"]);
export const MAX_SUGGESTIONS = 12;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** When a project folder last changed: the newest of the folder, its .git and its CLAUDE.md. Zero when it is not one. */
function projectTime(dir: string): number {
  const marks = [join(dir, ".git"), join(dir, "CLAUDE.md")].filter((p) => existsSync(p));
  return marks.length === 0 ? 0 : Math.max(mtime(dir), ...marks.map(mtime));
}

/**
 * Folders under home, one or two levels down, that hold a git repository or a CLAUDE.md, newest first. A
 * folder that is one is not looked into; hidden folders and the ones in SKIP are skipped. At most `max`.
 */
export function suggestWorkspaces(home: string = homedir(), max = MAX_SUGGESTIONS): string[] {
  const found: { path: string; time: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const path = join(dir, name);
      if (!isDir(path)) continue;
      const time = projectTime(path);
      if (time > 0) found.push({ path, time });
      else if (depth < 2) walk(path, depth + 1);
    }
  };
  walk(home, 1);
  return found
    .sort((a, b) => b.time - a.time || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((f) => f.path);
}

/** A folder to add, and the name it was given (else it is named after the folder). */
export interface WorkspaceEntry {
  path: string;
  name?: string;
}

/** One --workspace: `name=path` or a path alone (~ allowed). The path must be a folder. */
export function parseWorkspaceFlag(value: string, cwd = process.cwd()): { ok: true; entry: WorkspaceEntry } | { ok: false; error: string } {
  const eq = value.indexOf("=");
  // A name has no slash: "a=b/c" names b/c "a", while "./x=y" is a path with an = in it.
  const named = eq > 0 && !value.slice(0, eq).includes("/");
  const name = named ? value.slice(0, eq).trim() : undefined;
  const raw = named ? value.slice(eq + 1) : value;
  if (named && name === "") return { ok: false, error: `--workspace ${value}: the name before = is empty` };
  if (raw.trim() === "") return { ok: false, error: `--workspace ${value}: no folder given` };
  const path = resolve(cwd, expandHome(raw.trim()));
  if (!isDir(path)) return { ok: false, error: `--workspace ${value}: no folder at ${path}` };
  return { ok: true, entry: name ? { path, name } : { path } };
}

/** The name a folder gets: its own name (home for /), with -2, -3 when that is taken. */
export function nameFor(path: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = basename(path) || "home";
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Workspaces for folders, in order: each with the name it was given, else the one it has in the config, else
 * one after its folder. One already in the config keeps its permission mode and agent.
 */
export function workspacesFor(entries: (WorkspaceEntry | string)[], existing: Workspace[] = []): Workspace[] {
  const out: Workspace[] = [];
  const taken = new Set<string>();
  for (const e of entries) {
    const { path, name: given } = typeof e === "string" ? { path: e, name: undefined } : e;
    if (out.some((w) => w.path === path)) continue;
    const before = existing.find((w) => resolve(expandHome(w.path)) === path);
    let name = given ?? before?.name ?? nameFor(path, taken);
    if (taken.has(name)) name = nameFor(name, taken);
    taken.add(name);
    out.push({ name, path, ...(before?.permissionMode ? { permissionMode: before.permissionMode } : {}), ...(before?.agent ? { agent: before.agent } : {}) });
  }
  return out;
}

/** The OS the shell runs on, for its hotkeys' defaults. */
export function shellOsOf(platform: Platform): ShellOs {
  return platform.layout === "windows-wsl" ? "windows" : platform.layout;
}

// --- Options ---

export interface SetupOptions {
  /** Take every default without asking. */
  yes: boolean;
  /** --workspace: these folders, without asking. The first is the default. */
  workspaces?: WorkspaceEntry[];
  /** --link-dir: where the command's link goes (else the folder bun is in). */
  linkDir?: string;
  /** --login / --no-login: start at login, without asking. */
  login?: boolean;
  /** --permission-mode: auto, or default (ask for everything). */
  permissionMode?: PermissionMode;
  /** --hotkey and --snip-hotkey: Electron accelerators. */
  hotkey?: string;
  snipHotkey?: string;
}

const VALUED = ["--workspace", "--link-dir", "--permission-mode", "--hotkey", "--snip-hotkey"];

/**
 * The words after `setup`. Each valued flag takes the next word or `--flag=value`. An error says which
 * word is wrong: an unknown flag, a missing value, a folder that is not there, a hotkey Electron would refuse.
 */
export function parseSetupArgs(words: string[], cwd = process.cwd()): { ok: true; options: SetupOptions } | { ok: false; error: string } {
  const options: SetupOptions = { yes: false };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const eq = word.indexOf("=");
    const flag = word.startsWith("--") && eq > 0 ? word.slice(0, eq) : word;
    if (flag === "--yes" || flag === "-y") options.yes = true;
    else if (flag === "--no-login") options.login = false;
    else if (flag === "--login") options.login = true;
    else if (VALUED.includes(flag)) {
      const value = flag !== word ? word.slice(eq + 1) : words[++i];
      if (value === undefined || (flag === word && value.startsWith("--"))) return { ok: false, error: `${flag} needs a value` };
      if (flag === "--workspace") {
        const w = parseWorkspaceFlag(value, cwd);
        if (!w.ok) return w;
        (options.workspaces ??= []).push(w.entry);
      } else if (flag === "--link-dir") options.linkDir = value;
      else if (flag === "--permission-mode") {
        const mode = ({ auto: "auto", default: "default", ask: "default" } as const)[value as "auto"];
        if (!mode) return { ok: false, error: `--permission-mode ${value}: use auto, or default (ask for everything)` };
        options.permissionMode = mode;
      } else {
        const why = acceleratorError(value);
        if (why) return { ok: false, error: `${flag} ${value}: ${why}` };
        options[flag === "--hotkey" ? "hotkey" : "snipHotkey"] = value.trim();
      }
    } else return { ok: false, error: `unknown option: ${word}` };
  }
  return { ok: true, options };
}

/** The flags that answer a question each: without a terminal, setup needs --yes or all of them. */
export function unanswered(options: SetupOptions): string[] {
  const missing: string[] = [];
  if (!options.workspaces) missing.push("--workspace");
  if (options.hotkey === undefined) missing.push("--hotkey");
  if (options.snipHotkey === undefined) missing.push("--snip-hotkey");
  if (options.permissionMode === undefined) missing.push("--permission-mode");
  if (options.login === undefined) missing.push("--no-login (or --login)");
  return missing;
}

/** True when there is no config yet: plain `intuition` then runs setup. */
export function firstRun(env: Env = process.env): boolean {
  return !existsSync(configPath(env));
}

// --- The flow ---

/** What setup does to the machine. Each step's lines go to `log` (a spinner's progress line on a terminal). */
export interface Actions {
  /** Puts the command on the PATH; returns link's exit code. */
  link(dir: string | undefined, log: (line: string) => void): number;
  /** Installs the shell, or installs it again when it is older than the repo's, and writes where the runner lives. */
  installShell(log: (line: string) => void): Promise<void>;
  /** Starts the runner; returns start's exit code. */
  startRunner(log: (line: string) => void): Promise<number>;
  /** The URL of the runner that answers, for the outro. */
  runnerUrl(): Promise<string | null>;
  /** Starts the shell; with `prompt` it opens the pop-up (a running shell is handed it). */
  startShell(prompt: boolean): void;
  /** Turns start at login on or off; returns whether it is on. */
  login(on: boolean): Promise<boolean>;
}

/** The exit code of start that means a runner with other code was kept (runner.KEPT): setup goes on. */
const KEPT = 3;
/** The exit codes: a Ctrl+C or Esc; a question with no terminal to ask it on. */
export const CANCELLED = 130;
export const NO_TERMINAL = 2;

/** The prerequisites without which setup stops. The login only warns: sessions fail until it is done, but nothing else does. */
const BLOCKING = ["git", "bun", "node and npm", "Claude Code"];

const PERMISSION_CHOICES: Choice<PermissionMode>[] = [
  { value: "auto", label: "Auto (recommended)", hint: "a classifier lets routine tool calls run and asks you about the rest" },
  { value: "default", label: "Ask for everything", hint: "every tool call that needs permission waits for your Allow in the chat" },
];

const ADD = "\0add";

export interface SetupContext {
  env?: Env;
  probes?: Pick<Probes, "output" | "codex" | "warm">;
  home?: string;
  ui?: Ui;
  /** The version in the intro: package.json's. */
  version?: string;
  /** Whether questions can be asked: a terminal (ui.term.interactive), or --yes. Tests pass true with a scripted Ask. */
  interactive?: boolean;
}

/** Runs setup. Returns the exit code: 0, 1 when something failed, 2 with no terminal to ask on, 3 when a runner was kept, 130 when cancelled. */
export async function setup(options: SetupOptions, platform: Platform, actions: Actions, ask: Ask, context: SetupContext = {}): Promise<number> {
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();
  const ui = context.ui ?? makeUi({ guide: true });
  const probes = context.probes ?? { output: firstLine, codex: () => null };
  const interactive = options.yes || (context.interactive ?? ui.term.interactive);
  const { c } = ui;

  if (!interactive) {
    const missing = unanswered(options);
    if (missing.length > 0) {
      ui.line(`${ui.mark("fail")} setup needs a terminal to ask its questions, and this is not one`);
      ui.line(`  pass --yes to take every default, or answer them with ${missing.join(", ")}`);
      return NO_TERMINAL;
    }
  }
  /** Ends the flow at a cancelled prompt: nothing has been written yet. */
  const cancelled = () => {
    ui.outro(`${c.red(ui.m.cancel)} cancelled: nothing was written`);
    return CANCELLED;
  };

  ui.intro(`intuition ${context.version ?? ""} setup`.replace(/\s+/g, " "));
  ui.line(c.dim(layoutLine(platform)));

  // 1. Requirements.
  ui.step(1, "Requirements");
  let list: Check[];
  for (;;) {
    list = await requirements(ui, platform, probes);
    const blocking = list.filter((ch) => BLOCKING.includes(ch.name) && !ch.ok);
    if (blocking.length === 0) break;
    ui.line();
    ui.line(`${ui.mark("fail")} ${c.bold(`missing: ${blocking.map((ch) => ch.name).join(", ")}`)}`);
    ui.line(c.dim("  run each fix above in another terminal (setup never installs system packages for you)"));
    if (options.yes || !interactive) return 1;
    const again = await ask.select({ message: "Once they are fixed", options: [{ value: true, label: "Check again" }, { value: false, label: "Quit" }], initial: true });
    if (again === CANCEL) return cancelled();
    if (!again) {
      ui.outro("run `intuition setup` again once they are fixed");
      return 1;
    }
  }
  if (list.some((ch) => ch.name === "Claude Code login" && !ch.ok)) ui.line(`${ui.mark("warn")} sessions fail until you log in: run ${c.cyan("claude auth login")} in another terminal`);

  // A missing config is not written here (loadConfig would write the default one): nothing is, until every answer is in.
  const path = configPath(env);
  let current: StoredSettings;
  try {
    current = existsSync(path) ? loadConfig(env).settings : SettingsSchema.parse(DEFAULT_CONFIG);
  } catch (e) {
    ui.line(`${ui.mark("fail")} the config cannot be read: ${errorText(e)}`);
    ui.outro("correct it or move it away, then run `intuition setup` again");
    return 1;
  }

  // 2. Workspaces.
  ui.step(2, "Workspaces");
  let entries: WorkspaceEntry[];
  if (options.workspaces) {
    entries = options.workspaces;
  } else {
    const kept = current.workspaces.map((w) => resolve(expandHome(w.path))).filter(isDir);
    const suggested = suggestWorkspaces(home).filter((p) => !kept.includes(p));
    if (options.yes) entries = kept.map((path) => ({ path }));
    else {
      const picked = await ask.multiselect<string>({
        message: "Which folders can sessions run in? (space to toggle, enter to confirm)",
        options: [...kept, ...suggested].map((p) => ({ value: p, label: tilde(p, home), hint: kept.includes(p) ? "in the config" : undefined })).concat([{ value: ADD, label: "Add a folder…", hint: "type its path" }]),
        initial: kept,
      });
      if (picked === CANCEL) return cancelled();
      entries = picked.filter((p) => p !== ADD).map((path) => ({ path }));
      if (picked.includes(ADD)) {
        const added = await addFolders(ask, entries, current.workspaces, home);
        if (added === CANCEL) return cancelled();
        entries.push(...added);
      }
    }
  }
  let workspaces = workspacesFor(entries, current.workspaces);
  if (workspaces.length > 1 && !options.workspaces && !options.yes) {
    const first = await ask.select({ message: "Which one does the pop-up pick first?", options: workspaces.map((w) => ({ value: w.name, label: w.name, hint: tilde(w.path, home) })), initial: workspaces[0]!.name });
    if (first === CANCEL) return cancelled();
    workspaces = [...workspaces.filter((w) => w.name === first), ...workspaces.filter((w) => w.name !== first)];
  }
  if (workspaces.length === 0) ui.line(`${ui.mark("skip")} none for now: add them in Settings, or run setup again`);
  else for (const [i, w] of workspaces.entries()) ui.line(`${ui.mark("ok")} ${w.name}  ${c.dim(tilde(w.path, home))}${i === 0 && workspaces.length > 1 ? c.dim("  (default)") : ""}`);

  // 3. Hotkeys.
  ui.step(3, "Hotkeys");
  const defaults = defaultHotkeys(shellOsOf(platform));
  let hotkey = options.hotkey ?? current.shell?.hotkey ?? defaults.hotkey;
  let snipHotkey = options.snipHotkey ?? current.shell?.snipHotkey ?? defaults.snipHotkey;
  const shown = () => {
    ui.line(`New task   ${keycaps(hotkey, c, ui.term.color)}`);
    ui.line(`Snip       ${keycaps(snipHotkey, c, ui.term.color)}`);
  };
  shown();
  if (!options.yes && (options.hotkey === undefined || options.snipHotkey === undefined)) {
    const keep = await ask.select({ message: "Keep these hotkeys?", options: [{ value: true, label: "Keep them" }, { value: false, label: "Change them" }], initial: true });
    if (keep === CANCEL) return cancelled();
    if (!keep) {
      const validate = (v: string) => acceleratorError(v) ?? undefined;
      if (options.hotkey === undefined) {
        const h = await ask.text({ message: "New task hotkey (an Electron accelerator, such as Control+Alt+Space)", initial: hotkey, validate });
        if (h === CANCEL) return cancelled();
        hotkey = h.trim();
      }
      if (options.snipHotkey === undefined) {
        const s = await ask.text({ message: "Snip hotkey", initial: snipHotkey, validate: (v) => validate(v) ?? (v.trim().toLowerCase() === hotkey.toLowerCase() ? "the new task hotkey is already this" : undefined) });
        if (s === CANCEL) return cancelled();
        snipHotkey = s.trim();
      }
      shown();
    }
  }

  // 4. Permissions.
  ui.step(4, "Permissions");
  let permissionMode: PermissionMode = options.permissionMode ?? current.permissionMode;
  if (options.permissionMode === undefined && !options.yes) {
    const mode = await ask.select({ message: "How should sessions ask for permission?", options: PERMISSION_CHOICES, initial: permissionMode });
    if (mode === CANCEL) return cancelled();
    permissionMode = mode;
  }
  ui.line(`${ui.mark("ok")} ${PERMISSION_CHOICES.find((p) => p.value === permissionMode)!.label.replace(" (recommended)", "")}  ${c.dim(permissionMode === "auto" ? "(auto)" : "(default)")}`);

  // 5. Start at login.
  ui.step(5, "Start at login");
  let startOnLogin = options.login ?? true;
  if (options.login === undefined && !options.yes) {
    const on = await ask.confirm({ message: "Start intuition when you log in?", initial: true });
    if (on === CANCEL) return cancelled();
    startOnLogin = on;
  }
  ui.line(`${ui.mark(startOnLogin ? "ok" : "skip")} ${startOnLogin ? "on" : "off"}`);

  // The work: every answer is in, so the config is written first, at once.
  ui.step(6, "Setting up");
  const results: { title: string; state: State; retry?: string }[] = [];
  const record = (title: string, state: State, retry?: string) => results.push({ title, state, retry });

  const settings: StoredSettings = { ...current, permissionMode, workspaces, shell: { hotkey, snipHotkey, dock: current.shell?.dock ?? true, startOnLogin } };
  const written = await ui.task(
    "Writing the config",
    async () => {
      mkdirSync(dirname(path), { recursive: true });
      writeSettings(path, settings);
      return true;
    },
    () => ({ state: "ok", text: `config written  ${c.dim(tilde(path, home))}` }),
    (e) => ({ state: "fail", text: `config not written: ${errorText(e)}`, more: ["retry: intuition setup"] }),
  );
  record("config written", written === undefined ? "fail" : "ok", "intuition setup");
  if (written === undefined) return finish(ui, results, 1);

  const linkLines: string[] = [];
  const linked = await ui.task(
    "Linking the command",
    async (update) => actions.link(options.linkDir, (l) => (linkLines.push(l), update(l))),
    (code) => (code === 0 ? { state: linkLines.some((l) => l.includes("not on the PATH")) ? "warn" : "ok", text: "command linked", more: linkLines.filter((l) => l.includes("not on the PATH")) } : { state: "fail", text: "command not linked", more: [...linkLines, `retry: bun src/cli.ts link${options.linkDir ? ` ${options.linkDir}` : ""}`] }),
  );
  record("command linked", linked === 0 ? "ok" : "fail", "bun src/cli.ts link");

  const unavailable = platform.unavailable(env);
  let shellReady = false;
  if (unavailable) {
    ui.line(`${ui.mark("skip")} shell not installed  ${c.dim(`(${unavailable})`)}`);
    record("shell installed", "skip");
  } else {
    const done = await ui.task(
      "Installing the shell",
      async (update) => (await actions.installShell(update), true),
      () => ({ state: "ok", text: "shell installed" }),
      (e) => ({ state: "fail", text: `shell not installed: ${errorText(e)}`, more: ["retry: intuition shell install"] }),
    );
    shellReady = done === true;
    record("shell installed", shellReady ? "ok" : "fail", "intuition shell install");
  }

  const runnerLines: string[] = [];
  const code = await ui.task(
    "Starting the runner",
    async (update) => actions.startRunner((l) => (runnerLines.push(...l.split("\n")), update(l))),
    (code) =>
      code === 0
        ? { state: "ok", text: `runner started  ${c.dim(/https?:\/\/\S+/.exec(runnerLines.join(" "))?.[0]?.replace(/[),]$/, "") ?? "")}` }
        : code === KEPT
          ? { state: "warn", text: "runner kept (it runs older code, and sessions are in the way)", more: [...runnerLines, "retry: intuition restart"] }
          : { state: "fail", text: "runner not started", more: [...runnerLines, "retry: intuition start"] },
    (e) => ({ state: "fail", text: `runner not started: ${errorText(e)}`, more: ["retry: intuition start"] }),
  );
  record("runner started", code === 0 ? "ok" : code === KEPT ? "warn" : "fail", "intuition start");

  if (shellReady) {
    // --yes is for scripts: the shell starts, but nobody is there for a pop-up.
    const started = await ui.task(
      "Starting the shell",
      async () => (actions.startShell(!options.yes), true),
      () => ({ state: "ok", text: options.yes ? "shell started" : "shell started, opening the pop-up" }),
      (e) => ({ state: "fail", text: `shell not started: ${errorText(e)}`, more: ["retry: intuition shell start"] }),
    );
    record("shell started", started ? "ok" : "fail", "intuition shell start");
    const retry = `intuition shell login ${startOnLogin ? "on" : "off"}`;
    const on = await ui.task(
      "Setting start at login",
      () => actions.login(startOnLogin),
      (on) => (on === startOnLogin ? { state: "ok", text: `login item ${on ? "set" : "off"}` } : { state: "fail", text: `start at login is still ${on ? "on" : "off"}`, more: [`retry: ${retry}`] }),
      (e) => ({ state: "fail", text: `start at login not changed: ${errorText(e)}`, more: [`retry: ${retry}`] }),
    );
    record("login item set", on === startOnLogin ? "ok" : "fail", retry);
  } else {
    const why = unavailable ? "no shell here" : "the shell is not installed";
    ui.line(`${ui.mark("skip")} shell not started  ${c.dim(`(${why})`)}`);
    ui.line(`${ui.mark("skip")} login item not set  ${c.dim(`(${why})`)}`);
    if (!unavailable) {
      record("shell started", "fail", "intuition shell start");
      record("login item set", "fail", `intuition shell login ${startOnLogin ? "on" : "off"}`);
    }
  }

  const url = code === 0 || code === KEPT ? await actions.runnerUrl().catch(() => null) : null;
  const exit = results.some((r) => r.state === "fail") ? 1 : code === KEPT ? KEPT : 0;
  const next = [
    `${c.bold("Done.")} ${exit === 0 ? "intuition is set up." : "Some steps need another try (above)."}`,
    "",
    ...padded([keycaps(hotkey, c, ui.term.color), keycaps(snipHotkey, c, ui.term.color)]).map((k, i) => `${k}  ${i === 0 ? "a new task, from anywhere" : "snip a part of the screen"}`),
    "",
    unavailable ? `chat: ${url ?? "intuition start, then open the URL it prints"}` : `chat: the tray icon${url ? `, or ${url}` : ""}`,
    `settings: the tray menu${url ? `, or ${url}/settings` : ""}`,
    `${c.cyan("intuition doctor")} checks everything`,
  ];
  return finish(ui, results, exit, next);
}

/** The requirements, each under its own spinner: a tick, a cross with its fix, or a dash for an optional one. */
async function requirements(ui: Ui, platform: Platform, probes: Pick<Probes, "output" | "codex" | "warm">): Promise<Check[]> {
  const codex = probes.codex();
  const pad = "Claude Code login".length + 2;
  const done = (ch: Check) => ({ state: stateOf(ch), text: `${ch.name.padEnd(pad)}${ui.c.dim(ch.needed ? ch.detail : `${ch.detail} (optional)`)}`, more: ch.ok ? [] : [`${" ".repeat(pad)}fix: ${ch.fix}`] });
  const all = () => [...prerequisites(platform, probes), ...codexChecks(probes)];
  for (const name of ["git", "bun", "node and npm", "Claude Code", "Claude Code login", "Codex", "Codex login"]) {
    await probes.warm?.(commandsFor(name, codex));
    // The logins are checked only when their program is there.
    const check = all().find((ch) => ch.name === name);
    if (!check) continue;
    await ui.task(`Checking ${name}`, async () => {
      await probes.warm?.(commandsFor(name, codex));
      return check;
    }, done);
  }
  return all();
}

/** "Add a folder…": a path, checked to be a folder, then its name; again until the person says no more. */
async function addFolders(ask: Ask, picked: WorkspaceEntry[], existing: Workspace[], home: string): Promise<WorkspaceEntry[] | Cancel> {
  const added: WorkspaceEntry[] = [];
  for (;;) {
    const taken = () => [...picked, ...added].map((e) => resolve(e.path));
    const raw = await ask.text({
      message: "Folder path",
      placeholder: "~/code/project",
      validate: (v) => {
        if (v.trim() === "") return "type a folder's path (~ is your home folder)";
        const path = resolve(expandHome(v.trim()));
        if (!isDir(path)) return `no folder at ${path}`;
        if (taken().includes(path)) return "that folder is already picked";
        return undefined;
      },
    });
    if (raw === CANCEL) return CANCEL;
    const path = resolve(expandHome(raw.trim()));
    const names = workspacesFor([...picked, ...added], existing).map((w) => w.name);
    const suggested = existing.find((w) => resolve(expandHome(w.path)) === path)?.name ?? nameFor(path, names);
    const name = await ask.text({
      message: `Name for ${tilde(path, home)}`,
      initial: suggested,
      validate: (v) => (v.trim() === "" ? "a name, as the pop-up shows it" : names.includes(v.trim()) ? `${v.trim()} is taken` : undefined),
    });
    if (name === CANCEL) return CANCEL;
    added.push({ path, name: name.trim() });
    const more = await ask.confirm({ message: "Add another folder?", initial: false });
    if (more === CANCEL) return CANCEL;
    if (!more) return added;
  }
}

/**
 * The outro. Each step already ended on its own line with its mark, so the checklist is those lines; here only
 * the steps that failed are named again, with the command that retries each.
 */
function finish(ui: Ui, results: { title: string; state: State; retry?: string }[], exit: number, next?: string[]): number {
  const failed = results.filter((r) => r.state === "fail");
  if (failed.length > 0) {
    ui.line();
    ui.line(`${ui.mark("fail")} ${ui.c.bold(`${failed.length === 1 ? "one step" : `${failed.length} steps`} to try again`)}`);
    for (const r of failed) ui.line(`  ${r.title.replace(/ (written|linked|installed|started|set)$/, "")}: ${ui.c.cyan(r.retry ?? "intuition setup")}`);
  }
  ui.outro((next ?? ["Setup stopped: run `intuition setup` again once the step above is fixed."]).join("\n"));
  return exit;
}

/** Strings padded to the widest one's visible width (colour codes not counted). */
function padded(list: string[]): string[] {
  const w = (s: string) => Bun.stringWidth(stripAnsi(s));
  const max = Math.max(...list.map(w));
  return list.map((s) => s + " ".repeat(max - w(s)));
}

/** A path with the home folder written ~. */
function tilde(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
