// The clipboard handoff: the Windows shell posts what it captured on the hotkey, the runner keeps
// the latest capture in memory, and the pop-up asks for it. An image arrives as the Windows path
// of a PNG the shell saved; the runner stores its WSL path, which is what Claude reads.
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";
import type { ClipboardCapture } from "../shared/protocol";

/** Clipboard text is cut to this many characters. */
export const MAX_TEXT = 20_000;
/** Where WSL mounts the Windows drives: /mnt/c is C:\. */
export const MOUNTS = "/mnt";

export const NOT_AN_IMAGE = "imagePath must be an existing .png under /mnt/<drive>/";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The WSL path a Windows path (C:\Users\x\clip.png) or a WSL path names: the drive letter lowercased
 * under `mounts`, backslashes to slashes, normalised. Null when the result isn't a .png under
 * <mounts>/<drive>/. Nothing is read from disk here.
 */
export function wslPath(raw: string, mounts = MOUNTS): string | null {
  const windows = /^([A-Za-z]):[\\/](.*)$/s.exec(raw);
  const path = posix.normalize(windows ? `${mounts}/${windows[1]!.toLowerCase()}/${windows[2]!.replaceAll("\\", "/")}` : raw);
  if (!path.startsWith(`${mounts}/`) || path.includes("\0") || /[\r\n]/.test(path)) return null;
  return /^[a-z]\/.+\.[pP][nN][gG]$/.test(path.slice(mounts.length + 1)) ? path : null;
}

function isPngFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(PNG_SIGNATURE.length);
      return readSync(fd, head, 0, head.length, 0) === head.length && PNG_SIGNATURE.every((b, i) => head[i] === b);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * The WSL path of an image a request names, or null when it must be refused. Accepted: a PNG file
 * that exists under <mounts>/<drive>/, by its Windows or its WSL path. A link is followed, and what
 * it points at must pass the same test, so a link under /mnt/c can't name a file elsewhere.
 */
export function imagePathOf(raw: unknown, mounts = MOUNTS): string | null {
  if (typeof raw !== "string") return null;
  const path = wslPath(raw, mounts);
  if (path === null) return null;
  try {
    // The mounts folder itself may be a link (a temp folder in tests): compare real paths.
    if (wslPath(realpathSync(path), realpathSync(mounts)) === null) return null;
  } catch {
    return null;
  }
  return isPngFile(path) ? path : null;
}

/** The latest capture. In memory only: a capture is for the pop-up that opens with it. */
export class Clipboard {
  private latest: ClipboardCapture | null = null;

  constructor(private readonly mounts = MOUNTS) {}

  /** Stores a capture and returns it, or returns the error text for a body that is refused. */
  post(body: Record<string, unknown>): ClipboardCapture | string {
    if (body.text !== undefined && typeof body.text !== "string") return "text must be a string";
    const capture: ClipboardCapture = { capturedAt: new Date().toISOString() };
    if (body.text) capture.text = body.text.slice(0, MAX_TEXT);
    if (body.imagePath !== undefined) {
      const path = imagePathOf(body.imagePath, this.mounts);
      if (path === null) return NOT_AN_IMAGE;
      capture.imagePath = path;
    }
    this.latest = capture;
    return capture;
  }

  get(): ClipboardCapture | null {
    return this.latest;
  }

  /** The latest capture's image, checked again: the shell deletes old clips. Null without one. */
  image(): string | null {
    const path = this.latest?.imagePath;
    return path !== undefined ? imagePathOf(path, this.mounts) : null;
  }
}
