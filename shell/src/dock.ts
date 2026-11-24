// The dock: its window, its three states, where the island is in each, and which setState calls are
// taken. No Electron imports here: main.ts owns the window, dock-preload.ts the bridge.
import type { Area } from "./geometry";
import { sameOrigin } from "./origin";

export const DOCK_STATES = ["idle", "peek", "open"] as const;
export type DockState = (typeof DOCK_STATES)[number];

/**
 * The window's one size, in CSS pixels, for the dock's whole life: as large as the open island can
 * get. It is never resized or moved on a change of state. The contract in docs/protocol.md ("Dock").
 */
export const DOCK_WINDOW = { width: 460, height: 480 } as const;

/**
 * The most the island covers in each state, in CSS pixels, hanging from the top centre of the
 * window. The page never draws outside it (idle may be narrower, open shorter), and the shell takes
 * the mouse only inside it. The same numbers as the page's (src/web/dock-state.js).
 */
export const DOCK_SIZES: Record<DockState, { width: number; height: number }> = {
  idle: { width: 128, height: 22 },
  peek: { width: 380, height: 40 },
  open: { width: DOCK_WINDOW.width, height: DOCK_WINDOW.height },
};

/** The one message the bridge sends: the state the page asks for. */
export const DOCK_CHANNEL = "intuition-dock:set-state";
/** The preload's bundle, beside main.cjs in the app folder. */
export const DOCK_PRELOAD = "dock-preload.cjs";
/** How often the shell asks whether the runner is there, to hide the dock or bring it back. */
export const DOCK_CHECK_MS = 4000;
/** The runner has to miss this many checks in a row before the dock hides: one slow answer is not "gone". */
export const DOCK_MISSES = 2;
/**
 * Shown once when the runner answers /health but its /dock does not load: a runner started before
 * the update that added the dock, or one older than the shell some other way.
 */
export const DOCK_STALE_RUNNER = {
  title: "intuition: the runner is older than the shell",
  body: "The dock needs a newer runner: run intuition up in WSL. The dock appears by itself once it is restarted.",
} as const;

/**
 * A Mac's notch, in points: its size, and its left edge from the display's left. Measured by the
 * shell (os.ts, notchOf) and handed to the page as /dock?notch=WxH (docs/protocol.md, "Dock").
 */
export interface Notch { x: number; width: number; height: number }

/**
 * Beside the notch, a wing on each side shows the idle pill's dot (left) and words (right): the
 * notch itself hides whatever is drawn under it. The same number as the page's (dock-state.js).
 */
export const NOTCH_WING = 76;

/**
 * The most the island covers in each state, with a notch or without one. With one, the island
 * hangs from the notch: idle is the notch and its wings at the notch's height, peek is the peek's
 * line below the notch's band, and open is as before. The same as the page's dockSizes.
 */
export function dockSizes(notch: Pick<Notch, "width" | "height"> | null): Record<DockState, { width: number; height: number }> {
  if (!notch) return DOCK_SIZES;
  const idle = { width: notch.width + 2 * NOTCH_WING, height: notch.height };
  return {
    idle,
    peek: { width: Math.max(DOCK_SIZES.peek.width, idle.width), height: notch.height + DOCK_SIZES.peek.height },
    open: DOCK_SIZES.open,
  };
}

export function isDockState(value: unknown): value is DockState {
  return typeof value === "string" && (DOCK_STATES as readonly string[]).includes(value);
}

/**
 * Where the dock's window is, in every state: centred on the area, touching its top edge. `area` is
 * what os.ts dockArea gives: the primary display's bounds (the very edge), a Mac's area below the
 * menu bar, or, with a notch, the display's bounds centred on the notch.
 */
export function dockBounds(area: Area): Area {
  const { width, height } = DOCK_WINDOW;
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height };
}

/**
 * The island's rectangle in a state, inside the window: top centre, the state's size. It is where
 * the shell takes the mouse. With a notch, idle's is the notch alone: its wings are drawn over the
 * menu bar and let every click through to it, so the notch is the handle.
 */
export function islandRect(state: DockState, notch: Notch | null = null): Area {
  const { width, height } = state === "idle" && notch ? notch : dockSizes(notch)[state];
  return { x: (DOCK_WINDOW.width - width) / 2, y: 0, width, height };
}

/** A point on the screen, in the units of the window's bounds. */
export interface Spot { x: number; y: number }

/** How far the cursor is from the island, in pixels: 0 on it. `win` is the window's bounds on the screen. */
export function islandDistance(win: Area, state: DockState, cursor: Spot, notch: Notch | null = null): number {
  const r = islandRect(state, notch);
  const left = win.x + r.x;
  const top = win.y + r.y;
  // The right and bottom edges are the first pixels outside.
  const dx = Math.max(left - cursor.x, 0, cursor.x - (left + r.width - 1));
  const dy = Math.max(top - cursor.y, 0, cursor.y - (top + r.height - 1));
  return Math.hypot(dx, dy);
}

/**
 * Whether the window takes the mouse: only while the cursor is on the island of the state the page
 * last reported. `state` is null until the page has reported one (not loaded yet, failed, crashed,
 * reloading): then the window lets every click through, so a broken page can block nothing.
 */
export function takesMouse(win: Area, state: DockState | null, cursor: Spot, notch: Notch | null = null): boolean {
  return state !== null && islandDistance(win, state, cursor, notch) === 0;
}

/** While the cursor is within this many pixels of the island it is watched closely. */
export const DOCK_NEAR = 160;
/** How often the cursor is looked at: near the island, and anywhere else. */
export const DOCK_WATCH_NEAR_MS = 20;
export const DOCK_WATCH_FAR_MS = 120;

/** How long until the cursor is looked at again. */
export function watchMs(win: Area, state: DockState | null, cursor: Spot, notch: Notch | null = null): number {
  return state !== null && islandDistance(win, state, cursor, notch) <= DOCK_NEAR ? DOCK_WATCH_NEAR_MS : DOCK_WATCH_FAR_MS;
}

/**
 * Whether a display's change of metrics can move the dock, from Electron's changedMetrics: its
 * bounds, scale or rotation. Not the work area alone: a menu bar or the Dock hiding and showing
 * changes it (a full-screen app on a Mac), and the dock hangs from the display's edge (D0037).
 */
export function movesDock(changed: readonly string[]): boolean {
  return changed.some((metric) => metric !== "workArea");
}

/** Only in "open" can the window take the keyboard. */
export function dockFocusable(state: DockState): boolean {
  return state === "open";
}

/** Who sent a setState message, as the main process sees it. */
export interface DockSender {
  /** The message came from the dock window's own web contents. */
  fromDock: boolean;
  /** It came from that window's main frame, not a frame inside the page. */
  mainFrame: boolean;
  /** The sending frame's URL. Null when the frame is gone. */
  url: string | null;
}

/**
 * The state a setState message asks for, or null when the message is refused: it must come from
 * the dock window's main frame, on the runner's origin, and name one of the three states.
 */
export function acceptedState(sender: DockSender, runnerUrl: string, value: unknown): DockState | null {
  if (!sender.fromDock || !sender.mainFrame || sender.url === null || !sameOrigin(sender.url, runnerUrl)) return null;
  return isDockState(value) ? value : null;
}
