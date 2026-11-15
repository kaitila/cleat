// The person's settings, owned by the runner: what the shell reads from GET /api/settings and the
// 'settings' message on /ws, what it writes with PUT /api/settings, and the decisions it takes on
// them (re-registering a hotkey, the one-time migration from its own file). No Electron imports here.
//
// The types are the settings contract of T-0030 (docs/protocol.md, "Settings"), copied here while
// that task's src/shared/protocol.ts is not merged: the shell is built against the same shape.

export type Theme = "system" | "light" | "dark";
export type PermissionMode = "auto" | "default";

/** What the shell applies: its two hotkeys, the dock, and start on login. */
export interface ShellPrefs {
  /** An Electron accelerator: opens the pop-up with the clipboard attached. */
  hotkey: string;
  /** An Electron accelerator: freezes the screens for a snip. */
  snipHotkey: string;
  /** Whether the dock is shown at the top of the screen. */
  dock: boolean;
  /** Whether Windows starts the shell at login (Electron's login item). */
  startOnLogin: boolean;
}

/** GET /api/settings, the body of PUT /api/settings, and the 'settings' message's `settings`. */
export interface RunnerSettings {
  theme: Theme;
  permissionMode: PermissionMode;
  workspaces: { name: string; path: string; permissionMode?: PermissionMode }[];
  /** Null until something sets it: the shell then sends its own values once (the migration). */
  shell: ShellPrefs | null;
  port: number;
}

/** What the shell uses until the runner has said otherwise, and for anything its file never had. */
export const SHELL_DEFAULTS: Omit<ShellPrefs, "startOnLogin"> = { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true };

/**
 * The self-test's hotkeys, unlikely to be anyone's, so it never clashes with a running shell: the two
 * its old-style file starts with, the one it changes the hotkey to through the stub runner, and one
 * that is not a valid accelerator.
 */
export const SELF_TEST_PREFS = {
  hotkey: "Control+Alt+Shift+F11",
  snipHotkey: "Control+Alt+Shift+F10",
  changed: "Control+Alt+Shift+F12",
  invalid: "Control+Alt+Nope",
} as const;

export const SETTINGS_PATH = "/api/settings";
/** The Settings window's page. Links to either of these open that window. */
export const SETTINGS_PAGE = "/assets/settings.html";
export const SETTINGS_ALIAS = "/settings";
/** The Settings window: a normal window like the chat, smaller. */
export const SETTINGS_WINDOW = { width: 720, height: 640 } as const;
/** The socket's reconnect: quick at first, then every 15 seconds at most, never giving up. */
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is PermissionMode => v === "auto" || v === "default";

/** The shell's part, or null when it is not one. Hotkeys are trimmed; an empty one is not a hotkey. */
export function parseShellPrefs(v: unknown): ShellPrefs | null {
  if (!isObject(v)) return null;
  const key = (k: unknown) => (typeof k === "string" && k.trim() ? k.trim() : null);
  const hotkey = key(v.hotkey);
  const snipHotkey = key(v.snipHotkey);
  if (!hotkey || !snipHotkey || typeof v.dock !== "boolean" || typeof v.startOnLogin !== "boolean") return null;
  return { hotkey, snipHotkey, dock: v.dock, startOnLogin: v.startOnLogin };
}

/** Settings as the runner sent them, or null when they are not (the shell then keeps what it has). */
export function parseRunnerSettings(v: unknown): RunnerSettings | null {
  if (!isObject(v)) return null;
  if (v.theme !== "system" && v.theme !== "light" && v.theme !== "dark") return null;
  if (!isMode(v.permissionMode) || typeof v.port !== "number" || !Array.isArray(v.workspaces)) return null;
  const workspaces: RunnerSettings["workspaces"] = [];
  for (const w of v.workspaces) {
    if (!isObject(w) || typeof w.name !== "string" || typeof w.path !== "string") return null;
    if (w.permissionMode !== undefined && !isMode(w.permissionMode)) return null;
    workspaces.push({ name: w.name, path: w.path, ...(w.permissionMode ? { permissionMode: w.permissionMode } : {}) });
  }
  const shell = v.shell === null ? null : parseShellPrefs(v.shell);
  if (v.shell !== null && !shell) return null;
  return { theme: v.theme, permissionMode: v.permissionMode, workspaces, shell, port: v.port };
}

