import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../shell/src/args";
import { captureBody, clipFileName, clipsToPrune, isPng, KEEP_CLIPS, MAX_TEXT, PNG_SIGNATURE, saveClip } from "../../shell/src/clip";
import { acceptedState, DOCK_CHANNEL, DOCK_CHECK_MS, DOCK_MISSES, DOCK_PRELOAD, DOCK_SIZES, DOCK_STATES, dockBounds, dockFocusable, isDockState } from "../../shell/src/dock";
import { centred, iconBitmap } from "../../shell/src/geometry";
import { APP_ID, loginItem, parseLogin } from "../../shell/src/login";
import { chatUrl, dockUrl, promptUrl, sameOrigin, sessionOf, windowTarget } from "../../shell/src/origin";
import type { SelfTestResult } from "../../shell/src/result";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveDock, withDock, withWsl } from "../../shell/src/settings";
import { parseWsl, RUNNER_START_MS, runnerCommand } from "../../shell/src/wsl";
import { buildShell, BUNDLE, isInstalled, runnerLocation, wantedElectron, writeRunnerLocation } from "../../src/shell/install";
import { REPO } from "../../src/shell/paths";
import { problems, selfTestRun, STUB_SESSION, stubRunner } from "../../src/shell/selftest-run";

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

  test("the dock's preload is its own small file beside it, and exposes setState and nothing else", async () => {
    const out = join(dir, "bundle-preload");
    await buildShell(out);
    expect(readdirSync(out).sort()).toEqual([DOCK_PRELOAD, BUNDLE].sort());
    const code = readFileSync(join(out, DOCK_PRELOAD), "utf8");
    expect(code).toContain('require("electron")');
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain(DOCK_CHANNEL);
    // A sandboxed preload can require electron and nothing else.
    expect(code.match(/require\("[^"]+"\)/g)).toEqual(['require("electron")']);
    expect(code.length).toBeLessThan(5_000);

    const src = readFileSync(join(REPO, "shell", "src", "dock-preload.ts"), "utf8");
    expect(src.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(src).toContain('contextBridge.exposeInMainWorld("intuitionDock", {\n  setState: (state: unknown): void => {\n    ipcRenderer.send(DOCK_CHANNEL, state);\n  },\n});');
    // One way out of the page: a send on the dock's channel. Nothing comes back in.
    expect(src.match(/ipcRenderer\.\w+/g)).toEqual(["ipcRenderer.send"]);
  });

  test("an install without the preload counts as not installed, so `up` installs again", () => {
    const app = join(dir, "installed");
    const paths = { home: dir, app, electronExe: join(app, "electron.exe") };
    mkdirSync(app, { recursive: true });
    writeFileSync(paths.electronExe, "");
    writeFileSync(join(app, BUNDLE), "");
    expect(isInstalled(paths)).toBe(false);
    writeFileSync(join(app, DOCK_PRELOAD), "");
    expect(isInstalled(paths)).toBe(true);
  });

  test("the shell pins the Electron the repo has types for", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(wantedElectron()).toBe(root.devDependencies.electron);
  });

  test("only main.ts and the preload import electron, and the windows are sandboxed without Node; only the dock has a preload", () => {
    const src = join(REPO, "shell", "src");
    for (const name of readdirSync(src)) {
      const imports = /from "electron"|require\("electron"\)/.test(readFileSync(join(src, name), "utf8"));
      expect(`${name}: ${imports}`).toBe(`${name}: ${name === "main.ts" || name === "dock-preload.ts"}`);
    }
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toContain("sandbox: true, contextIsolation: true, nodeIntegration: false");
    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(3);
    // The pop-up and the chat window: no preload. The dock: the same preferences, plus its preload.
    expect(main.match(/webPreferences: WEB_PREFERENCES/g)).toHaveLength(2);
    expect(main.match(/webPreferences:/g)).toHaveLength(3);
    expect(main).toContain("webPreferences: { ...WEB_PREFERENCES, preload: join(app.getAppPath(), DOCK_PRELOAD) }");
    expect(main.match(/preload\s*:/g)).toHaveLength(1);
    expect(main).not.toMatch(/nodeIntegration: true|sandbox: false|contextIsolation: false|webSecurity: false/);
  });
});

