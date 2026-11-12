import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../shell/src/args";
import { captureBody, clipFileName, clipsToPrune, isPng, KEEP_CLIPS, MAX_TEXT, PNG_SIGNATURE, saveClip } from "../../shell/src/clip";
import { centred, iconBitmap } from "../../shell/src/geometry";
import { chatUrl, promptUrl, sameOrigin, sessionOf } from "../../shell/src/origin";
import type { SelfTestResult } from "../../shell/src/result";
import { DEFAULT_SETTINGS, loadSettings, parseSettings } from "../../shell/src/settings";
import { buildShell, BUNDLE, wantedElectron } from "../../src/shell/install";
import { REPO } from "../../src/shell/paths";
import { problems, selfTestRun, stubRunner } from "../../src/shell/selftest-run";

const dir = mkdtempSync(join(tmpdir(), "intuition-shell-test-"));
const RUNNER = "http://127.0.0.1:4777";

describe("bundle", () => {
  test("builds into one CommonJS file that requires electron and does not contain it", async () => {
    const file = await buildShell(join(dir, "bundle"));
    expect(file.endsWith(BUNDLE)).toBe(true);
    const code = readFileSync(file, "utf8");
    expect(code).toContain('require("electron")');
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain("--self-test");
    expect(code.length).toBeLessThan(200_000);
  });

  test("the shell pins the Electron the repo has types for", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(wantedElectron()).toBe(root.devDependencies.electron);
  });

  test("only main.ts imports electron, and its windows are sandboxed without Node", () => {
    const src = join(REPO, "shell", "src");
    for (const name of readdirSync(src)) {
      const imports = /from "electron"|require\("electron"\)/.test(readFileSync(join(src, name), "utf8"));
      expect(`${name}: ${imports}`).toBe(`${name}: ${name === "main.ts"}`);
    }
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toContain("sandbox: true, contextIsolation: true, nodeIntegration: false");
    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(2);
    expect(main.match(/webPreferences: WEB_PREFERENCES/g)).toHaveLength(2);
    expect(main).not.toMatch(/preload\s*:/);
  });
});

describe("settings", () => {
  test("a first start writes the defaults", () => {
    const file = join(dir, "data", "settings.json");
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://127.0.0.1:4777", hotkey: "Control+Alt+Space" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(DEFAULT_SETTINGS);
  });

  test("a changed file is read, and is not overwritten", () => {
    const file = join(dir, "changed.json");
    writeFileSync(file, JSON.stringify({ runnerUrl: "http://localhost:5000/", hotkey: " Alt+F9 " }));
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://localhost:5000", hotkey: "Alt+F9" });
    expect(JSON.parse(readFileSync(file, "utf8")).hotkey).toBe(" Alt+F9 ");
  });

  test("anything missing or malformed falls back to its default", () => {
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"hotkey":"Alt+F9"}')).toEqual({ ...DEFAULT_SETTINGS, hotkey: "Alt+F9" });
    expect(parseSettings('{"runnerUrl":"file:///c:/x","hotkey":7}')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"runnerUrl":"javascript:alert(1)"}')).toEqual(DEFAULT_SETTINGS);
  });
});

