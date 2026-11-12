// The shell's settings: one JSON file in the app's user data folder. No Electron imports here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Settings {
  /** Where the runner listens. The shell's windows load only this origin. */
  runnerUrl: string;
  /** An Electron accelerator: opens the pop-up with the clipboard attached. */
  hotkey: string;
}

export const DEFAULT_SETTINGS: Settings = { runnerUrl: "http://127.0.0.1:4777", hotkey: "Control+Alt+Space" };
export const SETTINGS_FILE = "settings.json";

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
export function parseSettings(text: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    runnerUrl: httpUrl(o.runnerUrl) ?? DEFAULT_SETTINGS.runnerUrl,
    hotkey: typeof o.hotkey === "string" && o.hotkey.trim() ? o.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
  };
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