describe("settings", () => {
  test("a first start writes the defaults", () => {
    const file = join(dir, "data", "settings.json");
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://127.0.0.1:4777", hotkey: "Control+Alt+Space", dock: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(DEFAULT_SETTINGS);
  });

  test("a changed file is read, and is not overwritten", () => {
    const file = join(dir, "changed.json");
    writeFileSync(file, JSON.stringify({ runnerUrl: "http://localhost:5000/", hotkey: " Alt+F9 " }));
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://localhost:5000", hotkey: "Alt+F9", dock: true });
    expect(JSON.parse(readFileSync(file, "utf8")).hotkey).toBe(" Alt+F9 ");
  });

  test("anything missing or malformed falls back to its default", () => {
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"hotkey":"Alt+F9"}')).toEqual({ ...DEFAULT_SETTINGS, hotkey: "Alt+F9" });
    expect(parseSettings('{"runnerUrl":"file:///c:/x","hotkey":7}')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"runnerUrl":"javascript:alert(1)"}')).toEqual(DEFAULT_SETTINGS);
  });

  test("the dock is on unless the file says false, and the tray's checkbox is written keeping the rest", () => {
    expect(DEFAULT_SETTINGS.dock).toBe(true);
    expect(parseSettings('{"dock":false}').dock).toBe(false);
    expect(parseSettings('{"dock":true}').dock).toBe(true);
    for (const odd of ['"no"', "0", "null", "{}"]) expect(parseSettings(`{"dock":${odd}}`).dock).toBe(true);

    const file = join(dir, "dock", "settings.json");
    saveDock(file, false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, dock: false });
    writeFileSync(file, JSON.stringify({ hotkey: "Alt+F9", mine: true, dock: false }));
    saveDock(file, true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hotkey: "Alt+F9", mine: true, dock: true });
    expect(loadSettings(file)).toMatchObject({ hotkey: "Alt+F9", dock: true });
    expect(JSON.parse(withDock("not json", false))).toEqual({ ...DEFAULT_SETTINGS, dock: false });
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
    expect(dockUrl(RUNNER)).toBe("http://127.0.0.1:4777/dock");
  });

  test("new windows: the chat view from any page, the pop-up from the dock only, nothing else", () => {
    for (const fromDock of [true, false]) {
      expect(windowTarget("http://127.0.0.1:4777/?session=a+b%26c", RUNNER, fromDock)).toEqual({ kind: "chat", session: "a b&c" });
      expect(windowTarget("http://127.0.0.1:4777/", RUNNER, fromDock)).toEqual({ kind: "chat", session: undefined });
      for (const url of ["http://127.0.0.1:4777/dock", "http://127.0.0.1:4777/assets/base.css", "http://127.0.0.1:4777/prompt/x", "http://127.0.0.1:4777/api/sessions", "http://localhost:4777/prompt", "http://localhost:4777/?session=x", "https://example.com/", "file:///C:/x", "javascript:alert(1)", "about:blank", ""]) {
        expect(`${url} ${windowTarget(url, RUNNER, fromDock)}`).toBe(`${url} null`);
      }
    }
    expect(windowTarget("http://127.0.0.1:4777/prompt", RUNNER, true)).toEqual({ kind: "prompt" });
    expect(windowTarget("http://127.0.0.1:4777/prompt?x=1", RUNNER, true)).toEqual({ kind: "prompt" });
    expect(windowTarget("http://127.0.0.1:4777/prompt", RUNNER, false)).toBeNull();
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

describe("the dock", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const sender = { fromDock: true, mainFrame: true, url: "http://127.0.0.1:4777/dock" };

  test("three states, each an exact size", () => {
    expect([...DOCK_STATES]).toEqual(["idle", "peek", "open"]);
    expect(DOCK_SIZES).toEqual({ idle: { width: 280, height: 40 }, peek: { width: 420, height: 76 }, open: { width: 460, height: 600 } });
  });

  test("the bounds in each state: the top edge of the display, centred", () => {
    expect(dockBounds(display, "idle")).toEqual({ x: 820, y: 0, width: 280, height: 40 });
    expect(dockBounds(display, "peek")).toEqual({ x: 750, y: 0, width: 420, height: 76 });
    expect(dockBounds(display, "open")).toEqual({ x: 730, y: 0, width: 460, height: 600 });
  });

  test("on a primary display that does not start at 0,0, of an odd width, or smaller than the dock", () => {
    expect(dockBounds({ x: -1280, y: 200, width: 1280, height: 1024 }, "idle")).toEqual({ x: -780, y: 200, width: 280, height: 40 });
    // An odd width: whole pixels, and the same middle in every state to within one.
    const odd = { x: 0, y: 0, width: 1367, height: 768 };
    for (const state of DOCK_STATES) {
      const b = dockBounds(odd, state);
      expect(Number.isInteger(b.x)).toBe(true);
      expect(Math.abs(b.x + b.width / 2 - 1367 / 2)).toBeLessThanOrEqual(0.5);
      expect(b.y).toBe(0);
    }
    // The size never gives way: the contract says exactly this size.
    expect(dockBounds({ x: 0, y: 0, width: 400, height: 300 }, "open")).toEqual({ x: -30, y: 0, width: 460, height: 600 });
  });

  test("only open can take the keyboard", () => {
    expect(DOCK_STATES.map(dockFocusable)).toEqual([false, false, true]);
  });

  test("setState is taken from the dock's main frame on the runner's origin, with one of the three values", () => {
    for (const state of DOCK_STATES) expect(acceptedState(sender, RUNNER, state)).toBe(state);
    expect(acceptedState({ ...sender, url: "http://127.0.0.1:4777/dock?x#y" }, RUNNER, "peek")).toBe("peek");
  });

  test("any other value is refused", () => {
    for (const bad of ["Open", "OPEN", " open", "open ", "closed", "huge", "", "idle,open", 0, 1, true, null, undefined, {}, [], ["open"], { state: "open" }, { toString: () => "open" }]) {
      expect(`${JSON.stringify(bad)} ${acceptedState(sender, RUNNER, bad)}`).toBe(`${JSON.stringify(bad)} null`);
      expect(isDockState(bad)).toBe(false);
    }
    // A name every object has is not a state.
    for (const inherited of ["constructor", "toString", "__proto__", "length"]) expect(acceptedState(sender, RUNNER, inherited)).toBeNull();
  });

  test("another window, a frame inside the page, another origin or a frame that is gone: refused", () => {
    expect(acceptedState({ ...sender, fromDock: false }, RUNNER, "open")).toBeNull();
    expect(acceptedState({ ...sender, mainFrame: false }, RUNNER, "open")).toBeNull();
    expect(acceptedState({ ...sender, url: null }, RUNNER, "open")).toBeNull();
    for (const url of ["http://localhost:4777/dock", "http://127.0.0.1:4778/dock", "https://127.0.0.1:4777/dock", "http://127.0.0.1.evil.test:4777/dock", "https://evil.test/dock", "file:///C:/dock.html", "about:blank", "data:text/html,x", ""]) {
      expect(`${url} ${acceptedState({ ...sender, url }, RUNNER, "open")}`).toBe(`${url} null`);
    }
  });

  test("the runner is asked every few seconds, and has to miss twice before the dock hides", () => {
    expect(DOCK_CHECK_MS).toBeGreaterThanOrEqual(2000);
    expect(DOCK_CHECK_MS).toBeLessThanOrEqual(5000);
    expect(DOCK_MISSES).toBe(2);
  });

  test("main.ts: the window is frameless, clear, on top, out of the taskbar, never activated, and placed from the display's bounds", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    const create = main.slice(main.indexOf("function createDock()"), main.indexOf("async function loadDock()"));
    for (const option of ["frame: false", "transparent: true", "hasShadow: false", "alwaysOnTop: true", "skipTaskbar: true", 'type: "toolbar"', "focusable: false", "show: false", "movable: false"]) expect(create).toContain(option);
    expect(create).toContain('win.on("will-resize", (event) => event.preventDefault());');
    const dockCode = main.slice(main.indexOf("// --- Dock ---"), main.indexOf("// --- Self-test ---"));
    // Shown without activating, and never focused by the shell.
    expect(dockCode).toContain("win.showInactive();");
    expect(dockCode).not.toMatch(/\.show\(\)|\.focus\(\)/);
    // The primary display's bounds, not its work area.
    expect(dockCode.match(/screen\.getPrimaryDisplay\(\)\.bounds/g)).toHaveLength(2);
    expect(dockCode).not.toContain("workArea");
    for (const event of ["display-metrics-changed", "display-added", "display-removed"]) expect(dockCode).toContain(`screen.on("${event}", placeDock);`);
  });

  test("main.ts: one listener on the dock's channel, and it resizes only through the validation", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main.match(/ipcMain\.\w+\(/g)).toEqual(["ipcMain.on("]);
    expect(main).toContain("ipcMain.on(DOCK_CHANNEL, onDockState);");
    const handler = main.slice(main.indexOf("function onDockState("), main.indexOf("/** Listens for the page's setState"));
    expect(handler).toContain("event.sender === dock.webContents");
    expect(handler).toContain("frame.parent === null");
    expect(handler).toContain("acceptedState(");
    expect(handler).toContain("if (state) setDockState(state);");
  });

  test("main.ts: a page that fails to load, a 404 or a crashed page hides the dock; 'Show dock' is in the tray", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main).toContain("if (dockStatus < 200 || dockStatus >= 300) throw");
    expect(main).toContain('win.webContents.on("render-process-gone", () => hideDock());');
    expect(main).toContain("if (isMainFrame && code !== -3) hideDock();");
    expect(main).toContain('{ label: "Show dock", type: "checkbox", checked: settings.dock, click: (item) => setDock(item.checked) }');
  });
});

