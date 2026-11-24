// Window placement and the tray icon's and app icon's pixels. No Electron imports here.

export interface Area { x: number; y: number; width: number; height: number }

/** Where a width x height window goes to sit in the middle of a display's area. */
export function centred(area: Area, width: number, height: number): { x: number; y: number } {
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
}

// The Ledge, the app's mark (D0044): a dot waiting on a ledge, off to one side, in a 24-unit
// viewBox. Black and white only: no status colour is ever part of it. Its SVG is src/web/mark.svg.
export const MARK = { dot: { cx: 16.5, cy: 10, r: 4.5 }, ledge: { x: 2, y: 16.5, width: 20, height: 4, rx: 2 } } as const;
/** The app icon's tile, in the same units: a black rounded square with the mark in white, 0.8 of its size and centred on what it draws. */
export const TILE = { rx: 5.4, scale: 0.8, dx: 2.4, dy: 1.6 } as const;

type Rgb = readonly [number, number, number];
/** Inside a shape, in pixel coordinates. */
type Inside = (x: number, y: number) => boolean;

/** Samples per pixel along each axis: 8 x 8 points give its coverage, so every edge is anti-aliased. */
const SAMPLES = 8;

function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Inside {
  const rr = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + rr), x1 - rr);
    const cy = Math.min(Math.max(y, y0 + rr), y1 - rr);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
  };
}

/**
 * The mark's two shapes in pixels, the viewBox scaled by `k` and moved by (ox, oy). The ledge's top
 * and bottom edges land on whole pixels (at least one pixel apart), so the bar is crisp at 16 px;
 * the dot stays round, anti-aliased.
 */
function markShapes(k: number, ox: number, oy: number): Inside[] {
  const { dot, ledge } = MARK;
  const cx = ox + dot.cx * k, cy = oy + dot.cy * k, r = dot.r * k;
  const top = Math.round(oy + ledge.y * k);
  const bottom = Math.max(top + 1, Math.round(oy + (ledge.y + ledge.height) * k));
  return [
    (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
    roundedRect(ox + ledge.x * k, top, ox + (ledge.x + ledge.width) * k, bottom, ledge.rx * k),
  ];
}

/** Paints `shapes` in `rgb` over `out` (size x size BGRA, premultiplied), each pixel by its coverage. */
function paint(out: Buffer, size: number, shapes: Inside[], [r, g, b]: Rgb): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const sx = x + (i + 0.5) / SAMPLES, sy = y + (j + 0.5) / SAMPLES;
          if (shapes.some((inside) => inside(sx, sy))) hits++;
        }
      }
      const a = hits / (SAMPLES * SAMPLES);
      if (a === 0) continue;
      const at = (y * size + x) * 4;
      const keep = 1 - a;
      out[at] = Math.round(b * a + out[at]! * keep);
      out[at + 1] = Math.round(g * a + out[at + 1]! * keep);
      out[at + 2] = Math.round(r * a + out[at + 2]! * keep);
      out[at + 3] = Math.round(255 * a + out[at + 3]! * keep);
    }
  }
}

/**
 * The mark alone on a clear background, as size x size BGRA pixels (premultiplied): the macOS menu
 * bar's template image, which macOS tints from its alpha (so its colour, black, is never seen).
 */
export function markBitmap(size: number, rgb: Rgb = [0, 0, 0]): Buffer {
  const out = Buffer.alloc(size * size * 4);
  paint(out, size, markShapes(size / 24, 0, 0), rgb);
  return out;
}

/**
 * The app icon: the mark in white on a black rounded square, as size x size BGRA pixels
 * (premultiplied). It is the tray's icon off the Mac too, where nothing tints it: a black tile
 * reads on a light taskbar and its white mark on a dark one.
 */
export function tileBitmap(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const k = size / 24;
  paint(out, size, [roundedRect(0, 0, size, size, TILE.rx * k)], [0, 0, 0]);
  paint(out, size, markShapes(k * TILE.scale, TILE.dx * k, TILE.dy * k), [255, 255, 255]);
  return out;
}
