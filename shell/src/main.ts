// The Windows shell: Electron's main process. It lives in the tray, opens the pop-up on the global
// hotkey with the clipboard captured, freezes the screens for a snip on the second hotkey, shows the
// runner's pages in small windows, and keeps the dock at the top of the screen. Its settings (the
// hotkeys, the dock, start on login, the theme) are the runner's: it reads them on a WebSocket and
// applies each change at once.
// Written against Electron 45's electron.d.ts: the clipboard is clipboard.read / write / readText.
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, type NativeImage, nativeTheme, net, Notification, screen, session, shell, Tray } from "electron";
import { parseArgs } from "./args";
import { type Capture, captureBody, isPng, saveClip } from "./clip";
import { acceptedState, DOCK_CHANNEL, DOCK_CHECK_MS, DOCK_STALE_RUNNER, DOCK_MISSES, DOCK_PRELOAD, DOCK_WATCH_FAR_MS, type DockState, dockBounds, dockFocusable, islandRect, takesMouse, watchMs } from "./dock";
import { centred, iconBitmap } from "./geometry";
import { APP_ID, loginItem, type LoginResult } from "./login";
import { chatUrl, dockUrl, externalLink, isSettingsLink, promptUrl, sameOrigin, settingsUrl, windowTarget } from "./origin";
import { hotkeyNotice, migratedPrefs, releaseBoth, parseRunnerSettings, reconnectMs, type RunnerSettings, SELF_TEST_PREFS, SETTINGS_PATH, SETTINGS_WINDOW, SHELL_DEFAULTS, type ShellPrefs, settingsMessage, socketUrl, swapHotkey, withShell } from "./prefs";
import type { SelfTestResult } from "./result";
import { dropLegacy, hasLegacy, loadSettings, PID_FILE, SETTINGS_FILE, type Settings } from "./settings";
import { acceptedRect, acceptedSender, captureSize, cropPlan, matchSources, SNIP_CAPTURE, SNIP_CLOSE, SNIP_CROP, SNIP_PRELOAD, SELF_TEST_CROP, SNIP_SHOW_MS, SNIP_VIEW_QUALITY, snipUrl } from "./snip";
import { RUNNER_START_MS, runnerCommand } from "./wsl";

const POPUP = { width: 560, height: 380 };
const CHAT = { width: 1100, height: 720 };
const ICON_SIZE = 32;
/** Unlikely to be anyone's shortcut, so the self-test never clashes with a running shell. */
const SELF_TEST_HOTKEY = SELF_TEST_PREFS.hotkey;
const SELF_TEST_SNIP_HOTKEY = SELF_TEST_PREFS.snipHotkey;
/** Pages get no Node and their own sandboxed process. Only the dock and the snip overlays add a preload, each for its own small bridge. */
const WEB_PREFERENCES = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } as const;

const args = parseArgs(process.argv);
/** The shell's own file: where the runner is. */
let settings: Settings;
/** What the shell applies: the runner's, once it has answered; until then the old file's values or the defaults. */
let prefs: ShellPrefs = { ...SHELL_DEFAULTS, startOnLogin: false };
/** The runner's settings as last received. Null until it has sent them (or when it has no settings API). */
let remote: RunnerSettings | null = null;
let tray: Tray | null = null;
let popup: BrowserWindow | null = null;
let popupOpening = false;
let chat: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let dock: BrowserWindow | null = null;

type Clip = { kind: "image"; png: Buffer } | { kind: "text"; text: string } | { kind: "empty" };

function icon() {
  return nativeImage.createFromBitmap(iconBitmap(ICON_SIZE), { width: ICON_SIZE, height: ICON_SIZE });
}

/** What the self-test would have shown as notifications: it puts none on the person's screen. */
const noticesShown: string[] = [];

/** The shell's own trouble only (the runner is not running, the hotkey is taken). Sessions show in the dock. */
function notify(title: string, body: string): void {
  if (args.selfTest) noticesShown.push(`${title}: ${body}`);
  else if (Notification.isSupported()) new Notification({ title, body, icon: icon() }).show();
  else console.error(`${title}: ${body}`);
}

async function runnerAnswers(): Promise<boolean> {
  try {
    return (await fetch(new URL("/health", settings.runnerUrl), { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let starting: Promise<boolean> | null = null;

/**
 * True once the runner answers. When it does not, the shell starts it in WSL, if `shell install`
 * wrote where it lives, and waits up to ten seconds. Callers at the same moment share one start.
 */
function ensureRunner(): Promise<boolean> {
  starting ??= (async () => {
    if (await runnerAnswers()) return true;
    // The self-test never starts a runner: it has its stub, and checks what happens without one.
    const wsl = settings.wsl;
    if (args.selfTest || !wsl) return false;
    const { file, args: wslArgs } = runnerCommand(wsl, process.env.SystemRoot);
    // An array of arguments and no shell. windowsHide: wsl.exe is a console program, and no console window may flash.
    const child = spawn(file, wslArgs, { stdio: "ignore", windowsHide: true, shell: false });
    child.on("error", (e) => console.error("starting the runner in WSL failed", e));
    const end = Date.now() + RUNNER_START_MS;
    while (Date.now() < end) {
      await sleep(300);
      if (await runnerAnswers()) return true;
    }
    return false;
  })()
    .then((up) => {
      // The runner is there, perhaps because the shell just started it: the dock comes with it.
      if (up && !args.selfTest) {
        void showDock();
        if (snipKeepWarm) void warmSnip();
      }
      return up;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

function runnerDown(): void {
  // The self-test checks that no window opens; it does not put a toast on the person's screen.
  if (args.selfTest) return;
  const how = settings.wsl
    ? "The shell tried to start it in WSL and it did not come up. In WSL: intuition start, and intuition logs"
    : "Start it in WSL: intuition up";
  notify("intuition: the runner is not running", `Nothing answers at ${settings.runnerUrl}. ${how}`);
}

// --- Start on login ---

/** The same executable and arguments for setting and for reading: Electron compares them. */
function startsOnLogin(): boolean {
  return app.getLoginItemSettings(loginItem(process.execPath, app.getAppPath())).openAtLogin;
}

/** Only the runner's settings (the tray's checkbox and the Settings page write them) and `--login on|off` come here. */
function setStartOnLogin(on: boolean): void {
  app.setLoginItemSettings({ ...loginItem(process.execPath, app.getAppPath()), openAtLogin: on, name: APP_ID });
}

/**
 * --login on|off|status: does it, tells the runner (when it answers) so its setting agrees and a
 * running shell does not turn it back, writes the outcome, tells a running shell to redraw its menu, and quits.
 */
async function loginCommand(action: "on" | "off" | "status"): Promise<void> {
  let result: LoginResult;
  try {
    if (action !== "status") setStartOnLogin(action === "on");
    result = { openAtLogin: startsOnLogin(), error: null };
  } catch (e) {
    result = { openAtLogin: null, error: e instanceof Error ? e.message : String(e) };
  }
  if (action !== "status" && result.openAtLogin !== null) {
    settings = loadSettings(join(app.getPath("userData"), SETTINGS_FILE));
    const current = await fetchSettings();
    if (current?.shell && current.shell.startOnLogin !== result.openAtLogin) await putSettings(withShell(current, { ...current.shell, startOnLogin: result.openAtLogin }));
  }
  if (args.loginResult) writeFileSync(args.loginResult, JSON.stringify(result));
  // Asking for the lock hands this command line to a running shell: its checkbox follows.
  app.requestSingleInstanceLock();
  app.exit(0);
}

// --- Clipboard ---

async function readClipboard(): Promise<Clip> {
  try {
    for (const item of await clipboard.read()) {
      const type = item.types.includes("image/png") ? "image/png" : item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const data = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer());
      const png = isPng(data) ? data : nativeImage.createFromBuffer(data).toPNG();
      if (isPng(png)) return { kind: "image", png };
    }
  } catch (e) {
    console.error("reading the clipboard's image failed", e);
  }
  const text = await clipboard.readText().catch(() => "");
  return text ? { kind: "text", text } : { kind: "empty" };
}

async function writeClipboard(clip: Clip): Promise<void> {
  if (clip.kind === "image") await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(clip.png)], { type: "image/png" }) })]);
  else if (clip.kind === "text") await clipboard.writeText(clip.text);
  else clipboard.clear();
}

/** Reads the clipboard, saves an image as a PNG in the temp folder, and posts the capture to the runner. */
async function captureClipboard(): Promise<{ capture: Capture; posted: boolean }> {
  const clip = await readClipboard();
  const capture: Capture = clip.kind === "image" ? { kind: "image", path: saveClip(join(app.getPath("temp"), "intuition"), clip.png) } : clip;
  let posted = false;
  // Read first, posted once the runner is there: the shell may be starting it.
  if (!(await ensureRunner())) return { capture, posted };
  try {
    const res = await fetch(new URL("/api/clipboard", settings.runnerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(captureBody(capture)),
      signal: AbortSignal.timeout(3000),
    });
    posted = res.ok;
  } catch (e) {
    console.error("posting the clipboard failed", e);
  }
  return { capture, posted };
}

// --- Windows ---

/** Every page stays on the runner's origin: other navigations are refused, and so are new windows but the shell's own two. */
function guard(): void {
  app.on("web-contents-created", (_event, contents) => {
    const stay = (event: { preventDefault(): void; url: string }) => {
      if (!sameOrigin(event.url, settings.runnerUrl)) event.preventDefault();
    };
    // A link followed in the page to http:, https: or mailto: elsewhere goes to the default browser. A redirect never does.
    contents.on("will-navigate", (event) => {
      if (sameOrigin(event.url, settings.runnerUrl)) {
        // A link to the Settings page followed in another window opens the Settings window instead.
        const inSettings = settingsWindow !== null && !settingsWindow.isDestroyed() && contents === settingsWindow.webContents;
        if (!inSettings && isSettingsLink(event.url, settings.runnerUrl)) {
          event.preventDefault();
          void openSettings(Boolean(args.selfTest));
        }
        return;
      }
      event.preventDefault();
      openExternal(event.url);
    });
    contents.on("will-redirect", stay);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // A link to the runner's own chat view opens in the chat window, and the dock's link to /prompt opens
      // the pop-up, as the hotkey does. Nothing else opens. The self-test opens them without taking the focus.
      const target = windowTarget(url, settings.runnerUrl, dock !== null && !dock.isDestroyed() && contents === dock.webContents);
      if (target?.kind === "chat") void openChat(target.session, Boolean(args.selfTest));
      else if (target?.kind === "settings") void openSettings(Boolean(args.selfTest));
      else if (target?.kind === "prompt") args.selfTest ? void openPopup(true) : newTask();
      else openExternal(url);
      return { action: "deny" };
    });
  });
  // Pages may copy to the clipboard; every other permission (camera, location, notifications...) is refused.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" && sameOrigin(contents.getURL(), settings.runnerUrl));
  });
}

