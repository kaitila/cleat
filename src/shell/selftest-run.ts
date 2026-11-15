// Runs the Windows shell's self-test from WSL: `bun src/shell/selftest-run.ts`.
// This machine only: it needs Windows, so it is skipped in CI and where there is no /mnt/c.
// It installs the shell, starts a stub runner, runs electron.exe --self-test and checks every field it wrote.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, normalize } from "node:path";
import { dockBounds } from "../../shell/src/dock";
import { cropPlan, SELF_TEST_CROP } from "../../shell/src/snip";
import type { Area } from "../../shell/src/geometry";
import { parseRunnerSettings, type RunnerSettings, SELF_TEST_PREFS, SETTINGS_PAGE, SETTINGS_WINDOW } from "../../shell/src/prefs";
import type { SelfTestResult } from "../../shell/src/result";
import { HOST, type ClipboardPostRequest } from "../shared/protocol";
import { electron, install } from "./install";
import { desktopLocked, hasWindows, shellPaths, toWindows, toWsl } from "./paths";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The pages' folder: the stub serves the real snip page from it, as the runner's /assets/ route does. */
const WEB = join(import.meta.dir, "..", "web");
/** The snip should be up in about 300 ms. The time is printed; only one this slow fails, as something broken rather than slow. */
export const SNIP_SLOW_MS = 3000;
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", woff2: "font/woff2" };

/** A PNG's width and height from its header, or null when it is not a PNG. */
export function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24 || !PNG.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
const PAGE = "<!doctype html><meta charset=utf-8><title>intuition self-test</title><p>self-test</p>";

/**
 * The stub's dock page: clear, and it calls setState as the real page does. In a browser the bridge is
 * absent and the call is skipped. The self-test asks for the other states through the same function.
 */
const DOCK_PAGE = `<!doctype html><meta charset=utf-8><title>intuition self-test dock</title>
<style>html, body { margin: 0; background: transparent; }</style>
<script>window.intuitionDock?.setState("idle");</script>`;
const SILENT_DOCK_PAGE = DOCK_PAGE.replace(/<script>.*<\/script>/, "");

/** The session the dock's link opens in the self-test. The shell's self-test names the same one. */
export const STUB_SESSION = "self-test-session";

/** What the stub runner received from the shell. */
export interface Seen {
  posts: ClipboardPostRequest[];
  /** Every PUT /api/settings it took, in order: the shell's migration first, then the self-test's own and the tray's. */
  puts: RunnerSettings[];
}

/** The stub's settings at its start: as a runner that has never had a shell, so the shell migrates. */
export function stubSettings(port: number): RunnerSettings {
  return { theme: "system", permissionMode: "auto", workspaces: [], shell: null, port };
}

/**
 * Just enough of the runner for the shell: /health, the pages, the real snip page's files, no workspaces,
 * POST /api/clipboard, which it records, and the settings: GET and PUT /api/settings, which records each
 * PUT and sends { type: "settings" } to every socket on /ws, as the real runner does.
 */
export function stubRunner() {
  const posts: ClipboardPostRequest[] = [];
  const puts: RunnerSettings[] = [];
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  let stored: RunnerSettings;
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    async fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/ws") return srv.upgrade(req, { data: undefined }) ? undefined : Response.json({ error: "expected a WebSocket upgrade" }, { status: 400 });
      if (req.method === "GET" && path === "/api/settings") return Response.json(stored);
      if (req.method === "PUT" && path === "/api/settings") {
        const body = parseRunnerSettings(await req.json().catch(() => null));
        if (!body) return Response.json({ error: "not settings", field: "settings" }, { status: 400 });
        puts.push(body);
        stored = { ...body, port: stored.port };
        const message = JSON.stringify({ type: "settings", settings: stored });
        for (const ws of sockets) ws.send(message);
        return Response.json(stored);
      }
      // The Settings page: the real one once src/web has it, else a stand-in. /settings is its alias.
      if (req.method === "GET" && (path === "/settings" || (path === SETTINGS_PAGE && !existsSync(join(WEB, "settings.html"))))) return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (req.method === "GET" && path === "/health") return Response.json({ ok: true, version: "self-test" });
      if (req.method === "GET" && (path === "/" || path === "/prompt")) return new Response(PAGE, { headers: { "content-type": "text/html" } });
      // /dock?silent: the same page without its call, as a page that never got as far as reporting a state.
      if (req.method === "GET" && path === "/dock") return new Response(new URL(req.url).search === "?silent" ? SILENT_DOCK_PAGE : DOCK_PAGE, { headers: { "content-type": "text/html" } });
      if (req.method === "GET" && path === "/api/workspaces") return Response.json({ workspaces: [], lastUsed: null });
      if (req.method === "GET" && path.startsWith("/assets/")) {
        const rel = normalize(path.slice("/assets/".length));
        const file = join(WEB, rel);
        const type = TYPES[rel.split(".").pop() ?? ""];
        if (!rel.startsWith("..") && !rel.startsWith("/") && type && existsSync(file)) return new Response(Bun.file(file), { headers: { "content-type": type } });
      }
      if (req.method === "POST" && path === "/api/clipboard") {
        const body = (await req.json()) as ClipboardPostRequest;
        posts.push(body);
        return Response.json({ capturedAt: new Date().toISOString(), ...body });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "hello", sessions: [] }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });
  stored = stubSettings(server.port ?? 0);
  return { url: `http://${HOST}:${server.port}`, posts, puts, settings: () => stored, stop: () => server.stop(true) };
}

