// Window placement and the tray icon's pixels. No Electron imports here.

export interface Area { x: number; y: number; width: number; height: number }

/** Where a width x height window goes to sit in the middle of a display's area. */
export function centred(area: Area, width: number, height: number): { x: number; y: number } {
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
}

/** A filled disc with a soft edge on a clear background, as size x size BGRA pixels (premultiplied). */
export function iconBitmap(size: number): Buffer {
  const [r, g, b] = [0x6b, 0x7c, 0xf0];
  const out = Buffer.alloc(size * size * 4);
  const mid = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = Math.max(0, Math.min(1, radius - Math.hypot(x - mid, y - mid) + 0.5));
      out.set([Math.round(b * alpha), Math.round(g * alpha), Math.round(r * alpha), Math.round(255 * alpha)], (y * size + x) * 4);
    }
  }
  return out;
}
