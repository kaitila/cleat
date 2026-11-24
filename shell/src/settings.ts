// The shell's own file: one JSON file in the app's user data folder. No Electron imports here.
// It holds only where the runner is (runnerUrl) and where it lives in WSL (wsl). The person's
// settings (hotkeys, dock, start on login, theme) live in the runner: see prefs.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LocalRunner, parseLocalRunner } from "./os";
import type { ShellPrefs } from "./prefs";
import { parseWsl, type WslSettings } from "./wsl";

/** The values a shell from before the runner kept the settings may still have in its file, until they are migrated. */
export type LegacyPrefs = Partial<Omit<ShellPrefs, "startOnLogin">>;

export interface Settings {
  /** Where the runner listens. The shell's windows load only this origin. */
  runnerUrl: string;
  /** Windows: where the runner lives in WSL, so the shell can start it. Absent until `shell install` has written it. */
  wsl?: WslSettings;
  /** macOS and Linux: the repo and bun on this machine, so the shell can start the runner. Absent until `shell install` has written it. */
  runner?: LocalRunner;
  /** hotkey, snipHotkey and dock as an older shell wrote them: present only while the file still has them. */
  legacy: LegacyPrefs;
}

/** The keys the file keeps: runnerUrl, and where the runner lives (wsl for the Windows shell, runner for a shell on the same machine, D0019). */
export const FILE_KEYS = ["runnerUrl", "wsl", "runner"] as const;
export const DEFAULT_SETTINGS = { runnerUrl: "http://127.0.0.1:4777" };
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

function object(text: string | null): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(text ?? "") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The settings in a file's text. Anything missing or malformed falls back to its default, or is absent. */
export function parseSettings(text: string): Settings {
  const o = object(text) ?? {};
  const key = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const legacy: LegacyPrefs = {};
  const hotkey = key(o.hotkey);
  const snipHotkey = key(o.snipHotkey);
  const chatHotkey = key(o.chatHotkey);
  if (hotkey) legacy.hotkey = hotkey;
  if (snipHotkey) legacy.snipHotkey = snipHotkey;
  if (chatHotkey) legacy.chatHotkey = chatHotkey;
  if (typeof o.dock === "boolean") legacy.dock = o.dock;
  const wsl = parseWsl(o.wsl);
  const runner = parseLocalRunner(o.runner);
  return { runnerUrl: httpUrl(o.runnerUrl) ?? DEFAULT_SETTINGS.runnerUrl, ...(wsl ? { wsl } : {}), ...(runner ? { runner } : {}), legacy };
}

/** True while the file still has a value the runner should be given (the migration has not happened yet). */
export function hasLegacy(settings: Settings): boolean {
  return Object.keys(settings.legacy).length > 0;
}

/** The settings file's text with one setting changed and everything else in it kept. Text that is not a JSON object starts from the defaults. */
export function withWsl(text: string | null, wsl: WslSettings): string {
  return JSON.stringify({ ...(object(text) ?? DEFAULT_SETTINGS), wsl }, null, 2) + "\n";
}

/** The file's text after the migration: runnerUrl, wsl and runner, as they were, and nothing else. */
export function withoutLegacy(text: string | null): string {
  const o = object(text) ?? DEFAULT_SETTINGS;
  const kept: Record<string, unknown> = {};
  for (const k of FILE_KEYS) if (k in o) kept[k] = (o as Record<string, unknown>)[k];
  return JSON.stringify(kept, null, 2) + "\n";
}

/** Rewrites the file to its kept keys once the runner has taken the rest. */
export function dropLegacy(file: string): void {
  if (!existsSync(file)) return;
  writeFileSync(file, withoutLegacy(readFileSync(file, "utf8")));
}

/** Reads the settings file, writing it with the defaults when it does not exist yet. */
export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    return { ...DEFAULT_SETTINGS, legacy: {} };
  }
  return parseSettings(readFileSync(file, "utf8"));
}
