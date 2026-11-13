// Clipboard captures: the saved PNG's name, pruning old ones, and the body posted to the runner.
// No Electron imports here.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClipboardPostRequest } from "../../src/shared/protocol";

export const MAX_TEXT = 20_000;
export const KEEP_CLIPS = 20;
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What was on the clipboard. An image has already been saved: path is its Windows path. */
export type Capture = { kind: "image"; path: string } | { kind: "text"; text: string } | { kind: "empty" };

export function isPng(data: Uint8Array): boolean {
  return data.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => data[i] === b);
}

const two = (n: number) => String(n).padStart(2, "0");

/** What a saved PNG is: a clipboard image (clip-<time>.png) or a snip (snip-<time>.png). */
export type CaptureKind = "clip" | "snip";
const SAVED = /^(?:clip|snip)-([\d-]+)\.png$/;

/** clip-<time>.png (or snip-<time>.png), in local time down to the millisecond, so names sort by age. */
export function clipFileName(at: Date, kind: CaptureKind = "clip"): string {
  const day = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
  const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `${kind}-${day}-${time}-${String(at.getMilliseconds()).padStart(3, "0")}.png`;
}

/**
 * Of a folder's file names, the clips and snips to delete so that only the newest `keep` of them,
 * together and by their time, stay. Other files are left alone.
 */
export function clipsToPrune(names: string[], keep = KEEP_CLIPS): string[] {
  const time = (n: string) => SAVED.exec(n)![1]!;
  return names
    .filter((n) => SAVED.test(n))
    .sort((a, b) => (time(a) === time(b) ? (a < b ? -1 : 1) : time(a) < time(b) ? -1 : 1))
    .reverse()
    .slice(keep);
}

/** Saves a PNG as a new clip (or snip) in `dir`, deletes the clips and snips beyond the newest KEEP_CLIPS, and returns the new path. */
export function saveClip(dir: string, png: Uint8Array, at = new Date(), kind: CaptureKind = "clip"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, clipFileName(at, kind));
  writeFileSync(file, png);
  for (const old of clipsToPrune(readdirSync(dir))) rmSync(join(dir, old), { force: true });
  return file;
}

/** The body of POST /api/clipboard for a capture. */
export function captureBody(capture: Capture): ClipboardPostRequest {
  if (capture.kind === "image") return { imagePath: capture.path };
  if (capture.kind === "text" && capture.text.trim() !== "") return { text: capture.text.slice(0, MAX_TEXT) };
  return {};
}