/** What the self-test would have handed to the default browser: it opens nothing on the person's screen. */
const externalOpened: string[] = [];

/** Hands a link to the default browser when externalLink lets it through; anything else is dropped. */
function openExternal(url: string): void {
  const link = externalLink(url, settings.runnerUrl);
  if (link === null) return;
  if (args.selfTest) externalOpened.push(link);
  else void shell.openExternal(link).catch((e) => console.error("opening a link in the browser failed", e));
}

/** Opens the pop-up on the display under the cursor, or focuses it when it is already up. */
async function openPopup(inactive = false): Promise<BrowserWindow | null> {
  if (popup && popup.isVisible()) {
    popup.focus();
    return popup;
  }
  if (popupOpening) return null;
  popupOpening = true;
  try {
    if (!(await ensureRunner())) {
      runnerDown();
      return null;
    }
    if (!popup) {
      const win = new BrowserWindow({
        ...POPUP,
        show: false,
        frame: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        title: "intuition",
        webPreferences: WEB_PREFERENCES,
      });
      win.on("closed", () => {
        if (popup === win) popup = null;
      });
      // Fixed in size by refusing the drag, not with resizable: false: on this machine (Electron 45, a display
      // scaled to 200%) a frameless window made that way grew a pixel taller every time it was moved.
      win.on("will-resize", (event) => event.preventDefault());
      // The self-test shows the pop-up without focus, so a blur there means nothing.
      if (!args.selfTest) win.on("blur", () => win.hide());
      win.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape") {
          event.preventDefault();
          win.hide();
        }
      });
      popup = win;
    }
    const win = popup;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds = { ...centred(area, POPUP.width, POPUP.height), ...POPUP };
    win.setBounds(bounds);
    // A window moved onto a display with another scale comes out sized by the scale it left: placed
    // again from there, it is right (seen on this machine with a display at 200% beside two at 100%).
    // Its content, not its outer bounds: at 200% those read a pixel taller than what was set.
    if (!sameArea(win.getContentBounds(), bounds)) win.setBounds(bounds);
    // Loaded afresh each time, so the page starts empty and reads the new capture.
    await win.loadURL(promptUrl(settings.runnerUrl));
    if (win.isDestroyed()) return null;
    if (inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
    return win;
  } catch (e) {
    console.error("opening the pop-up failed", e);
    popup?.destroy();
    runnerDown();
    return null;
  } finally {
    popupOpening = false;
  }
}

/** The hotkey and "New task": the capture and the pop-up start together, neither waiting for the other. */
function newTask(): void {
  void captureClipboard().catch((e) => console.error("capturing the clipboard failed", e));
  void openPopup();
}

/** Opens the chat view, on one session when given its id. `inactive`: without taking the focus (the self-test). */
async function openChat(sessionId?: string, inactive = false): Promise<void> {
  if (!(await ensureRunner())) return runnerDown();
  const url = chatUrl(settings.runnerUrl, sessionId);
  try {
    if (chat) {
      if (sessionId) await chat.loadURL(url);
      if (chat.isMinimized()) chat.restore();
      chat.show();
      chat.focus();
      return;
    }
    const win = new BrowserWindow({ ...CHAT, show: false, title: "intuition", icon: icon(), autoHideMenuBar: true, webPreferences: WEB_PREFERENCES });
    win.on("closed", () => {
      if (chat === win) chat = null;
    });
    chat = win;
    await win.loadURL(url);
    if (win.isDestroyed()) return;
    if (inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
  } catch (e) {
    console.error("opening the chat failed", e);
    chat?.destroy();
    runnerDown();
  }
}

/** Opens the Settings window on the runner's Settings page, or focuses it when it is open. `inactive`: without taking the focus (the self-test). */
async function openSettings(inactive = false): Promise<BrowserWindow | null> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    if (inactive) settingsWindow.showInactive();
    else {
      settingsWindow.show();
      settingsWindow.focus();
    }
    return settingsWindow;
  }
  if (!(await ensureRunner())) {
    runnerDown();
    return null;
  }
  try {
    const win = new BrowserWindow({ ...SETTINGS_WINDOW, show: false, title: "intuition settings", icon: icon(), autoHideMenuBar: true, webPreferences: WEB_PREFERENCES });
    win.on("closed", () => {
      if (settingsWindow === win) settingsWindow = null;
    });
    settingsWindow = win;
    await win.loadURL(settingsUrl(settings.runnerUrl));
    if (win.isDestroyed()) return null;
    if (inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
    return win;
  } catch (e) {
    console.error("opening the settings failed", e);
    settingsWindow?.destroy();
    runnerDown();
    return null;
  }
}

