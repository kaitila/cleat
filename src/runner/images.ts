// Pictures pasted or dropped into the pop-up's task (D0056): the page turns each into a PNG and posts
// it (POST /api/images, base64 in JSON); the runner saves it as <dataDir>/images/<uuid>.png and
// answers its path. A session started or replied to with `images` names such paths; each must be a PNG
// directly in that folder, or a path the clipboard rule takes (a snip). GET /api/images/<uuid>.png
// serves one back, for the chat's thumbnails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imagePathOf, type ImageRule } from "./clipboard";

/** The most a pasted picture may weigh, decoded. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** The most pictures one message may carry. */
export const MAX_IMAGES = 20;
export const NOT_A_PNG = "data must be a PNG, base64-encoded, at most 15 MB";
export const BAD_IMAGES = `images must be a list of at most ${MAX_IMAGES} paths from POST /api/images`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A saved picture's file name: a UUID and .png. */
export const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

/** Where the runner keeps pasted pictures. */
export function imagesFolder(dataDir: string): string {
  return join(dataDir, "images");
}

/** Saves a base64 PNG and returns its path, or the error text when it is refused. */
export function savePasted(dataDir: string, data: unknown): { imagePath: string } | { error: string } {
  if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) return { error: NOT_A_PNG };
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { error: NOT_A_PNG };
  const folder = imagesFolder(dataDir);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${crypto.randomUUID()}.png`);
  writeFileSync(path, bytes);
  return { imagePath: imagePathOf(path, { kind: "folder", folder }) ?? path };
}

/**
 * The paths of a request's `images`, as Claude is to read them: undefined without any, null when the
 * list or one of its paths is refused. A path is taken when it is a PNG directly in the runner's images
 * folder, or one the clipboard rule takes.
 */
export function imagesOf(raw: unknown, dataDir: string, rule: ImageRule): string[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return null;
  if (raw.length === 0) return undefined;
  const folder = { kind: "folder", folder: imagesFolder(dataDir) } as const;
  const paths: string[] = [];
  for (const item of raw) {
    const path = imagePathOf(item, folder) ?? imagePathOf(item, rule);
    if (path === null) return null;
    paths.push(path);
  }
  return paths;
}
