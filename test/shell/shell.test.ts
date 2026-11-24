import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "../../shell/src/args";
import { captureBody, clipFileName, clipsToPrune, isPng, KEEP_CLIPS, MAX_TEXT, PNG_SIGNATURE, saveClip } from "../../shell/src/clip";
import { acceptedRect, acceptedSender, captureSize, cropPlan, isSnipPage, matchSources, SELF_TEST_CROP, SNIP_CAPTURE, SNIP_CLOSE, SNIP_CROP, SNIP_PATH, SNIP_PRELOAD, snipUrl, toPixels } from "../../shell/src/snip";
import { acceptedState, chatSize, DOCK_CHANNEL, DOCK_CHAT_CHANNEL, dockWindow, DOCK_CHECK_MS, DOCK_MISSES, DOCK_STALE_RUNNER, DOCK_PRELOAD, DOCK_NEAR, DOCK_SIZES, DOCK_STATES, DOCK_WATCH_FAR_MS, DOCK_WATCH_NEAR_MS, DOCK_WINDOW, dockBounds, type DockState, dockFocusable, isDockState, islandDistance, islandRect, takesMouse, watchMs } from "../../shell/src/dock";
import { centred, iconBitmap } from "../../shell/src/geometry";
import { APP_ID, loginItem, parseLogin } from "../../shell/src/login";
import { chatUrl, dockUrl, externalLink, isSettingsLink, promptUrl, sameOrigin, sessionOf, settingsUrl, windowTarget } from "../../shell/src/origin";
import { hotkeyNotice, migratedPrefs, parseRunnerSettings, releaseBoth, parseShellPrefs, RECONNECT_MAX_MS, reconnectMs, type RunnerSettings, SELF_TEST_PREFS, SETTINGS_WINDOW, SHELL_DEFAULTS, settingsMessage, socketUrl, swapHotkey, withShell } from "../../shell/src/prefs";
import type { SelfTestResult } from "../../shell/src/result";
import { DEFAULT_SETTINGS, dropLegacy, hasLegacy, loadSettings, parseSettings, PID_FILE, SETTINGS_FILE, withoutLegacy, withWsl } from "../../shell/src/settings";
import { parseWsl, RUNNER_START_MS, runnerCommand } from "../../shell/src/wsl";
import { buildShell, BUNDLE, isCurrent, isInstalled, pidFile, runnerLocation, wantedElectron, writeRunnerLocation } from "../../src/shell/install";
import { REPO } from "../../src/shell/paths";
import { defaultHotkeys, dockArea, opaqueDockBounds, shellOs } from "../../shell/src/os";
import type { Area } from "../../shell/src/geometry";
import { captureWithheld, expectedExternal, materials, notes, pngSize, problems, selfTestRun, skipped, type Where, SNIP_SLOW_MS, STUB_SESSION, stubRunner, stubSettings } from "../../src/shell/selftest-run";

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

  test("the dock's preload is its own small file beside it, and exposes setState and onChat and nothing else", async () => {
    const out = join(dir, "bundle-preload");
    await buildShell(out);
    expect(readdirSync(out).sort()).toEqual([DOCK_PRELOAD, SNIP_PRELOAD, BUNDLE].sort());
    const code = readFileSync(join(out, DOCK_PRELOAD), "utf8");
    expect(code).toContain('require("electron")');
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain(DOCK_CHANNEL);
    // A sandboxed preload can require electron and nothing else.
    expect(code.match(/require\("[^"]+"\)/g)).toEqual(['require("electron")']);
    expect(code.length).toBeLessThan(5_000);

    const src = readFileSync(join(REPO, "shell", "src", "dock-preload.ts"), "utf8");
    expect(src.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(src).toContain('contextBridge.exposeInMainWorld("intuitionDock", {\n  setState: (state: unknown): void => {\n    ipcRenderer.send(DOCK_CHANNEL, state);\n  },\n');
    // One way out of the page: a send on the dock's channel. One way in (D0042): the chat's channel,
    // and what comes in is a session id or null, never the event or anything else the shell sent.
    expect(src.match(/ipcRenderer\.\w+/g)).toEqual(["ipcRenderer.send", "ipcRenderer.on"]);
    expect(code).toContain(DOCK_CHAT_CHANNEL);
    expect(src).toContain("ipcRenderer.on(DOCK_CHAT_CHANNEL, (_event, session: unknown) => {\n      callback(typeof session === \"string\" && session ? session : null);");
  });

  test("the snip's preload is its own small file, and exposes getCapture, crop and close and nothing else", async () => {
    const out = join(dir, "bundle-snip-preload");
    await buildShell(out);
    const code = readFileSync(join(out, SNIP_PRELOAD), "utf8");
    expect(code.match(/require\("[^"]+"\)/g)).toEqual(['require("electron")']);
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    for (const channel of [SNIP_CAPTURE, SNIP_CROP, SNIP_CLOSE]) expect(code).toContain(channel);
    expect(code.length).toBeLessThan(5_000);

    const src = readFileSync(join(REPO, "shell", "src", "snip-preload.ts"), "utf8");
    expect(src.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(src).toContain('contextBridge.exposeInMainWorld("intuitionSnip", {');
    // Three keys, each one call on its own channel. The page hands over a value; it never names a channel.
    const bridge = src.slice(src.indexOf("exposeInMainWorld"));
    expect([...bridge.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual(["getCapture", "crop", "close"]);
    expect(src.match(/ipcRenderer\.\w+\([^)]*\)/g)).toEqual(["ipcRenderer.invoke(SNIP_CAPTURE)", "ipcRenderer.invoke(SNIP_CROP, rect)", "ipcRenderer.send(SNIP_CLOSE)"]);
  });

  test("an install without the preload counts as not installed, so `up` installs again", () => {
    const app = join(dir, "installed");
    const paths = { home: dir, app, electronExe: join(app, "electron.exe") };
    mkdirSync(app, { recursive: true });
    writeFileSync(paths.electronExe, "");
    writeFileSync(join(app, BUNDLE), "");
    expect(isInstalled(paths)).toBe(false);
    writeFileSync(join(app, DOCK_PRELOAD), "");
    // Nor without the snip's.
    expect(isInstalled(paths)).toBe(false);
    writeFileSync(join(app, SNIP_PRELOAD), "");
    expect(isInstalled(paths)).toBe(true);
  });

  test("an install is current only when its bundles, package.json and Electron are what `shell install` would write now", async () => {
    const app = join(dir, "current");
    const paths = { home: dir, app, electronExe: join(app, "node_modules", "electron", "dist", "electron.exe") };
    expect(await isCurrent(paths)).toBe(false);
    await buildShell(app);
    copyFileSync(join(REPO, "shell", "package.json"), join(app, "package.json"));
    mkdirSync(dirname(paths.electronExe), { recursive: true });
    writeFileSync(paths.electronExe, "");
    writeFileSync(join(dirname(paths.electronExe), "version"), `v${wantedElectron()}`);
    expect(await isCurrent(paths)).toBe(true);
    // Bundling is repeatable: the same source gives the same bytes, or `up` would reinstall every time.
    expect(await isCurrent(paths)).toBe(true);

    for (const [file, text] of [[BUNDLE, "// an older bundle"], [DOCK_PRELOAD, "// an older preload"], [SNIP_PRELOAD, "// an older preload"], ["package.json", "{}"], [join("node_modules", "electron", "dist", "version"), "v1.0.0"]] as const) {
      const path = join(app, file);
      const before = readFileSync(path);
      writeFileSync(path, text);
      expect(`${file}: ${await isCurrent(paths)}`).toBe(`${file}: false`);
      writeFileSync(path, before);
    }
    expect(await isCurrent(paths)).toBe(true);
  });

  test("`up` stops an outdated shell, waits for its process to end, installs and starts it", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const up = cli.slice(cli.indexOf("  up: async"), cli.indexOf("  setup: "));
    // The shell half is src/cli/up.ts, which setup shares.
    const shellHalf = readFileSync(join(REPO, "src", "cli", "up.ts"), "utf8");
    expect(shellHalf).toContain("!(await isCurrent(paths))");
    expect(shellHalf.indexOf("await stopAndWait(paths, pidFile(platform.settingsFile()), undefined, platform);")).toBeGreaterThan(-1);
    expect(shellHalf.indexOf("await stopAndWait(")).toBeLessThan(shellHalf.lastIndexOf("await install(paths, log, platform);"));
    // up runs it under a spinner: shellInstall is installCurrentShell(platform, log).
    expect(cli).toContain("(log) => installCurrentShell(platform, log)");
    expect(up.indexOf("await shellInstall(platform)")).toBeGreaterThan(-1);
    expect(up.indexOf("await shellInstall(platform)")).toBeLessThan(up.indexOf("startShell();"));
    // The shell writes its pid beside its settings, and removes it as it quits.
    expect(pidFile(join("/x", SETTINGS_FILE))).toBe(join("/x", PID_FILE));
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main).toContain('const pidFile = join(app.getPath("userData"), PID_FILE);');
    expect(main).toContain('app.on("will-quit", () => rmSync(pidFile, { force: true }));');
  });

  test("the shell pins the Electron the repo has types for", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(wantedElectron()).toBe(root.devDependencies.electron);
  });

  test("only main.ts and the preloads import electron, and the windows are sandboxed without Node; only the dock and the snip have a preload", () => {
    const src = join(REPO, "shell", "src");
    for (const name of readdirSync(src)) {
      const imports = /from "electron"|require\("electron"\)/.test(readFileSync(join(src, name), "utf8"));
      expect(`${name}: ${imports}`).toBe(`${name}: ${["main.ts", "dock-preload.ts", "snip-preload.ts"].includes(name)}`);
    }
    const main = readFileSync(join(src, "main.ts"), "utf8");
    expect(main).toContain("sandbox: true, contextIsolation: true, nodeIntegration: false");
    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(6);
    // The pop-up, the chat, the Settings window and the dock's keyboard sink (a Mac's, it loads nothing): no preload.
    // The dock and the snip overlays: the same preferences, plus their preload.
    expect(main.match(/webPreferences: WEB_PREFERENCES/g)).toHaveLength(4);
    expect(main.match(/webPreferences:/g)).toHaveLength(6);
    expect(main).toContain("webPreferences: { ...WEB_PREFERENCES, preload: join(app.getAppPath(), DOCK_PRELOAD) }");
    expect(main).toContain("webPreferences: { ...WEB_PREFERENCES, backgroundThrottling: false, preload: join(app.getAppPath(), SNIP_PRELOAD) }");
    expect(main.match(/preload\s*:/g)).toHaveLength(2);
    expect(main).not.toMatch(/nodeIntegration: true|sandbox: false|contextIsolation: false|webSecurity: false/);
  });
});

describe("the shell's file", () => {
  test("a first start writes runnerUrl alone", () => {
    const file = join(dir, "data", "settings.json");
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://127.0.0.1:4777", legacy: {} });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ runnerUrl: "http://127.0.0.1:4777" });
    expect(DEFAULT_SETTINGS).toEqual({ runnerUrl: "http://127.0.0.1:4777" });
  });

  test("an older shell's hotkey, snip hotkey and dock are read as values to migrate, and only when they are valid", () => {
    const file = join(dir, "changed.json");
    writeFileSync(file, JSON.stringify({ runnerUrl: "http://localhost:5000/", hotkey: " Alt+F9 " }));
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://localhost:5000", legacy: { hotkey: "Alt+F9" } });
    // Read, not written.
    expect(JSON.parse(readFileSync(file, "utf8")).hotkey).toBe(" Alt+F9 ");
    expect(parseSettings('{"snipHotkey":" Alt+Shift+S ","dock":false}').legacy).toEqual({ snipHotkey: "Alt+Shift+S", dock: false });
    for (const odd of ['""', '"  "', "7", "null", "{}"]) expect(parseSettings(`{"hotkey":${odd},"snipHotkey":${odd},"dock":${odd}}`).legacy).toEqual({});
    expect(parseSettings('{"dock":"no"}').legacy).toEqual({});
    expect(hasLegacy(parseSettings('{"dock":true}'))).toBe(true);
    expect(hasLegacy(parseSettings('{"runnerUrl":"http://127.0.0.1:4777"}'))).toBe(false);
  });

  test("anything missing or malformed falls back to its default", () => {
    const empty = { ...DEFAULT_SETTINGS, legacy: {} };
    expect(parseSettings("not json")).toEqual(empty);
    expect(parseSettings("null")).toEqual(empty);
    expect(parseSettings("[1]")).toEqual(empty);
    expect(parseSettings('{"runnerUrl":"file:///c:/x","hotkey":7}')).toEqual(empty);
    expect(parseSettings('{"runnerUrl":"javascript:alert(1)"}')).toEqual(empty);
  });

  test("after the migration the file keeps runnerUrl and wsl, as they were, and nothing else", () => {
    const wsl = { distro: "Ubuntu", repo: "/r", bun: "/b" };
    expect(JSON.parse(withoutLegacy(JSON.stringify({ runnerUrl: "http://127.0.0.1:5000", hotkey: "Alt+F9", snipHotkey: "Alt+S", dock: false, wsl, mine: 1 })))).toEqual({ runnerUrl: "http://127.0.0.1:5000", wsl });
    expect(JSON.parse(withoutLegacy(JSON.stringify({ hotkey: "Alt+F9" })))).toEqual({});
    // A shell on the same machine keeps where its local runner lives (D0019).
    const runner = { kind: "local", repo: "/r", bun: "/b" };
    expect(JSON.parse(withoutLegacy(JSON.stringify({ hotkey: "Alt+F9", runner })))).toEqual({ runner });
    expect(JSON.parse(withoutLegacy("not json"))).toEqual(DEFAULT_SETTINGS);
    const file = join(dir, "migrate", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ runnerUrl: "http://127.0.0.1:5000", hotkey: "Alt+F9", dock: false, wsl }));
    dropLegacy(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ runnerUrl: "http://127.0.0.1:5000", wsl });
    expect(loadSettings(file)).toEqual({ runnerUrl: "http://127.0.0.1:5000", wsl, legacy: {} });
    // No file: nothing is written.
    dropLegacy(join(dir, "migrate", "none.json"));
    expect(readdirSync(join(dir, "migrate"))).toEqual(["settings.json"]);
  });
});

