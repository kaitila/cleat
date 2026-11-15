// The shell's settings: one JSON file in the app's user data folder. No Electron imports here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultHotkeys, type LocalRunner, parseLocalRunner, type ShellOs, shellOs } from "./os";
import { parseWsl, type WslSettings } from "./wsl";

export interface Settings {
  /** Where the runner listens. The shell's windows load only this origin. */
  runnerUrl: string;
  /** An Electron accelerator: opens the pop-up with the clipboard attached. */
  hotkey: string;
  /** An Electron accelerator: freezes the screens for a snip, with the task typed right beside it. */
  snipHotkey: string;
  /** Whether the dock is shown at the top of the screen. The tray's "Show dock" checkbox writes it. */
  dock: boolean;
  /** Windows: where the runner lives in WSL, so the shell can start it. Absent until `shell install` has written it. */
  wsl?: WslSettings;
  /** macOS and Linux: the repo and bun on this machine, so the shell can start the runner. Absent until `shell install` has written it. */
  runner?: LocalRunner;
}

/** The defaults on an OS: the hotkeys use Command on a Mac. */
export function defaultSettings(os: ShellOs): Settings {
  return { runnerUrl: "http://127.0.0.1:4777", ...defaultHotkeys(os), dock: true };
}

/** The defaults on the OS this runs on. */
export const DEFAULT_SETTINGS: Settings = defaultSettings(shellOs());
export const SETTINGS_FILE = "settings.json";
/** The running shell's Windows pid, beside the settings: `up` waits for that process to end before it installs over it. */
export const PID_FILE = "shell.pid";

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The settings in a file's text. Anything missing or malformed falls back to its default. */
export function parseSettings(text: string, defaults: Settings = DEFAULT_SETTINGS): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...defaults };
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const wsl = parseWsl(o.wsl);
  const runner = parseLocalRunner(o.runner);
  return {
    runnerUrl: httpUrl(o.runnerUrl) ?? defaults.runnerUrl,
    hotkey: typeof o.hotkey === "string" && o.hotkey.trim() ? o.hotkey.trim() : defaults.hotkey,
    snipHotkey: typeof o.snipHotkey === "string" && o.snipHotkey.trim() ? o.snipHotkey.trim() : defaults.snipHotkey,
    dock: typeof o.dock === "boolean" ? o.dock : defaults.dock,
    ...(wsl ? { wsl } : {}),
    ...(runner ? { runner } : {}),
  };
}

/** The settings file's text with one setting changed and everything else in it kept. Text that is not a JSON object starts from the defaults. */
function withSetting(text: string | null, key: string, value: unknown): string {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    // Missing or broken: the defaults.
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : DEFAULT_SETTINGS;
  return JSON.stringify({ ...o, [key]: value }, null, 2) + "\n";
}

export function withWsl(text: string | null, wsl: WslSettings): string {
  return withSetting(text, "wsl", wsl);
}

export function withDock(text: string | null, dock: boolean): string {
  return withSetting(text, "dock", dock);
}

/** Writes `dock` into the settings file, keeping what else is there: the tray's checkbox is remembered. */
export function saveDock(file: string, dock: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withDock(existsSync(file) ? readFileSync(file, "utf8") : null, dock));
}

/** Reads the settings file, writing it with the defaults when it does not exist yet. */
export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    return { ...DEFAULT_SETTINGS };
  }
  return parseSettings(readFileSync(file, "utf8"));
}
