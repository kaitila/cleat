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
  /** Anything that threw on the way. Empty on a clean run. */
  errors: string[];
}