describe("no toasts for sessions", () => {
  test("the poller is gone: nothing in the shell asks for notifications or shows one for a session", () => {
    const src = join(REPO, "shell", "src");
    expect(readdirSync(src)).not.toContain("poller.ts");
    for (const name of readdirSync(src)) {
      const code = readFileSync(join(src, name), "utf8");
      expect(`${name}: ${/api\/notifications|toastOf|pollOnce|Open last session|lastSession/.test(code)}`).toBe(`${name}: false`);
    }
    const main = readFileSync(join(src, "main.ts"), "utf8");
    // The one Notification left is notify(): the runner is not running, the hotkey is taken, start on login failed.
    expect(main.match(/new Notification\(/g)).toHaveLength(1);
    expect(main.match(/\bnotify\(/g)).toHaveLength(4);
    for (const title of ["intuition: the runner is not running", "intuition: the hotkey is taken", "intuition: start on login was not changed"]) expect(main).toContain(`notify("${title}"`);
    expect(main).toContain("app.setAppUserModelId(");
  });
});

describe("self-test runner", () => {
  const imagePath = "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-20261112-090507-042.png";
  const display = { x: 0, y: 0, width: 2560, height: 1440 };
  const good: SelfTestResult = {
    hotkeyRegistered: true, trayCreated: true, textCaptured: true, textPosted: true, imageCaptured: true, imagePosted: true, imagePath,
    notificationsSupported: true, popupCreated: true, popupWidth: 560, popupHeight: 380, popupUrl: "http://127.0.0.1:5000/prompt",
    popupVisible: true, popupCentred: true, foreignNavigationRefused: true, foreignWindowRefused: true, pageClosedPopup: true,
    noWindowWithoutRunner: true, clipboardRestored: true, loginItemRead: true, openAtLogin: false,
    dockOffNoWindow: true, dockCreated: true, dockUrl: "http://127.0.0.1:5000/dock", dockVisible: true, dockBridge: "object:setState:undefined:undefined",
    primaryDisplay: display, dockIdleBounds: { x: 1140, y: 0, width: 280, height: 40 }, dockIdleFocusable: false, dockIdleFocused: false,
    dockOpenBounds: { x: 1050, y: 0, width: 460, height: 600 }, dockOpenFocusable: true, dockOtherValueIgnored: true,
    dockBackBounds: { x: 1140, y: 0, width: 280, height: 40 }, dockBackFocusable: false, dockForeignOriginIgnored: true,
    dockOpenedChatUrl: `http://127.0.0.1:5000/?session=${STUB_SESSION}`, dockOpenedPromptUrl: "http://127.0.0.1:5000/prompt",
    dockOtherWindowRefused: true, dockHiddenWithoutRunner: true, dockShownAgain: true, errors: [],
  };
  const posts = [{ text: "intuition self-test 1" }, { imagePath }];
  const png = () => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]);
  const check = (r: Partial<SelfTestResult>, p = posts, read: () => Uint8Array | null = png) => problems(r, { posts: p }, "http://127.0.0.1:5000", read);

  test("a clean result has no problems", () => {
    expect(check(good)).toEqual([]);
  });

  test("every field is asserted", () => {
    for (const key of Object.keys(good) as (keyof SelfTestResult)[]) {
      const value = good[key];
      // Flipped, moved or replaced, by the field's kind. A display moved sideways moves where the dock should be.
      const broken = {
        ...good,
        [key]: key === "errors" ? ["boom"] : typeof value === "number" ? 381 : typeof value === "string" || key === "openAtLogin" ? "C:\\elsewhere"
          : typeof value === "boolean" ? !value : value && typeof value === "object" ? { ...value, x: (value as { x: number }).x + 2 } : false,
      };
      expect(`${key}: ${check(broken).length > 0}`).toBe(`${key}: true`);
    }
    expect(check({}).length).toBeGreaterThan(10);
  });

  test("the dock's bounds are judged against the display the shell reported", () => {
    // The same dock on another display is in the wrong place three times: at first, open, and back.
    expect(check({ ...good, primaryDisplay: { ...display, width: 1920 } })).toHaveLength(3);
    // On the display's top edge, wherever that is.
    const lower = { ...display, y: 300 };
    expect(check({ ...good, primaryDisplay: lower })).toHaveLength(3);
    expect(check({ ...good, primaryDisplay: lower, dockIdleBounds: { ...good.dockIdleBounds!, y: 300 }, dockOpenBounds: { ...good.dockOpenBounds!, y: 300 }, dockBackBounds: { ...good.dockBackBounds!, y: 300 } })).toEqual([]);
    for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 0 }, { x: "0", y: 0, width: 100, height: 100 }]) expect(check({ ...good, primaryDisplay: bad as never }).length).toBeGreaterThanOrEqual(4);
    // One pixel off, or one pixel too tall, is a failure: the contract says exactly.
    expect(check({ ...good, dockOpenBounds: { ...good.dockOpenBounds!, height: 601 } })).toHaveLength(1);
    expect(check({ ...good, dockBackBounds: good.dockOpenBounds })).toHaveLength(1);
    // The bridge with anything more on it, or Node in the page.
    for (const bridge of ["object:setState,resize:undefined:undefined", "undefined::undefined:undefined", "object:setState:function:undefined", "object:setState:undefined:object"]) expect(check({ ...good, dockBridge: bridge })).toHaveLength(1);
  });

  test("start on login is reported, on or off: either passes, and only an unread one fails", () => {
    expect(check({ ...good, openAtLogin: true })).toEqual([]);
    expect(check({ ...good, openAtLogin: false })).toEqual([]);
    expect(check({ ...good, openAtLogin: null })).toHaveLength(1);
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
      // The dock page calls setState when the bridge is there, and has a clear background.
      const dockPage = await (await fetch(`${runner.url}/dock`)).text();
      expect(dockPage).toContain('window.intuitionDock?.setState("idle")');
      expect(dockPage).toContain("background: transparent");
      // Notifications are the real runner's; the shell no longer asks for them.
      expect((await fetch(`${runner.url}/api/notifications`)).status).toBe(404);
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

describe("starting the runner from Windows", () => {
  const wsl = { distro: "Ubuntu", repo: "/root/projects/intuition", bun: "/root/.bun/bin/bun" };

  test("wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env, as an array", () => {
    expect(runnerCommand(wsl)).toEqual({
      file: "C:\\Windows\\System32\\wsl.exe",
      args: ["-d", "Ubuntu", "--exec", "/root/.bun/bin/bun", "/root/projects/intuition/src/cli.ts", "start", "--login-env"],
    });
    expect(runnerCommand(wsl, "D:\\WINNT\\").file).toBe("D:\\WINNT\\System32\\wsl.exe");
    expect(runnerCommand({ ...wsl, repo: "/repo/" }).args[4]).toBe("/repo/src/cli.ts");
  });

  test("paths with spaces stay one argument each", () => {
    const { args } = runnerCommand({ distro: "Ubuntu-24.04", repo: "/home/a b/my repo", bun: "/home/a b/.bun/bin/bun" });
    expect(args).toEqual(["-d", "Ubuntu-24.04", "--exec", "/home/a b/.bun/bin/bun", "/home/a b/my repo/src/cli.ts", "start", "--login-env"]);
  });

  test("shell characters in a path are data: they stay inside their one argument, and --exec runs no shell", () => {
    const repo = "/tmp/x; rm -rf ~ && $(id) `id` | \"q\" 'q' > /dev/null #";
    const { args } = runnerCommand({ ...wsl, repo });
    expect(args).toHaveLength(7);
    expect(args[4]).toBe(`${repo}/src/cli.ts`);
    expect(args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--exec", "/root/.bun/bin/bun"]);
    expect(args.slice(5)).toEqual(["start", "--login-env"]);
    // Never the default shell (no --exec, or `--`, `-c`, `bash`), which would read the line as a script.
    expect(args.filter((a) => a.startsWith("-"))).toEqual(["-d", "--exec", "--login-env"]);
  });

  test("settings that could be read as options, or are not what they should be, give no command at all", () => {
    expect(parseWsl(wsl)).toEqual(wsl);
    expect(parseWsl({ ...wsl, extra: 1 })).toEqual(wsl);
    for (const bad of [
      null, "x", [], {},
      { ...wsl, distro: "--exec" }, { ...wsl, distro: "-u root" }, { ...wsl, distro: "Ubuntu; calc" }, { ...wsl, distro: "a b" }, { ...wsl, distro: "" }, { ...wsl, distro: 7 },
      { ...wsl, bun: "bun" }, { ...wsl, bun: "--version" }, { ...wsl, bun: "C:\\bun.exe" }, { ...wsl, bun: "/bin/b\nun" }, { ...wsl, bun: undefined },
      { ...wsl, repo: "~/intuition" }, { ...wsl, repo: "-e" }, { ...wsl, repo: "" }, { ...wsl, repo: "/r\u0000" }, { ...wsl, repo: ["/r"] },
    ]) {
      expect(`${JSON.stringify(bad)} ${parseWsl(bad)}`).toBe(`${JSON.stringify(bad)} undefined`);
    }
  });

  test("the settings carry it only when it is whole", () => {
    expect(parseSettings(JSON.stringify({ wsl }))).toEqual({ ...DEFAULT_SETTINGS, wsl });
    expect(parseSettings(JSON.stringify({ wsl: { ...wsl, distro: "--exec" } }))).toEqual(DEFAULT_SETTINGS);
    expect("wsl" in parseSettings("{}")).toBe(false);
  });

  test("`shell install` writes the distribution, the repo and bun into the settings, keeping the rest", () => {
    expect(runnerLocation({ WSL_DISTRO_NAME: "Ubuntu" }, "/home/a b/repo", "/home/a b/bun")).toEqual({ distro: "Ubuntu", repo: "/home/a b/repo", bun: "/home/a b/bun" });
    expect(runnerLocation({ WSL_DISTRO_NAME: "Ubuntu" })).toEqual({ distro: "Ubuntu", repo: REPO, bun: process.execPath });
    expect(runnerLocation({})).toBeUndefined();

    const file = join(dir, "roaming", "intuition-shell", "settings.json");
    const lines: string[] = [];
    expect(writeRunnerLocation(file, wsl, (l) => lines.push(l))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, wsl });
    expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, wsl });
    expect(lines).toHaveLength(1);

    writeFileSync(file, JSON.stringify({ hotkey: "Alt+F9", mine: true, wsl: { distro: "Old", repo: "/old", bun: "/old/bun" } }));
    expect(writeRunnerLocation(file, wsl, () => {})).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hotkey: "Alt+F9", mine: true, wsl });
    // Nothing to change: nothing is written or said.
    expect(writeRunnerLocation(file, wsl, (l) => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(1);

    // No distribution name: the file is left alone.
    const before = readFileSync(file, "utf8");
    expect(writeRunnerLocation(file, null, () => {})).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(withWsl("not json", wsl))).toEqual({ ...DEFAULT_SETTINGS, wsl });
    expect(JSON.parse(withWsl("[1]", wsl))).toEqual({ ...DEFAULT_SETTINGS, wsl });
  });

  test("main.ts spawns that command without a shell or a window, and waits ten seconds", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(RUNNER_START_MS).toBe(10_000);
    expect(main).toContain("spawn(file, wslArgs, { stdio: \"ignore\", windowsHide: true, shell: false })");
    expect(main.match(/\bspawn\(/g)).toHaveLength(1);
    expect(main).not.toMatch(/\bexec(Sync|File|FileSync)?\(/);
    // The self-test never starts a runner.
    expect(main).toContain("if (args.selfTest || !wsl) return false;");
  });
});

