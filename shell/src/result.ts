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
  /** Toasts created by the first poll of /api/notifications (the stub runner had two older ones): 0. */
  toastsOnFirstPoll: number;
  /** Toasts created after the second poll, by which the stub runner had recorded one more: 1. */
  toastsCreated: number;
  toastTitle: string | null;
  toastBody: string | null;
  /** Windows answered show() with the toast's `show` event. Nobody saw it. */
  toastShown: boolean;
  /** What came instead of `show`: `failed: <error>`, or `nothing` within three seconds. */
  toastError: string | null;
  /** The chat window's URL after the toast's click handler ran. */
  toastOpenedUrl: string | null;
  /** The session "Open last session" opens. */
  lastSession: string | null;
  /** app.getLoginItemSettings answered. The self-test only reads start on login; it never sets it. */
  loginItemRead: boolean;
  /** What it answered: whether the shell starts on login on this machine. Reported, not judged. */
  openAtLogin: boolean | null;
  /** Anything that threw on the way. Empty on a clean run. */
  errors: string[];
}
