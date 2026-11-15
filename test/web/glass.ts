// What text on Glass (docs/design.md, D0028) actually sits on: translucent tokens composited over
// the ground under them, so a contrast is checked on the colour a reader sees. design.test.ts and
// theme.test.ts use it for every scheme and forced theme.

/** An sRGB colour with its alpha, channels 0..255, alpha 0..1. */
export interface Rgba { r: number; g: number; b: number; a: number }

/** `#rrggbb` or `rgb(r g b / a)`, the two ways base.css writes a colour. */
export function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 };
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`not a colour base.css writes: ${value}`);
}

/** `top` drawn over the opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The grain's reach: a fractal noise between about a quarter and three quarters grey, blended as an
 * overlay at `strength`. The darkest and lightest a ground becomes under it, a channel at a time.
 */
export function grained(c: Rgba, strength: number): Rgba[] {
  const overlay = (b: number, g: number) => (b < 0.5 ? 2 * b * g : 1 - 2 * (1 - b) * (1 - g));
  return [0.25, 0.75].map((g) => {
    const ch = (v: number) => 255 * ((1 - strength) * (v / 255) + strength * overlay(v / 255, g));
    return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: 1 };
  });
}

/** The grounds a scheme's text can sit on, by name, each as every colour it can be. */
export type Grounds = Record<string, Rgba[]>;

/**
 * Every ground of a scheme, from its tokens:
 * - backdrop: the window's ground, alone and under each colour field at full strength, with the grain;
 * - glass: a frosted panel over each of those (the frost smooths the grain away; it is kept anyway);
 * - float: the denser glass over the real desktop, which may be anything from black to white;
 * - surface, sunken, hover, selected, bubble: each over glass and over float.
 */
export function grounds(t: Map<string, string>): Grounds {
  const tok = (name: string) => {
    const v = t.get(`--${name}`);
    if (!v) throw new Error(`no --${name}`);
    return parse(v);
  };
  const strength = Number(t.get("--grain-strength"));
  const bg = tok("bg");
  const fields = [bg, ...["field-1", "field-2", "field-3"].map((f) => over(tok(f), bg))];
  const backdrop = fields.flatMap((c) => [c, ...grained(c, strength)]);
  const glass = backdrop.map((c) => over(tok("glass"), c));
  const desktops = [{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, { r: 128, g: 128, b: 128, a: 1 }];
  const float = desktops.map((c) => over(tok("glass-float"), c));
  const on = (name: string) => [...glass, ...float].map((c) => over(tok(name), c));
  return { backdrop, glass, float, surface: on("surface"), sunken: on("sunken"), hover: on("hover"), selected: on("selected"), bubble: on("bubble") };
}

/** The lowest contrast of the colour token `fg` (drawn over each ground if translucent) on `ground`. */
export function worst(t: Map<string, string>, g: Grounds, fg: string, ground: string): number {
  const colour = parse(t.get(`--${fg}`)!);
  return Math.min(...g[ground]!.map((c) => contrast(over(colour, c), c)));
}
