// The zip extractor and the Electron download (D0045): zips made here, in memory, and a fetch that serves them.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { distDir, electronAsset, fetchElectron, PINNED, releaseUrl, shaFor } from "../../src/shell/electron-fetch";
import { wantedElectron } from "../../src/shell/install";
import { extractZip, listZip } from "../../src/shell/unzip";

interface Item {
  name: string;
  data?: string | Uint8Array;
  /** Unix mode with its type bits: 0o100755 a file, 0o120777 a symlink, 0o040755 a folder. */
  mode?: number;
  store?: boolean;
}

/** A zip of these entries, as Unix's zip writes them (made by Unix, the mode in the external attributes). */
function zipOf(items: Item[], { badCrc = false } = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const it of items) {
    const name = enc.encode(it.name);
    const raw = typeof it.data === "string" ? enc.encode(it.data) : (it.data ?? new Uint8Array(0));
    const method = it.store || raw.length === 0 ? 0 : 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = (Bun.hash.crc32(raw) >>> 0) ^ (badCrc ? 1 : 0);
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((it.mode ?? (it.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const temp = () => mkdtempSync(join(tmpdir(), "cleat-unzip-"));

/** What Electron's macOS zip looks like, in small: an executable, a framework of symlinks, a version file. */
const APP: Item[] = [
  { name: "Electron.app/", mode: 0o040755 },
  { name: "Electron.app/Contents/MacOS/Electron", data: "#!binary", mode: 0o100755 },
  { name: "Electron.app/Contents/Frameworks/F.framework/Versions/A/F", data: "x".repeat(5000), mode: 0o100755 },
  { name: "Electron.app/Contents/Frameworks/F.framework/Versions/Current", data: "A", mode: 0o120755 },
  { name: "Electron.app/Contents/Frameworks/F.framework/F", data: "Versions/Current/F", mode: 0o120755 },
  { name: "Electron.app/Contents/Info.plist", data: "<plist/>", store: true },
  { name: "empty.txt", data: "" },
  { name: "version", data: "45.3.1" },
];

describe("extractZip", () => {
  test("files with their bytes and modes, folders, and symlinks that still point inside", () => {
    const dest = temp();
    expect(extractZip(zipOf(APP), dest)).toBe(APP.length);
    const at = (p: string) => join(dest, p);
    expect(readFileSync(at("Electron.app/Contents/MacOS/Electron"), "utf8")).toBe("#!binary");
    expect(statSync(at("Electron.app/Contents/MacOS/Electron")).mode & 0o777).toBe(0o755);
    expect(statSync(at("Electron.app/Contents/Info.plist")).mode & 0o777).toBe(0o644);
    expect(readFileSync(at("Electron.app/Contents/Frameworks/F.framework/Versions/A/F"), "utf8")).toBe("x".repeat(5000));
    expect(lstatSync(at("Electron.app/Contents/Frameworks/F.framework/F")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(at("Electron.app/Contents/Frameworks/F.framework/F"))).toBe("Versions/Current/F");
    // Through both links, to the file.
    expect(readFileSync(at("Electron.app/Contents/Frameworks/F.framework/F"), "utf8")).toBe("x".repeat(5000));
    expect(readFileSync(at("empty.txt"), "utf8")).toBe("");
  });

  test("lists what it holds, with kinds", () => {
    const kinds = Object.fromEntries(listZip(zipOf(APP)).map((e) => [e.name, e.kind]));
    expect(kinds["Electron.app/"]).toBe("dir");
    expect(kinds["Electron.app/Contents/Frameworks/F.framework/F"]).toBe("symlink");
    expect(kinds["version"]).toBe("file");
  });

  test("refuses, before writing anything, a path out of the folder, an absolute one, a symlink out, or a write through a symlink", () => {
    const cases: [string, Item[]][] = [
      ["..", [{ name: "ok.txt", data: "a" }, { name: "../evil.txt", data: "x" }]],
      ["nested ..", [{ name: "a/../../evil.txt", data: "x" }]],
      ["absolute", [{ name: "/tmp/evil.txt", data: "x" }]],
      ["drive", [{ name: "C:/evil.txt", data: "x" }]],
      ["backslash", [{ name: "a\\..\\..\\evil.txt", data: "x" }]],
      ["symlink out", [{ name: "link", data: "../../etc", mode: 0o120777 }]],
      ["absolute symlink", [{ name: "link", data: "/etc", mode: 0o120777 }]],
      ["through a symlink", [{ name: "dir", data: ".", mode: 0o120777 }, { name: "dir/x.txt", data: "x" }]],
      ["a chain of links out", [{ name: "s/up", data: "..", mode: 0o120777 }, { name: "deep", data: "s/up/..", mode: 0o120777 }]],
      ["a loop", [{ name: "a", data: "b", mode: 0o120777 }, { name: "b", data: "a", mode: 0o120777 }]],
    ];
    for (const [what, items] of cases) {
      const dest = join(temp(), "out");
      expect(() => extractZip(zipOf(items), dest), what).toThrow(/refused/);
      expect(existsSync(dest), `${what}: nothing written`).toBe(false);
    }
  });

  test("a wrong CRC-32 or a file that is not a zip is an error", () => {
    expect(() => extractZip(zipOf([{ name: "a.txt", data: "hello" }], { badCrc: true }), temp())).toThrow(/CRC-32/);
    expect(() => listZip(new TextEncoder().encode("not a zip at all, just some text here"))).toThrow(/end of central directory/);
  });
});

describe("fetchElectron", () => {
  const target = { platform: "darwin", arch: "arm64" } as const;
  const asset = electronAsset("45.3.1", target);
  const zip = zipOf(APP);
  const sha = new Bun.CryptoHasher("sha256").update(zip).digest("hex");

  /** Serves SHASUMS256.txt and the zip from the release URL, and records what was asked. */
  const pinned = { [asset]: sha };
  function server(shasums = `${"0".repeat(64)} *electron-v45.3.1-linux-x64.zip\n${sha} *${asset}\n`) {
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      if (url.endsWith("SHASUMS256.txt")) return new Response(shasums);
      if (url.endsWith(asset)) return new Response(new Blob([zip as Uint8Array<ArrayBuffer>]), { headers: { "content-length": String(zip.length) } });
      return new Response("no", { status: 404 });
    };
    return { asked, fetch };
  }

  test("every layout's zip of the pinned Electron has its SHA-256 pinned in the repo", () => {
    const version = wantedElectron();
    for (const t of [{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }, { platform: "linux", arch: "x64" }, { platform: "linux", arch: "arm64" }, { platform: "win32", arch: "x64" }] as const) {
      expect(PINNED[electronAsset(version, t)]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the asset's name, the release URL and ELECTRON_MIRROR, as Electron's installer names them", () => {
    expect(asset).toBe("electron-v45.3.1-darwin-arm64.zip");
    expect(electronAsset("45.3.1", { platform: "win32", arch: "x64" })).toBe("electron-v45.3.1-win32-x64.zip");
    expect(releaseUrl("45.3.1", {})).toBe("https://github.com/electron/electron/releases/download/v45.3.1/");
    expect(releaseUrl("45.3.1", { ELECTRON_MIRROR: "https://mirror.example/electron" })).toBe("https://mirror.example/electron/v45.3.1/");
    expect(shaFor(`${sha} *${asset}\n`, asset)).toBe(sha);
    expect(shaFor(`${sha}  ${asset}\n`, asset)).toBe(sha);
    expect(shaFor(`${sha} *other.zip\n`, asset)).toBeNull();
  });

  test("downloads the zip, checks its SHA-256, and unpacks it where npm's installer did", async () => {
    const app = temp();
    const { asked, fetch } = server();
    const lines: string[] = [];
    expect(await fetchElectron("45.3.1", target, app, { env: {}, fetch, pinned, log: (l) => lines.push(l) })).toBe("45.3.1");
    // Only dist is left: the download's folder beside it is gone.
    expect(readdirSync(join(app, "node_modules", "electron"))).toEqual(["dist"]);
    expect(asked).toEqual([`https://github.com/electron/electron/releases/download/v45.3.1/SHASUMS256.txt`, `https://github.com/electron/electron/releases/download/v45.3.1/${asset}`]);
    expect(readFileSync(join(distDir(app), "Electron.app/Contents/MacOS/Electron"), "utf8")).toBe("#!binary");
    expect(distDir(app)).toBe(join(app, "node_modules", "electron", "dist"));
    expect(lines.at(-1)).toBe(`unpacking ${asset} (SHA-256 checked)`);
  });

  test("a SHA-256 that does not match, or a release that names no such zip, fails and keeps what was installed", async () => {
    const app = temp();
    mkdirSync(distDir(app), { recursive: true });
    writeFileSync(join(distDir(app), "version"), "44.0.0");
    await expect(fetchElectron("45.3.1", target, app, { env: {}, fetch: server(`${"a".repeat(64)} *${asset}\n`).fetch, pinned: {}, log: () => {} })).rejects.toThrow(/SHA-256/);
    // A mirror whose SHASUMS256.txt matches its own zip, but not the sum pinned in the repo, is refused.
    await expect(fetchElectron("45.3.1", target, app, { env: { ELECTRON_MIRROR: "https://evil.example/" }, fetch: async (u) => (u.endsWith("SHASUMS256.txt") ? new Response(`${sha} *${asset}\n`) : new Response(new Blob([zip as Uint8Array<ArrayBuffer>]))), pinned: { [asset]: "b".repeat(64) }, log: () => {} })).rejects.toThrow(/pinned/);
    await expect(fetchElectron("45.3.1", target, app, { env: {}, fetch: server("").fetch, log: () => {} })).rejects.toThrow(/names no/);
    const notFound = async () => new Response("gone", { status: 404 });
    await expect(fetchElectron("45.3.1", target, app, { env: {}, fetch: notFound, log: () => {} })).rejects.toThrow(/HTTP 404/);
    expect(readFileSync(join(distDir(app), "version"), "utf8")).toBe("44.0.0");
  });
});
