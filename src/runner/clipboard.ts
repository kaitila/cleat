// The clipboard handoff: the shell posts what it captured on the hotkey, the runner keeps the latest
// capture in memory, and the pop-up asks for it. An image arrives as the path of a PNG the shell saved.
// windows-wsl: a Windows path, stored as its WSL path under /mnt/<drive>/, which is what Claude reads.
// macOS and Linux: the shell runs on this machine and saves into <temp>/intuition/; only a PNG there is taken.
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ClipboardCapture } from "../shared/protocol";
import { detectLayout, type Layout } from "../shell/platform";

/** Clipboard text is cut to this many characters. */
export const MAX_TEXT = 20_000;
/** Where WSL mounts the Windows drives: /mnt/c is C:\. */
export const MOUNTS = "/mnt";

export const NOT_AN_IMAGE = "imagePath must be an existing .png the shell saved: under /mnt/<drive>/ for Windows with WSL, in <temp>/intuition/ on macOS and Linux";

/**
 * Which image paths a runner takes. `mounts`: a Windows or WSL path under <mounts>/<drive>/ (windows-wsl).
 * `folder`: a file directly in one folder, the shell's <temp>/intuition/ (macOS and Linux, where the
 * shell and the runner share the machine and its temp folder). A bare string is a `mounts` rule.
 */
export type ImageRule = string | { kind: "mounts"; mounts: string } | { kind: "folder"; folder: string };

/** Where the shell saves clips and snips on a native layout: the OS temp folder's intuition/, as Electron's app.getPath("temp") gives it. */
export function nativeImageFolder(): string {
  return join(tmpdir(), "intuition");
}

/** The rule for a layout: /mnt for windows-wsl, the temp folder's intuition/ for macOS and Linux. */
export function imageRuleFor(layout: Layout): ImageRule {
  return layout === "windows-wsl" ? { kind: "mounts", mounts: MOUNTS } : { kind: "folder", folder: nativeImageFolder() };
}

/** This machine's rule, from its layout (INTUITION_PLATFORM when set). */
export function defaultImageRule(): ImageRule {
  return imageRuleFor(detectLayout());
}

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
 * The real path of a PNG directly in `folder`, or null. The path must be absolute, without control
 * characters, named .png, and once links are followed (the folder's own too: /var is /private/var on a
 * Mac) it must still be a file directly in the folder.
 */
function folderImage(raw: string, folder: string): string | null {
  if (!raw.startsWith("/") || /[\u0000-\u001f]/.test(raw) || !/\.[pP][nN][gG]$/.test(raw)) return null;
  try {
    const real = realpathSync(posix.normalize(raw));
    const dir = realpathSync(folder);
    if (posix.dirname(real) !== dir || !/\.[pP][nN][gG]$/.test(real)) return null;
    return isPngFile(real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The path of an image a request names, as Claude is to read it, or null when it must be refused.
 * A `mounts` rule takes a PNG file that exists under <mounts>/<drive>/, by its Windows or its WSL path,
 * and gives its WSL path. A link is followed, and what it points at must pass the same test, so a link
 * under /mnt/c can't name a file elsewhere. A `folder` rule takes a PNG file directly in the folder
 * (a link only to another file there) and gives its real path.
 */
export function imagePathOf(raw: unknown, rule: ImageRule = MOUNTS): string | null {
  if (typeof raw !== "string") return null;
  if (typeof rule !== "string" && rule.kind === "folder") return folderImage(raw, rule.folder);
  const mounts = typeof rule === "string" ? rule : rule.mounts;
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

  constructor(private readonly rule: ImageRule = MOUNTS) {}

  /** Stores a capture and returns it, or returns the error text for a body that is refused. */
  post(body: Record<string, unknown>): ClipboardCapture | string {
    if (body.text !== undefined && typeof body.text !== "string") return "text must be a string";
    const capture: ClipboardCapture = { capturedAt: new Date().toISOString() };
    if (body.text) capture.text = body.text.slice(0, MAX_TEXT);
    if (body.imagePath !== undefined) {
      const path = imagePathOf(body.imagePath, this.rule);
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
    return path !== undefined ? imagePathOf(path, this.rule) : null;
  }
}
