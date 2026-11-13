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

export function isDockState(value: unknown): value is DockState {
  return typeof value === "string" && (DOCK_STATES as readonly string[]).includes(value);
}

/**
 * Where the dock's window is, in every state: centred on the display, touching its top edge.
 * `display` is the primary display's bounds, not its work area: the dock sits on the very edge.
 */
export function dockBounds(display: Area): Area {
  const { width, height } = DOCK_WINDOW;
  return { x: Math.round(display.x + (display.width - width) / 2), y: display.y, width, height };
}

/** The island's rectangle in a state, inside the window: top centre, the state's size. */
export function islandRect(state: DockState): Area {
  const { width, height } = DOCK_SIZES[state];
  return { x: (DOCK_WINDOW.width - width) / 2, y: 0, width, height };
}

/** A point on the screen, in the units of the window's bounds. */
export interface Spot { x: number; y: number }

/** How far the cursor is from the island, in pixels: 0 on it. `win` is the window's bounds on the screen. */
export function islandDistance(win: Area, state: DockState, cursor: Spot): number {
  const r = islandRect(state);
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
export function takesMouse(win: Area, state: DockState | null, cursor: Spot): boolean {
  return state !== null && islandDistance(win, state, cursor) === 0;
}

/** While the cursor is within this many pixels of the island it is watched closely. */
export const DOCK_NEAR = 160;
/** How often the cursor is looked at: near the island, and anywhere else. */
export const DOCK_WATCH_NEAR_MS = 20;
export const DOCK_WATCH_FAR_MS = 120;

/** How long until the cursor is looked at again. */
export function watchMs(win: Area, state: DockState | null, cursor: Spot): number {
  return state !== null && islandDistance(win, state, cursor) <= DOCK_NEAR ? DOCK_WATCH_NEAR_MS : DOCK_WATCH_FAR_MS;
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