/** The settings in a message on /ws, or null for every other message (sessions, events, deltas...). */
export function settingsMessage(data: unknown): RunnerSettings | null {
  if (typeof data !== "string" || !data.includes('"settings"')) return null;
  try {
    const m = JSON.parse(data) as unknown;
    return isObject(m) && m.type === "settings" ? parseRunnerSettings(m.settings) : null;
  } catch {
    return null;
  }
}

/** The whole settings to PUT, with the shell's part replaced. Everything else goes back as it came. */
export function withShell(settings: RunnerSettings, shell: ShellPrefs): RunnerSettings {
  return { ...settings, shell };
}

/** ws://host:port/ws for the runner's http://host:port. */
export function socketUrl(runnerUrl: string): string {
  const url = new URL("/ws", runnerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** How long to wait before the n-th reconnect in a row (n from 0): doubling from a second, at most 15. */
export function reconnectMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/**
 * The migration: what the shell sends the first time it finds the runner has no shell settings.
 * The values the person had in the shell's own settings.json, the defaults for the rest, and start
 * on login as Windows has it now.
 */
export function migratedPrefs(local: Partial<Omit<ShellPrefs, "startOnLogin">>, startOnLogin: boolean): ShellPrefs {
  return {
    hotkey: local.hotkey ?? SHELL_DEFAULTS.hotkey,
    snipHotkey: local.snipHotkey ?? SHELL_DEFAULTS.snipHotkey,
    dock: local.dock ?? SHELL_DEFAULTS.dock,
    startOnLogin,
  };
}

/** What the shell does with a hotkey change: the accelerator that now works, and the one that could not be registered, if any. */
export interface HotkeySwap {
  active: string | null;
  failed: string | null;
}

/**
 * Moves a global shortcut from `current` to `wanted`. The new one is registered first, and only
 * once it is the old one is released: a hotkey that is taken by another program, held by the shell's
 * other hotkey, or is not a valid accelerator (Electron throws for those) leaves the old one working.
 * `current` is null when nothing is registered yet (the first start, or a first one that failed).
 */
export function swapHotkey(
  current: string | null,
  wanted: string,
  ops: { register(accelerator: string): boolean; unregister(accelerator: string): void; isRegistered(accelerator: string): boolean },
): HotkeySwap {
  if (wanted === current) return { active: current, failed: null };
  let ok = false;
  try {
    // Already registered by the shell, and not as this hotkey: the other one holds it.
    ok = !ops.isRegistered(wanted) && ops.register(wanted);
  } catch {
    ok = false;
  }
  if (!ok) return { active: current, failed: wanted };
  if (current !== null) ops.unregister(current);
  return { active: wanted, failed: null };
}

/**
 * True when one hotkey is to take the key the other holds now while that one moves to another: the
 * two traded, or one moved onto the other's old key. Both are then released before either registers.
 * A hotkey wanting the key the other keeps is not this: that one is taken, and fails.
 */
export function releaseBoth(active: { hotkey: string | null; snipHotkey: string | null }, wanted: { hotkey: string; snipHotkey: string }): boolean {
  const takes = (want: string, mine: string | null, other: string | null, otherWants: string) => want !== mine && want === other && otherWants !== other;
  return takes(wanted.hotkey, active.hotkey, active.snipHotkey, wanted.snipHotkey) || takes(wanted.snipHotkey, active.snipHotkey, active.hotkey, wanted.hotkey);
}

/** The notification for a hotkey that could not be registered: it names it, and says what still works. */
export function hotkeyNotice(which: "hotkey" | "snip hotkey", failed: string, active: string | null): { title: string; body: string } {
  const still = active ? `${active} still works.` : `No ${which} works until another is chosen.`;
  return {
    title: `intuition: the ${which} could not be set`,
    body: `${failed} could not be registered: another program holds it, the shell's other hotkey is the same, or it is not a valid shortcut. ${still} Choose another in Settings.`,
  };
}
