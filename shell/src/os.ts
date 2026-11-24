// What differs in the shell between the OS it runs on: Windows (the runner in WSL), macOS and Linux
// (the runner on the same machine). No Electron imports here: main.ts asks these and does the rest.
import type { Notch } from "./dock";
import type { Area } from "./geometry";
import { runnerCommand, type WslSettings } from "./wsl";

/** The OS the shell itself runs on. The command line's layouts map onto it: windows-wsl is "windows". */
export type ShellOs = "windows" | "macos" | "linux";

type Env = Record<string, string | undefined>;

export function shellOs(platform: string = process.platform): ShellOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/**
 * The three hotkeys' defaults: Command+Shift on a Mac where Windows and Linux use Control+Alt. The
 * chat's is J (D0046): beside ⌘K, the pages' own switch, and taken by nothing system-wide on any of
 * the three. src/web/shortcuts.js has the same for the pages, and a test holds the two together.
 */
export function defaultHotkeys(os: ShellOs): { hotkey: string; snipHotkey: string; chatHotkey: string } {
  return os === "macos"
    ? { hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S", chatHotkey: "Command+Shift+J" }
    : { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", chatHotkey: "Control+Alt+J" };
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
    ? `The shell tried to start it and it did not come up. ${os === "windows" ? "In WSL" : "In a terminal"}: holm start, and holm logs`
    : `Start it ${where}: holm up`;
}

// --- The dock ---

/**
 * The area the dock hangs from. Windows and Linux: the display's bounds, so the dock touches the very
 * top edge. macOS with a notch: the display's very top too, centred on the notch, so the island grows
 * out of it over the menu bar. macOS without one: from the work area's top down, so it sits below the
 * menu bar, centred on the display.
 */
export function dockArea(os: ShellOs, bounds: Area, workArea: Area, notch: Notch | null = null): Area {
  if (os !== "macos") return bounds;
  if (notch) return { x: bounds.x + notch.x + notch.width / 2 - bounds.width / 2, y: bounds.y, width: bounds.width, height: bounds.height };
  const top = Math.max(bounds.y, workArea.y);
  return { x: bounds.x, y: top, width: bounds.width, height: bounds.height - (top - bounds.y) };
}

/**
 * How the shell measures a Mac's notch: osascript runs this JavaScript for Automation, which asks
 * AppKit about the primary display (the first screen, the one with the menu bar). Electron's Display
 * has no notch. It prints the screen's width, the menu bar's areas left and right of the notch (both
 * 0 without one) and the height the notch takes from the top.
 */
export const NOTCH_PROBE: readonly string[] = [
  "-l",
  "JavaScript",
  "-e",
  'ObjC.import("AppKit"); var s = $.NSScreen.screens.objectAtIndex(0); ' +
    "JSON.stringify({ width: s.frame.size.width, left: s.auxiliaryTopLeftArea.size.width, right: s.auxiliaryTopRightArea.size.width, top: s.safeAreaInsets.top })",
];

/**
 * The notch from what NOTCH_PROBE printed, or null: no notch, an answer for another display than
 * `bounds` (the primary display Electron sees), or anything that is not a sensible notch.
 */
export function parseNotch(output: string, bounds: Area): Notch | null {
  let v: unknown;
  try {
    v = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { width: w, left: l, right: r, top: t } = v as Record<string, unknown>;
  const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!num(w) || !num(l) || !num(r) || !num(t)) return null;
  if (Math.round(w) !== Math.round(bounds.width) || l <= 0 || r <= 0) return null;
  const notch = { x: l, width: Math.round(w - l - r), height: Math.round(t) };
  // A notch is a small bar at the top: anything else is not one.
  if (notch.width < 40 || notch.width > 400 || notch.height < 16 || notch.height > 64) return null;
  return notch;
}

/** A stand-in notch's width, in points: about a MacBook's own (179 on a 14-inch, 185 on a 16-inch). */
export const STAND_IN_NOTCH_WIDTH = 180;
/**
 * Its height, in points: a menu bar's on a display without a notch. Fixed, not read from the work
 * area, which a full-screen app or a menu bar that hides itself changes: a stand-in that changed
 * with it would reload the dock's page each time (D0037).
 */
export const STAND_IN_NOTCH_HEIGHT = 30;

/**
 * The notch the dock hangs from on a Mac (D0037): the display's own, or on a display without one (an
 * external screen as the primary, or a measurement that failed) a stand-in drawn by the dock, at the
 * top centre of the display and as tall as a menu bar. The dock then looks and works the same on
 * every Mac display.
 */
export function dockNotchOf(measured: Notch | null, bounds: Area): Notch {
  if (measured) return measured;
  return { x: (bounds.width - STAND_IN_NOTCH_WIDTH) / 2, width: STAND_IN_NOTCH_WIDTH, height: STAND_IN_NOTCH_HEIGHT };
}

/** Desktops that run a compositor by default on X11: a transparent window shows what is under it. */
const COMPOSITED = /\b(GNOME|KDE|Cinnamon|Budgie|Pantheon|Unity|Deepin|COSMIC|XFCE|MATE|LXQt)\b/i;

/**
 * Whether the dock's window can be transparent. Windows and macOS: always. Linux: under Wayland (the
 * compositor is the display server; XWayland included), or on X11 with a desktop that composites. A bare
 * window manager on X11 paints a transparent window black, so the dock is then an opaque window the
 * island's size. HOLM_DOCK_OPAQUE=1 or 0 overrides the guess.
 */
export function dockTransparent(os: ShellOs, env: Env = process.env): boolean {
  if (env.HOLM_DOCK_OPAQUE === "1") return false;
  if (env.HOLM_DOCK_OPAQUE === "0") return true;
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
      title: "Holm: GNOME shows no tray icon",
      body: "GNOME needs the AppIndicator extension for the tray: install gnome-shell-extension-appindicator and enable it (gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com). The hotkeys work without it.",
    });
  }
  if (linuxOzone(env) === "wayland") {
    out.push({
      title: "Holm: the hotkeys may not work under Wayland",
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
  title: "Holm: the snip needs Screen Recording",
  body: "macOS has not given holm (Electron) Screen Recording, so a snip shows nothing. Allow it in System Settings > Privacy & Security > Screen Recording, then quit and start the shell again. Click to open that pane.",
} as const;

/** True when the snip can capture the screens: anything but macOS, or macOS with Screen Recording granted. */
export function screenAllowed(os: ShellOs, status: string): boolean {
  return os !== "macos" || status === "granted";
}

// --- The OS's frosted material (docs/windows-shell.md "Frosted windows") ---

/** What the OS draws behind a window's transparent page: Windows 11's acrylic, macOS's vibrancy, or nothing (the page's own fill shows). */
export type WindowMaterial = "acrylic" | "vibrancy" | "none";

/** The windows the shell makes that a material could go on. */
export type MaterialWindow = "popup" | "dock" | "snip" | "settings";

/** Windows 11 22H2: the first build where Electron's backgroundMaterial takes effect. */
export const ACRYLIC_BUILD = 22621;

/** The build number of a Windows release as os.release() gives it ("10.0.22631"), or null when it is not one. */
export function windowsBuild(release: string): number | null {
  const m = /^\d+\.\d+\.(\d+)/.exec(release.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The material a window gets. Only the pop-up has one: its page fills the whole window, which the OS
 * rounds, so the material is exactly the pop-up's shape. The dock never does: its window is a fixed
 * rectangle bigger than the island, and neither acrylic nor vibrancy can be clipped to the island's
 * rounded shape (setShape takes rectangles only, and not on macOS), so a material would be a blurred
 * rectangle across the top of the screen. The snip's overlay covers a display, and Settings is a normal window.
 * `transparent`: whether a transparent window shows what is under it here (dockTransparent).
 */
export function windowMaterial(which: MaterialWindow, os: ShellOs, release: string, transparent: boolean): WindowMaterial {
  if (which !== "popup" || !transparent) return "none";
  if (os === "macos") return "vibrancy";
  if (os === "windows") return (windowsBuild(release) ?? 0) >= ACRYLIC_BUILD ? "acrylic" : "none";
  return "none";
}

/** The BrowserWindow options for a material. Plain values, so this file stays without Electron. */
export interface MaterialOptions {
  transparent?: boolean;
  backgroundColor: string;
  backgroundMaterial?: "acrylic";
  vibrancy?: "popover";
  visualEffectState?: "active";
}

/** A fully transparent colour: the page's own background is transparent too, so the material (or the desktop) shows. */
export const CLEAR = "#00000000";

/**
 * The options that give a window its material. Acrylic: a clear background and not `transparent`
 * (a transparent window on Windows is a layered one, which DWM draws no material or rounded corners
 * for). Vibrancy: active even when the window is not focused, as the pop-up is shown. No material:
 * a transparent window, so the page's translucent fill is over the desktop; `opaque` where a
 * transparent window would be painted black (Linux without a compositor).
 */
export function materialOptions(material: WindowMaterial, transparent: boolean, opaque: string): MaterialOptions {
  if (material === "acrylic") return { backgroundColor: CLEAR, backgroundMaterial: "acrylic" };
  if (material === "vibrancy") return { transparent: true, backgroundColor: CLEAR, vibrancy: "popover", visualEffectState: "active" };
  return transparent ? { transparent: true, backgroundColor: CLEAR } : { backgroundColor: opaque };
}
