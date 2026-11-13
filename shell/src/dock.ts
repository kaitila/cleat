// The dock: its three states, where its window goes, and which setState calls are taken.
// No Electron imports here: main.ts owns the window, dock-preload.ts the bridge.
import type { Area } from "./geometry";
import { sameOrigin } from "./origin";

export const DOCK_STATES = ["idle", "peek", "open"] as const;
export type DockState = (typeof DOCK_STATES)[number];

/** The window's exact size in each state, in CSS pixels. The contract in docs/protocol.md ("Dock"). */
export const DOCK_SIZES: Record<DockState, { width: number; height: number }> = {
  idle: { width: 280, height: 40 },
  peek: { width: 420, height: 76 },
  open: { width: 460, height: 600 },
};

/** The one message the bridge sends: the state the page asks for. */
export const DOCK_CHANNEL = "intuition-dock:set-state";
/** The preload's bundle, beside main.cjs in the app folder. */
export const DOCK_PRELOAD = "dock-preload.cjs";
/** How often the shell asks whether the runner is there, to hide the dock or bring it back. */
export const DOCK_CHECK_MS = 4000;
/** The runner has to miss this many checks in a row before the dock hides: one slow answer is not "gone". */
export const DOCK_MISSES = 2;

export function isDockState(value: unknown): value is DockState {
  return typeof value === "string" && (DOCK_STATES as readonly string[]).includes(value);
}

/**
 * Where the dock's window goes in a state: centred on the display, touching its top edge.
 * `display` is the primary display's bounds, not its work area: the dock sits on the very edge.
 */
export function dockBounds(display: Area, state: DockState): Area {
  const { width, height } = DOCK_SIZES[state];
  return { x: Math.round(display.x + (display.width - width) / 2), y: display.y, width, height };
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