/** The tray's menu. */
function trayMenu(): Menu {
  let onLogin = false;
  try {
    onLogin = startsOnLogin();
  } catch (e) {
    console.error("reading start on login failed", e);
  }
  return Menu.buildFromTemplate([
    { label: "New task", click: newTask },
    { label: "Snip", click: () => void snip() },
    { label: "Open chat", click: () => void openChat() },
    { label: "Settings…", click: () => void openSettings() },
    { type: "separator" },
    // Both written to the runner, like the Settings page: the change comes back as a 'settings' message and is applied from there.
    { label: "Show dock", type: "checkbox", checked: prefs.dock, click: (item) => void changePrefs({ dock: item.checked }) },
    { label: "Start on login", type: "checkbox", checked: onLogin, click: (item) => void changePrefs({ startOnLogin: item.checked }) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray(): Tray {
  const t = new Tray(icon());
  t.setToolTip("intuition");
  t.setContextMenu(trayMenu());
  t.on("double-click", () => void openChat());
  return t;
}

// --- Snip ---

/**
 * One overlay: its window, the display it covers, and that display's frozen capture. The capture
 * is a promise the page's getCapture() waits on: the windows are made and loaded ahead of the key,
 * hidden, and the key only captures, hands the images over and shows them.
 */
interface Overlay {
  win: BrowserWindow;
  display: Electron.Display;
  capture: Promise<NativeImage | null>;
  give: (image: NativeImage | null) => void;
  /** The capture as the page shows it, encoded once. */
  view: string | null;
}
/** The overlays, one per display: loaded and hidden while waiting for the key, shown during a snip. Empty when there are none. */
let overlays: Overlay[] = [];
/** True from the key until the overlays close. */
let snipShown = false;
/** The displays the overlays were made for, to know when they no longer fit. */
let overlaysFor = "";
let warming: Promise<boolean> | null = null;
let snipOpening: Promise<SnipOpened | null> | null = null;
/** False in the self-test until it asks: the overlays are made ahead only for a running shell. */
let snipKeepWarm = false;

/** What opening a snip did, for the self-test: its overlays, how long until all were shown, whether every display was captured, and when each part was done. */
interface SnipOpened { overlays: Overlay[]; ms: number; captured: boolean; phases: Record<string, number> }

const displaysKey = (displays: Electron.Display[]) => JSON.stringify(displays.map((d) => [d.id, d.bounds, d.scaleFactor]));

/** Every display at its native resolution, one image each, by display. An image that came back empty is null. */
async function captureDisplays(displays: Electron.Display[]): Promise<(NativeImage | null)[]> {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: captureSize(displays) });
  const which = matchSources(displays.map((d) => d.id), sources.map((s) => s.display_id));
  return which.map((i) => {
    const image = i >= 0 ? sources[i]!.thumbnail : null;
    return image && !image.isEmpty() ? image : null;
  });
}

/** Destroys every overlay window, shown or waiting. */
function dropOverlays(): void {
  const all = overlays;
  overlays = [];
  overlaysFor = "";
  snipShown = false;
  for (const o of all) if (!o.win.isDestroyed()) o.win.destroy();
}

/** Closes the snip: every overlay at once. New ones are made ahead for the next key. */
function closeSnip(): void {
  const wasShown = snipShown;
  dropOverlays();
  if (wasShown && snipKeepWarm) void warmSnip();
}

function overlayWindow(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#0f0f11",
    title: "intuition snip",
    // Not throttled while hidden: the page waits, loaded, for the key, and must draw at once.
    webPreferences: { ...WEB_PREFERENCES, backgroundThrottling: false, preload: join(app.getAppPath(), SNIP_PRELOAD) },
  });
  // Above the taskbar too.
  win.setAlwaysOnTop(true, "screen-saver");
  win.on("will-resize", (event) => event.preventDefault());
  // One overlay going away (Esc, a crash, the page closing it) takes all of them.
  win.on("closed", () => {
    if (overlays.some((o) => o.win === win)) closeSnip();
  });
  win.webContents.on("render-process-gone", () => closeSnip());
  // Esc closes everything even when the page does not answer.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      closeSnip();
    }
  });
  return win;
}

/**
 * Makes one hidden overlay per display and loads the page in each, unless loaded ones that fit the
 * displays are already there. True when they are ready for the key. Calls at the same moment share one.
 */
function warmSnip(): Promise<boolean> {
  warming ??= (async () => {
    const displays = screen.getAllDisplays();
    if (overlays.length && overlaysFor === displaysKey(displays)) return true;
    if (snipShown) return false;
    dropOverlays();
    const mine = displays.map((display): Overlay => {
      let give: (image: NativeImage | null) => void = () => {};
      const capture = new Promise<NativeImage | null>((resolve) => (give = resolve));
      return { win: overlayWindow(display), display, capture, give, view: null };
    });
    overlays = mine;
    overlaysFor = displaysKey(displays);
    try {
      await Promise.all(mine.map((o) => o.win.loadURL(snipUrl(settings.runnerUrl))));
      return overlays === mine;
    } catch (e) {
      // The runner is not there: the key makes them again once it is.
      console.error("loading the snip overlays failed", e);
      if (overlays === mine) dropOverlays();
      return false;
    }
  })().finally(() => {
    warming = null;
  });
  return warming;
}

/** Makes the overlays again for a display added, removed or changed, unless a snip is up. */
function rewarmSnip(): void {
  if (snipShown) return;
  dropOverlays();
  if (snipKeepWarm) void warmSnip();
}

/** Resolves once the page says its frozen image is drawn, or after SNIP_SHOW_MS whatever it says. */
function pageReady(win: BrowserWindow): Promise<unknown> {
  return Promise.race([win.webContents.executeJavaScript("window.snipReady ?? null", true).catch(() => null), sleep(SNIP_SHOW_MS)]);
}

/**
 * The snip hotkey and the tray's Snip: captures every display, then covers each with an overlay
 * showing its own frozen capture, the one under the cursor focused. A second press while it is up
 * focuses it again. `inactive`: without taking the focus (the self-test).
 */
function snip(inactive = false): Promise<SnipOpened | null> {
  if (snipShown && !snipOpening) {
    const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const o = overlays.find((x) => x.display.id === under.id) ?? overlays[0];
    if (!inactive && o && !o.win.isDestroyed()) o.win.focus();
    return Promise.resolve(o ? { overlays, ms: 0, captured: true, phases: {} } : null);
  }
  snipOpening ??= openSnip(inactive).finally(() => {
    snipOpening = null;
  });
  return snipOpening;
}

async function openSnip(inactive: boolean): Promise<SnipOpened | null> {
  const started = performance.now();
  const phases: Record<string, number> = {};
  const mark = (name: string) => (phases[name] = Math.round(performance.now() - started));
  const displays = screen.getAllDisplays();
  // The capture first, before any window of ours is on screen.
  const capturing = captureDisplays(displays)
    .catch((e) => {
      console.error("capturing the screens failed", e);
      return displays.map(() => null);
    })
    .finally(() => mark("captured"));
  const warm = overlays.length > 0 && overlaysFor === displaysKey(displays) && !warming;
  phases.warm = warm ? 1 : 0;
  try {
    // Waiting overlays were loaded from a runner that answered: they show at once, and the runner is
    // checked (and started, if it has gone) meanwhile, by the time the task is sent.
    if (warm) void ensureRunner();
    else {
      if (!(await ensureRunner())) {
        dropOverlays();
        runnerDown();
        return null;
      }
      if (!(await warmSnip())) throw new Error("the overlays did not load");
      mark("loaded");
    }
    const mine = overlays;
    snipShown = true;
    const images = await capturing;
    mine.forEach((o) => o.give(images[displays.findIndex((d) => d.id === o.display.id)] ?? null));
    await Promise.all(mine.map((o) => pageReady(o.win)));
    mark("drawn");
    if (overlays !== mine) return null;
    const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    for (const o of mine) {
      if (o.win.isDestroyed()) continue;
      if (inactive || o.display.id !== under.id) o.win.showInactive();
      else {
        o.win.show();
        o.win.focus();
      }
      // Again once shown: on Windows a window placed on a display with another scale can come out sized for the first.
      if (!sameArea(o.win.getContentBounds(), o.display.bounds)) o.win.setContentBounds(o.display.bounds);
    }
    return { overlays: mine, ms: Math.round(performance.now() - started), captured: images.every((image) => image !== null), phases };
  } catch (e) {
    console.error("opening the snip failed", e);
    dropOverlays();
    return null;
  }
}

