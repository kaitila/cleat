// The snip overlay's rules, without the DOM: the selection a drag makes, its size in device pixels,
// where the prompt box and the size label go, and the workspace keys. src/web/snip.js draws them;
// test/web/snip.test.ts checks them. Lengths are CSS pixels of the overlay window, whose top left is
// its display's.

/** A press that moves less than this, in CSS pixels, either way, is a click: it selects the whole display. */
export const CLICK_SLOP = 4;
/** The space between the selection and the prompt box or the size label, and between them and the screen's edge. */
export const GAP = 8;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** True when a press from `start` to `end` is a click, not a drag. */
export function isClick(start, end) {
  return Math.abs(end.x - start.x) < CLICK_SLOP && Math.abs(end.y - start.y) < CLICK_SLOP;
}

/** The whole display, as a selection. */
export function wholeDisplay(viewport) {
  return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

/** The rectangle between the press and where the pointer is now, whichever way it went, kept inside the display. */
export function selectionOf(start, end, viewport) {
  const x1 = clamp(Math.min(start.x, end.x), 0, viewport.width);
  const y1 = clamp(Math.min(start.y, end.y), 0, viewport.height);
  const x2 = clamp(Math.max(start.x, end.x), 0, viewport.width);
  const y2 = clamp(Math.max(start.y, end.y), 0, viewport.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * A selection as whole device pixels at `ratio` device pixels per CSS pixel: left and top rounded
 * down, right and bottom up, inside the display. The same rule as the shell's crop
 * (shell/src/snip.ts, toPixels), so the size shown is the size saved.
 */
export function devicePixels(rect, ratio, viewport) {
  const snap = (n) => Math.round(n * 1000) / 1000;
  const maxW = Math.round(viewport.width * ratio);
  const maxH = Math.round(viewport.height * ratio);
  const left = Math.max(0, Math.floor(snap(rect.x * ratio)));
  const top = Math.max(0, Math.floor(snap(rect.y * ratio)));
  const right = Math.min(maxW, Math.ceil(snap((rect.x + rect.width) * ratio)));
  const bottom = Math.min(maxH, Math.ceil(snap((rect.y + rect.height) * ratio)));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** The size label's text: "1280 × 720". */
export function sizeText(size) {
  return `${size.width} × ${size.height}`;
}

/**
 * Where the prompt box goes for a selection: below it, centred on it; above it, centred, when there
 * is no room below; inside it, at its bottom and centred, when there is room on neither side (a
 * selection as tall as the display). Always inside the display, GAP from its edges where it fits,
 * so a selection near a side has its box pushed in from that side rather than centred.
 */
export function anchorBox(sel, box, viewport) {
  const maxX = Math.max(0, viewport.width - box.width - GAP);
  const maxY = Math.max(0, viewport.height - box.height - GAP);
  const x = Math.round(clamp(sel.x + (sel.width - box.width) / 2, Math.min(GAP, maxX), maxX));
  const below = sel.y + sel.height + GAP;
  if (below + box.height <= viewport.height - GAP) return { placement: "below", x, y: below };
  const above = sel.y - GAP - box.height;
  if (above >= GAP) return { placement: "above", x, y: above };
  const y = sel.y + sel.height - GAP - box.height;
  return { placement: "inside", x, y: Math.round(clamp(y, Math.min(GAP, maxY), maxY)) };
}

/**
 * Where the size label goes: just above the selection's top left corner, or inside that corner when
 * there is no room above or the prompt box is above (it would cover the label).
 */
export function anchorLabel(sel, label, viewport, boxPlacement = "below") {
  const maxX = Math.max(0, viewport.width - label.width);
  const x = clamp(sel.x, 0, maxX);
  const above = sel.y - GAP / 2 - label.height;
  if (above >= 0 && boxPlacement !== "above") return { x, y: above, inside: false };
  return { x: clamp(sel.x + GAP / 2, 0, maxX), y: clamp(sel.y + GAP / 2, 0, Math.max(0, viewport.height - label.height)), inside: true };
}

/** The workspace selected at first: the last one used if its folder is there, otherwise the first whose folder is. */
export function initialWorkspace(workspaces, lastUsed) {
  const usable = workspaces.filter((w) => w.exists);
  return (usable.find((w) => w.name === lastUsed) ?? usable[0])?.name ?? null;
}

/** The next usable workspace after `current` (or before, with step -1), going round. */
export function stepWorkspace(workspaces, current, step) {
  const usable = workspaces.filter((w) => w.exists).map((w) => w.name);
  if (usable.length === 0) return null;
  const at = usable.indexOf(current);
  if (at < 0) return usable[0];
  return usable[(at + step + usable.length) % usable.length];
}

/** The position (from 0) that Alt+1..9 asks for, or null. The physical key first: with Alt held some layouts report another character. */
export function altDigit(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")?.[1] ?? (/^[1-9]$/.test(event.key ?? "") ? event.key : null);
  return digit ? Number(digit) - 1 : null;
}

export const UNREACHABLE = "the runner is not reachable";

/** The line shown for an answer that isn't a success: the runner's own error text if it sent one. */
export function errorText(status, body) {
  const text = body && typeof body === "object" && typeof body.error === "string" ? body.error.trim() : "";
  return text || `the runner answered ${status}`;
}

/** The body of POST /api/sessions for a snip. */
export function sessionBody(workspace, prompt, imagePath) {
  return { workspace, prompt, imagePath };
}