describe("start on login", () => {
  test("the login item: electron.exe on the quoted app folder", () => {
    const exe = "C:\\Users\\A B\\AppData\\Local\\intuition\\shell\\node_modules\\electron\\dist\\electron.exe";
    const appFolder = "C:\\Users\\A B\\AppData\\Local\\intuition\\shell";
    expect(loginItem(exe, appFolder)).toEqual({ path: exe, args: [`"${appFolder}"`] });
    expect(APP_ID).toBe("intuition");
  });

  test("--login takes on, off or status, and nothing else", () => {
    expect(parseArgs(["e", "app", "--login", "on", "--login-result", "C:\\r.json"])).toMatchObject({ login: "on", loginResult: "C:\\r.json" });
    expect(parseArgs(["e", "app", "--login", "off"]).login).toBe("off");
    expect(parseArgs(["e", "app", "--login", "status"]).login).toBe("status");
    for (const bad of ["yes", "ON", "", undefined]) expect(parseLogin(bad)).toBeUndefined();
    expect(parseArgs(["e", "app", "--login"]).login).toBeUndefined();
    expect(parseArgs(["e", "app"]).login).toBeUndefined();
  });

  test("only the tray's checkbox and --login set it; the self-test and the scripts only read", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main.match(/setLoginItemSettings\(/g)).toHaveLength(1);
    // The function itself, the checkbox's click, and --login on|off.
    expect(main.match(/setStartOnLogin\(/g)).toHaveLength(3);
    expect(main).toContain("setStartOnLogin(item.checked)");
    expect(main).toContain('if (action !== "status") setStartOnLogin(action === "on");');
    const selfTest = main.slice(main.indexOf("async function selfTest()"), main.indexOf("// --- Start ---"));
    expect(selfTest).toContain("startsOnLogin()");
    expect(selfTest).not.toMatch(/setStartOnLogin|setLoginItemSettings/);
    expect(main).toContain('label: "Start on login"');
    // Outside the shell, only `shell login` in the command line passes --login, with the word the person typed.
    const sources = Bun.spawnSync(["git", "grep", "-l", "-e", "--login\"", "--", "src", "scripts", "test"], { cwd: REPO }).stdout.toString().trim().split("\n");
    expect(sources.sort()).toEqual(["src/shell/install.ts", "test/shell/shell.test.ts"]);
    const selfTestRun = readFileSync(join(REPO, "src", "shell", "selftest-run.ts"), "utf8");
    expect(selfTestRun).not.toMatch(/--login|login\(/);
  });
});

describe("the repo", () => {
  test("has no AutoHotkey, PowerShell, batch or shell-script file", () => {
    const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: REPO }).stdout.toString().split("\n");
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /\.(ahk|ps1|cmd|bat|sh)$/i.test(f))).toEqual([]);
  });
});