describe("clips", () => {
  test("the file name is clip-<time>.png and sorts by age", () => {
    const a = clipFileName(new Date(2026, 10, 12, 9, 5, 7, 42));
    expect(a).toBe("clip-20261112-090507-042.png");
    expect(clipFileName(new Date(2026, 10, 12, 9, 5, 7, 43)) > a).toBe(true);
    expect(clipFileName(new Date(2026, 10, 12, 10, 0, 0, 0)) > a).toBe(true);
  });

  test("pruning names the clips beyond the newest 20 and nothing else", () => {
    const names = Array.from({ length: 25 }, (_, i) => clipFileName(new Date(2026, 0, 1, 0, 0, i)));
    const prune = clipsToPrune([...names].reverse().concat("notes.txt", "clip-x.png.bak", "self-test-data"));
    expect(prune.sort()).toEqual(names.slice(0, 5));
    expect(clipsToPrune(names.slice(0, KEEP_CLIPS))).toEqual([]);
  });

  test("saving writes the PNG and keeps the newest 20 in the folder", () => {
    const clips = join(dir, "clips");
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.from("rest")]);
    let last = "";
    for (let i = 0; i < 23; i++) last = saveClip(clips, png, new Date(2026, 0, 1, 0, 0, i));
    writeFileSync(join(clips, "other.txt"), "kept");
    last = saveClip(clips, png, new Date(2026, 0, 1, 0, 0, 23));
    const left = readdirSync(clips);
    expect(left.filter((n) => n.startsWith("clip-"))).toHaveLength(20);
    expect(left).toContain("other.txt");
    expect(left).toContain("clip-20260101-000023-000.png");
    expect(left).not.toContain("clip-20260101-000003-000.png");
    expect(isPng(readFileSync(last))).toBe(true);
  });

  test("a PNG is known by its signature", () => {
    expect(isPng(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4)]))).toBe(true);
    expect(isPng(PNG_SIGNATURE)).toBe(false);
    expect(isPng(Buffer.from("BM bitmap bytes here"))).toBe(false);
  });

  test("a capture becomes the request body", () => {
    expect(captureBody({ kind: "image", path: "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png" })).toEqual({ imagePath: "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png" });
    expect(captureBody({ kind: "text", text: "hello" })).toEqual({ text: "hello" });
    expect(captureBody({ kind: "text", text: "x".repeat(MAX_TEXT + 5) }).text).toHaveLength(20_000);
    expect(captureBody({ kind: "text", text: " \r\n" })).toEqual({});
    expect(captureBody({ kind: "empty" })).toEqual({});
  });
});

describe("origin", () => {
  test("only the runner's own origin passes", () => {
    expect(sameOrigin("http://127.0.0.1:4777/prompt", RUNNER)).toBe(true);
    expect(sameOrigin("http://127.0.0.1:4777/?session=abc#x", RUNNER)).toBe(true);
    for (const url of [
      "http://localhost:4777/prompt",
      "http://127.0.0.1:4778/",
      "https://127.0.0.1:4777/",
      "http://127.0.0.1.evil.test:4777/",
      "http://evil.test/?http://127.0.0.1:4777/",
      "http://127.0.0.1:4777@evil.test/",
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "about:blank",
      "data:text/html,hi",
      "",
      "not a url",
    ]) {
      expect(`${url} ${sameOrigin(url, RUNNER)}`).toBe(`${url} false`);
    }
  });

  test("the pages' addresses", () => {
    expect(promptUrl(RUNNER)).toBe("http://127.0.0.1:4777/prompt");
    expect(chatUrl(RUNNER)).toBe("http://127.0.0.1:4777/");
    expect(chatUrl(RUNNER, "a b&c")).toBe("http://127.0.0.1:4777/?session=a+b%26c");
    expect(sessionOf(chatUrl(RUNNER, "a b&c"))).toBe("a b&c");
    expect(sessionOf(chatUrl(RUNNER))).toBeUndefined();
  });
});

