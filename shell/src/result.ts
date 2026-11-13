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
  /**
   * The mouse. The self-test cannot move the real cursor: it gives the shell's cursor watching a made-up
   * position and reads what the shell last told the window (setIgnoreMouseEvents; Electron has no getter).
   * With the window created and no page loaded, the cursor where the island will be was ignored.
   */
  dockIgnoresMouseBeforeLoad: boolean;
  /** The dock's window as first shown: its one place and size, not focusable, not focused. */
  dockIdleBounds: Area | null;
  dockIdleFocusable: boolean | null;
  dockIdleFocused: boolean | null;
  /** Idle: the cursor on the pill's rectangle was taken; far away, and just below the pill inside the window, it was ignored. */
  dockMouseOnIdleIsland: boolean;
  dockMouseAwayIgnored: boolean;
  dockMouseBelowPillIgnored: boolean;
  /** After the page called setState("peek"): the same bounds, not focusable. */
  dockPeekBounds: Area | null;
  dockPeekFocusable: boolean | null;
  /** Peek: the cursor below the peek was ignored, and on it taken. */
  dockMouseOnPeekIsland: boolean;
  /** After the page called setState("open"): the same bounds, focusable. */
  dockOpenBounds: Area | null;
  dockOpenFocusable: boolean | null;
  /** Open: the point that was below the pill is on the island now and was taken; far away was ignored. */
  dockMouseOnOpenIsland: boolean;
  /** setState with a value that is not a state changed nothing: still open, still focusable. */
  dockOtherValueIgnored: boolean;
  /** After the page called setState("idle"): the same bounds, not focusable. */
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
  /** A page that loaded and never called setState: the cursor on the island was ignored. */
  dockIgnoresMouseUnreported: boolean;
  /** The page's process was crashed: the window hid, and the cursor where the open island was was ignored. */
  dockIgnoresMouseAfterCrash: boolean;
  /** With no runner answering, the dock stayed for one check and was hidden by the second. */
  dockHiddenWithoutRunner: boolean;
  /** The runner answering again, the next check loaded the page and showed the dock, idle. */
  dockShownAgain: boolean;
  /** The self-test's own snip hotkey registered as a global shortcut. */
  snipHotkeyRegistered: boolean;
  /** The displays the snip covered, in its order: bounds (DIPs) and scale. */
  snipDisplays: { bounds: Area; scaleFactor: number }[] | null;
  /** Each overlay's bounds once shown, in the same order. */
  snipOverlayBounds: Area[] | null;
  /** Every overlay was shown (without being activated) and is always on top. */
  snipOverlaysShown: boolean;
  /** The URL the first overlay loaded. */
  snipUrl: string | null;
  /** From the call to the last overlay shown, in ms. Printed; only a very slow one (SNIP_SLOW_MS in selftest-run.ts) fails. */
  snipMs: number | null;
  /** When each part of opening it was done, in ms from the call: captured, runner, loaded, drawn. Reported, not judged. */
  snipPhases: Record<string, number> | null;
  /** Every display's capture came back with pixels. False on a locked desktop. */
  snipCaptured: boolean | null;
  /** What the page sees of the bridge: `typeof intuitionSnip : its keys, sorted : typeof require : typeof process`. */
  snipBridge: string | null;
  /** The rectangle the page asked to crop, in the first display's DIPs, and the Windows path it was saved as. */
  snipCropRect: Area | null;
  snipCropPath: string | null;
  /** crop() with anything but a rectangle of finite numbers inside the display was refused, every time. */
  snipBadRectsRefused: boolean;
  /** The page's close() closed every overlay. */
  snipClosed: boolean;
  /** Esc, sent to the first overlay as a key, closed every overlay. */
  snipEscClosed: boolean;
  /** What the shell would have handed to the default browser (the self-test opens none). */
  externalLinks: string[];
  /** Anything that threw on the way. Empty on a clean run. */
  errors: string[];
}