function isArea(value: unknown): value is Area {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
}

/** The links the self-test's pages try, that the shell would hand to the browser: the localhost one twice (opened and followed), a mailto and an https. */
export function expectedExternal(runnerUrl: string): string[] {
  const foreign = `${runnerUrl.replace("127.0.0.1", "localhost")}/prompt`;
  return [foreign, foreign, "mailto:someone@example.invalid", "https://example.invalid/"].sort();
}

/** What is wrong with a self-test result, given what the stub runner received. Empty when all is well. */
export function problems(r: Partial<SelfTestResult>, seen: Seen, runnerUrl: string, readImage: (windowsPath: string) => Uint8Array | null): string[] {
  const bad: string[] = [...(r.errors ?? []).map((e) => `the shell reported: ${e}`)];
  const { posts, puts } = seen;
  const need = (ok: unknown, what: string) => {
    if (!ok) bad.push(what);
  };
  need(r.hotkeyRegistered, "the global hotkey did not register");
  need(r.trayCreated, "the tray icon was not created");
  need(r.textCaptured, "the text clipboard was not captured");
  need(r.textPosted, "the text capture was not posted");
  need(posts.some((p) => typeof p.text === "string" && p.text.startsWith("intuition self-test ") && p.imagePath === undefined), "the stub runner did not receive the text");
  need(r.imageCaptured, "the image clipboard was not captured");
  need(r.imagePosted, "the image capture was not posted");
  need(r.imagePath && posts.some((p) => p.imagePath === r.imagePath && p.text === undefined), "the stub runner did not receive the image's path");
  need(r.imagePath && /^[A-Za-z]:\\.*\\intuition\\clip-[\d-]+\.png$/.test(r.imagePath), `the image path is not <temp>\\intuition\\clip-<time>.png: ${r.imagePath}`);
  const image = r.imagePath ? readImage(r.imagePath) : null;
  need(image, "the saved image does not exist under /mnt/c");
  need(image && PNG.every((b, i) => image[i] === b), "the saved image does not start with the PNG signature");
  need(r.notificationsSupported, "notifications are not supported");
  need(r.popupCreated, "the pop-up was not created");
  // A pixel either way: on a display at 200% left of the primary one, Electron reads a 560x380 window back as 559x380 (outer bounds 560x381).
  const near = (n: unknown, want: number) => typeof n === "number" && Math.abs(n - want) <= 1;
  need(near(r.popupWidth, 560) && near(r.popupHeight, 380), `the pop-up is ${r.popupWidth}x${r.popupHeight}, not 560x380`);
  need(r.popupUrl === `${runnerUrl}/prompt`, `the pop-up loaded ${r.popupUrl}, not ${runnerUrl}/prompt`);
  need(r.popupVisible, "the pop-up was not shown");
  need(r.popupCentred, "the pop-up was not centred on the display under the cursor");
  need(r.foreignNavigationRefused, "a navigation to another origin was not refused");
  need(r.foreignWindowRefused, "a new window on another origin was not refused");
  need(r.pageClosedPopup, "window.close() from the page did not close the pop-up");
  need(r.noWindowWithoutRunner, "a window opened although no runner answered");
  need(r.clipboardRestored, "the clipboard was not put back");
  // Start on login is read and reported, whichever it is. Nothing here sets it.
  need(r.loginItemRead && typeof r.openAtLogin === "boolean", `start on login could not be read: ${JSON.stringify(r.openAtLogin)}`);

  need(r.dockOffNoWindow, 'a dock window was created although "dock" is false');
  need(r.dockCreated, "the dock window was not created");
  need(r.dockUrl === `${runnerUrl}/dock`, `the dock loaded ${r.dockUrl}, not ${runnerUrl}/dock`);
  need(r.dockVisible, "the dock was not shown");
  need(r.dockBridge === "object:setState:undefined:undefined", `the page sees more or less than intuitionDock.setState: ${r.dockBridge}`);
  // The same pure function the shell uses, run here on the display the shell reported.
  const display = isArea(r.primaryDisplay) && r.primaryDisplay.width > 0 && r.primaryDisplay.height > 0 ? r.primaryDisplay : null;
  need(display, `the primary display's bounds are ${JSON.stringify(r.primaryDisplay)}`);
  // One place and one size, whatever the state: the window is never resized or moved.
  const want = display ? dockBounds(display) : null;
  const at = (bounds: unknown, when: string) => {
    need(want && isArea(bounds) && bounds.x === want.x && bounds.y === want.y && bounds.width === want.width && bounds.height === want.height,
      `${when}, the dock's window is at ${JSON.stringify(bounds)}, not its one place at the top centre of the primary display, ${JSON.stringify(want)}`);
  };
  need(r.dockIgnoresMouseBeforeLoad, "the dock's window did not ignore the mouse before its page had loaded");
  at(r.dockIdleBounds, "at first");
  need(r.dockIdleFocusable === false, "the dock is focusable in idle");
  need(r.dockIdleFocused === false, "the dock took the focus when it was shown");
  need(r.dockMouseOnIdleIsland, "idle: the cursor on the island was not taken");
  need(r.dockMouseAwayIgnored, "idle: the cursor far from the island was not ignored");
  need(r.dockMouseBelowPillIgnored, "idle: the cursor below the pill, inside the window, was not ignored");
  at(r.dockPeekBounds, 'after setState("peek")');
  need(r.dockPeekFocusable === false, "the dock is focusable in peek");
  need(r.dockMouseOnPeekIsland, "peek: the cursor on the island was not taken, or below it was not ignored");
  at(r.dockOpenBounds, 'after setState("open")');
  need(r.dockOpenFocusable === true, "the dock is not focusable in open");
  need(r.dockMouseOnOpenIsland, "open: the cursor on the island was not taken, or away from it was not ignored");
  need(r.dockOtherValueIgnored, "setState with a value that is not a state changed the dock");
  at(r.dockBackBounds, 'after setState("idle")');
  need(r.dockBackFocusable === false, "the dock is still focusable back in idle");
  need(r.dockIgnoresMouseUnreported, "a page that loaded and reported no state did not leave the window ignoring the mouse");
  need(r.dockIgnoresMouseAfterCrash, "after the page's process crashed the window did not hide and ignore the mouse");
  need(r.dockForeignOriginIgnored, "setState from a page on another origin changed the dock");
  need(r.dockOpenedChatUrl === `${runnerUrl}/?session=${STUB_SESSION}`, `the dock's link to a session opened ${r.dockOpenedChatUrl}, not ${runnerUrl}/?session=${STUB_SESSION}`);
  need(r.dockOpenedPromptUrl === `${runnerUrl}/prompt`, `the dock's link to /prompt opened ${r.dockOpenedPromptUrl}, not the pop-up on ${runnerUrl}/prompt`);
  need(r.dockOtherWindowRefused, "another new window from the dock was not refused");
  need(r.dockHiddenWithoutRunner, "the dock was not hidden when the runner stopped answering (or hid at the first missed check)");
  need(r.dockShownAgain, "the dock did not load and show again when the runner answered");

  // Settings. The migration: the old file's values, and start on login as it was read, sent once, first.
  const migrated = { hotkey: SELF_TEST_PREFS.hotkey, snipHotkey: SELF_TEST_PREFS.snipHotkey, dock: false, startOnLogin: r.openAtLogin };
  need(JSON.stringify(puts[0]?.shell) === JSON.stringify(migrated), `the shell's first PUT /api/settings carried ${JSON.stringify(puts[0]?.shell)}, not the old file's values ${JSON.stringify(migrated)}`);
  need(puts.filter((p) => p.shell && p.shell.hotkey === SELF_TEST_PREFS.hotkey && !p.shell.dock).length === 1, "the migration was sent more than once, or not at all");
  need(JSON.stringify(r.settingsFileKeys) === JSON.stringify(["runnerUrl"]), `after the migration the shell's file has ${JSON.stringify(r.settingsFileKeys)}, not runnerUrl alone`);
  need(r.settingsHotkeyRegistered, "after the migration the file's hotkeys were not the ones registered");
  need(r.settingsHotkeyChanged, "a new hotkey from the runner was not registered, or the old one was not released");
  need(r.settingsInvalidHotkeyKept, "a hotkey that is not a valid accelerator did not leave the one before it working");
  need(r.settingsTakenHotkeyKept, "a hotkey that is taken did not leave the one before it working");
  const notices = Array.isArray(r.settingsNotices) ? r.settingsNotices : [];
  need(notices.length === 2 && notices[0]?.includes(SELF_TEST_PREFS.invalid) && notices[1]?.includes(SELF_TEST_PREFS.snipHotkey) && notices.every((n) => n.includes(`${SELF_TEST_PREFS.changed} still works`)),
    `the notifications for the two hotkeys that could not be set were ${JSON.stringify(r.settingsNotices)}, not one naming each and the one that still works`);
  need(puts.some((p) => p.shell?.dock === true), "the tray's Show dock did not write to the runner");
  need(r.settingsDockShown, "the dock was not shown at once when the setting turned it on");
  need(r.settingsDockHidden, "the dock was not closed at once when the setting turned it off");
  need(r.settingsTheme === "dark", `the shell's windows' theme was ${r.settingsTheme} after the setting said dark`);
  need(typeof r.settingsOpenAtLogin === "boolean" && r.settingsOpenAtLogin === r.openAtLogin, `start on login was ${r.openAtLogin} at the start and ${r.settingsOpenAtLogin} at the end: the self-test must not change it`);
  const settingsPage = `${runnerUrl}${SETTINGS_PAGE}`;
  need(r.settingsWindowUrl === settingsPage, `the Settings window loaded ${r.settingsWindowUrl}, not ${settingsPage}`);
  need(near(r.settingsWindowWidth, SETTINGS_WINDOW.width) && near(r.settingsWindowHeight, SETTINGS_WINDOW.height), `the Settings window is ${r.settingsWindowWidth}x${r.settingsWindowHeight}, not ${SETTINGS_WINDOW.width}x${SETTINGS_WINDOW.height}`);
  need(r.settingsWindowReused, "opening Settings again made a second window");
  need(r.settingsLinkOpened === settingsPage, `a page's link to /settings opened ${r.settingsLinkOpened}, not the Settings window on ${settingsPage}`);

  need(Array.isArray(r.externalLinks) && JSON.stringify([...r.externalLinks].sort()) === JSON.stringify(expectedExternal(runnerUrl)), `the links handed to the browser were ${JSON.stringify(r.externalLinks)}, not ${JSON.stringify(expectedExternal(runnerUrl))}`);

  need(r.snipHotkeyRegistered, "the snip hotkey did not register");
  const displays = Array.isArray(r.snipDisplays) ? r.snipDisplays : [];
  need(displays.length > 0 && displays.every((d) => isArea(d.bounds) && d.bounds.width > 0 && typeof d.scaleFactor === "number" && d.scaleFactor > 0), `the snip's displays are ${JSON.stringify(r.snipDisplays)}`);
  const overlays = Array.isArray(r.snipOverlayBounds) ? r.snipOverlayBounds : [];
  need(overlays.length === displays.length && displays.every((d, i) => JSON.stringify(overlays[i]) === JSON.stringify(d.bounds)),
    `the snip's overlays are at ${JSON.stringify(r.snipOverlayBounds)}, not one on each display's bounds ${JSON.stringify(displays.map((d) => d.bounds))}`);
  need(r.snipOverlaysShown, "the snip's overlays were not all shown on top");
  need(r.snipUrl === `${runnerUrl}/assets/snip.html`, `the snip overlay loaded ${r.snipUrl}, not ${runnerUrl}/assets/snip.html`);
  need(typeof r.snipMs === "number" && r.snipMs > 0 && r.snipMs < SNIP_SLOW_MS, `the snip took ${r.snipMs} ms to show (more than ${SNIP_SLOW_MS} ms is broken, not slow)`);
  need(r.snipBridge === "object:close,crop,getCapture:undefined:undefined", `the snip page sees more or less than intuitionSnip.getCapture, crop and close: ${r.snipBridge}`);
  const phases = r.snipPhases;
  need(phases && typeof phases === "object" && ["captured", "drawn"].every((k) => k in phases) && Object.values(phases).every((n) => Number.isFinite(n)), `the snip's phases are ${JSON.stringify(phases)}`);
  need(JSON.stringify(r.snipCropRect) === JSON.stringify(SELF_TEST_CROP), `the snip cropped ${JSON.stringify(r.snipCropRect)}, not ${JSON.stringify(SELF_TEST_CROP)}`);
  need(r.snipBadRectsRefused, "crop() took something that is not a rectangle inside the display");
  need(r.snipClosed, "the page's close() did not close every overlay");
  need(r.snipEscClosed, "Esc did not close every overlay");
  if (r.snipCaptured === false) {
    // A locked desktop gives empty captures: said once, and the crop, which needs pixels, is not judged.
    bad.push("the screen capture came back empty: Windows is probably on its lock screen. Unlock it and run this again; the crop was not checked");
  } else {
    need(r.snipCaptured === true, "the snip did not say whether it captured the screens");
    const path = r.snipCropPath ?? null;
    need(path && /^[A-Za-z]:\\.*\\intuition\\snip-[\d-]+\.png$/.test(path), `the snip was not saved as <temp>\\intuition\\snip-<time>.png: ${path}`);
    const data = path ? readImage(path) : null;
    const size = data ? pngSize(data) : null;
    need(size, "the snip's PNG does not exist under /mnt/c or is not a PNG");
    const d = displays[0];
    if (size && d) {
      const native = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
      const want = cropPlan(SELF_TEST_CROP, d.bounds, d.scaleFactor, native).output;
      need(size.width === want.width && size.height === want.height, `the snip's PNG is ${size.width}x${size.height}, not ${want.width}x${want.height} (the rectangle at ${d.scaleFactor}x)`);
    }
  }
  return bad;
}

