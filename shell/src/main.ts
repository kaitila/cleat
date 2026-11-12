// The Windows shell: Electron's main process. It lives in the tray, opens the pop-up on the global
// hotkey with the clipboard captured, and shows the runner's pages in small windows.
// Written against Electron 45's electron.d.ts: the clipboard is clipboard.read / write / readText.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, ClipboardItem, globalShortcut, Menu, nativeImage, Notification, screen, session, Tray } from "electron";
import { parseArgs } from "./args";
import { type Capture, captureBody, isPng, saveClip } from "./clip";
import { centred, iconBitmap } from "./geometry";
import { APP_ID, loginItem, type LoginResult } from "./login";
import type { Notification as RunnerNotification } from "../../src/shared/protocol";
import { chatUrl, promptUrl, sameOrigin, sessionOf } from "./origin";
import { parseResponse, POLL_MS, POLL_TIMEOUT_MS, pollUrl, START, step, toastOf } from "./poller";
import type { SelfTestResult } from "./result";
import { loadSettings, SETTINGS_FILE, type Settings } from "./settings";
import { RUNNER_START_MS, runnerCommand } from "./wsl";

const POPUP = { width: 560, height: 380 };
const CHAT = { width: 1100, height: 720 };
const ICON_SIZE = 32;
/** Unlikely to be anyone's shortcut, so the self-test never clashes with a running shell. */
const SELF_TEST_HOTKEY = "Control+Alt+Shift+F11";
/** Pages get no Node, no preload, and their own sandboxed process. */
const WEB_PREFERENCES = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } as const;

const args = parseArgs(process.argv);
let settings: Settings;
let tray: Tray | null = null;
let popup: BrowserWindow | null = null;
let popupOpening = false;
let chat: BrowserWindow | null = null;

type Clip = { kind: "image"; png: Buffer } | { kind: "text"; text: string } | { kind: "empty" };

function icon() {
  return nativeImage.createFromBitmap(iconBitmap(ICON_SIZE), { width: ICON_SIZE, height: ICON_SIZE });
}

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
  })().finally(() => {
    starting = null;
  });
  return starting;
}

function runnerDown(): void {
  // The self-test checks that no window opens; it does not put a toast on the person's screen.
  if (args.selfTest) return;
  const how = settings.wsl
    ? "The shell tried to start it in WSL and it did not come up. In WSL: bun src/cli.ts start, and bun src/cli.ts logs"
    : "Start it in WSL: bun src/cli.ts up";
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

/** Every page stays on the runner's origin: other navigations and all new windows are refused. */
function guard(): void {
  app.on("web-contents-created", (_event, contents) => {
    const stay = (event: { preventDefault(): void; url: string }) => {
      if (!sameOrigin(event.url, settings.runnerUrl)) event.preventDefault();
    };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // A link to the runner's own chat view opens in the chat window; nothing else opens.
      if (sameOrigin(url, settings.runnerUrl) && new URL(url).pathname === "/") void openChat(sessionOf(url));
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

/** The tray's menu. "Open last session" is greyed out until a session has notified. */
function trayMenu(): Menu {
  const last = pollState.lastSession;
  let onLogin = false;
  try {
    onLogin = startsOnLogin();
  } catch (e) {
    console.error("reading start on login failed", e);
  }
  return Menu.buildFromTemplate([
    { label: "New task", click: newTask },
    { label: "Open chat", click: () => void openChat() },
    { label: "Open last session", enabled: last !== null, click: () => void openChat(last ?? undefined) },
    { type: "separator" },
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

// --- Toasts ---

let pollState = START;
/** The newest toasts. Kept so their click handlers outlive the garbage collector. */
const toasts: Notification[] = [];
const KEEP_TOASTS = 20;
/** How many session toasts were created: the self-test counts them, since nobody can see one from WSL. */
let toastsCreated = 0;

/** Shows one of the runner's notifications as a toast. A click opens the chat on its session. */
function toast(n: RunnerNotification): Notification {
  const t = new Notification({ ...toastOf(n), icon: icon() });
  toastsCreated++;
  t.on("click", () => void openChat(n.sessionId, Boolean(args.selfTest)));
  t.on("failed", (_event, error) => console.error("showing a toast failed", error));
  toasts.push(t);
  if (toasts.length > KEEP_TOASTS) toasts.shift();
  t.show();
  return t;
}

/** One poll of the runner's notifications. A failed one is silent: the next asks for the same again. */
async function pollOnce(): Promise<Notification[]> {
  let response = null;
  try {
    const res = await fetch(pollUrl(settings.runnerUrl, pollState), { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (res.ok) response = parseResponse(await res.json());
  } catch {
    // The runner is down or slow.
  }
  const next = step(pollState, response);
  const changed = next.state.lastSession !== pollState.lastSession;
  pollState = next.state;
  if (changed) tray?.setContextMenu(trayMenu());
  if (!Notification.isSupported()) return [];
  return next.show.map(toast);
}

/** Polls every two seconds, each poll starting after the one before has ended. */
function startPolling(): void {
  const tick = () => void pollOnce().catch((e) => console.error("polling failed", e)).finally(() => setTimeout(tick, POLL_MS));
  tick();
}

// --- Self-test ---

async function selfTest(): Promise<SelfTestResult> {
  const r: SelfTestResult = {
    hotkeyRegistered: false, trayCreated: false, textCaptured: false, textPosted: false, imageCaptured: false, imagePosted: false,
    imagePath: null, notificationsSupported: false, popupCreated: false, popupWidth: 0, popupHeight: 0, popupUrl: null,
    popupVisible: false, popupCentred: false, foreignNavigationRefused: false, foreignWindowRefused: false, pageClosedPopup: false,
    noWindowWithoutRunner: false, clipboardRestored: false, toastsOnFirstPoll: -1, toastsCreated: -1, toastTitle: null, toastBody: null,
    toastShown: false, toastError: null, toastOpenedUrl: null, lastSession: null, loginItemRead: false, openAtLogin: null, errors: [],
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
  });
  await step("image", async () => {
    await writeClipboard({ kind: "image", png: icon().toPNG() });
    const { capture, posted } = await captureClipboard();
    r.imageCaptured = capture.kind === "image";
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
  await step("toasts", async () => {
    // The stub runner has two notifications from before this first poll, and records one more after it.
    await pollOnce();
    r.toastsOnFirstPoll = toastsCreated;
    const shown = await pollOnce();
    r.toastsCreated = toastsCreated;
    r.lastSession = pollState.lastSession;
    const t = shown[0];
    if (!t) throw new Error("the second poll showed no toast");
    r.toastTitle = t.title;
    r.toastBody = t.body;
    // Windows answers show() with one of the two events; neither says the person saw it.
    const outcome = await Promise.race([
      new Promise<string>((resolve) => t.once("show", () => resolve("show"))),
      new Promise<string>((resolve) => t.once("failed", (_event, error) => resolve(`failed: ${error}`))),
      sleep(3000).then(() => "nothing"),
    ]);
    r.toastShown = outcome === "show";
    r.toastError = outcome === "show" ? null : outcome;
    // Nobody can click it from WSL: the click is sent to the toast's own handler.
    t.emit("click");
    for (let i = 0; i < 40 && !chat?.isVisible(); i++) await sleep(100);
    r.toastOpenedUrl = chat?.webContents.getURL() ?? null;
    chat?.destroy();
    t.close();
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
  startPolling();
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
  // Windows toasts need an app id, and the login item is named after it.
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