describe("geometry and arguments", () => {
  test("the pop-up sits in the middle of the display's area, on a second display too", () => {
    expect(centred({ x: 0, y: 0, width: 1920, height: 1040 }, 560, 380)).toEqual({ x: 680, y: 330 });
    expect(centred({ x: -1280, y: 100, width: 1280, height: 985 }, 560, 380)).toEqual({ x: -920, y: 403 });
  });

  test("the icon is a disc: opaque in the middle, clear in the corners", () => {
    const px = iconBitmap(32);
    expect(px).toHaveLength(32 * 32 * 4);
    expect(px[(16 * 32 + 16) * 4 + 3]).toBe(255);
    expect(px[3]).toBe(0);
  });

  test("the command line", () => {
    expect(parseArgs(["electron.exe", "C:\\app"])).toEqual({ selfTest: undefined, runnerUrl: undefined, session: undefined, quit: false });
    expect(parseArgs(["electron.exe", "C:\\app", "--self-test", "C:\\r.json", "--runner-url", "http://127.0.0.1:5"])).toMatchObject({ selfTest: "C:\\r.json", runnerUrl: "http://127.0.0.1:5" });
    expect(parseArgs(["e", "app", "--quit"]).quit).toBe(true);
    expect(parseArgs(["e", "app", "--session", "s1"]).session).toBe("s1");
    expect(parseArgs(["e", "app", "--self-test"]).selfTest).toBeUndefined();
    expect(parseArgs(["e", "app", "--self-test", "--quit"]).selfTest).toBeUndefined();
  });
});

describe("self-test runner", () => {
  const imagePath = "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-20261112-090507-042.png";
  const good: SelfTestResult = {
    hotkeyRegistered: true, trayCreated: true, textCaptured: true, textPosted: true, imageCaptured: true, imagePosted: true, imagePath,
    notificationsSupported: true, popupCreated: true, popupWidth: 560, popupHeight: 380, popupUrl: "http://127.0.0.1:5000/prompt",
    popupVisible: true, popupCentred: true, foreignNavigationRefused: true, foreignWindowRefused: true, pageClosedPopup: true,
    noWindowWithoutRunner: true, clipboardRestored: true, errors: [],
  };
  const posts = [{ text: "intuition self-test 1" }, { imagePath }];
  const png = () => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]);
  const check = (r: Partial<SelfTestResult>, p = posts, read: () => Uint8Array | null = png) => problems(r, p, "http://127.0.0.1:5000", read);

  test("a clean result has no problems", () => {
    expect(check(good)).toEqual([]);
  });

  test("every field is asserted", () => {
    for (const key of Object.keys(good) as (keyof SelfTestResult)[]) {
      const broken = { ...good, [key]: key === "errors" ? ["boom"] : typeof good[key] === "number" ? 381 : typeof good[key] === "string" ? "C:\\elsewhere" : false };
      expect(`${key}: ${check(broken).length > 0}`).toBe(`${key}: true`);
    }
    expect(check({}).length).toBeGreaterThan(10);
  });

  test("what the stub runner received and the saved file are asserted too", () => {
    expect(check(good, [{ imagePath }])).toHaveLength(1);
    expect(check(good, [{ text: "intuition self-test 1" }])).toHaveLength(1);
    expect(check(good, posts, () => null)).toHaveLength(2);
    expect(check(good, posts, () => Buffer.from("BM not a png at all"))).toHaveLength(1);
  });

  test("the stub runner answers what the shell asks and records the clipboard posts", async () => {
    const runner = stubRunner();
    try {
      expect(await (await fetch(`${runner.url}/health`)).json()).toMatchObject({ ok: true });
      expect((await fetch(`${runner.url}/prompt`)).headers.get("content-type")).toContain("text/html");
      const res = await fetch(`${runner.url}/api/clipboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
      expect(res.status).toBe(200);
      expect(runner.posts).toEqual([{ text: "hi" }]);
      expect((await fetch(`${runner.url}/nope`)).status).toBe(404);
    } finally {
      await runner.stop();
    }
  });

  test("it is skipped when CI is set", async () => {
    const before = process.env.CI;
    process.env.CI = "true";
    try {
      expect(await selfTestRun()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.CI;
      else process.env.CI = before;
    }
  });
});

describe("the repo", () => {
  test("has no AutoHotkey, PowerShell, batch or shell-script file", () => {
    const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: REPO }).stdout.toString().split("\n");
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /\.(ahk|ps1|cmd|bat|sh)$/i.test(f))).toEqual([]);
  });
});