/** Returns the exit code. */
export async function selfTestRun(): Promise<number> {
  if (process.env.CI || !hasWindows()) {
    console.log(`skipped: the shell's self-test needs Windows (${process.env.CI ? "CI is set" : "there is no /mnt/c"})`);
    return 0;
  }
  const paths = shellPaths();
  await install(paths);
  const resultFile = join(paths.home, "self-test-result.json");
  rmSync(resultFile, { force: true });
  const runner = stubRunner();
  let result: Partial<SelfTestResult> = {};
  const written: string[] = [];
  try {
    const shell = electron(paths, ["--self-test", toWindows(resultFile), "--runner-url", runner.url]);
    const timer = setTimeout(() => shell.kill(), 120_000);
    await shell.exited;
    clearTimeout(timer);
    if (!existsSync(resultFile)) {
      console.error("FAILED: the shell wrote no result file");
      return 1;
    }
    result = JSON.parse(readFileSync(resultFile, "utf8"));
    const bad = problems(result, runner, runner.url, (windowsPath) => {
      const file = toWsl(windowsPath);
      written.push(file);
      return file.startsWith("/mnt/c/") && existsSync(file) ? readFileSync(file) : null;
    });
    console.log(JSON.stringify(result, null, 2));
    const shown = result.snipDisplays?.length ?? 0;
    console.log(`the snip: ${shown} overlay${shown === 1 ? "" : "s"} shown ${result.snipMs} ms after the call${typeof result.snipMs === "number" && result.snipMs > 300 ? " (slower than the 300 ms aimed for)" : ""}`);
    if (bad.length) {
      for (const b of bad) console.error(`FAILED: ${b}`);
      if (bad.some((b) => b.includes("clipboard")) && desktopLocked()) {
        console.error("note: Windows is showing its lock screen (LogonUI.exe is running). Nothing can write or read the clipboard behind it: unlock the desktop and run this again.");
      }
      return 1;
    }
    console.log(`start on login is ${result.openAtLogin ? "on" : "off"} on this machine (read, not changed)`);
    console.log("the shell's self-test passed");
    return 0;
  } finally {
    await runner.stop();
    rmSync(resultFile, { force: true });
    for (const file of written) rmSync(file, { force: true });
  }
}

if (import.meta.main) process.exit(await selfTestRun());