describe("settings from the runner", () => {
  const shell = { hotkey: "Alt+F9", snipHotkey: "Alt+S", dock: false, startOnLogin: true };
  const good: RunnerSettings = { theme: "dark", permissionMode: "auto", workspaces: [{ name: "a", path: "/a" }, { name: "b", path: "/b", permissionMode: "default" }], shell, port: 4777 };

  test("settings as the contract has them are taken; anything else is not", () => {
    expect(parseRunnerSettings(good)).toEqual(good);
    expect(parseRunnerSettings({ ...good, shell: null })).toEqual({ ...good, shell: null });
    expect(parseShellPrefs({ ...shell, hotkey: " Alt+F9 " })).toEqual(shell);
    for (const bad of [
      null, [], "x", { ...good, theme: "blue" }, { ...good, permissionMode: "bypassPermissions" }, { ...good, port: "4777" }, { ...good, workspaces: {} },
      { ...good, workspaces: [{ name: "a" }] }, { ...good, workspaces: [{ name: "a", path: "/a", permissionMode: "acceptEdits" }] }, { ...good, shell: undefined },
      { ...good, shell: { ...shell, hotkey: "" } }, { ...good, shell: { ...shell, snipHotkey: 7 } }, { ...good, shell: { ...shell, dock: "yes" } }, { ...good, shell: { ...shell, startOnLogin: undefined } },
    ]) {
      expect(`${JSON.stringify(bad)} ${parseRunnerSettings(bad)}`).toBe(`${JSON.stringify(bad)} null`);
    }
  });

  test("the 'settings' message on /ws is read; every other message is not", () => {
    expect(settingsMessage(JSON.stringify({ type: "settings", settings: good }))).toEqual(good);
    for (const other of [
      JSON.stringify({ type: "hello", sessions: [] }), JSON.stringify({ type: "delta", sessionId: "s", text: "settings" }), JSON.stringify({ type: "settings", settings: { theme: "x" } }),
      "not json", '{"settings"', 7, null, Buffer.from(JSON.stringify({ type: "settings", settings: good })),
    ]) {
      expect(settingsMessage(other)).toBeNull();
    }
  });

  test("a PUT sends everything back as it came, with the shell's part replaced", () => {
    const next = { ...shell, dock: true };
    expect(withShell(good, next)).toEqual({ ...good, shell: next });
    expect(withShell({ ...good, shell: null }, next).workspaces).toEqual(good.workspaces);
  });

  test("the socket is /ws on the runner's host, and reconnects quietly: a second, doubling, fifteen at most, forever", () => {
    expect(socketUrl("http://127.0.0.1:4777")).toBe("ws://127.0.0.1:4777/ws");
    expect(socketUrl("https://example.invalid:8443/x")).toBe("wss://example.invalid:8443/ws");
    expect([0, 1, 2, 3, 4, 5, 100, -1].map(reconnectMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 1000]);
    expect(RECONNECT_MAX_MS).toBe(15_000);
  });

  test("the migration sends the old file's values, the defaults for the rest, and start on login as Windows has it", () => {
    expect(migratedPrefs({}, false)).toEqual({ ...SHELL_DEFAULTS, startOnLogin: false });
    expect(migratedPrefs({ hotkey: "Alt+F9", dock: false }, true)).toEqual({ hotkey: "Alt+F9", snipHotkey: SHELL_DEFAULTS.snipHotkey, dock: false, startOnLogin: true });
    // Control+Alt on Windows and Linux, Command+Shift on a Mac (shell/src/os.ts).
    expect(SHELL_DEFAULTS).toEqual({ ...defaultHotkeys(shellOs()), dock: true });
  });

  /** A stand-in for globalShortcut: some accelerators are taken by another program, some throw as Electron does for one that is not valid. */
  const shortcuts = (taken: string[] = []) => {
    const held = new Set<string>();
    const calls: string[] = [];
    return {
      held,
      calls,
      register(a: string) {
        calls.push(`register ${a}`);
        if (a.includes("Nope")) throw new TypeError(`conversion failure from ${a}`);
        if (taken.includes(a) || held.has(a)) return false;
        held.add(a);
        return true;
      },
      unregister(a: string) {
        calls.push(`unregister ${a}`);
        held.delete(a);
      },
      isRegistered: (a: string) => {
        if (a.includes("Nope")) throw new TypeError(`conversion failure from ${a}`);
        return held.has(a);
      },
    };
  };

  test("a hotkey change registers the new one first, then releases the old one", () => {
    const ops = shortcuts();
    expect(swapHotkey(null, "Alt+F9", ops)).toEqual({ active: "Alt+F9", failed: null });
    expect(swapHotkey("Alt+F9", "Alt+F10", ops)).toEqual({ active: "Alt+F10", failed: null });
    expect([...ops.held]).toEqual(["Alt+F10"]);
    expect(ops.calls).toEqual(["register Alt+F9", "register Alt+F10", "unregister Alt+F9"]);
    // The same one: nothing is touched.
    expect(swapHotkey("Alt+F10", "Alt+F10", ops)).toEqual({ active: "Alt+F10", failed: null });
    expect(ops.calls).toHaveLength(3);
  });

  test("one that cannot be registered (taken, held by the other hotkey, or not an accelerator) keeps the old one working", () => {
    const ops = shortcuts(["Control+Alt+T"]);
    swapHotkey(null, "Alt+F9", ops);
    swapHotkey(null, "Alt+S", ops);
    for (const wanted of ["Control+Alt+T", "Alt+S", "Control+Alt+Nope"]) {
      expect(swapHotkey("Alt+F9", wanted, ops)).toEqual({ active: "Alt+F9", failed: wanted });
      expect([...ops.held].sort()).toEqual(["Alt+F9", "Alt+S"]);
    }
    expect(ops.calls.filter((c) => c.startsWith("unregister"))).toEqual([]);
    // Nothing registered yet, and the first one fails: none works, and that is said.
    expect(swapHotkey(null, "Control+Alt+T", shortcuts(["Control+Alt+T"]))).toEqual({ active: null, failed: "Control+Alt+T" });
  });

  test("two hotkeys that trade keys, or one moving onto the key the other leaves, are both released first; one wanting the key the other keeps is not", () => {
    const now = { hotkey: "A", snipHotkey: "B" };
    expect(releaseBoth(now, { hotkey: "B", snipHotkey: "A" })).toBe(true);
    expect(releaseBoth(now, { hotkey: "B", snipHotkey: "C" })).toBe(true);
    expect(releaseBoth(now, { hotkey: "C", snipHotkey: "A" })).toBe(true);
    expect(releaseBoth(now, { hotkey: "B", snipHotkey: "B" })).toBe(false);
    expect(releaseBoth(now, { hotkey: "A", snipHotkey: "B" })).toBe(false);
    expect(releaseBoth(now, { hotkey: "C", snipHotkey: "D" })).toBe(false);
    expect(releaseBoth({ hotkey: null, snipHotkey: null }, { hotkey: "A", snipHotkey: "B" })).toBe(false);
    // After the release, the trade registers both.
    const held = new Set<string>();
    const ops = { register: (a: string) => (held.has(a) ? false : (held.add(a), true)), unregister: (a: string) => void held.delete(a), isRegistered: (a: string) => held.has(a) };
    swapHotkey(null, "A", ops);
    swapHotkey(null, "B", ops);
    held.clear();
    expect([swapHotkey(null, "B", ops), swapHotkey(null, "A", ops)]).toEqual([{ active: "B", failed: null }, { active: "A", failed: null }]);
  });

  test("the notification names the hotkey that failed and the one that still works", () => {
    const n = hotkeyNotice("hotkey", "Control+Alt+T", "Alt+F9");
    expect(n.title).toBe("intuition: the hotkey could not be set");
    expect(n.body).toContain("Control+Alt+T could not be registered");
    expect(n.body).toContain("Alt+F9 still works.");
    expect(hotkeyNotice("snip hotkey", "X", null)).toEqual({ title: "intuition: the snip hotkey could not be set", body: expect.stringContaining("No snip hotkey works") });
  });

  test("main.ts: applied at start and at every message; the tray writes through PUT; the theme follows", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main).toContain("new net.WebSocket(shellSocketUrl(settings.runnerUrl))");
    expect(main).toContain("if (s) applySettings(s);");
    expect(main).toContain("nativeTheme.themeSource = next.theme;");
    expect(main).toContain('{ label: "Show dock", type: "checkbox", checked: prefs.dock, click: (item) => void changePrefs({ dock: item.checked }) }');
    expect(main).toContain('{ label: "Start on login", type: "checkbox", checked: onLogin, click: (item) => void changePrefs({ startOnLogin: item.checked }) }');
    expect(main).toContain('{ label: "Settings…", click: () => void openSettings() }');
    // The hotkeys are registered in one place, through swapHotkey.
    expect(main.match(/globalShortcut\.register\(/g)).toHaveLength(3);
    // The other two are the self-test's own registration checks.
    expect(main.match(/globalShortcut\.register\(SELF_TEST_/g)).toHaveLength(2);
    expect(main).toContain("register: (accelerator: string) => globalShortcut.register(accelerator, press),");
    // Nothing is written to the file but the migration's rewrite.
    expect(main).not.toMatch(/saveDock|withDock/);
    expect(main.match(/dropLegacy\(/g)).toHaveLength(1);
    // PUT only to the runner's own routes: putSettings, the shell's report (REPORT_PATH), and the self-test standing in for the Settings page.
    expect(main.match(/method: "PUT"/g)).toHaveLength(3);
    expect(main).toContain('fetch(new URL(REPORT_PATH, settings.runnerUrl), { method: "PUT"');
    const selfTest = main.slice(main.indexOf("async function selfTest()"), main.indexOf("// --- Start ---"));
    expect(selfTest.match(/method: "PUT"/g)).toHaveLength(1);
    expect(main).toContain("fetch(new URL(SETTINGS_PATH, settings.runnerUrl), {");
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

  test("snips are snip-<time>.png, and are pruned with the clips: the newest 20 of both together", () => {
    expect(clipFileName(new Date(2026, 10, 12, 9, 5, 7, 42), "snip")).toBe("snip-20261112-090507-042.png");
    const names = Array.from({ length: 24 }, (_, i) => clipFileName(new Date(2026, 0, 1, 0, 0, i), i % 2 ? "snip" : "clip"));
    const prune = clipsToPrune([...names].reverse().concat("snip-x.png.bak", "notes.txt"));
    // By time, not by name: the four oldest go, clips and snips alike.
    expect(prune.sort()).toEqual(names.slice(0, 4).sort());
    const folder = join(dir, "snips");
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.from("rest")]);
    for (let i = 0; i < 15; i++) saveClip(folder, png, new Date(2026, 0, 1, 0, 0, i));
    for (let i = 15; i < 25; i++) saveClip(folder, png, new Date(2026, 0, 1, 0, 0, i), "snip");
    const left = readdirSync(folder).sort();
    expect(left).toHaveLength(20);
    expect(left.filter((n) => n.startsWith("snip-"))).toHaveLength(10);
    expect(left).not.toContain("clip-20260101-000004-000.png");
    expect(left).toContain("clip-20260101-000005-000.png");
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

  test("the Settings window's page", () => {
    expect(settingsUrl("http://127.0.0.1:4777")).toBe("http://127.0.0.1:4777/assets/settings.html");
    expect(isSettingsLink("http://127.0.0.1:4777/settings", "http://127.0.0.1:4777")).toBe(true);
    expect(isSettingsLink("http://127.0.0.1:4778/settings", "http://127.0.0.1:4777")).toBe(false);
    expect(SETTINGS_WINDOW).toEqual({ width: 720, height: 640 });
  });

  test("the pages' addresses", () => {
    expect(promptUrl(RUNNER)).toBe("http://127.0.0.1:4777/prompt");
    expect(chatUrl(RUNNER)).toBe("http://127.0.0.1:4777/");
    expect(chatUrl(RUNNER, "a b&c")).toBe("http://127.0.0.1:4777/?session=a+b%26c");
    expect(sessionOf(chatUrl(RUNNER, "a b&c"))).toBe("a b&c");
    expect(sessionOf(chatUrl(RUNNER))).toBeUndefined();
    expect(dockUrl(RUNNER)).toBe("http://127.0.0.1:4777/dock");
  });

  test("links elsewhere go to the browser: http, https and mailto only, never the runner's own origin", () => {
    expect(externalLink("https://example.com/a?b=1#c", RUNNER)).toBe("https://example.com/a?b=1#c");
    expect(externalLink("http://example.com", RUNNER)).toBe("http://example.com/");
    expect(externalLink("HTTPS://Example.COM/x", RUNNER)).toBe("https://example.com/x");
    expect(externalLink("mailto:someone@example.com?subject=hi", RUNNER)).toBe("mailto:someone@example.com?subject=hi");
    // Another port or name for this machine is another origin: a local dev server, say.
    expect(externalLink("http://localhost:4777/prompt", RUNNER)).toBe("http://localhost:4777/prompt");
    expect(externalLink("http://127.0.0.1:3000/", RUNNER)).toBe("http://127.0.0.1:3000/");
    for (const url of [
      "http://127.0.0.1:4777/", "http://127.0.0.1:4777/assets/base.css", "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,hi", "about:blank",
      "ftp://example.com/", "ms-settings:display", "vbscript:x", "chrome://settings", "\\\\server\\share", "C:\\Windows\\notepad.exe", "mailto:", "https://user:pass@example.com/", "https://user@example.com/", "", "not a url",
    ]) {
      expect(`${url} ${externalLink(url, RUNNER)}`).toBe(`${url} null`);
    }
  });

  test("new windows: the chat view from any page, the pop-up from the dock only, nothing else", () => {
    for (const fromDock of [true, false]) {
      expect(windowTarget("http://127.0.0.1:4777/?session=a+b%26c", RUNNER, fromDock)).toEqual({ kind: "chat", session: "a b&c" });
      expect(windowTarget("http://127.0.0.1:4777/", RUNNER, fromDock)).toEqual({ kind: "chat", session: undefined });
      for (const url of ["http://127.0.0.1:4777/settings", "http://127.0.0.1:4777/settings/", "http://127.0.0.1:4777/assets/settings.html", "http://127.0.0.1:4777/settings?x=1#y"]) expect(windowTarget(url, RUNNER, fromDock)).toEqual({ kind: "settings" });
      for (const url of ["http://localhost:4777/settings", "http://127.0.0.1:4777/settingsx", "http://127.0.0.1:4777/assets/settings.js", "https://example.com/settings"]) expect(`${url} ${windowTarget(url, RUNNER, fromDock)}`).toBe(`${url} null`);
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
    expect(parseArgs(["electron.exe", "C:\\app"])).toEqual({ selfTest: undefined, runnerUrl: undefined, session: undefined, prompt: false, quit: false });
    expect(parseArgs(["electron.exe", "C:\\app", "--self-test", "C:\\r.json", "--runner-url", "http://127.0.0.1:5"])).toMatchObject({ selfTest: "C:\\r.json", runnerUrl: "http://127.0.0.1:5" });
    expect(parseArgs(["e", "app", "--quit"]).quit).toBe(true);
    expect(parseArgs(["e", "app", "--session", "s1"]).session).toBe("s1");
    expect(parseArgs(["e", "app", "--prompt"]).prompt).toBe(true);
    expect(parseArgs(["e", "app", "--self-test"]).selfTest).toBeUndefined();
    expect(parseArgs(["e", "app", "--self-test", "--quit"]).selfTest).toBeUndefined();
  });
});

describe("the dock", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const sender = { fromDock: true, mainFrame: true, url: "http://127.0.0.1:4777/dock" };

  test("four states, one window as large as the largest, and the most the island covers in each", () => {
    expect([...DOCK_STATES]).toEqual(["idle", "peek", "open", "chat"]);
    expect(DOCK_WINDOW).toEqual({ width: 960, height: 680 });
    expect(DOCK_SIZES).toEqual({ idle: { width: 128, height: 22 }, peek: { width: 380, height: 40 }, open: { width: 460, height: 480 }, chat: { width: 960, height: 680 } });
    // The chat the shell works out for a display sizes the window (D0042): never smaller than the open dock.
    expect(dockWindow({ width: 1180, height: 820 })).toEqual({ width: 1180, height: 820 });
    expect(dockWindow({ width: 300, height: 300 })).toEqual({ width: 460, height: 480 });
  });

  test("the window's bounds: the top edge of the display, centred, and no state in it", () => {
    expect(dockBounds(display)).toEqual({ x: 480, y: 0, width: 960, height: 680 });
    expect(dockBounds(display, chatSize(display))).toEqual({ x: 370, y: 0, width: 1180, height: 820 });
    expect(dockBounds.length).toBe(1);
  });

  test("on a primary display that does not start at 0,0, of an odd width, or smaller than the dock", () => {
    expect(dockBounds({ x: -1280, y: 200, width: 1280, height: 1024 })).toEqual({ x: -1120, y: 200, width: 960, height: 680 });
    const odd = dockBounds({ x: 0, y: 0, width: 1367, height: 768 }, chatSize({ width: 1367, height: 768 }));
    expect(Number.isInteger(odd.x)).toBe(true);
    expect(Math.abs(odd.x + odd.width / 2 - 1367 / 2)).toBeLessThanOrEqual(0.5);
    // The size never gives way: the contract says exactly this size.
    expect(dockBounds({ x: 0, y: 0, width: 400, height: 300 }, chatSize({ width: 400, height: 300 }))).toEqual({ x: -30, y: 0, width: 460, height: 480 });
  });

  test("the island's rectangle in each state hangs from the top centre of the window", () => {
    expect(islandRect("idle")).toEqual({ x: 416, y: 0, width: 128, height: 22 });
    expect(islandRect("peek")).toEqual({ x: 290, y: 0, width: 380, height: 40 });
    expect(islandRect("open")).toEqual({ x: 250, y: 0, width: 460, height: 480 });
    expect(islandRect("chat")).toEqual({ x: 0, y: 0, width: 960, height: 680 });
    expect(islandRect("open", null, { width: 1180, height: 820 })).toEqual({ x: 360, y: 0, width: 460, height: 480 });
    for (const state of DOCK_STATES) {
      const r = islandRect(state);
      expect(r.x + r.width / 2).toBe(DOCK_WINDOW.width / 2);
      expect(r.x >= 0 && r.x + r.width <= DOCK_WINDOW.width && r.height <= DOCK_WINDOW.height).toBe(true);
    }
  });

  test("the hit test: the window takes the mouse only on the island of the state the page last reported", () => {
    const win = dockBounds(display); // x 730..1189, y 0..479
    // Idle: 128x22 at 896..1023.
    expect(takesMouse(win, "idle", { x: 960, y: 10 })).toBe(true);
    expect(takesMouse(win, "idle", { x: 896, y: 0 })).toBe(true);
    expect(takesMouse(win, "idle", { x: 1023, y: 21 })).toBe(true);
    // One pixel off each edge, all of them inside the window.
    expect(takesMouse(win, "idle", { x: 895, y: 10 })).toBe(false);
    expect(takesMouse(win, "idle", { x: 1024, y: 10 })).toBe(false);
    expect(takesMouse(win, "idle", { x: 960, y: 22 })).toBe(false);
    expect(takesMouse(win, "idle", { x: 960, y: -1 })).toBe(false);
    // The middle of the window, where the open island would be: through, in idle and in peek.
    expect(takesMouse(win, "idle", { x: 960, y: 200 })).toBe(false);
    expect(takesMouse(win, "peek", { x: 960, y: 200 })).toBe(false);
    expect(takesMouse(win, "peek", { x: 770, y: 39 })).toBe(true);
    expect(takesMouse(win, "peek", { x: 769, y: 39 })).toBe(false);
    expect(takesMouse(win, "peek", { x: 960, y: 40 })).toBe(false);
    expect(takesMouse(win, "open", { x: 960, y: 200 })).toBe(true);
    expect(takesMouse(win, "open", { x: 730, y: 479 })).toBe(true);
    expect(takesMouse(win, "open", { x: 729, y: 200 })).toBe(false);
    expect(takesMouse(win, "open", { x: 1190, y: 200 })).toBe(false);
    expect(takesMouse(win, "open", { x: 960, y: 480 })).toBe(false);
    // On a display that does not start at 0,0 the rectangle moves with the window.
    const left = dockBounds({ x: -1280, y: 200, width: 1280, height: 1024 });
    expect(takesMouse(left, "idle", { x: -640, y: 210 })).toBe(true);
    expect(takesMouse(left, "idle", { x: 960, y: 10 })).toBe(false);
  });

  test("click-through is the default: with no state reported, nothing takes the mouse, wherever the cursor is", () => {
    const win = dockBounds(display);
    for (const cursor of [{ x: 960, y: 0 }, { x: 960, y: 10 }, { x: 960, y: 200 }, { x: 730, y: 479 }, { x: 0, y: 0 }]) expect(takesMouse(win, null, cursor)).toBe(false);
    // And the watching is slow: there is no island to be near.
    expect(watchMs(win, null, { x: 960, y: 10 })).toBe(DOCK_WATCH_FAR_MS);
  });

  test("the cursor is watched closely near the island and slowly far from it", () => {
    const win = dockBounds(display);
    expect(islandDistance(win, "idle", { x: 960, y: 10 })).toBe(0);
    expect(islandDistance(win, "idle", { x: 960, y: 31 })).toBe(10);
    expect(islandDistance(win, "idle", { x: 885, y: 10 })).toBe(11);
    expect(islandDistance(win, "idle", { x: 1026, y: 25 })).toBe(5);
    expect(watchMs(win, "idle", { x: 960, y: 10 })).toBe(DOCK_WATCH_NEAR_MS);
    expect(watchMs(win, "idle", { x: 960, y: 21 + DOCK_NEAR })).toBe(DOCK_WATCH_NEAR_MS);
    expect(watchMs(win, "idle", { x: 960, y: 22 + DOCK_NEAR })).toBe(DOCK_WATCH_FAR_MS);
    expect(watchMs(win, "open", { x: 100, y: 900 })).toBe(DOCK_WATCH_FAR_MS);
    // About a frame or two near, and a handful of looks a second far.
    expect(DOCK_WATCH_NEAR_MS).toBeGreaterThanOrEqual(16);
    expect(DOCK_WATCH_NEAR_MS).toBeLessThanOrEqual(30);
    expect(DOCK_WATCH_FAR_MS).toBeGreaterThan(DOCK_WATCH_NEAR_MS);
    expect(DOCK_WATCH_FAR_MS).toBeLessThanOrEqual(250);
  });

  test("the shell never resizes or moves the dock for a state: setBounds is called in one place, and never setSize", () => {
    const main = readFileSync(join(import.meta.dir, "..", "..", "shell", "src", "main.ts"), "utf8");
    const body = (name: string) => main.match(new RegExp("function " + name + "\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}"))?.[0] ?? "";
    expect(body("placeDock")).toContain("dock.setBounds(want)");
    expect(body("dockWindowBounds")).toContain("DOCK_TRANSPARENT ? dockPlace() : opaqueDockBounds(dockPlace(), islandRect(dockState ?? \"idle\", null, dockChat))");
    // A state reaches the window's bounds only through fitOpaqueDock, which does nothing for a transparent dock.
    expect(body("fitOpaqueDock")).toContain("if (!DOCK_TRANSPARENT) placeDock();");
    for (const name of ["setDockState", "onDockState", "watchDockMouse", "setDockMouse", "forgetDockState"]) {
      expect(body(name).length).toBeGreaterThan(40);
      expect(name + ": " + /setBounds|setSize|setPosition|setContentSize|placeDock/.test(body(name).replace("fitOpaqueDock()", ""))).toBe(name + ": false");
    }
    expect(main.match(/dock\.setBounds\(/g)).toHaveLength(1);
    expect(main).not.toMatch(/dock\.(setSize|setContentSize|setPosition)\(/);
    // The window is told to let the mouse through the moment it is created, before any page.
    expect(body("createDock")).toContain("win.setIgnoreMouseEvents(true, { forward: true })");
  });

  test("only open and the chat can take the keyboard", () => {
    expect(DOCK_STATES.map(dockFocusable)).toEqual([false, false, true, true]);
  });

  test("setState is taken from the dock's main frame on the runner's origin, with one of the four values", () => {
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

  test("main.ts: the window is frameless, clear, on top, out of the taskbar, shown without activating, focused only when open, and placed from the display's bounds", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    const create = main.slice(main.indexOf("function createDock()"), main.indexOf("async function loadDock()"));
    for (const option of ["frame: false", "...materialOptions(DOCK_MATERIAL, DOCK_TRANSPARENT, OPAQUE_BACKGROUND)", "hasShadow: false", "alwaysOnTop: true", "skipTaskbar: true", 'type: OS === "macos" ? "panel" : "toolbar"', "focusable: false", "show: false", "movable: false"]) expect(create).toContain(option);
    expect(create).toContain('win.on("will-resize", (event) => event.preventDefault());');
    const dockCode = main.slice(main.indexOf("// --- Dock ---"), main.indexOf("// --- Self-test ---"));
    // Shown without activating. Focused once, in setDockState, and only when the state lets it take the keyboard ("open").
    expect(dockCode).toContain("win.showInactive();");
    expect(dockCode).not.toMatch(/\.show\(\)/);
    // The other: the Mac's keyboard sink, which takes the keyboard from the dock for a moment to give it back.
    expect(dockCode.match(/\.focus\(\)/g)).toEqual([".focus()", ".focus()"]);
    expect(dockCode).toContain("sink.focus();\n  sink.blur();");
    expect(dockCode).toContain("if (giveBack && OS === \"macos\") giveKeyboardBack(win);");
    expect(dockCode).toContain("if (focusable && !win.isFocused()) win.focus();");
    // From the primary display, through dockArea: its bounds on Windows and Linux, from the work area's top on a Mac, or from its notch.
    expect(dockCode).toContain("return dockBounds(dockArea(OS, display.bounds, display.workArea, dockNotch), dockChat);");
    // The chat's size (D0042) from the same area the dock hangs in, worked out again with the notch.
    expect(dockCode).toContain("return chatSize(dockArea(OS, display.bounds, display.workArea, dockNotch));");
    expect(dockCode).toContain("dockChat = currentChat();\n    if (JSON.stringify([dockNotch, dockChat]) === before) return;".replace("\n    if", "\n  if"));
    // Once for the place, once for the chat's size, once for the bounds the notch's measurement is
    // checked against, and twice to see whether the primary display changed while it was measured
    // (then it is measured again); and once for the corner the Mac's keyboard sink sits in.
    expect(dockCode.match(/getPrimaryDisplay\(\)/g)).toHaveLength(6);
    expect(dockCode).toContain("if (screen.getPrimaryDisplay().id === primary || tries >= 2) return notch;");
    // A change of display places the dock again and measures the notch again; a change of the work
    // area alone (a full-screen app, a menu bar hiding) does not (D0037).
    for (const event of ["display-added", "display-removed"]) expect(dockCode).toContain(`screen.on("${event}", displays);`);
    expect(dockCode).toContain("if (movesDock(changed)) displays();");
    expect(dockCode).toContain('spawn("osascript", [...NOTCH_PROBE], { stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 5000 })');
    // Over the menu bar from a notch: a frameless window goes there only with enableLargerThanScreen, at the status level.
    expect(create).toContain('enableLargerThanScreen: OS === "macos"');
    expect(dockCode).toContain('win.setAlwaysOnTop(true, dockNotch ? "status" : "floating")');
    // Every load waits for the first measurement, whoever asks first: the start, the runner coming up or the settings.
    const load = main.slice(main.indexOf("async function loadDock()"), main.indexOf("function showDock()"));
    expect(load.indexOf("await firstNotch();")).toBeGreaterThan(0);
    expect(load.indexOf("await firstNotch();")).toBeLessThan(load.indexOf("createDock()"));
  });

  test("main.ts: one listener on the dock's channel, and it takes a state only through the validation", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    // The dock's one channel, and the snip's three (see "the snip" for those).
    expect(main.match(/ipcMain\.\w+\([^)]*\)/g)).toEqual(["ipcMain.handle(SNIP_CAPTURE, onSnipCapture)", "ipcMain.handle(SNIP_CROP, onSnipCrop)", "ipcMain.on(SNIP_CLOSE, onSnipClose)", "ipcMain.on(DOCK_CHANNEL, onDockState)"]);
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
    expect(main).toContain('{ label: "Show dock", type: "checkbox", checked: prefs.dock, click: (item) => void changePrefs({ dock: item.checked }) }');
  });

  test("main.ts: a runner that answers but has no dock is said once, and the check keeps loading the page", () => {
    expect(DOCK_STALE_RUNNER.title).toContain("the runner is older than the shell");
    expect(DOCK_STALE_RUNNER.body).toContain("intuition up");
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    const load = main.slice(main.indexOf("async function loadDock()"), main.indexOf("/** Loads the dock's page and shows it"));
    expect(load).toContain("if (!staleRunnerSaid && !args.selfTest && dockStatus >= 400 && (await runnerAnswers())) {");
    expect(load).toContain("staleRunnerSaid = true;");
    expect(load).toContain("notify(DOCK_STALE_RUNNER.title, DOCK_STALE_RUNNER.body);");
    // A dock that loads clears it, so a later stale runner is said again.
    expect(load.indexOf("dockLoaded = true;")).toBeLessThan(load.indexOf("staleRunnerSaid = false;"));
    // The retry: every check while the runner answers loads the page again when no dock is shown.
    const check = main.slice(main.indexOf("async function checkDock()"), main.indexOf("/** Checks every few seconds."));
    expect(check).toContain("await showDock();");
    expect(main).toContain("if (!prefs.dock || dockLoaded) return Promise.resolve();");
  });
});

describe("the snip", () => {
  const display = { width: 1920, height: 1080 };

  test("the page is /assets/snip.html on the runner's origin, and only there", () => {
    expect(snipUrl(RUNNER)).toBe(`http://127.0.0.1:4777${SNIP_PATH}`);
    expect(isSnipPage("http://127.0.0.1:4777/assets/snip.html", RUNNER)).toBe(true);
    expect(isSnipPage("http://127.0.0.1:4777/assets/snip.html?x#y", RUNNER)).toBe(true);
    for (const url of ["http://localhost:4777/assets/snip.html", "http://127.0.0.1:4777/prompt", "http://127.0.0.1:4777/assets/snip.js", "http://127.0.0.1:4777/assets/snip.html/x", "file:///C:/snip.html", "", null]) {
      expect(`${url} ${isSnipPage(url, RUNNER)}`).toBe(`${url} false`);
    }
  });

  test("a call is answered only from an overlay's main frame on the snip page", () => {
    const page = "http://127.0.0.1:4777/assets/snip.html";
    expect(acceptedSender({ fromOverlay: true, mainFrame: true, url: page }, RUNNER)).toBe(true);
    expect(acceptedSender({ fromOverlay: false, mainFrame: true, url: page }, RUNNER)).toBe(false);
    expect(acceptedSender({ fromOverlay: true, mainFrame: false, url: page }, RUNNER)).toBe(false);
    expect(acceptedSender({ fromOverlay: true, mainFrame: true, url: "http://127.0.0.1:4777/prompt" }, RUNNER)).toBe(false);
    expect(acceptedSender({ fromOverlay: true, mainFrame: true, url: "https://example.com/assets/snip.html" }, RUNNER)).toBe(false);
    expect(acceptedSender({ fromOverlay: true, mainFrame: true, url: null }, RUNNER)).toBe(false);
  });

  test("crop takes a rectangle of finite numbers inside the display, and nothing else", () => {
    expect(acceptedRect({ x: 0, y: 0, width: 1920, height: 1080 }, display)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(acceptedRect({ height: 49.5, width: 101, y: 20.25, x: 10.5 }, display)).toEqual({ x: 10.5, y: 20.25, width: 101, height: 49.5 });
    expect(acceptedRect({ x: 1919, y: 1079, width: 1, height: 1 }, display)).not.toBeNull();
    for (const bad of [
      null, undefined, 7, "0,0,10,10", [0, 0, 10, 10], {}, { x: 0, y: 0, width: 10 },
      { x: 0, y: 0, width: 10, height: 10, path: "C:\\x.png" }, { x: 0, y: 0, width: 10, height: 10, toString: 1 },
      { x: "0", y: 0, width: 10, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: Infinity, height: 10 },
      { x: 0, y: -Infinity, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: null },
      { x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: -0.5, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 0.9 },
      { x: 0, y: 0, width: -10, height: 10 }, { x: 1911, y: 0, width: 10, height: 10 }, { x: 0, y: 1071, width: 10, height: 10 }, { x: 0, y: 0, width: 1921, height: 1080 },
      { x: 0, y: 0, width: 1e308, height: 1e308 },
    ]) {
      expect(`${JSON.stringify(bad)} ${acceptedRect(bad, display)}`).toBe(`${JSON.stringify(bad)} null`);
    }
  });

  // A display of 2560x1440 device pixels at each scale, and the same selection as the page would make it.
  for (const [scale, dip] of [[1, { width: 2560, height: 1440 }], [1.25, { width: 2048, height: 1152 }], [1.5, { width: 1707, height: 960 }], [2, { width: 1280, height: 720 }]] as const) {
    test(`the crop at ${scale * 100}%: device pixels, edges rounded outwards, inside the image`, () => {
      const native = { width: Math.round(dip.width * scale), height: Math.round(dip.height * scale) };
      // The image Windows gives at 150% is 2560 wide, though 1707 DIPs times 1.5 is 2560.5: the same crop.
      if (scale === 1.5) expect(cropPlan({ x: 10, y: 20, width: 100, height: 50 }, dip, scale, { width: 2560, height: 1440 }).source).toEqual({ x: 15, y: 30, width: 150, height: 75 });
      // A whole display is the whole image.
      expect(cropPlan({ x: 0, y: 0, ...dip }, dip, scale, native)).toEqual({ source: { x: 0, y: 0, ...native }, output: native });
      // 100x50 DIPs at 10,20 is 100*scale x 50*scale device pixels at 10*scale,20*scale.
      const plain = cropPlan({ x: 10, y: 20, width: 100, height: 50 }, dip, scale, native);
      expect(plain.source).toEqual({ x: Math.floor(10 * scale), y: Math.floor(20 * scale), width: Math.ceil(110 * scale) - Math.floor(10 * scale), height: Math.ceil(70 * scale) - Math.floor(20 * scale) });
      expect(plain.output).toEqual({ width: plain.source.width, height: plain.source.height });
      // Fractions: what was selected is all in, and no pixel more than that.
      const fine = cropPlan(SELF_TEST_CROP, dip, scale, native).source;
      expect(fine.x).toBeLessThanOrEqual(SELF_TEST_CROP.x * scale);
      expect(fine.x + fine.width).toBeGreaterThanOrEqual((SELF_TEST_CROP.x + SELF_TEST_CROP.width) * scale);
      expect(fine.width).toBeLessThanOrEqual(Math.ceil(SELF_TEST_CROP.width * scale) + 1);
      // The bottom right corner stays inside the image.
      const corner = cropPlan({ x: dip.width - 3.3, y: dip.height - 2.7, width: 3.3, height: 2.7 }, dip, scale, native).source;
      expect(corner.x + corner.width).toBe(native.width);
      expect(corner.y + corner.height).toBe(native.height);
      // A capture that came back larger (sized for a bigger display): cut from it in its pixels, saved at this display's.
      const big = { width: native.width * 2, height: native.height * 2 };
      const resized = cropPlan({ x: 10, y: 20, width: 100, height: 50 }, dip, scale, big);
      expect(resized.output).toEqual(plain.output);
      expect(Math.abs(resized.source.width - plain.output.width * 2)).toBeLessThanOrEqual(2);
    });
  }

  test("the crop of the known numbers", () => {
    const at = (scale: number) => cropPlan(SELF_TEST_CROP, { width: 1920, height: 1080 }, scale, { width: 1920 * scale, height: 1080 * scale });
    // 10.5..111.5 x 20.25..69.75 DIPs.
    expect(at(1)).toEqual({ source: { x: 10, y: 20, width: 102, height: 50 }, output: { width: 102, height: 50 } });
    expect(at(1.25).source).toEqual({ x: 13, y: 25, width: 127, height: 63 });
    expect(at(1.5).source).toEqual({ x: 15, y: 30, width: 153, height: 75 });
    expect(at(2).source).toEqual({ x: 21, y: 40, width: 202, height: 100 });
    // 0.1 * 3 is 0.30000000000000004: still 0 and 1, not a pixel more.
    expect(toPixels({ x: 0.1, y: 0, width: 0.2, height: 1 }, 3, { width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 1, height: 3 });
  });

  test("one capture for every display, as large as the largest at its native resolution, matched by display id", () => {
    expect(captureSize([{ size: { width: 1440, height: 901 }, scaleFactor: 2 }, { size: { width: 1920, height: 1200 }, scaleFactor: 1 }])).toEqual({ width: 2880, height: 1802 });
    expect(captureSize([{ size: { width: 1707, height: 960 }, scaleFactor: 1.5 }])).toEqual({ width: 2561, height: 1440 });
    expect(matchSources([5, 7], ["7", "5"])).toEqual([1, 0]);
    expect(matchSources([5, 7], ["", ""])).toEqual([0, 1]);
    expect(matchSources([5, 7], ["5"])).toEqual([0, -1]);
    expect(matchSources([5, 7, 9], ["", ""])).toEqual([0, 1, -1]);
  });

  test("main.ts: the overlays are sandboxed, every call goes through the checks, and the PNG is written under the temp folder only", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    const section = main.slice(main.indexOf("// --- Snip ---"), main.indexOf("// --- Dock ---"));
    expect(section).toContain("webPreferences: { ...WEB_PREFERENCES, backgroundThrottling: false, preload: join(app.getAppPath(), SNIP_PRELOAD) }");
    for (const handler of ["onSnipCapture", "onSnipCrop", "onSnipClose"]) {
      const body = section.slice(section.indexOf(`function ${handler}(`));
      expect(body.slice(0, body.indexOf("\n}\n"))).toContain("overlayOf(event)");
    }
    expect(section).toContain("acceptedSender(");
    const crop = section.slice(section.indexOf("async function onSnipCrop("));
    expect(crop.slice(0, crop.indexOf("\n}\n"))).toContain("const rect = acceptedRect(value, bounds);");
    // One write, by name from the clock, in <temp>\intuition. Nothing the page sends names a file.
    expect(section.match(/saveClip\(|writeFileSync\(|writeFile\(/g)).toEqual(["saveClip("]);
    expect(section).toContain('saveClip(join(app.getPath("temp"), "intuition"), cut.toPNG(), new Date(), "snip")');
    expect(main).toContain('activeSnipHotkey = one("snip hotkey", activeSnipHotkey, prefs.snipHotkey, unlessSettings(() => void snip()));');
    // Pressed while Settings has the keyboard (recording a shortcut), neither hotkey opens anything.
    expect(main).toContain('activeHotkey = one("hotkey", activeHotkey, prefs.hotkey, unlessSettings(newTask));');
    expect(main).toContain("if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isFocused()) return;");
    expect(main).toContain('{ label: "Snip", click: () => void snip() }');
  });

  test("main.ts: links elsewhere go through externalLink to the browser; the self-test opens none", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    // The other one opens System Settings' Screen Recording pane, a constant, when its notice is clicked.
    expect(main.match(/shell\.openExternal\(/g)).toHaveLength(2);
    expect(main).toContain("shell.openExternal(SCREEN_RECORDING_PANE)");
    const open = main.slice(main.indexOf("function openExternal("));
    const body = open.slice(0, open.indexOf("\n}\n"));
    expect(body).toContain("const link = externalLink(url, settings.runnerUrl);");
    expect(body).toContain("if (link === null) return;");
    expect(body.indexOf("if (args.selfTest) externalOpened.push(link);")).toBeLessThan(body.indexOf("shell.openExternal(link)"));
    // A redirect never opens anything.
    expect(main).toContain('contents.on("will-redirect", stay);');
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
    // notify(): the runner is not running or is older than the shell, a hotkey could not be set, a setting or start on login was not changed,
    // the Linux desktop may hide the tray or the hotkeys. The other Notification: macOS has not given Screen Recording.
    expect(main.match(/new Notification\(/g)).toHaveLength(2);
    expect(main).toContain("new Notification({ title: SCREEN_RECORDING_NOTICE.title, body: SCREEN_RECORDING_NOTICE.body })");
    expect(main.match(/\bnotify\(/g)).toHaveLength(7);
    expect(main).toContain("notify(DOCK_STALE_RUNNER.title, DOCK_STALE_RUNNER.body);");
    expect(main).toContain("notify(n.title, n.body);");
    for (const title of ["intuition: the runner is not running", "intuition: the setting was not changed", "intuition: start on login was not changed"]) expect(main).toContain(`notify("${title}"`);
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
    // On 2560x1440 the chat is 1180x860 (chatSize), and the window is as large as that.
    dockOffNoWindow: true, dockCreated: true, dockUrl: "http://127.0.0.1:5000/dock?chat=1180x860", dockNotch: null, dockVisible: true, dockBridge: "object:setState,onChat:undefined:undefined",
    primaryDisplay: display, dockIgnoresMouseBeforeLoad: true, dockIdleBounds: { x: 690, y: 0, width: 1180, height: 860 }, dockIdleFocusable: false, dockIdleFocused: false,
    dockMouseOnIdleIsland: true, dockMouseAwayIgnored: true, dockMouseBelowPillIgnored: true,
    dockPeekBounds: { x: 690, y: 0, width: 1180, height: 860 }, dockPeekFocusable: false, dockMouseOnPeekIsland: true,
    dockOpenBounds: { x: 690, y: 0, width: 1180, height: 860 }, dockOpenFocusable: true, dockMouseOnOpenIsland: true, dockOtherValueIgnored: true,
    dockChatBounds: { x: 690, y: 0, width: 1180, height: 860 }, dockChatFocusable: true, dockMouseOnChatIsland: true,
    dockBackBounds: { x: 690, y: 0, width: 1180, height: 860 }, dockBackFocusable: false, dockForeignOriginIgnored: true,
    dockIgnoresMouseUnreported: true, dockIgnoresMouseAfterCrash: true,
    dockChatSession: STUB_SESSION, dockChatNoWindow: true, dockOpenedPromptUrl: "http://127.0.0.1:5000/prompt",
    dockOtherWindowRefused: true, dockHiddenWithoutRunner: true, dockShownAgain: true,
    snipHotkeyRegistered: true, snipDisplays: [{ bounds: display, scaleFactor: 1.5 }, { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    snipOverlayBounds: [display, { x: 2560, y: 0, width: 1920, height: 1080 }], snipOverlaysShown: true, snipUrl: "http://127.0.0.1:5000/assets/snip.html",
    snipMs: 240, snipPhases: { warm: 1, captured: 150, drawn: 230 }, snipCaptured: true, snipBridge: "object:close,crop,getCapture:undefined:undefined",
    snipCropRect: SELF_TEST_CROP, snipCropPath: "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\snip-20261113-120000-000.png", snipBadRectsRefused: true,
    snipClosed: true, snipEscClosed: true,
    settingsFileKeys: ["runnerUrl"], settingsHotkeyRegistered: true, settingsHotkeyChanged: true, settingsInvalidHotkeyKept: true, settingsTakenHotkeyKept: true,
    settingsNotices: [
      hotkeyNotice("hotkey", SELF_TEST_PREFS.invalid, SELF_TEST_PREFS.changed), hotkeyNotice("hotkey", SELF_TEST_PREFS.snipHotkey, SELF_TEST_PREFS.changed),
    ].map((n) => `${n.title}: ${n.body}`),
    settingsDockShown: true, settingsDockHidden: true, settingsTheme: "dark", settingsOpenAtLogin: false,
    settingsWindowUrl: "http://127.0.0.1:5000/assets/settings.html", settingsWindowWidth: 720, settingsWindowHeight: 640, settingsWindowReused: true,
    settingsLinkOpened: "http://127.0.0.1:5000/assets/settings.html",
    externalLinks: expectedExternal("http://127.0.0.1:5000"), errors: [],
    os: "windows", dockTransparent: true, primaryWorkArea: { ...display, height: 1400 }, screenAccess: "granted",
    windowsRelease: "10.0.22631", popupMaterial: "acrylic", dockMaterial: "none", snipMaterial: "none", settingsMaterial: "none",
  };
  const posts = [{ text: "intuition self-test 1" }, { imagePath }];
  const base = stubSettings(5000);
  const migration = (startOnLogin: boolean) => withShell(base, { hotkey: SELF_TEST_PREFS.hotkey, snipHotkey: SELF_TEST_PREFS.snipHotkey, dock: false, startOnLogin });
  const puts = (startOnLogin = false) => {
    const m = migration(startOnLogin);
    const changed = withShell(m, { ...m.shell!, hotkey: SELF_TEST_PREFS.changed });
    return [m, changed, withShell(changed, { ...changed.shell!, dock: true }), withShell(changed, { ...changed.shell!, dock: false })];
  };
  /** A PNG header of a given size: what the stand-in reader gives for every path. */
  const header = (width: number, height: number) => {
    const b = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(16)]);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  };
  // SELF_TEST_CROP at 150%: 10.5..111.5 x 20.25..69.75 is 15..168 x 30..105 device pixels.
  const png = () => header(153, 75);
  const check = (r: Partial<SelfTestResult>, p = posts, read: (windowsPath: string) => Uint8Array | null = png, put = puts()) => problems(r, { posts: p, puts: put }, "http://127.0.0.1:5000", read);

  test("a clean result has no problems", () => {
    expect(check(good)).toEqual([]);
  });

  test("every field is asserted", () => {
    for (const key of Object.keys(good) as (keyof SelfTestResult)[]) {
      const value = good[key];
      // Flipped, moved or replaced, by the field's kind. A display moved sideways moves where the dock should be.
      const broken = {
        ...good,
        [key]: key === "errors" ? ["boom"] : typeof value === "number" ? 9999 : typeof value === "string" || key === "openAtLogin" ? "C:\\elsewhere"
          : typeof value === "boolean" ? !value : Array.isArray(value) ? [] : value && typeof value === "object" ? { ...value, x: Number((value as { x: number }).x) + 2.5 } : false,
      };
      expect(`${key}: ${check(broken).length > 0}`).toBe(`${key}: true`);
    }
    expect(check({}).length).toBeGreaterThan(10);
  });

  describe("on macOS and Linux", () => {
    const macDisplay = { x: 0, y: 0, width: 1512, height: 982 };
    // A MacBook with a notch: the menu bar is 38 points tall.
    const macWork = { x: 0, y: 38, width: 1512, height: 944 };
    const native = "/var/folders/xy/T/intuition";
    const placeAt = (p: Area) => ({ dockIdleBounds: p, dockPeekBounds: p, dockOpenBounds: p, dockChatBounds: p, dockBackBounds: p });
    /** The window's place in an area, for the chat that area gives (D0042). */
    const placed = (area: Area) => dockBounds(area, chatSize(area));
    const chatQuery = (area: Area) => `chat=${chatSize(area).width}x${chatSize(area).height}`;
    const macArea = dockArea("macos", macDisplay, macWork);
    const macPlace = placed(macArea);
    const mac: SelfTestResult = {
      ...good, os: "macos", primaryDisplay: macDisplay, primaryWorkArea: macWork, ...placeAt(macPlace), dockUrl: `http://127.0.0.1:5000/dock?${chatQuery(macArea)}`,
      imagePath: `${native}/clip-20261115-090507-042.png`, snipCropPath: `${native}/snip-20261115-090508-000.png`,
      snipDisplays: [{ bounds: macDisplay, scaleFactor: 1.5 }], snipOverlayBounds: [macDisplay],
      windowsRelease: null, popupMaterial: "vibrancy",
    };
    const macPosts = [{ text: "intuition self-test 1" }, { imagePath: mac.imagePath! }];
    const at = (r: Partial<SelfTestResult>, where: Where) => problems(r, { posts: macPosts, puts: puts() }, "http://127.0.0.1:5000", png, where);
    const linuxPlace = placed(macDisplay);
    const linux: SelfTestResult = { ...mac, os: "linux", primaryWorkArea: macDisplay, ...placeAt(linuxPlace), dockUrl: `http://127.0.0.1:5000/dock?${chatQuery(macDisplay)}`, popupMaterial: "none" };

    test("a clean Mac result has no problems, and its dock is judged below the menu bar", () => {
      expect(at(mac, { layout: "macos" })).toEqual([]);
      expect(at({ ...mac, ...placeAt(placed(macDisplay)) }, { layout: "macos" })).toHaveLength(5);
    });

    test("with a notch, the dock is judged at the very top, centred on it, and its page has the notch's and the chat's sizes", () => {
      const notch = { x: 666.5, width: 179, height: 38 };
      const area = dockArea("macos", macDisplay, macWork, notch);
      const notched = { ...mac, dockNotch: notch, dockUrl: "http://127.0.0.1:5000/dock?notch=179x38&chat=936x746", ...placeAt(placed(area)) };
      expect(chatSize(area)).toEqual({ width: 936, height: 746 });
      expect(notched.dockIdleBounds).toEqual({ x: 288, y: 0, width: 936, height: 746 });
      expect(at(notched, { layout: "macos" })).toEqual([]);
      // Below the menu bar, or without the notch in its address, is not where it should be.
      expect(at({ ...notched, ...placeAt(macPlace) }, { layout: "macos" })).toHaveLength(5);
      expect(at({ ...notched, dockUrl: "http://127.0.0.1:5000/dock?chat=936x746" }, { layout: "macos" })).toEqual([expect.stringContaining("the dock loaded")]);
      expect(at({ ...notched, dockUrl: "http://127.0.0.1:5000/dock?notch=179x38" }, { layout: "macos" })).toEqual([expect.stringContaining("the dock loaded")]);
      // A notch is a Mac's.
      expect(at({ ...linux, dockNotch: notch }, { layout: "linux" })).toContainEqual(expect.stringContaining("measured a notch"));
    });

    test("the shell must have run on the layout's OS, with the layout's paths", () => {
      // Its pop-up's vibrancy is not what Windows would get, so that is named too.
      expect(at({ ...mac, os: "windows" }, { layout: "macos" })).toEqual(["the shell ran on windows, not macos", expect.stringContaining("the pop-up's material")]);
      expect(at(good, { layout: "macos" }).length).toBeGreaterThan(0);
      expect(at(linux, { layout: "linux" })).toEqual([]);
    });

    test("macOS without Screen Recording: the capture, crop and time are skipped and named, not failed", () => {
      const denied = { ...mac, screenAccess: "denied", snipCaptured: false, snipCropPath: null, snipMs: 3100 };
      expect(at(denied, { layout: "macos" })).toEqual([]);
      expect(skipped(denied, { layout: "macos" })).toEqual([expect.stringContaining("macOS has not given Screen Recording (denied)")]);
      // Granted but empty is a failure, and so is an empty capture on Linux outside WSLg.
      expect(at({ ...denied, screenAccess: "granted" }, { layout: "macos" }).length).toBeGreaterThan(0);
      expect(captureWithheld({ ...denied, os: "linux" }, { layout: "linux" })).toBeNull();
      expect(skipped(mac, { layout: "macos" })).toEqual([]);
      // Only macOS asks: another OS saying it was withheld is wrong.
      expect(at({ ...linux, screenAccess: "denied" }, { layout: "linux" })).toHaveLength(1);
    });

    test("WSLg: an empty capture is skipped and named; an overlay a pixel short is taken on Linux only", () => {
      const wslg = { ...linux, snipCaptured: false, snipCropPath: null, snipMs: 3013, snipOverlayBounds: [{ ...macDisplay, width: 1511, height: 981 }] };
      expect(at(wslg, { layout: "linux", wslg: true })).toEqual([]);
      expect(skipped(wslg, { layout: "linux", wslg: true })).toEqual([expect.stringContaining("WSLg gives Electron no pixels")]);
      expect(at(wslg, { layout: "linux" }).length).toBeGreaterThan(0);
      expect(at({ ...wslg, snipOverlayBounds: [{ ...macDisplay, width: 1510 }] }, { layout: "linux", wslg: true })).toHaveLength(1);
      expect(at({ ...mac, snipOverlayBounds: [{ ...macDisplay, width: 1511 }] }, { layout: "macos" })).toHaveLength(1);
    });

    test("a crash the self-test had to kill itself, and an opaque dock, are printed as notes, not failures", () => {
      const killed = { ...linux, dockCrashKilledBySelfTest: true };
      expect(at(killed, { layout: "linux" })).toEqual([]);
      expect(notes(killed)).toEqual([expect.stringContaining("killed it with SIGKILL")]);
      expect(notes({ ...killed, dockTransparent: false })).toEqual([expect.stringContaining("killed it with SIGKILL"), expect.stringContaining("opaque window")]);
      expect(notes({ ...mac, dockTransparent: true })).toEqual([]);
    });

    test("each window's material is judged against this OS, and printed", () => {
      expect(at({ ...mac, popupMaterial: "none" }, { layout: "macos" })).toEqual([expect.stringContaining("the pop-up's material is \"none\", not \"vibrancy\"")]);
      expect(at({ ...linux, popupMaterial: "acrylic" }, { layout: "linux" })).toHaveLength(1);
      expect(at({ ...mac, dockMaterial: "vibrancy" }, { layout: "macos" })).toEqual([expect.stringContaining("the dock's material")]);
      expect(at({ ...mac, windowsRelease: "10.0.22631" }, { layout: "macos" }).length).toBeGreaterThan(0);
      expect(materials(mac)).toBe("materials: pop-up vibrancy, dock none, snip none, settings none");
      expect(materials(good)).toBe("materials (Windows 10.0.22631): pop-up acrylic, dock none, snip none, settings none");
    });

    test("an opaque dock is judged as the island of each state", () => {
      const island = (s: DockState) => opaqueDockBounds(linuxPlace, islandRect(s, null, chatSize(macDisplay)));
      const opaque = { ...linux, dockTransparent: false, dockIdleBounds: island("idle"), dockPeekBounds: island("peek"), dockOpenBounds: island("open"), dockChatBounds: island("chat"), dockBackBounds: island("idle") };
      // Grown into the chat, an opaque dock is the whole window's place.
      expect(island("chat")).toEqual(linuxPlace);
      expect(at(opaque, { layout: "linux" })).toEqual([]);
      expect(at({ ...opaque, dockTransparent: true }, { layout: "linux" })).toHaveLength(4);
    });
  });

  test("the dock's bounds are judged against the display the shell reported", () => {
    // The same dock on another display is in the wrong place five times: idle, peek, open, chat, and back.
    const narrow = { ...display, width: 1920 };
    expect(check({ ...good, primaryDisplay: narrow, primaryWorkArea: narrow })).toHaveLength(5);
    // On the display's top edge, wherever that is.
    const lower = { ...display, y: 300 };
    expect(check({ ...good, primaryDisplay: lower, primaryWorkArea: lower })).toHaveLength(5);
    const at = { ...good.dockIdleBounds!, y: 300 };
    expect(check({ ...good, primaryDisplay: lower, primaryWorkArea: lower, dockIdleBounds: at, dockPeekBounds: at, dockOpenBounds: at, dockChatBounds: at, dockBackBounds: at })).toEqual([]);
    // Another chat size in the page's address than the display gives: the page would draw another chat.
    expect(check({ ...good, dockUrl: "http://127.0.0.1:5000/dock?chat=960x680" })).toEqual([expect.stringContaining("the dock loaded")]);
    for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 0 }, { x: "0", y: 0, width: 100, height: 100 }]) expect(check({ ...good, primaryDisplay: bad as never }).length).toBeGreaterThanOrEqual(5);
    // The window is the same in every state: one that grew, shrank or moved for a state is a failure.
    expect(check({ ...good, dockOpenBounds: { ...good.dockOpenBounds!, height: 481 } })).toHaveLength(1);
    expect(check({ ...good, dockPeekBounds: { x: 1070, y: 0, width: 420, height: 76 } })).toHaveLength(1);
    expect(check({ ...good, dockBackBounds: { x: 1140, y: 0, width: 280, height: 40 } })).toHaveLength(1);
    expect(check({ ...good, dockPeekBounds: null })).toHaveLength(1);
    // The mouse: each of these alone is a failure.
    for (const key of ["dockIgnoresMouseBeforeLoad", "dockMouseOnIdleIsland", "dockMouseAwayIgnored", "dockMouseBelowPillIgnored", "dockMouseOnPeekIsland", "dockMouseOnOpenIsland", "dockIgnoresMouseUnreported", "dockIgnoresMouseAfterCrash"] as const) {
      expect(check({ ...good, [key]: false })).toHaveLength(1);
    }
    expect(check({ ...good, dockPeekFocusable: true })).toHaveLength(1);
    // The bridge with anything more on it, or Node in the page.
    for (const bridge of ["object:setState,resize:undefined:undefined", "undefined::undefined:undefined", "object:setState:function:undefined", "object:setState:undefined:object"]) expect(check({ ...good, dockBridge: bridge })).toHaveLength(1);
  });

  test("the snip: one overlay on each display's bounds, the bridge, the crop's size at the display's scale, and the time", () => {
    expect(check({ ...good, snipOverlayBounds: [display] })).toHaveLength(1);
    expect(check({ ...good, snipOverlayBounds: [display, { x: 2560, y: 0, width: 1920, height: 1081 }] })).toHaveLength(1);
    expect(check({ ...good, snipMs: SNIP_SLOW_MS })).toHaveLength(1);
    // Slower than aimed for is printed, not failed.
    expect(check({ ...good, snipMs: 900 })).toEqual([]);
    for (const bridge of ["object:close,crop,getCapture,save:undefined:undefined", "object:crop,getCapture:undefined:undefined", "object:close,crop,getCapture:function:undefined"]) expect(check({ ...good, snipBridge: bridge })).toHaveLength(1);
    // The PNG's size at the first display's 150%: a pixel off, or the size at 100%, fails.
    expect(check(good, posts, () => header(154, 75))).toHaveLength(1);
    expect(check(good, posts, () => header(102, 50))).toHaveLength(1);
    expect(check({ ...good, snipDisplays: [{ bounds: display, scaleFactor: 1 }, good.snipDisplays![1]!] }, posts, () => header(102, 50))).toEqual([]);
    expect(check({ ...good, snipCropPath: "C:\\Users\\x\\Desktop\\snip-1.png" })).toHaveLength(1);
    expect(check({ ...good, externalLinks: [...good.externalLinks, "file:///C:/Windows/win.ini"] })).toHaveLength(1);
  });

  test("an empty capture (a locked desktop) is said once and plainly, and the crop is not judged", () => {
    const locked = check({ ...good, snipCaptured: false, snipCropPath: null }, posts, (p) => (p.includes("snip-") ? null : png()));
    expect(locked).toHaveLength(1);
    expect(locked[0]).toContain("lock screen");
    // The rest of the snip is still judged.
    expect(check({ ...good, snipCaptured: false, snipCropPath: null, snipEscClosed: false })).toHaveLength(2);
  });

  test("a PNG's size is read from its header", () => {
    expect(pngSize(header(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(pngSize(Buffer.from("BM not a png at all, long enough"))).toBeNull();
    expect(pngSize(PNG_SIGNATURE)).toBeNull();
  });

  test("start on login is reported, on or off: either passes, and only an unread one fails", () => {
    expect(check({ ...good, openAtLogin: true, settingsOpenAtLogin: true }, posts, png, puts(true))).toEqual([]);
    expect(check({ ...good, openAtLogin: false })).toEqual([]);
    expect(check({ ...good, openAtLogin: null, settingsOpenAtLogin: null }, posts, png, [withShell(base, { ...migration(false).shell!, startOnLogin: null as never }), ...puts().slice(1)])).toHaveLength(2);
    // Changed by the self-test: a failure.
    expect(check({ ...good, settingsOpenAtLogin: true })).toHaveLength(1);
  });

  test("settings: the migration sent once with the old file's values, the tray's PUT, the notices naming each hotkey, and the Settings window", () => {
    // No migration, or a migration with other values.
    expect(check(good, posts, png, puts().slice(1)).length).toBeGreaterThanOrEqual(2);
    expect(check(good, posts, png, [withShell(base, { ...SHELL_DEFAULTS, startOnLogin: false }), ...puts().slice(1)]).length).toBeGreaterThanOrEqual(2);
    // Sent twice.
    expect(check(good, posts, png, [migration(false), ...puts()])).toHaveLength(1);
    // The tray never wrote.
    expect(check(good, posts, png, puts().filter((p) => !p.shell?.dock))).toHaveLength(1);
    expect(check({ ...good, settingsFileKeys: ["dock", "runnerUrl"] })).toHaveLength(1);
    expect(check({ ...good, settingsNotices: good.settingsNotices.slice(0, 1) })).toHaveLength(1);
    expect(check({ ...good, settingsNotices: [...good.settingsNotices].reverse() })).toHaveLength(1);
    expect(check({ ...good, settingsWindowUrl: "http://127.0.0.1:5000/settings" })).toHaveLength(1);
    expect(check({ ...good, settingsWindowWidth: 721 })).toEqual([]);
    expect(check({ ...good, settingsWindowHeight: 720 })).toHaveLength(1);
  });

  test("what the stub runner received and the saved file are asserted too", () => {
    expect(check(good, [{ imagePath }])).toHaveLength(1);
    expect(check(good, [{ text: "intuition self-test 1" }])).toHaveLength(1);
    // The clipboard image twice (missing, not a PNG) and the snip once.
    expect(check(good, posts, () => null)).toHaveLength(3);
    expect(check(good, posts, () => Buffer.from("BM not a png at all"))).toHaveLength(2);
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
      // The real snip page and what it loads, from src/web; nothing outside it.
      const page = await fetch(`${runner.url}/assets/snip.html`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain('src="/assets/snip.js"');
      for (const file of ["snip.js", "snip-geometry.js", "snip.css", "base.css"]) expect(`${file} ${(await fetch(`${runner.url}/assets/${file}`)).status}`).toBe(`${file} 200`);
      for (const path of ["/assets/../../package.json", "/assets/%2e%2e/%2e%2e/package.json", "/assets/nope.js"]) expect(`${path} ${(await fetch(`${runner.url}${path}`)).status}`).toBe(`${path} 404`);
      expect(await (await fetch(`${runner.url}/api/workspaces`)).json()).toEqual({ workspaces: [], lastUsed: null });
      // The Settings page, a stand-in until src/web has it, and its alias.
      for (const path of ["/assets/settings.html", "/settings"]) expect((await fetch(`${runner.url}${path}`)).headers.get("content-type")).toContain("text/html");
    } finally {
      await runner.stop();
    }
  });

  test("the stub runner keeps settings, records each PUT and sends it to every socket", async () => {
    const runner = stubRunner();
    const ws = new WebSocket(`${runner.url.replace("http:", "ws:")}/ws`);
    const messages: unknown[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    try {
      await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
      const first = parseRunnerSettings(await (await fetch(`${runner.url}/api/settings`)).json());
      expect(first).toEqual(stubSettings(Number(new URL(runner.url).port)));
      expect(first!.shell).toBeNull();
      const next = withShell(first!, { ...SHELL_DEFAULTS, startOnLogin: false });
      const res = await fetch(`${runner.url}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, port: 1 }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(next);
      expect(runner.puts).toHaveLength(1);
      const bad = await fetch(`${runner.url}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, theme: "blue" }) });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ field: expect.any(String) });
      for (let i = 0; i < 20 && messages.length < 2; i++) await Bun.sleep(25);
      expect(messages).toEqual([{ type: "hello", sessions: [] }, { type: "settings", settings: next }]);
      expect(runner.settings()).toEqual(next);
    } finally {
      ws.close();
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
  const wsl = { distro: "Ubuntu", repo: "/home/you/intuition", bun: "/home/you/.bun/bin/bun" };

  test("wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env, as an array", () => {
    expect(runnerCommand(wsl)).toEqual({
      file: "C:\\Windows\\System32\\wsl.exe",
      args: ["-d", "Ubuntu", "--exec", "/home/you/.bun/bin/bun", "/home/you/intuition/src/cli.ts", "start", "--login-env"],
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
    expect(args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--exec", "/home/you/.bun/bin/bun"]);
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
    expect(parseSettings(JSON.stringify({ wsl }))).toEqual({ ...DEFAULT_SETTINGS, wsl, legacy: {} });
    expect(parseSettings(JSON.stringify({ wsl: { ...wsl, distro: "--exec" } }))).toEqual({ ...DEFAULT_SETTINGS, legacy: {} });
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
    expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, wsl, legacy: {} });
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
    expect(main).toContain("spawn(how.file, how.args, { stdio: \"ignore\", windowsHide: true, shell: false, detached: how.detached })");
    // The other spawns ask gnome-extensions what is enabled and osascript for the notch, also without a shell.
    expect(main.match(/\bspawn\(/g)).toHaveLength(3);
    expect(main).toContain('spawn("gnome-extensions", ["list", "--enabled"], { stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 3000 })');
    expect(main).not.toMatch(/\bexec(Sync|File|FileSync)?\(/);
    // The self-test never starts a runner.
    expect(main).toContain("if (args.selfTest || !how) return false;");
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
    // The function itself, the runner's settings applied, and --login on|off. The checkbox writes to the runner.
    expect(main.match(/setStartOnLogin\(/g)).toHaveLength(3);
    expect(main).toContain("if (startsOnLogin() !== next.startOnLogin) setStartOnLogin(next.startOnLogin);");
    // Never in the self-test.
    expect(main).toContain("if (!args.selfTest) {\n    try {\n      if (startsOnLogin() !== next.startOnLogin)");
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
