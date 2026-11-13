// The snip: freeze every display, drag an area, type the task right there. What the main process
// takes from an overlay page and the maths of the crop. No Electron or Node imports here: main.ts
// owns the windows and the files, snip-preload.ts the bridge.
import type { Area } from "./geometry";
import { sameOrigin } from "./origin";

/** The bridge's three calls, one channel each. */
export const SNIP_CAPTURE = "intuition-snip:capture";
export const SNIP_CROP = "intuition-snip:crop";
export const SNIP_CLOSE = "intuition-snip:close";
/** The preload's bundle, beside main.cjs in the app folder. */
export const SNIP_PRELOAD = "snip-preload.cjs";
/** The overlay page, served by the runner's /assets/ route. */
export const SNIP_PATH = "/assets/snip.html";
/** The frozen image the page shows: a JPEG is quick to encode and to decode. The crop is from the full image, never from this. */
export const SNIP_VIEW_QUALITY = 92;
/** How long the shell waits for a page to say its image is drawn before it shows the window anyway. */
export const SNIP_SHOW_MS = 1500;

export interface Size { width: number; height: number }

/** The rectangle the self-test crops, in the first display's DIPs: with fractions, so the rounding is exercised. */
export const SELF_TEST_CROP: Area = { x: 10.5, y: 20.25, width: 101, height: 49.5 };

export function snipUrl(runnerUrl: string): string {
  return new URL(SNIP_PATH, runnerUrl).href;
}

/** True when a page is the snip overlay on the runner's own origin. */
export function isSnipPage(url: string | null, runnerUrl: string): boolean {
  if (url === null || !sameOrigin(url, runnerUrl)) return false;
  return new URL(url).pathname === SNIP_PATH;
}

/** Where a call to the bridge came from, as the main process sees it. */
export interface SnipSender {
  /** The sender is one of the overlay windows the shell opened for this snip. */
  fromOverlay: boolean;
  /** The call came from the window's main frame, not from a frame inside the page. */
  mainFrame: boolean;
  /** The frame's URL, or null when Electron has none. */
  url: string | null;
}

/** True when the main process answers a bridge call from this sender. */
export function acceptedSender(sender: SnipSender, runnerUrl: string): boolean {
  return sender.fromOverlay && sender.mainFrame && isSnipPage(sender.url, runnerUrl);
}

/**
 * The rectangle a page asks to crop, in CSS pixels of its window (which covers its display, so
 * CSS pixels are the display's DIPs from its top left), or null when it is not one: an object with
 * exactly x, y, width and height, each a finite number, at least one pixel wide and tall, and
 * entirely inside the display. Nothing else is taken from the page.
 */
export function acceptedRect(value: unknown, display: Size): Area | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join() !== "height,width,x,y") return null;
  const { x, y, width, height } = o;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const r = { x: x as number, y: y as number, width: width as number, height: height as number };
  if (r.width < 1 || r.height < 1 || r.x < 0 || r.y < 0) return null;
  // A hair of slack for a page whose maths rounded the far edge up.
  const slack = 0.01;
  if (r.x + r.width > display.width + slack || r.y + r.height > display.height + slack) return null;
  return r;
}

/**
 * A rectangle in a display's DIPs as whole pixels of an image of it, scaled by `scale` (image pixels
 * per DIP): the left and top edges rounded down, the right and bottom up, so the crop holds all of
 * what was selected, and kept inside the image.
 */
export function toPixels(rect: Area, scale: number, image: Size): Area {
  // Rounded before floor and ceil: 0.1 * 3 is 0.30000000000000004, which is not a reason for a pixel more.
  const snap = (n: number) => Math.round(n * 1000) / 1000;
  const left = Math.max(0, Math.floor(snap(rect.x * scale)));
  const top = Math.max(0, Math.floor(snap(rect.y * scale)));
  const right = Math.min(image.width, Math.ceil(snap((rect.x + rect.width) * scale)));
  const bottom = Math.min(image.height, Math.ceil(snap((rect.y + rect.height) * scale)));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * The crop of a selection: `source`, the rectangle to cut from the captured image, and `output`,
 * the size the saved PNG has, the selection at the display's own device pixels (`scaleFactor`).
 * The two differ only when the capture came back at another size than the display's native one
 * (one capture call is sized for the largest display): then the cut is resized to `output`.
 */
export function cropPlan(rect: Area, display: Size, scaleFactor: number, image: Size): { source: Area; output: Size } {
  const native = { width: Math.round(display.width * scaleFactor), height: Math.round(display.height * scaleFactor) };
  // At its native size the image is the display's own pixels: its scale is the display's, also where
  // the DIPs were rounded (2560 pixels at 150% are 1707 DIPs, not 1706.67). Otherwise, its own ratio.
  const isNative = Math.abs(image.width - native.width) <= 1 && Math.abs(image.height - native.height) <= 1;
  const source = toPixels(rect, isNative ? scaleFactor : image.width / display.width, image);
  const device = toPixels(rect, scaleFactor, native);
  return { source, output: { width: device.width, height: device.height } };
}

/**
 * The size to ask desktopCapturer for: one call captures every screen, each scaled to fit inside it,
 * so it is as large as the largest display at its native resolution.
 */
export function captureSize(displays: { size: Size; scaleFactor: number }[]): Size {
  let width = 0;
  let height = 0;
  for (const d of displays) {
    width = Math.max(width, Math.round(d.size.width * d.scaleFactor));
    height = Math.max(height, Math.round(d.size.height * d.scaleFactor));
  }
  return { width, height };
}

/**
 * Which source is which display: by the display id desktopCapturer gives each screen, and, where it
 * gives none (it can be empty on Windows), by order. Returns the source index for each display, or
 * -1 when there is none.
 */
export function matchSources(displayIds: number[], sourceDisplayIds: string[]): number[] {
  const byId = displayIds.map((id) => sourceDisplayIds.indexOf(String(id)));
  if (byId.every((i) => i >= 0)) return byId;
  const allEmpty = sourceDisplayIds.every((s) => s === "");
  return displayIds.map((_, i) => (byId[i]! >= 0 ? byId[i]! : allEmpty && i < sourceDisplayIds.length ? i : -1));
}
