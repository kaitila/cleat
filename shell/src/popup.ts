// The pop-up's window (D0056): it opens small, the size of a workspace row, two lines of task and
// the hint line, and grows with what is typed or pasted into it up to POPUP_MAX_HEIGHT, past which the
// task scrolls. The page measures what it needs and asks through its preload (popup-preload.ts,
// window.cleatPopup.fit(height)); the main process takes the ask only from the pop-up's own main
// frame on the runner's origin, and keeps the window's top edge where it opened.
import { sameOrigin } from "./origin";

export const POPUP_WIDTH = 520;
/** The window as it opens: room for the workspaces, two lines of task and the hint line. */
export const POPUP_MIN_HEIGHT = 172;
/** The most it grows to; the task scrolls past this. */
export const POPUP_MAX_HEIGHT = 520;
export const POPUP_FIT = "cleat:popup-fit";
/** The preload's bundle, beside main.cjs. */
export const POPUP_PRELOAD = "popup-preload.cjs";

/** The height a fit asks for, clamped to the window's range and to whole pixels; null when it isn't a number. */
export function fittedHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, Math.ceil(value)));
}

/** Whether a fit comes from the pop-up's own main frame, on the runner's origin. */
export function acceptedFit(from: { fromPopup: boolean; mainFrame: boolean; url: string | null }, runnerUrl: string): boolean {
  return from.fromPopup && from.mainFrame && from.url !== null && sameOrigin(from.url, runnerUrl);
}
