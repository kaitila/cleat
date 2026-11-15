// What differs in the shell between the OS it runs on: Windows (the runner in WSL), macOS and Linux
// (the runner on the same machine). No Electron imports here: main.ts asks these and does the rest.
import type { Area } from "./geometry";
import { runnerCommand, type WslSettings } from "./wsl";

/** The OS the shell itself runs on. The command line's layouts map onto it: windows-wsl is "windows". */
export type ShellOs = "windows" | "macos" | "linux";

type Env = Record<string, string | undefined>;

export function shellOs(platform: string = process.platform): ShellOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/** The two hotkeys' defaults: Command on a Mac where Windows and Linux use Control. */
export function defaultHotkeys(os: ShellOs): { hotkey: string; snipHotkey: string } {
  return os === "macos" ? { hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S" } : { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S" };
}

// --- The runner ---

/** Where a shell on macOS or Linux finds the runner: this repo with this bun, on the same machine. `shell install` writes it. */
export interface LocalRunner {
  kind: "local";
  repo: string;
  bun: string;
}

/** An absolute path without control characters: it starts with a slash, so it is never read as an option. */
function absolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096 && !/[\u0000-\u001f]/.test(value);
}

/** The `runner` object of the settings, or undefined unless it is whole. */
export function parseLocalRunner(value: unknown): LocalRunner | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, repo, bun } = value as Record<string, unknown>;
  return kind === "local" && absolute(repo) && absolute(bun) ? { kind, repo, bun } : undefined;
}

/** How the shell starts the runner: a program, its arguments, and whether it is a detached child of its own. */
export interface RunnerSpawn {
  file: string;
  args: string[];
  /** True for a local runner: its own process group, so it outlives the shell. wsl.exe is left attached, as before. */
  detached: boolean;
}

/**
 * The command that starts the runner, from what the settings say: wsl.exe on Windows, or bun on the
 * repo's cli on macOS and Linux. Both pass --login-env, so the runner gets the person's login shell's
 * PATH (claude, git) even when the shell itself was started at login. Null when the settings say nothing usable.
 */
export function runnerSpawn(os: ShellOs, where: { wsl?: WslSettings; runner?: LocalRunner }, systemRoot?: string): RunnerSpawn | null {
  if (os === "windows") {
    if (!where.wsl) return null;
    const { file, args } = runnerCommand(where.wsl, systemRoot);
    return { file, args, detached: false };
  }
  if (!where.runner) return null;
  return { file: where.runner.bun, args: [`${where.runner.repo.replace(/\/+$/, "")}/src/cli.ts`, "start", "--login-env"], detached: true };
}

/** What the "runner is not running" notification says to do. `tried`: the shell had a way to start it and it did not come up. */
export function runnerDownHint(os: ShellOs, tried: boolean): string {
  const where = os === "windows" ? "in WSL" : "in a terminal";
  return tried
    ? `The shell tried to start it and it did not come up. ${os === "windows" ? "In WSL" : "In a terminal"}: intuition start, and intuition logs`
    : `Start it ${where}: intuition up`;
}

// --- The dock ---

/**
 * The area the dock hangs from. Windows and Linux: the display's bounds, so the dock touches the very
 * top edge. macOS: from the work area's top down, so it sits below the menu bar (and below the notch,
 * whose height the menu bar takes), centred on the display.
 */
export function dockArea(os: ShellOs, bounds: Area, workArea: Area): Area {
  if (os !== "macos") return bounds;
  const top = Math.max(bounds.y, workArea.y);
  return { x: bounds.x, y: top, width: bounds.width, height: bounds.height - (top - bounds.y) };
}

/** Desktops that run a compositor by default on X11: a transparent window shows what is under it. */
const COMPOSITED = /\b(GNOME|KDE|Cinnamon|Budgie|Pantheon|Unity|Deepin|COSMIC|XFCE|MATE|LXQt)\b/i;

/**
 * Whether the dock's window can be transparent. Windows and macOS: always. Linux: under Wayland (the
 * compositor is the display server; XWayland included), or on X11 with a desktop that composites. A bare
 * window manager on X11 paints a transparent window black, so the dock is then an opaque window the
 * island's size. INTUITION_DOCK_OPAQUE=1 or 0 overrides the guess.
 */
export function dockTransparent(os: ShellOs, env: Env = process.env): boolean {
  if (env.INTUITION_DOCK_OPAQUE === "1") return false;
  if (env.INTUITION_DOCK_OPAQUE === "0") return true;
  if (os !== "linux") return true;
  return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland" || COMPOSITED.test(env.XDG_CURRENT_DESKTOP ?? "");
}

/** The opaque dock's window: the island of a state, at the top centre of where the transparent window would be. */
export function opaqueDockBounds(full: Area, island: Area): Area {
  return { x: full.x + Math.round(island.x), y: full.y + island.y, width: island.width, height: island.height };
}

// --- Linux ---

/**
 * Which display server Electron talks to on Linux. With DISPLAY set the shell asks for X11 (XWayland
 * on a Wayland desktop): global shortcuts, window placement and always-on-top work there. Without it,
 * only Wayland is left.
 */
export function linuxOzone(env: Env = process.env): "x11" | "wayland" | null {
  if (env.DISPLAY) return "x11";
  if (env.WAYLAND_DISPLAY) return "wayland";
  return null;
}

/** True on a GNOME desktop: its top bar shows tray icons only with an AppIndicator extension. */
export function isGnome(env: Env = process.env): boolean {
  return /\bGNOME\b/i.test(env.XDG_CURRENT_DESKTOP ?? "");
}

/** True when `gnome-extensions list --enabled` lists an AppIndicator (or KStatusNotifierItem) extension. */
export function hasAppIndicator(enabledExtensions: string): boolean {
  return /appindicator|kstatusnotifier|ubuntu-appindicators/i.test(enabledExtensions);
}

/** What the shell says once on Linux when the tray or the hotkeys may not work, each with what to do. Empty when nothing is known to be wrong. */
export function linuxNotices(env: Env, enabledExtensions: string | null): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  if (isGnome(env) && enabledExtensions !== null && !hasAppIndicator(enabledExtensions)) {
    out.push({
      title: "intuition: GNOME shows no tray icon",
      body: "GNOME needs the AppIndicator extension for the tray: install gnome-shell-extension-appindicator and enable it (gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com). The hotkeys work without it.",
    });
  }
  if (linuxOzone(env) === "wayland") {
    out.push({
      title: "intuition: the hotkeys may not work under Wayland",
      body: "There is no DISPLAY, so the shell runs on Wayland, where global shortcuts may not register. Use the tray's New task and Snip, or start the shell with XWayland (DISPLAY set).",
    });
  }
  return out;
}

// --- macOS ---

/** System Settings > Privacy & Security > Screen Recording. */
export const SCREEN_RECORDING_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** What the shell says when macOS has not given it Screen Recording: the snip cannot see the screens. */
export const SCREEN_RECORDING_NOTICE = {
  title: "intuition: the snip needs Screen Recording",
  body: "macOS has not given intuition (Electron) Screen Recording, so a snip shows nothing. Allow it in System Settings > Privacy & Security > Screen Recording, then quit and start the shell again. Click to open that pane.",
} as const;

/** True when the snip can capture the screens: anything but macOS, or macOS with Screen Recording granted. */
export function screenAllowed(os: ShellOs, status: string): boolean {
  return os !== "macos" || status === "granted";
}
