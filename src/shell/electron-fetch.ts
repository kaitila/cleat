// Electron without npm or Node (D0045): the release zip from Electron's GitHub release, checked against the
// release's SHASUMS256.txt, unpacked with ./unzip into <app>/node_modules/electron/dist, the folder npm's
// installer used. So the executable's path (platform.ts electronExe) and dist/version stay as they were.
// ELECTRON_MIRROR, as Electron's own installer reads it, points the download at a mirror.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractZip } from "./unzip";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/** Electron's names for the OS and the architecture of a release zip. */
export interface ElectronTarget {
  platform: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64" | "armv7l";
}

export const RELEASES = "https://github.com/electron/electron/releases/download/";

/**
 * The SHA-256 of each release zip the layouts use, for the Electron that shell/package.json pins, copied from
 * that release's SHASUMS256.txt into the repo. The download must match this, not only the SHASUMS256.txt served
 * beside it, so a mirror (or a release) that serves another zip with a matching list is refused. Bumping the
 * pinned Electron means adding its sums here (test/shell/unzip.test.ts checks they are there).
 */
export const PINNED: Record<string, string> = {
  "electron-v45.3.1-darwin-arm64.zip": "ed40f8473a3c62a7c0463bd42f6724ccb8d5919cfdc64e0d9f65f61bdb3fe4d2",
  "electron-v45.3.1-darwin-x64.zip": "68f7ff8aa374630f27403ce792d1956ae401690a95beff655a4e399ccc5d859b",
  "electron-v45.3.1-linux-arm64.zip": "98bb5dbdcd5c6daaba6d2de293fe84bfae0ba61eb4288042a13723cf865b060a",
  "electron-v45.3.1-linux-x64.zip": "c61d44206f8bd533d30310840b5baaa7fd0e8421cd711b8d1f719a7a336cbce7",
  "electron-v45.3.1-win32-x64.zip": "d92d1aa4700e3a7e7f174731f5086ebd9c21f9773e642b260160fe0a6ebe12d2",
};

/** The release zip's name: electron-v45.3.1-darwin-arm64.zip. */
export function electronAsset(version: string, target: ElectronTarget): string {
  return `electron-v${version}-${target.platform}-${target.arch}.zip`;
}

/** The folder a version's files are in: ELECTRON_MIRROR (ending in a slash) or GitHub's, then v<version>/. */
export function releaseUrl(version: string, env: Env = process.env): string {
  const base = env.ELECTRON_MIRROR?.trim() || RELEASES;
  return `${base.endsWith("/") ? base : `${base}/`}v${version}/`;
}

/** The SHA-256 SHASUMS256.txt gives a file, lower case; null when it names none. Lines are `<hex> *<name>` or `<hex>  <name>`. */
export function shaFor(shasums: string, file: string): string | null {
  for (const line of shasums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return null;
}

/** The folder Electron's files go in, under the app folder: as npm's installer laid it out. */
export function distDir(app: string): string {
  return join(app, "node_modules", "electron", "dist");
}

export interface FetchOptions {
  env?: Env;
  log?: Log;
  /** Replaced in tests. */
  fetch?: (url: string) => Promise<Response>;
  /** The pinned sums (PINNED); replaced in tests. */
  pinned?: Record<string, string>;
}

async function get(fetcher: (url: string) => Promise<Response>, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`could not download ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || !res.body) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Downloads Electron `version` for `target` and puts it in <app>/node_modules/electron/dist, replacing what
 * was there only once the new one is checked and unpacked. Throws, leaving the old one, when the download
 * fails or its SHA-256 is not the pinned one (PINNED) and the one SHASUMS256.txt gives. An asset with no pin
 * (an architecture no layout ships, such as armv7l) is checked against SHASUMS256.txt alone, and says so.
 */
export async function fetchElectron(version: string, target: ElectronTarget, app: string, options: FetchOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const fetcher = options.fetch ?? ((url: string) => fetch(url));
  const asset = electronAsset(version, target);
  const base = releaseUrl(version, env);

  const shasums = await (await get(fetcher, `${base}SHASUMS256.txt`)).text();
  const listed = shaFor(shasums, asset);
  if (!listed) throw new Error(`${base}SHASUMS256.txt names no ${asset}`);
  const pin = (options.pinned ?? PINNED)[asset];
  if (pin && pin !== listed) throw new Error(`${base}SHASUMS256.txt gives ${asset} the SHA-256 ${listed}, not the one pinned in this repo (${pin})`);
  if (!pin) log(`${asset} has no SHA-256 pinned in this repo: checked against SHASUMS256.txt only`);
  const want = pin ?? listed;

  // Unpacked beside its final place, on the same disk (windows-wsl: the Windows disk), so the swap is one rename.
  const electronDir = join(app, "node_modules", "electron");
  mkdirSync(electronDir, { recursive: true });
  const work = mkdtempSync(join(electronDir, ".download-"));
  try {
    const res = await get(fetcher, `${base}${asset}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const hasher = new Bun.CryptoHasher("sha256");
    const chunks: Uint8Array[] = [];
    let got = 0;
    let shownTenth = -1;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      chunks.push(value);
      got += value.length;
      const tenth = total ? Math.floor((got / total) * 10) : -1;
      if (tenth > shownTenth) {
        shownTenth = tenth;
        log(`downloading ${asset}: ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`);
      }
    }
    const sha = hasher.digest("hex");
    if (sha !== want) throw new Error(`${asset} is not the release's: its SHA-256 is ${sha}, not ${want}`);
    const zip = Buffer.concat(chunks);

    log(`unpacking ${asset} (SHA-256 checked)`);
    const fresh = join(work, "dist");
    extractZip(zip, fresh);
    // npm's installer leaves dist/version; a zip without one gets it, so installedElectron can read it.
    if (!existsSync(join(fresh, "version"))) writeFileSync(join(fresh, "version"), version);

    // Only a whole, checked dist is ever in place: removed, then the new one renamed in. A stop between the two
    // leaves none, which counts as not installed, so the next install fetches it again.
    const dist = distDir(app);
    rmSync(dist, { recursive: true, force: true });
    renameSync(fresh, dist);
    return readFileSync(join(dist, "version"), "utf8").trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
