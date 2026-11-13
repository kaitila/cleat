// The Windows shell: Electron's main process. It lives in the tray, opens the pop-up on the global
// hotkey with the clipboard captured, shows the runner's pages in small windows, and keeps the dock
// at the top of the screen.
// Written against Electron 45's electron.d.ts: the clipboard is clipboard.read / write / readText.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, ClipboardItem, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, Tray } from "electron";
import { parseArgs } from "./args";
import { type Capture, captureBody, isPng, saveClip } from "./clip";
import { acceptedState, DOCK_CHANNEL, DOCK_CHECK_MS, DOCK_MISSES, DOCK_PRELOAD, DOCK_WATCH_FAR_MS, type DockState, dockBounds, dockFocusable, islandRect, takesMouse, watchMs } from "./dock";
import { centred, iconBitmap } from "./geometry";
import { APP_ID, loginItem, type LoginResult } from "./login";
import { chatUrl, dockUrl, promptUrl, sameOrigin, windowTarget } from "./origin";
import type { SelfTestResult } from "./result";
import { loadSettings, saveDock, SETTINGS_FILE, type Settings } from "./settings";
import { RUNNER_START_MS, runnerCommand } from "./wsl";

const POPUP = { width: 560, height: 380 };
const CHAT = { width: 1100, height: 720 };
const ICON_SIZE = 32;
/** Unlikely to be anyone's shortcut, so the self-test never clashes with a running shell. */
const SELF_TEST_HOTKEY = "Control+Alt+Shift+F11";
/** Pages get no Node and their own sandboxed process. Only the dock adds a preload, for its one-function bridge. */
const WEB_PREFERENCES = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } as const;

const args = parseArgs(process.argv);
let settings: Settings;
let tray: Tray | null = null;
let popup: BrowserWindow | null = null;
let popupOpening = false;
let chat: BrowserWindow | null = null;
let dock: BrowserWindow | null = null;

type Clip = { kind: "image"; png: Buffer } | { kind: "text"; text: string } | { kind: "empty" };

function icon() {
  return nativeImage.createFromBitmap(iconBitmap(ICON_SIZE), { width: ICON_SIZE, height: ICON_SIZE });
}

/** The shell's own trouble only (the runner is not running, the hotkey is taken). Sessions show in the dock. */
function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, icon: icon() }).show();
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
      if (up && !args.selfTest) void showDock();
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

/** Only the tray's checkbox and `--login on|off` come here. */
function setStartOnLogin(on: boolean): void {
  app.setLoginItemSettings({ ...loginItem(process.execPath, app.getAppPath()), openAtLogin: on, name: APP_ID });
}

/** --login on|off|status: does it, writes the outcome, tells a running shell to redraw its menu, and quits. */
function loginCommand(action: "on" | "off" | "status"): void {
  let result: LoginResult;
  try {
    if (action !== "status") setStartOnLogin(action === "on");
    result = { openAtLogin: startsOnLogin(), error: null };
  } catch (e) {
    result = { openAtLogin: null, error: e instanceof Error ? e.message : String(e) };
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
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // A link to the runner's own chat view opens in the chat window, and the dock's link to /prompt opens
      // the pop-up, as the hotkey does. Nothing else opens. The self-test opens them without taking the focus.
      const target = windowTarget(url, settings.runnerUrl, dock !== null && !dock.isDestroyed() && contents === dock.webContents);
      if (target?.kind === "chat") void openChat(target.session, Boolean(args.selfTest));
      else if (target?.kind === "prompt") args.selfTest ? void openPopup(true) : newTask();
      return { action: "deny" };
    });
  });
  // Pages may copy to the clipboard; every other permission (camera, location, notifications...) is refused.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" && sameOrigin(contents.getURL(), settings.runnerUrl));
  });
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
    win.setBounds({ ...centred(area, POPUP.width, POPUP.height), ...POPUP });
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
    { label: "Open chat", click: () => void openChat() },
    { type: "separator" },
    { label: "Show dock", type: "checkbox", checked: settings.dock, click: (item) => setDock(item.checked) },
    {
      label: "Start on login",
      type: "checkbox",
      checked: onLogin,
      click: (item) => {
        try {
          setStartOnLogin(item.checked);
        } catch (e) {
          notify("intuition: start on login was not changed", e instanceof Error ? e.message : String(e));
        }
        // Drawn again from what Windows now says.
        tray?.setContextMenu(trayMenu());
      },
    },
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
    // Never activated: showing the dock takes nothing from what the person is doing.
    win.showInactive();
    watchDockMouseLoop();
  } catch (e) {
    console.error("loading the dock failed", e);
    hideDock();
  }
}

/** Loads the dock's page and shows it, unless the setting is off or it is already up. Calls at the same moment share one load. */
function showDock(): Promise<void> {
  if (!settings.dock || dockLoaded) return Promise.resolve();
  dockLoading ??= loadDock().finally(() => {
    dockLoading = null;
  });
  return dockLoading;
}

/** The tray's "Show dock": at once, and written to the settings file so the next start remembers. */
function setDock(on: boolean): void {
  settings = { ...settings, dock: on };
  try {
    saveDock(join(app.getPath("userData"), SETTINGS_FILE), on);
  } catch (e) {
    console.error("writing the dock setting failed", e);
  }
  if (on) void showDock();
  else closeDock();
  tray?.setContextMenu(trayMenu());
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
  if (!settings.dock) return;
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
    dockHiddenWithoutRunner: false, dockShownAgain: false, errors: [],
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
    const bounds = win.getBounds();
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
    await win.webContents.executeJavaScript(`window.open(${JSON.stringify(foreign)}); location.href = ${JSON.stringify(foreign)}; 0`, true);
    await sleep(700);
    r.foreignNavigationRefused = win.webContents.getURL() === r.popupUrl;
    r.foreignWindowRefused = BrowserWindow.getAllWindows().length === windows;

    const closed = new Promise<boolean>((resolve) => win.once("closed", () => resolve(true)));
    void win.webContents.executeJavaScript("window.close(); 0", true).catch(() => {});
    r.pageClosedPopup = await Promise.race([closed, sleep(3000).then(() => false)]);
    if (!win.isDestroyed()) win.destroy();
  });
  await step("dock off", async () => {
    // "dock": false in the settings: no window at all.
    settings = { ...settings, dock: false };
    try {
      await showDock();
      r.dockOffNoWindow = dock === null && BrowserWindow.getAllWindows().length === 0;
    } finally {
      settings = { ...settings, dock: true };
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
  return r;
}

// --- Start ---

function start(): void {
  settings = loadSettings(join(app.getPath("userData"), SETTINGS_FILE));
  if (args.runnerUrl) settings = { ...settings, runnerUrl: new URL(args.runnerUrl).origin };
  Menu.setApplicationMenu(null);
  guard();
  dockEvents();

  if (args.selfTest) {
    const file = args.selfTest;
    const done = (result: Partial<SelfTestResult>) => {
      writeFileSync(file, JSON.stringify(result, null, 2));
      app.exit(0);
    };
    setTimeout(() => done({ errors: ["the self-test did not finish in 40 seconds"] }), 40_000);
    void selfTest().then(done, (e) => done({ errors: [String(e)] }));
    return;
  }

  tray = createTray();
  if (!globalShortcut.register(settings.hotkey, newTask)) {
    notify("intuition: the hotkey is taken", `${settings.hotkey} could not be registered. Change "hotkey" in ${join(app.getPath("userData"), SETTINGS_FILE)} and start the shell again.`);
  }
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
  void app.whenReady().then(() => loginCommand(action));
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
