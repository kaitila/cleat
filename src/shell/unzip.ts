// A zip extractor in TypeScript, for Electron's release zips (D0045): no npm, no `unzip` program, no dependency.
// Stored and deflated entries, zip64 sizes and offsets, Unix modes (the executable bit) and symlinks (Electron.app's
// frameworks are full of them). Every entry's CRC-32 is checked, and an entry that would land outside the folder
// (an absolute path, a `..`, a path through a symlink, a symlink pointing out) is refused before anything is written.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** The path inside the zip, with forward slashes. */
  name: string;
  kind: "file" | "dir" | "symlink";
  /** The Unix permission bits, when the zip was made on Unix; else null. */
  mode: number | null;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

function fail(why: string): never {
  throw new Error(`not a zip this can read: ${why}`);
}

function u64(view: DataView, at: number): number {
  const n = view.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail("a size beyond 2^53");
  return Number(n);
}

/** The entries in the zip's central directory, in order. */
export function listZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end of central directory record: within the last 64 KiB and 22 bytes (its comment is at most 64 KiB).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - MAX16); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("no end of central directory");
  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (count === MAX16 || cdOffset === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || view.getUint32(loc, true) !== EOCD64_LOCATOR) fail("zip64 without its locator");
    const at = u64(view, loc + 8);
    if (view.getUint32(at, true) !== EOCD64) fail("zip64 record missing");
    count = u64(view, at + 32);
    cdOffset = u64(view, at + 48);
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || view.getUint32(p, true) !== CENTRAL) fail(`central directory entry ${n} missing`);
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const flags = view.getUint16(p + 8, true);
    if (flags & 1) fail("encrypted entries");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const external = view.getUint32(p + 38, true);
    let offset = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // zip64: the extra field 0x0001 holds, in order, each of these that was 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === MAX32) (size = u64(view, q)), (q += 8);
        if (compressedSize === MAX32) (compressedSize = u64(view, q)), (q += 8);
        if (offset === MAX32) offset = u64(view, q);
      }
      e += 4 + len;
    }
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const type = unixMode & 0o170000;
    const kind = name.endsWith("/") || type === 0o040000 ? "dir" : type === 0o120000 ? "symlink" : "file";
    entries.push({ name, kind, mode: unixMode ? unixMode & 0o7777 : null, method, crc, compressedSize, size, offset });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** An entry's bytes, inflated and checked against its CRC-32 and size. */
export function readEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const at = entry.offset;
  if (at + 30 > zip.length || view.getUint32(at, true) !== LOCAL) fail(`${entry.name}: local header missing`);
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const raw = zip.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) fail(`${entry.name}: cut short`);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  // Inflated no further than the size the zip states, so a small entry cannot fill the memory before the check.
  else if (entry.method === 8) data = entry.size === 0 ? new Uint8Array(0) : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
  else fail(`${entry.name}: compression method ${entry.method}`);
  if (data.length !== entry.size) fail(`${entry.name}: ${data.length} bytes, not ${entry.size}`);
  if ((Bun.hash.crc32(data) >>> 0) !== entry.crc) fail(`${entry.name}: its CRC-32 does not match`);
  return data;
}

/** The entry's place under `root`, or why it may not be written: absolute, `..`, or a backslash path. */
function placeOf(root: string, name: string): string {
  if (name.includes("\\") || name.includes("\0")) throw new Error(`refused ${JSON.stringify(name)}: a backslash or NUL in its path`);
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`refused ${JSON.stringify(name)}: an absolute path`);
  const path = resolve(root, normalize(name));
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`refused ${JSON.stringify(name)}: it would land outside ${root}`);
  return path;
}

/**
 * Where `target`, read from folder `from`, ends once each of the zip's links on the way (`links`: a link's
 * path to its target) is followed, one path part at a time, as the OS resolves it. Null for a loop (over 40
 * links) or a step outside `root`, where the zip has no say over what is there.
 */
function follow(root: string, from: string, target: string, links: Map<string, string>, depth = 0): string | null {
  if (depth > 40) return null;
  let at = from;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    at = part === ".." ? dirname(at) : join(at, part);
    if (at !== root && !at.startsWith(root + sep)) return null;
    const next = links.get(at);
    if (next !== undefined) {
      const end = follow(root, dirname(at), next, links, depth + 1);
      if (end === null) return null;
      at = end;
    }
  }
  return at;
}

/**
 * Extracts every entry of `zip` into `dest` (made if missing). Throws before writing anything when an entry
 * would land outside `dest`, would be written through one of the zip's own symlinks, or is a symlink that
 * points outside it. Symlinks are made last. Returns how many entries were written.
 */
export function extractZip(zip: Uint8Array, dest: string): number {
  const root = resolve(dest);
  const entries = listZip(zip);
  const places = entries.map((e) => ({ entry: e, path: placeOf(root, e.name.replace(/\/$/, "")) }));
  const links = places.filter((p) => p.entry.kind === "symlink");
  for (const l of links) {
    for (const other of places) {
      if (other.path.startsWith(l.path + sep)) throw new Error(`refused ${JSON.stringify(other.entry.name)}: it would be written through the symlink ${l.entry.name}`);
    }
  }
  const targets = links.map((l) => {
    const target = new TextDecoder().decode(readEntry(zip, l.entry));
    const to = resolve(dirname(l.path), target);
    if (isAbsolute(target) || (to !== root && !to.startsWith(root + sep))) throw new Error(`refused the symlink ${l.entry.name} -> ${target}: it points outside ${root}`);
    return { ...l, target };
  });
  // Judged by its text alone, a chain could still escape (`s/up -> ..`, then `deep -> s/up/..`): every link
  // is followed through the zip's other links, step by step as the OS would, and must end inside the folder.
  const linkTo = new Map(targets.map((t) => [t.path, t.target]));
  for (const t of targets) {
    const end = follow(root, dirname(t.path), t.target, linkTo);
    if (end === null || (end !== root && !end.startsWith(root + sep))) throw new Error(`refused the symlink ${t.entry.name} -> ${t.target}: through the zip's links it ends outside ${root}`);
  }
  mkdirSync(root, { recursive: true });
  for (const { entry, path } of places) {
    if (entry.kind === "dir") {
      mkdirSync(path, { recursive: true });
      continue;
    }
    if (entry.kind !== "file") continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readEntry(zip, entry));
    if (entry.mode !== null && process.platform !== "win32") chmodSync(path, entry.mode & 0o777);
  }
  for (const { path, target } of targets) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  }
  return places.length;
}