const sameArea = (a: Electron.Rectangle, b: Electron.Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The overlay a bridge call came from, when the main process answers it: one of the shell's overlay windows, its main frame, on the snip page. */
function overlayOf(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Overlay | null {
  const o = overlays.find((x) => !x.win.isDestroyed() && x.win.webContents === event.sender) ?? null;
  const frame = event.senderFrame;
  const ok = acceptedSender({ fromOverlay: o !== null, mainFrame: frame !== null && frame.parent === null, url: frame?.url ?? null }, settings.runnerUrl);
  return ok ? o : null;
}

/** getCapture(): the page's own display, frozen, as a data URL, once the key has been pressed. Null when it came back empty or the call is refused. */
async function onSnipCapture(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
  const o = overlayOf(event);
  if (!o) return null;
  const image = await o.capture;
  if (!image) return null;
  o.view ??= `data:image/jpeg;base64,${image.toJPEG(SNIP_VIEW_QUALITY).toString("base64")}`;
  return o.view;
}

/** crop(rect): the selection cut from the full capture at device pixels, saved as %TEMP%\intuition\snip-<time>.png. */
async function onSnipCrop(event: Electron.IpcMainInvokeEvent, value: unknown): Promise<{ path: string } | { error: string }> {
  const o = overlayOf(event);
  if (!o || !snipShown) return { error: "refused" };
  const bounds = o.display.bounds;
  const rect = acceptedRect(value, bounds);
  if (!rect) return { error: "not a rectangle inside the display" };
  const image = await o.capture;
  if (!image) return { error: "nothing was captured" };
  try {
    const plan = cropPlan(rect, bounds, o.display.scaleFactor, image.getSize());
    let cut = image.crop(plan.source);
    const got = cut.getSize();
    if (got.width !== plan.output.width || got.height !== plan.output.height) cut = cut.resize({ ...plan.output, quality: "best" });
    // The one place a snip is written: under the Windows temp folder, named from the clock, never from the page.
    return { path: saveClip(join(app.getPath("temp"), "intuition"), cut.toPNG(), new Date(), "snip") };
  } catch (e) {
    console.error("saving the snip failed", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** close(): every overlay, from any of them, while a snip is up. */
function onSnipClose(event: Electron.IpcMainEvent): void {
  if (overlayOf(event) && snipShown) closeSnip();
}

function snipEvents(): void {
  ipcMain.handle(SNIP_CAPTURE, onSnipCapture);
  ipcMain.handle(SNIP_CROP, onSnipCrop);
  ipcMain.on(SNIP_CLOSE, onSnipClose);
  screen.on("display-metrics-changed", rewarmSnip);
  screen.on("display-added", rewarmSnip);
  screen.on("display-removed", rewarmSnip);
}

// --- Dock ---

/** The state the page last reported through setState. Null until it has: not loaded yet, failed, crashed, reloading. */
let dockState: DockState | null = null;
/** True while the dock's page is loaded and its window shown. */
let dockLoaded = false;
let dockLoading: Promise<void> | null = null;
/** The HTTP status of the dock window's last navigation. */
let dockStatus = 0;
/** What the window was last told: true, the mouse goes through it. Electron has no getter for this. */
let dockIgnoresMouse = true;
/** Where the cursor is. The self-test puts a made-up one here. */
let dockCursor = (): Electron.Point => screen.getCursorScreenPoint();
let dockWatch: ReturnType<typeof setTimeout> | null = null;

/** Puts the dock's window in its one place, on the primary display as it is now. Never called for a change of state. */
function placeDock(): void {
  if (!dock || dock.isDestroyed()) return;
  // The display's bounds, not its work area: the dock touches the very top edge.
  dock.setBounds(dockBounds(screen.getPrimaryDisplay().bounds));
}

/** Tells the window whether to take the mouse, when that changes. */
function setDockMouse(win: BrowserWindow, takes: boolean): void {
  if (dockIgnoresMouse === !takes) return;
  dockIgnoresMouse = !takes;
  // Ignoring, mouse moves are still forwarded to the page, so it sees the pointer arrive and leave.
  if (takes) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

/**
 * Looks at the cursor once: the window takes the mouse only while the cursor is on the island of
 * the state the page last reported, and lets it through everywhere else. Returns how long until
 * the next look.
 */
function watchDockMouse(): number {
  const win = dock;
  if (!win || win.isDestroyed()) return DOCK_WATCH_FAR_MS;
  const bounds = win.getBounds();
  const cursor = dockCursor();
  // A page that has reported nothing, or a window that is not shown, takes nothing.
  const state = dockLoaded ? dockState : null;
  setDockMouse(win, takesMouse(bounds, state, cursor));
  return watchMs(bounds, state, cursor);
}

/** Looks at the cursor now and again after a while, for as long as the shell runs. */
function watchDockMouseLoop(): void {
  if (dockWatch) clearTimeout(dockWatch);
  let wait = DOCK_WATCH_FAR_MS;
  try {
    wait = watchDockMouse();
  } catch (e) {
    console.error("watching the cursor for the dock failed", e);
  }
  dockWatch = setTimeout(watchDockMouseLoop, wait);
}

/** The page is gone or starting over: no state, so the window lets the mouse through until the page reports one. */
function forgetDockState(): void {
  dockState = null;
  const win = dock;
  if (!win || win.isDestroyed()) return;
  setDockMouse(win, false);
  if (win.isFocused()) win.blur();
  if (win.isFocusable()) {
    win.setFocusable(false);
    win.setSkipTaskbar(true);
  }
}

/** Takes the page's state: where the island is for the mouse, and the keyboard only in "open". The window stays as it is. */
function setDockState(state: DockState): void {
  const win = dock;
  if (!win || win.isDestroyed()) return;
  dockState = state;
  const focusable = dockFocusable(state);
  // Closing with the keyboard in it: the focus goes back to the window below.
  if (!focusable && win.isFocused()) win.blur();
  if (win.isFocusable() !== focusable) {
    win.setFocusable(focusable);
    // On Windows, making a window focusable puts it back in the taskbar.
    win.setSkipTaskbar(true);
  }
  // At once, not at the next look: the island just changed under the cursor.
  watchDockMouseLoop();
}

/** No dock on screen. Its window stays, hidden, for when the runner answers again. */
function hideDock(): void {
  dockLoaded = false;
  forgetDockState();
  if (dock && !dock.isDestroyed()) dock.hide();
}

function closeDock(): void {
  dockLoaded = false;
  dockState = null;
  if (dock && !dock.isDestroyed()) dock.destroy();
  dock = null;
}

function createDock(): BrowserWindow {
  const win = new BrowserWindow({
    ...dockBounds(screen.getPrimaryDisplay().bounds),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    // No thick frame: no shadow, no edges to drag, no square outline around the island.
    thickFrame: false,
    roundedCorners: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // A tool window: not in the taskbar and not in Alt+Tab, also while it is focusable.
    type: "toolbar",
    focusable: false,
    title: "intuition dock",
    webPreferences: { ...WEB_PREFERENCES, preload: join(app.getAppPath(), DOCK_PRELOAD) },
  });
  // The default, before any page: every click goes through the window to what is under it.
  dockState = null;
  dockIgnoresMouse = true;
  win.setIgnoreMouseEvents(true, { forward: true });
  // Fixed in size by refusing the drag, as the pop-up is (see there for why not resizable: false).
  win.on("will-resize", (event) => event.preventDefault());
  win.on("closed", () => {
    if (dock === win) {
      dock = null;
      dockLoaded = false;
      dockState = null;
    }
  });
  // A page that starts over (a reload, a new load) has reported nothing yet.
  win.webContents.on("did-start-navigation", (details) => {
    if (dock === win && details.isMainFrame && !details.isSameDocument) forgetDockState();
  });
  win.webContents.on("did-navigate", (_event, _url, code) => {
    dockStatus = code;
  });
  // The page went away under a shown dock (the runner died, the page reloaded into nothing, its process
  // crashed): an empty transparent window must not stay on screen. -3 is a navigation that was only aborted.
  win.webContents.on("did-fail-load", (_event, code, _text, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) hideDock();
  });
  win.webContents.on("render-process-gone", () => hideDock());
  return win;
}

/** True once the stale-runner notification was shown; a dock that loads clears it. */
let staleRunnerSaid = false;

async function loadDock(): Promise<void> {
  const win = (dock ??= createDock());
  try {
    // A page that loads starts over: it has no state until it reports one.
    forgetDockState();
    dockStatus = 0;
    await win.loadURL(dockUrl(settings.runnerUrl));
    if (win.isDestroyed() || dock !== win) return;
    // A runner without the page answers 404 with a body, which loads: that is not the dock.
    if (dockStatus < 200 || dockStatus >= 300) throw new Error(`${dockUrl(settings.runnerUrl)} answered ${dockStatus}`);
    dockLoaded = true;
    staleRunnerSaid = false;
    // Never activated: showing the dock takes nothing from what the person is doing.
    win.showInactive();
    watchDockMouseLoop();
  } catch (e) {
    console.error("loading the dock failed", e);
    hideDock();
    // The runner answers but has no dock: it runs older code than the shell. Said once; the dock's
    // check keeps loading the page every few seconds, so the dock appears once the runner is restarted.
    if (!staleRunnerSaid && !args.selfTest && dockStatus >= 400 && (await runnerAnswers())) {
      staleRunnerSaid = true;
      notify(DOCK_STALE_RUNNER.title, DOCK_STALE_RUNNER.body);
    }
  }
}

/** Loads the dock's page and shows it, unless the setting is off or it is already up. Calls at the same moment share one load. */
function showDock(): Promise<void> {
  if (!prefs.dock || dockLoaded) return Promise.resolve();
  dockLoading ??= loadDock().finally(() => {
    dockLoading = null;
  });
  return dockLoading;
}

/** The page's setState, through the preload's bridge. Taken only from the dock's own main frame on the runner's origin. */
function onDockState(event: Electron.IpcMainEvent, value: unknown): void {
  const frame = event.senderFrame;
  const fromDock = dock !== null && !dock.isDestroyed() && event.sender === dock.webContents;
  const state = acceptedState({ fromDock, mainFrame: frame !== null && frame.parent === null, url: frame?.url ?? null }, settings.runnerUrl, value);
  if (state) setDockState(state);
}

/** Listens for the page's setState and for the displays changing, and starts watching the cursor. */
function dockEvents(): void {
  ipcMain.on(DOCK_CHANNEL, onDockState);
  watchDockMouseLoop();
  // A display added or removed, a new resolution or scale: centred again on the primary display.
  screen.on("display-metrics-changed", placeDock);
  screen.on("display-added", placeDock);
  screen.on("display-removed", placeDock);
}

let dockMisses = 0;

/** One check: is the runner there? Gone (two checks in a row), the dock hides; back, its page loads again and it shows. */
async function checkDock(): Promise<void> {
  if (!prefs.dock) return;
  if (await runnerAnswers()) {
    dockMisses = 0;
    await showDock();
  } else if (++dockMisses >= DOCK_MISSES) hideDock();
}

/** Checks every few seconds. This never starts the runner: the shell's start, the hotkey and the tray do. */
function watchDock(): void {
  const tick = () => void checkDock().catch((e) => console.error("checking the dock failed", e)).finally(() => setTimeout(tick, DOCK_CHECK_MS));
  tick();
}

// --- Settings ---

/** GET /api/settings. Null when the runner does not answer, or has no settings yet (older than the shell). */
async function fetchSettings(): Promise<RunnerSettings | null> {
  try {
    const res = await fetch(new URL(SETTINGS_PATH, settings.runnerUrl), { signal: AbortSignal.timeout(3000) });
    return res.ok ? parseRunnerSettings(await res.json()) : null;
  } catch {
    return null;
  }
}

/** PUT /api/settings with the whole settings: what the runner stored, or why not. */
async function putSettings(body: RunnerSettings): Promise<{ settings: RunnerSettings } | { error: string }> {
  try {
    const res = await fetch(new URL(SETTINGS_PATH, settings.runnerUrl), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const answer = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const o = (answer ?? {}) as { error?: unknown; field?: unknown };
      return { error: `${typeof o.field === "string" ? `${o.field}: ` : ""}${typeof o.error === "string" ? o.error : `the runner answered ${res.status}`}` };
    }
    const stored = parseRunnerSettings(answer);
    return stored ? { settings: stored } : { error: "the runner's answer was not settings" };
  } catch (e) {
    return { error: `nothing answered at ${settings.runnerUrl} (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** The settings file, which keeps runnerUrl and wsl. */
const settingsFile = () => join(app.getPath("userData"), SETTINGS_FILE);

/** The hotkeys as registered now. Null when none is (not yet, or the first one failed). */
let activeHotkey: string | null = null;
let activeSnipHotkey: string | null = null;
/** The last hotkey of each that could not be registered and was said: said once, not at every settings message. */
const hotkeySaid: Record<"hotkey" | "snip hotkey", string | null> = { hotkey: null, "snip hotkey": null };

/** Registers the two hotkeys of `prefs`. A change moves the shortcut; one that cannot be registered keeps the old one working, and a notification names it. */
function registerHotkeys(): void {
  const ops = (press: () => void) => ({
    register: (accelerator: string) => globalShortcut.register(accelerator, press),
    unregister: (accelerator: string) => globalShortcut.unregister(accelerator),
    isRegistered: (accelerator: string) => globalShortcut.isRegistered(accelerator),
  });
  const one = (which: "hotkey" | "snip hotkey", current: string | null, wanted: string, press: () => void): string | null => {
    const { active, failed } = swapHotkey(current, wanted, ops(press));
    if (!failed) hotkeySaid[which] = null;
    else if (hotkeySaid[which] !== failed) {
      hotkeySaid[which] = failed;
      const n = hotkeyNotice(which, failed, active);
      notify(n.title, n.body);
    }
    return active;
  };
  // One takes the other's key as that one moves away (the two traded, say): both are let go first, or each would find the other holding it.
  if (releaseBoth({ hotkey: activeHotkey, snipHotkey: activeSnipHotkey }, prefs)) {
    for (const held of [activeHotkey, activeSnipHotkey]) if (held) globalShortcut.unregister(held);
    activeHotkey = activeSnipHotkey = null;
  }
  activeHotkey = one("hotkey", activeHotkey, prefs.hotkey, newTask);
  activeSnipHotkey = one("snip hotkey", activeSnipHotkey, prefs.snipHotkey, () => void snip());
}

/** Takes the shell's part of the settings: the hotkeys, the dock, start on login, and the tray drawn again. */
function applyPrefs(next: ShellPrefs): void {
  prefs = next;
  registerHotkeys();
  // At once: on loads the page and shows it (when the runner answers), off closes the window.
  if (next.dock) void showDock();
  else closeDock();
  // The self-test only reads start on login: it never changes it on this machine.
  if (!args.selfTest) {
    try {
      if (startsOnLogin() !== next.startOnLogin) setStartOnLogin(next.startOnLogin);
    } catch (e) {
      notify("intuition: start on login was not changed", e instanceof Error ? e.message : String(e));
    }
  }
  tray?.setContextMenu(trayMenu());
}

let migrating = false;

/** Stores the shell's part in the runner, applies what it stored, and drops the file's old values once the runner has them. */
async function saveShell(current: RunnerSettings, shellPrefs: ShellPrefs): Promise<string | null> {
  const saved = await putSettings(withShell(current, shellPrefs));
  if ("error" in saved) return saved.error;
  if (hasLegacy(settings)) {
    try {
      dropLegacy(settingsFile());
      settings = { ...settings, legacy: {} };
    } catch (e) {
      console.error("rewriting the settings file failed", e);
    }
  }
  applySettings(saved.settings);
  return null;
}

/**
 * The migration, once: the runner has no shell settings yet, so the shell sends its own, the values
 * the person had in its file. Should the runner refuse them (a hotkey it does not take), the defaults.
 */
async function migrate(current: RunnerSettings): Promise<void> {
  if (migrating) return;
  migrating = true;
  try {
    let login = false;
    try {
      login = startsOnLogin();
    } catch (e) {
      console.error("reading start on login failed", e);
    }
    const error = await saveShell(current, migratedPrefs(settings.legacy, login));
    if (error) {
      console.error(`the runner refused the shell's settings (${error}); sending the defaults`);
      const again = await saveShell(current, migratedPrefs({}, login));
      if (again) console.error(`the runner refused the defaults too: ${again}`);
    }
  } finally {
    migrating = false;
  }
}

/** Takes settings from the runner: the theme of the shell's windows, then the shell's part, or the migration when there is none. */
function applySettings(next: RunnerSettings): void {
  remote = next;
  // Window chrome, scrollbars and the pages' prefers-color-scheme follow it.
  nativeTheme.themeSource = next.theme;
  if (next.shell) applyPrefs(next.shell);
  else void migrate(next);
}

/**
 * The tray's checkboxes: the change goes to the runner, as the Settings page's would, and is applied
 * from what it stored. Fresh settings are asked for first, so nothing the page just saved is undone.
 */
async function changePrefs(change: Partial<ShellPrefs>): Promise<void> {
  const current = await fetchSettings();
  let error: string | null;
  if (!current) error = `The runner at ${settings.runnerUrl} did not give its settings, which it keeps: it is not running, or older than the shell. In WSL: intuition up, then try again.`;
  else {
    let login = false;
    try {
      login = startsOnLogin();
    } catch {
      // Only for a runner that has no shell settings yet; the checkbox says what the person wants.
    }
    error = await saveShell(current, { ...(current.shell ?? migratedPrefs(settings.legacy, login)), ...change });
  }
  if (error) notify("intuition: the setting was not changed", error);
  // Drawn again from what is so now, whichever way it went.
  tray?.setContextMenu(trayMenu());
}

let syncSocket: Electron.WebSocket | null = null;

/**
 * One WebSocket to the runner's /ws for as long as the shell runs: on every connect it asks for the
 * settings, and it applies each 'settings' message. When it closes (the runner stopped or restarted)
 * it connects again, quietly: one second, then doubling up to fifteen. It never starts the runner.
 */
function syncSettings(): void {
  let attempt = 0;
  const again = () => void setTimeout(connect, reconnectMs(attempt++));
  function connect(): void {
    let ws: Electron.WebSocket;
    try {
      ws = new net.WebSocket(socketUrl(settings.runnerUrl));
    } catch (e) {
      console.error("opening the settings socket failed", e);
      return again();
    }
    syncSocket = ws;
    ws.addEventListener("open", () => {
      attempt = 0;
      void fetchSettings().then((s) => s && applySettings(s));
    });
    ws.addEventListener("message", (event) => {
      const s = settingsMessage((event as Event & { data?: unknown }).data);
      if (s) applySettings(s);
    });
    // An error is followed by close: that is where it connects again.
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", () => {
      if (syncSocket === ws) syncSocket = null;
      again();
    });
  }
  connect();
}

// --- Self-test ---

async function selfTest(): Promise<SelfTestResult> {
  const r: SelfTestResult = {
    hotkeyRegistered: false, trayCreated: false, textCaptured: false, textPosted: false, imageCaptured: false, imagePosted: false,
    imagePath: null, notificationsSupported: false, popupCreated: false, popupWidth: 0, popupHeight: 0, popupUrl: null,
    popupVisible: false, popupCentred: false, foreignNavigationRefused: false, foreignWindowRefused: false, pageClosedPopup: false,
    noWindowWithoutRunner: false, clipboardRestored: false, loginItemRead: false, openAtLogin: null,
    dockOffNoWindow: false, dockCreated: false, dockUrl: null, dockVisible: false, dockBridge: null, primaryDisplay: null,
    dockIgnoresMouseBeforeLoad: false, dockIdleBounds: null, dockIdleFocusable: null, dockIdleFocused: null, dockMouseOnIdleIsland: false,
    dockMouseAwayIgnored: false, dockMouseBelowPillIgnored: false, dockPeekBounds: null, dockPeekFocusable: null, dockMouseOnPeekIsland: false,
    dockOpenBounds: null, dockOpenFocusable: null, dockMouseOnOpenIsland: false, dockOtherValueIgnored: false,
    dockBackBounds: null, dockBackFocusable: null, dockForeignOriginIgnored: false, dockOpenedChatUrl: null, dockOpenedPromptUrl: null,
    dockOtherWindowRefused: false, dockIgnoresMouseUnreported: false, dockIgnoresMouseAfterCrash: false,
    dockHiddenWithoutRunner: false, dockShownAgain: false,
    snipHotkeyRegistered: false, snipDisplays: null, snipOverlayBounds: null, snipOverlaysShown: false, snipUrl: null, snipMs: null, snipPhases: null,
    snipCaptured: null, snipBridge: null, snipCropRect: null, snipCropPath: null, snipBadRectsRefused: false, snipClosed: false, snipEscClosed: false,
    settingsFileKeys: null, settingsHotkeyRegistered: false, settingsHotkeyChanged: false, settingsInvalidHotkeyKept: false, settingsTakenHotkeyKept: false,
    settingsNotices: [], settingsDockShown: false, settingsDockHidden: false, settingsTheme: null, settingsOpenAtLogin: null,
    settingsWindowUrl: null, settingsWindowWidth: 0, settingsWindowHeight: 0, settingsWindowReused: false, settingsLinkOpened: null,
    externalLinks: [], errors: [],
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      r.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const before = await readClipboard();

  await step("hotkey", async () => {
    r.hotkeyRegistered = globalShortcut.register(SELF_TEST_HOTKEY, () => {}) && globalShortcut.isRegistered(SELF_TEST_HOTKEY);
    globalShortcut.unregister(SELF_TEST_HOTKEY);
  });
  await step("tray", async () => {
    const t = createTray();
    r.trayCreated = !t.isDestroyed();
    t.destroy();
  });
  await step("text", async () => {
    const marker = `intuition self-test ${Date.now()}`;
    await clipboard.writeText(marker);
    const { capture, posted } = await captureClipboard();
    r.textCaptured = capture.kind === "text" && capture.text === marker;
    r.textPosted = posted;
    // Said in full: on a locked desktop, or with another program holding the clipboard, the write does not land.
    if (!r.textCaptured) r.errors.push(`text: the clipboard was given the marker and read back as ${capture.kind === "text" ? `other text (${capture.text.length} characters)` : capture.kind}`);
  });
  await step("image", async () => {
    await writeClipboard({ kind: "image", png: icon().toPNG() });
    const { capture, posted } = await captureClipboard();
    r.imageCaptured = capture.kind === "image";
    if (!r.imageCaptured) r.errors.push(`image: the clipboard was given a PNG and read back as ${capture.kind}`);
    r.imagePath = capture.kind === "image" ? capture.path : null;
    r.imagePosted = posted;
  });
  await step("restore", async () => {
    await writeClipboard(before);
    const after = await readClipboard();
    r.clipboardRestored = after.kind === before.kind && (after.kind !== "text" || after.text === (before as { text: string }).text);
  });
  r.notificationsSupported = Notification.isSupported();
  await step("start on login", async () => {
    // Read only: nothing in the self-test changes it.
    r.openAtLogin = startsOnLogin();
    r.loginItemRead = typeof r.openAtLogin === "boolean";
  });

  await step("popup", async () => {
    const win = await openPopup(true);
    if (!win) throw new Error("the pop-up did not open");
    r.popupCreated = true;
    // The content: at 200% the outer bounds read a pixel taller than the window that was set.
    const bounds = win.getContentBounds();
    r.popupWidth = bounds.width;
    r.popupHeight = bounds.height;
    r.popupUrl = win.webContents.getURL();
    r.popupVisible = win.isVisible();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const middle = centred(area, bounds.width, bounds.height);
    r.popupCentred = Math.abs(bounds.x - middle.x) <= 1 && Math.abs(bounds.y - middle.y) <= 1;

    // localhost is the same stub runner under another origin: it would load if the guard let it.
    const foreign = promptUrl(settings.runnerUrl.replace("127.0.0.1", "localhost"));
    const windows = BrowserWindow.getAllWindows().length;
    // Links elsewhere: http(s) and mailto would go to the browser (the self-test only notes them), the rest nowhere.
    const elsewhere = ["file:///C:/Windows/win.ini", "javascript:void 0", "mailto:someone@example.invalid", "ftp://example.invalid/"];
    await win.webContents.executeJavaScript(`for (const u of ${JSON.stringify(elsewhere)}) window.open(u); window.open(${JSON.stringify(foreign)}); location.href = ${JSON.stringify(foreign)}; 0`, true);
    await sleep(700);
    r.foreignNavigationRefused = win.webContents.getURL() === r.popupUrl;
    r.foreignWindowRefused = BrowserWindow.getAllWindows().length === windows;

    const closed = new Promise<boolean>((resolve) => win.once("closed", () => resolve(true)));
    void win.webContents.executeJavaScript("window.close(); 0", true).catch(() => {});
    r.pageClosedPopup = await Promise.race([closed, sleep(3000).then(() => false)]);
    if (!win.isDestroyed()) win.destroy();
  });
  await step("dock off", async () => {
    // The dock off in the settings: no window at all.
    prefs = { ...prefs, dock: false };
    try {
      await showDock();
      r.dockOffNoWindow = dock === null && BrowserWindow.getAllWindows().length === 0;
    } finally {
      prefs = { ...prefs, dock: true };
    }
  });
  await step("dock", async () => {
    // The cursor is made up from here on: the self-test cannot move the real one. The watching is the real loop.
    const display = screen.getPrimaryDisplay().bounds;
    const windowAt = dockBounds(display);
    /** A point on the screen from one inside the dock's window. */
    const spot = (x: number, y: number): Electron.Point => ({ x: windowAt.x + x, y: windowAt.y + y });
    const middle = (state: DockState) => {
      const island = islandRect(state);
      return spot(Math.floor(island.x + island.width / 2), Math.floor(island.height / 2));
    };
    /** Puts the made-up cursor somewhere and waits for the loop to have looked. Returns whether the window ignores the mouse. */
    const cursorAt = async (point: Electron.Point) => {
      dockCursor = () => point;
      await sleep(DOCK_WATCH_FAR_MS * 3);
      return dockIgnoresMouse;
    };
    const away = spot(-400, 700);
    // Below the pill and the peek, inside the window: on the island only when it is open.
    const below = spot(Math.floor(windowAt.width / 2), 200);

    // A window with no page in it yet: the cursor right where the island will be goes through.
    dock = createDock();
    r.dockIgnoresMouseBeforeLoad = await cursorAt(middle("idle"));

    await showDock();
    const win = dock;
    if (!win || win.isDestroyed()) throw new Error("the dock was not created");
    r.dockCreated = true;
    r.dockUrl = win.webContents.getURL();
    r.dockVisible = win.isVisible();
    r.primaryDisplay = display;
    const run = (code: string) => win.webContents.executeJavaScript(code, true);
    r.dockBridge = String(await run("typeof window.intuitionDock + ':' + Object.keys(window.intuitionDock ?? {}).join(',') + ':' + typeof window.require + ':' + typeof window.process"));
    /** Asks through the page, as the page would, and waits for the shell to take it (or not). */
    const ask = async (state: string, expect: DockState | null) => {
      const before = { state: dockState, focusable: win.isFocusable() };
      await run(`window.intuitionDock.setState(${JSON.stringify(state)}); 0`);
      // A refused call changes nothing: there is nothing to wait for but time.
      for (let i = 0; i < (expect ? 30 : 6) && !(expect && dockState === expect); i++) await sleep(100);
      return { bounds: win.getBounds(), focusable: win.isFocusable(), unchanged: dockState === before.state && win.isFocusable() === before.focusable };
    };
    // The stub's page reported "idle" as it loaded.
    for (let i = 0; i < 30 && dockState !== "idle"; i++) await sleep(100);
    r.dockIdleBounds = win.getBounds();
    r.dockIdleFocusable = win.isFocusable();
    r.dockIdleFocused = win.isFocused();
    r.dockMouseOnIdleIsland = !(await cursorAt(middle("idle")));
    r.dockMouseAwayIgnored = await cursorAt(away);
    r.dockMouseBelowPillIgnored = await cursorAt(below);
    const peek = await ask("peek", "peek");
    r.dockPeekBounds = peek.bounds;
    r.dockPeekFocusable = peek.focusable;
    // Still below the peek: ignored. On it: taken.
    r.dockMouseOnPeekIsland = (await cursorAt(below)) && !(await cursorAt(middle("peek")));
    await cursorAt(below);
    const open = await ask("open", "open");
    r.dockOpenBounds = open.bounds;
    r.dockOpenFocusable = open.focusable;
    // The same point, without the cursor moving: on the island now that it is open.
    r.dockMouseOnOpenIsland = !(await cursorAt(below)) && (await cursorAt(away));
    // Another value: refused, still open.
    const other = await ask("huge", null);
    r.dockOtherValueIgnored = other.unchanged && other.focusable;
    const back = await ask("idle", "idle");
    r.dockBackBounds = back.bounds;
    r.dockBackFocusable = back.focusable;
    // The page is on an origin that is not the runner's: the shell is told its runner is elsewhere
    // (localhost is another origin), so the same page's call now comes from a foreign one.
    const real = settings.runnerUrl;
    settings = { ...settings, runnerUrl: real.replace("127.0.0.1", "localhost") };
    try {
      const foreign = await ask("open", null);
      r.dockForeignOriginIgnored = foreign.unchanged && !foreign.focusable;
    } finally {
      settings = { ...settings, runnerUrl: real };
    }

    // The dock's links: the chat on a session, the pop-up, and nothing else.
    await run(`window.open(${JSON.stringify(chatUrl(real, "self-test-session"))}); 0`);
    for (let i = 0; i < 40 && !chat?.isVisible(); i++) await sleep(100);
    r.dockOpenedChatUrl = chat?.webContents.getURL() ?? null;
    chat?.destroy();
    await run(`window.open(${JSON.stringify(promptUrl(real))}); 0`);
    for (let i = 0; i < 40 && !popup?.isVisible(); i++) await sleep(100);
    r.dockOpenedPromptUrl = popup?.webContents.getURL() ?? null;
    popup?.destroy();
    const windows = BrowserWindow.getAllWindows().length;
    await run(`window.open(${JSON.stringify(new URL("/assets/base.css", real).href)}); window.open("https://example.invalid/"); 0`);
    await sleep(500);
    r.dockOtherWindowRefused = BrowserWindow.getAllWindows().length === windows;

    // A page that loads and never reports a state (the stub's /dock?silent): the cursor on the island goes through.
    await cursorAt(middle("idle"));
    await win.loadURL(`${dockUrl(real)}?silent`);
    r.dockIgnoresMouseUnreported = (await cursorAt(middle("idle"))) && dockState === null && !win.isFocusable();
    // The page's process dies: the window hides and ignores the mouse. The next check loads the page again.
    win.webContents.forcefullyCrashRenderer();
    for (let i = 0; i < 40 && win.isVisible(); i++) await sleep(100);
    r.dockIgnoresMouseAfterCrash = (await cursorAt(middle("open"))) && !win.isVisible();
    dockCursor = () => away;
    await checkDock();

    // The runner goes away (port 9, discard: nothing answers): after two checks the dock is hidden, not left
    // empty on screen. It answers again: the next check loads the page and shows the dock, idle.
    settings = { ...settings, runnerUrl: "http://127.0.0.1:9" };
    try {
      await checkDock();
      const afterOne = win.isVisible();
      await checkDock();
      r.dockHiddenWithoutRunner = afterOne && !win.isVisible();
    } finally {
      settings = { ...settings, runnerUrl: real };
    }
    await checkDock();
    r.dockShownAgain = win.isVisible() && win.webContents.getURL() === r.dockUrl && !win.isFocusable();
    closeDock();
    dockCursor = () => screen.getCursorScreenPoint();
  });
  await step("no runner", async () => {
    const real = settings.runnerUrl;
    // Port 9 (discard): nothing answers /health there.
    settings = { ...settings, runnerUrl: "http://127.0.0.1:9" };
    try {
      r.noWindowWithoutRunner = (await openPopup(true)) === null && BrowserWindow.getAllWindows().length === 0;
    } finally {
      settings = { ...settings, runnerUrl: real };
    }
  });
  await step("snip", async () => {
    r.snipHotkeyRegistered = globalShortcut.register(SELF_TEST_SNIP_HOTKEY, () => {}) && globalShortcut.isRegistered(SELF_TEST_SNIP_HOTKEY);
    globalShortcut.unregister(SELF_TEST_SNIP_HOTKEY);
    // As a running shell does: the overlays made and loaded ahead, so the key only captures and shows.
    snipKeepWarm = true;
    if (!(await warmSnip())) throw new Error("the snip overlays did not load");
    const opened = await snip(true);
    if (!opened) throw new Error("the snip did not open");
    r.snipMs = opened.ms;
    r.snipPhases = opened.phases;
    r.snipCaptured = opened.captured;
    r.snipDisplays = opened.overlays.map((o) => ({ bounds: o.display.bounds, scaleFactor: o.display.scaleFactor }));
    r.snipOverlayBounds = opened.overlays.map((o) => o.win.getContentBounds());
    r.snipOverlaysShown = opened.overlays.length > 0 && opened.overlays.every((o) => o.win.isVisible() && o.win.isAlwaysOnTop());
    const first = opened.overlays[0]!;
    r.snipUrl = first.win.webContents.getURL();
    const run = (code: string) => first.win.webContents.executeJavaScript(code, true);
    r.snipBridge = String(await run("typeof window.intuitionSnip + ':' + Object.keys(window.intuitionSnip ?? {}).sort().join(',') + ':' + typeof window.require + ':' + typeof window.process"));
    // A known rectangle: the PNG's size is checked in WSL.
    const { width, height } = first.display.bounds;
    r.snipCropRect = SELF_TEST_CROP;
    if (opened.captured) r.snipCropPath = String(await run(`window.intuitionSnip.crop(${JSON.stringify(r.snipCropRect)})`));
    // Anything but a rectangle of finite numbers inside the display is refused, whatever the capture.
    const bad = [
      "{ x: -1, y: 0, width: 10, height: 10 }", `{ x: 0, y: 0, width: ${width + 1}, height: 10 }`, `{ x: 0, y: ${height - 5}, width: 10, height: 10 }`,
      "{ x: NaN, y: 0, width: 10, height: 10 }", "{ x: 0, y: 0, width: Infinity, height: 10 }", '{ x: "0", y: 0, width: 10, height: 10 }',
      "{ x: 0, y: 0, width: 0.5, height: 10 }", "{ x: 0, y: 0, width: 10, height: 10, path: 'C:/x.png' }", "null", "[0, 0, 10, 10]", "'C:/Windows/x.png'",
    ];
    const answers = await run(`Promise.all([${bad.join(", ")}].map((rect) => window.intuitionSnip.crop(rect).then(() => "saved", () => "refused")))`);
    r.snipBadRectsRefused = Array.isArray(answers) && answers.length === bad.length && answers.every((a) => a === "refused");
    // The page's close() takes every overlay.
    void run("window.intuitionSnip.close(); 0").catch(() => {});
    for (let i = 0; i < 30 && opened.overlays.some((o) => !o.win.isDestroyed()); i++) await sleep(100);
    // New overlays are made at once for the next key, hidden: the ones that were up are gone.
    r.snipClosed = !snipShown && opened.overlays.every((o) => o.win.isDestroyed()) && overlays.every((o) => !o.win.isVisible());
    // Esc, as a key the window receives.
    const again = await snip(true);
    if (!again) throw new Error("the snip did not open a second time");
    again.overlays[0]!.win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    for (let i = 0; i < 30 && again.overlays.some((o) => !o.win.isDestroyed()); i++) await sleep(100);
    r.snipEscClosed = !snipShown && again.overlays.every((o) => o.win.isDestroyed());
    snipKeepWarm = false;
    await warming;
    dropOverlays();
  });
  await step("settings", async () => {
    const until = async (done: () => boolean, ms = 5000) => {
      for (let waited = 0; !done() && waited < ms; waited += 100) await sleep(100);
      return done();
    };
    /** Changes the settings as the Settings page does: GET, change, PUT. The shell hears of it only through the socket. */
    const asPage = async (change: (s: RunnerSettings) => RunnerSettings) => {
      const url = new URL(SETTINGS_PATH, settings.runnerUrl);
      const current = parseRunnerSettings(await (await fetch(url)).json());
      if (!current) throw new Error("the stub runner's settings are not settings");
      const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change(current)) });
      if (!res.ok) throw new Error(`the stub runner answered ${res.status} to a PUT`);
    };
    const shellPart = (s: RunnerSettings) => s.shell ?? (() => { throw new Error("the stub runner has no shell settings"); })();

    // A file as an older shell wrote it, with the self-test's own hotkeys and the dock off. The stub runner has no shell settings yet.
    const file = settingsFile();
    writeFileSync(file, JSON.stringify({ runnerUrl: settings.runnerUrl, hotkey: SELF_TEST_HOTKEY, snipHotkey: SELF_TEST_SNIP_HOTKEY, dock: false }, null, 2));
    settings = { ...loadSettings(file), runnerUrl: settings.runnerUrl };
    prefs = { ...SHELL_DEFAULTS, ...settings.legacy, startOnLogin: false };
    // As at the shell's start.
    registerHotkeys();
    syncSettings();
    // The migration: the file's values go to the runner, come back as its settings, and the file keeps its two keys.
    await until(() => remote?.shell != null && !hasLegacy(settings));
    r.settingsFileKeys = existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8")) as object).sort() : null;
    r.settingsHotkeyRegistered = activeHotkey === SELF_TEST_HOTKEY && globalShortcut.isRegistered(SELF_TEST_HOTKEY) && globalShortcut.isRegistered(SELF_TEST_SNIP_HOTKEY);

    // A new hotkey: registered without a restart, and the old one released.
    await asPage((s) => withShell(s, { ...shellPart(s), hotkey: SELF_TEST_PREFS.changed }));
    r.settingsHotkeyChanged = (await until(() => activeHotkey === SELF_TEST_PREFS.changed))
      && globalShortcut.isRegistered(SELF_TEST_PREFS.changed) && !globalShortcut.isRegistered(SELF_TEST_HOTKEY);
    // One that is not an accelerator, and one that is taken (the snip hotkey holds it): the last one keeps working, and a notice names each.
    const said = noticesShown.length;
    await asPage((s) => withShell(s, { ...shellPart(s), hotkey: SELF_TEST_PREFS.invalid }));
    r.settingsInvalidHotkeyKept = (await until(() => prefs.hotkey === SELF_TEST_PREFS.invalid)) && activeHotkey === SELF_TEST_PREFS.changed && globalShortcut.isRegistered(SELF_TEST_PREFS.changed);
    await asPage((s) => withShell(s, { ...shellPart(s), hotkey: SELF_TEST_SNIP_HOTKEY }));
    r.settingsTakenHotkeyKept = (await until(() => prefs.hotkey === SELF_TEST_SNIP_HOTKEY)) && activeHotkey === SELF_TEST_PREFS.changed
      && globalShortcut.isRegistered(SELF_TEST_PREFS.changed) && activeSnipHotkey === SELF_TEST_SNIP_HOTKEY;
    r.settingsNotices = noticesShown.slice(said);

    // The dock: on through the tray's checkbox (which writes to the runner), off from the page. Each at once.
    await changePrefs({ dock: true });
    r.settingsDockShown = await until(() => dock !== null && !dock.isDestroyed() && dock.isVisible() && dockLoaded);
    await asPage((s) => withShell(s, { ...shellPart(s), dock: false }));
    r.settingsDockHidden = await until(() => dock === null && !prefs.dock);

    // The theme of the shell's windows, then back.
    await asPage((s) => ({ ...s, theme: "dark" }));
    await until(() => nativeTheme.themeSource === "dark");
    r.settingsTheme = nativeTheme.themeSource;
    await asPage((s) => ({ ...s, theme: "system" }));
    await until(() => nativeTheme.themeSource === "system");
    // Read again after all that: still what it was. The self-test never changes it.
    r.settingsOpenAtLogin = startsOnLogin();

    // The Settings window, then the same window again rather than a second one.
    const win = await openSettings(true);
    if (!win) throw new Error("the Settings window did not open");
    r.settingsWindowUrl = win.webContents.getURL();
    // The outer bounds: the window is made that size, title bar and all.
    const bounds = win.getBounds();
    r.settingsWindowWidth = bounds.width;
    r.settingsWindowHeight = bounds.height;
    const windows = BrowserWindow.getAllWindows().length;
    r.settingsWindowReused = (await openSettings(true)) === win && BrowserWindow.getAllWindows().length === windows;
    win.destroy();
    // A page's link to /settings opens it.
    await openChat(undefined, true);
    if (!chat) throw new Error("the chat window did not open");
    await chat.webContents.executeJavaScript(`window.open(${JSON.stringify(new URL("/settings", settings.runnerUrl).href)}); 0`, true);
    await until(() => settingsWindow !== null && !settingsWindow.isDestroyed() && settingsWindow.isVisible());
    r.settingsLinkOpened = settingsWindow?.webContents.getURL() ?? null;
    settingsWindow?.destroy();
    chat?.destroy();
    syncSocket?.close();
    globalShortcut.unregisterAll();
  });
  r.externalLinks = [...externalOpened];
  return r;
}

// --- Start ---

function start(): void {
  settings = loadSettings(settingsFile());
  if (args.runnerUrl) settings = { ...settings, runnerUrl: new URL(args.runnerUrl).origin };
  // Until the runner sends its settings: the file's old values, if it still has them, or the defaults.
  prefs = { ...SHELL_DEFAULTS, ...settings.legacy, startOnLogin: false };
  Menu.setApplicationMenu(null);
  guard();
  dockEvents();
  snipEvents();

  if (args.selfTest) {
    const file = args.selfTest;
    const done = (result: Partial<SelfTestResult>) => {
      writeFileSync(file, JSON.stringify(result, null, 2));
      app.exit(0);
    };
    setTimeout(() => done({ errors: ["the self-test did not finish in 90 seconds"] }), 90_000);
    void selfTest().then(done, (e) => done({ errors: [String(e)] }));
    return;
  }
  // For `up`, which waits for this process to end before it installs a new bundle over it.
  const pidFile = join(app.getPath("userData"), PID_FILE);
  try {
    writeFileSync(pidFile, String(process.pid));
    app.on("will-quit", () => rmSync(pidFile, { force: true }));
  } catch (e) {
    console.error("writing the pid file failed", e);
  }

  tray = createTray();
  snipKeepWarm = true;
  registerHotkeys();
  // The runner's settings, at once and at every change; the hotkeys above move if they differ.
  syncSettings();
  // The runner is started here when it is not up: after a login, nobody has started it yet.
  if (args.session) void openChat(args.session);
  else void ensureRunner().then((up) => (up ? undefined : runnerDown()));
  watchDock();
}

/** False for a second copy (the running shell has been handed this command line) and for --quit with no shell running. */
function shouldRun(): boolean {
  if (args.selfTest) {
    // Its own user data, and no single-instance lock: it runs beside a running shell without touching it.
    app.setPath("userData", join(app.getPath("temp"), "intuition", "self-test-data"));
    return true;
  }
  return app.requestSingleInstanceLock() && !args.quit;
}

if (args.login) {
  // Before the single-instance lock: this works beside a running shell. The app id names the login item.
  const action = args.login;
  app.setAppUserModelId(APP_ID);
  void app.whenReady().then(() => loginCommand(action)).catch((e) => {
    console.error("--login failed", e);
    app.exit(1);
  });
} else if (!shouldRun()) {
  app.exit(0);
} else {
  // Windows notifications need an app id, and the login item is named after it.
  app.setAppUserModelId(APP_ID);
  // The shell stays in the tray when its windows close.
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => tray?.destroy());
  app.on("second-instance", (_event, argv) => {
    const second = parseArgs(argv);
    if (second.quit) app.quit();
    // `--login on|off` from the command line: the checkbox is drawn again.
    else if (second.login) tray?.setContextMenu(trayMenu());
    else void openChat(second.session);
  });
  void app.whenReady().then(start);
}
