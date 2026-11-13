import type { Area } from "./geometry";

// What the self-test writes. Shared with src/shell/selftest-run.ts, which asserts every field.
export interface SelfTestResult {
  /** The self-test's own hotkey registered as a global shortcut. */
  hotkeyRegistered: boolean;
  trayCreated: boolean;
  /** A text put on the clipboard was captured unchanged, and POST /api/clipboard answered 2xx. */
  textCaptured: boolean;
  textPosted: boolean;
  /** An image put on the clipboard was captured and saved as a PNG, and its path was posted. */
  imageCaptured: boolean;
  imagePosted: boolean;
  /** Windows path of the saved PNG. */
  imagePath: string | null;
  notificationsSupported: boolean;
  popupCreated: boolean;
  popupWidth: number;
  popupHeight: number;
  /** The URL the pop-up had loaded. */
  popupUrl: string | null;
  popupVisible: boolean;
  /** The pop-up's middle is the middle of the work area of the display under the cursor. */
  popupCentred: boolean;
  /** The page tried to navigate to another origin and to open a window on one; both were refused. */
  foreignNavigationRefused: boolean;
  foreignWindowRefused: boolean;
  /** window.close() from the page closed the pop-up. */
  pageClosedPopup: boolean;
  /** With no runner answering /health, no pop-up was opened. */
  noWindowWithoutRunner: boolean;
  clipboardRestored: boolean;
  /** app.getLoginItemSettings answered. The self-test only reads start on login; it never sets it. */
  loginItemRead: boolean;
  /** What it answered: whether the shell starts on login on this machine. Reported, not judged. */
  openAtLogin: boolean | null;
  /** With "dock": false in the settings, no dock window was created. */
  dockOffNoWindow: boolean;
  dockCreated: boolean;
  /** The URL the dock had loaded. */
  dockUrl: string | null;
  /** Shown (without being activated). Nobody saw it. */
  dockVisible: boolean;
  /** What the page sees of the bridge: `typeof intuitionDock : its keys : typeof require : typeof process`. */
  dockBridge: string | null;
  /** The primary display's bounds, which the dock's are checked against. */
  primaryDisplay: Area | null;
  /** The dock's window as first shown: the idle bounds, not focusable, not focused. */
  dockIdleBounds: Area | null;
  dockIdleFocusable: boolean | null;
  dockIdleFocused: boolean | null;
  /** After the page called setState("open"). */
  dockOpenBounds: Area | null;
  dockOpenFocusable: boolean | null;
  /** setState with a value that is not a state changed nothing: still open, still focusable. */
  dockOtherValueIgnored: boolean;
  /** After the page called setState("idle"). */
  dockBackBounds: Area | null;
  dockBackFocusable: boolean | null;
  /** setState from a page whose origin is not the runner's changed nothing. */
  dockForeignOriginIgnored: boolean;
  /** The chat window's URL after the dock's page opened /?session=<id> in a new window. */
  dockOpenedChatUrl: string | null;
  /** The pop-up's URL after the dock's page opened /prompt in a new window. */
  dockOpenedPromptUrl: string | null;
  /** New windows from the dock to another of the runner's paths and to another origin opened nothing. */
  dockOtherWindowRefused: boolean;
  /** With no runner answering, the dock stayed for one check and was hidden by the second. */
  dockHiddenWithoutRunner: boolean;
  /** The runner answering again, the next check loaded the page and showed the dock, idle. */
  dockShownAgain: boolean;
  /** Anything that threw on the way. Empty on a clean run. */
  errors: string[];
}
