// The shell on macOS and Linux: what differs per OS (shell/src/os.ts), start on login's files
// (shell/src/login.ts), the settings' local runner, and the self-test judged on each layout.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dockBounds, islandRect } from "../../shell/src/dock";
import { autostartEntry, autostartFile, LAUNCH_AGENT, launchAgentFile, launchAgentPlist } from "../../shell/src/login";
import {
  defaultHotkeys, dockArea, dockTransparent, hasAppIndicator, isGnome, linuxNotices, linuxOzone, opaqueDockBounds, parseLocalRunner,
  runnerDownHint, runnerSpawn, SCREEN_RECORDING_PANE, screenAllowed, selfTestHotkeys, shellOs,
} from "../../shell/src/os";
import type { SelfTestResult } from "../../shell/src/result";
import { defaultSettings, parseSettings } from "../../shell/src/settings";
import { SELF_TEST_CROP } from "../../shell/src/snip";
import { autostartEntry as cliAutostartEntry, parseLocalRunner as cliParseLocalRunner } from "../../src/shell/platform";
import { REPO } from "../../src/shell/paths";
import { captureWithheld, expectedExternal, problems, savedPathPattern, skipped, STUB_SESSION } from "../../src/shell/selftest-run";

const runner = { kind: "local" as const, repo: "/home/a/intuition", bun: "/home/a/.bun/bin/bun" };
const wsl = { distro: "Ubuntu", repo: "/root/intuition", bun: "/root/.bun/bin/bun" };

describe("the OS", () => {
  test("from process.platform: win32, darwin, and everything else Linux", () => {
    expect([shellOs("win32"), shellOs("darwin"), shellOs("linux"), shellOs("freebsd")]).toEqual(["windows", "macos", "linux", "linux"]);
  });

  test("hotkeys: Command+Shift on a Mac, Control+Alt elsewhere; the self-test's never clash", () => {
    expect(defaultHotkeys("macos")).toEqual({ hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S" });
    for (const os of ["windows", "linux"] as const) expect(defaultHotkeys(os)).toEqual({ hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S" });
    for (const os of ["windows", "macos", "linux"] as const) {
      const mine = selfTestHotkeys(os);
      expect(Object.values(mine)).not.toContain(defaultHotkeys(os).hotkey);
      expect(mine.hotkey).not.toBe(mine.snipHotkey);
    }
    expect(selfTestHotkeys("windows")).toEqual({ hotkey: "Control+Alt+Shift+F11", snipHotkey: "Control+Alt+Shift+F10" });
  });

  test("the settings' defaults follow the OS, and a file's own hotkeys win", () => {
    expect(defaultSettings("macos").hotkey).toBe("Command+Shift+Space");
    expect(parseSettings("{}", defaultSettings("macos")).snipHotkey).toBe("Command+Shift+S");
    expect(parseSettings('{"hotkey":"Alt+F9"}', defaultSettings("macos")).hotkey).toBe("Alt+F9");
  });
});

describe("starting the runner", () => {
  test("the settings' runner: a whole local one, or nothing", () => {
    expect(parseSettings(JSON.stringify({ runner })).runner).toEqual(runner);
    for (const bad of [null, "x", {}, { ...runner, kind: "wsl" }, { ...runner, repo: "relative" }, { ...runner, bun: "--exec" }, { ...runner, repo: "/a\nb" }]) {
      expect(parseSettings(JSON.stringify({ runner: bad })).runner).toBeUndefined();
    }
    // The command line and the shell read it with the same function.
    expect(cliParseLocalRunner).toBe(parseLocalRunner);
  });

  test("Windows: wsl.exe as before, attached. macOS and Linux: bun on the repo's cli, detached, with the login shell's environment", () => {
    expect(runnerSpawn("windows", { wsl }, "C:\\Windows")).toEqual({
      file: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Ubuntu", "--exec", wsl.bun, "/root/intuition/src/cli.ts", "start", "--login-env"], detached: false,
    });
    for (const os of ["macos", "linux"] as const) {
      expect(runnerSpawn(os, { runner: { ...runner, repo: "/home/a/intuition/" } })).toEqual({ file: runner.bun, args: ["/home/a/intuition/src/cli.ts", "start", "--login-env"], detached: true });
    }
  });

  test("each OS reads only its own kind: nothing to start without it", () => {
    expect(runnerSpawn("windows", { runner })).toBeNull();
    expect(runnerSpawn("macos", { wsl })).toBeNull();
    expect(runnerSpawn("linux", {})).toBeNull();
  });

  test("the notice says where to start it", () => {
    expect(runnerDownHint("windows", false)).toBe("Start it in WSL: intuition up");
    expect(runnerDownHint("macos", false)).toBe("Start it in a terminal: intuition up");
    expect(runnerDownHint("linux", true)).toContain("In a terminal: intuition start, and intuition logs");
  });
});

describe("the dock per OS", () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  // A MacBook with a notch: the menu bar is 38 points tall.
  const workArea = { x: 0, y: 38, width: 1512, height: 944 };

  test("a Mac's dock hangs below the menu bar, centred on the display; elsewhere from the very top edge", () => {
    expect(dockArea("macos", bounds, workArea)).toEqual({ x: 0, y: 38, width: 1512, height: 944 });
    expect(dockBounds(dockArea("macos", bounds, workArea))).toEqual({ x: 526, y: 38, width: 460, height: 480 });
    // Centred on the display, not on a work area the Dock app narrowed from the side.
    expect(dockArea("macos", bounds, { ...workArea, x: 80, width: 1432 }).x).toBe(0);
    for (const os of ["windows", "linux"] as const) expect(dockArea(os, bounds, workArea)).toEqual(bounds);
  });

  test("transparent on Windows and macOS; on Linux under Wayland or a compositing desktop, else opaque; the variable decides when set", () => {
    expect(dockTransparent("windows", {})).toBe(true);
    expect(dockTransparent("macos", {})).toBe(true);
    expect(dockTransparent("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe(true);
    expect(dockTransparent("linux", { XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(dockTransparent("linux", { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
    expect(dockTransparent("linux", { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" })).toBe(true);
    expect(dockTransparent("linux", { DISPLAY: ":0" })).toBe(false);
    expect(dockTransparent("linux", { DISPLAY: ":0", XDG_CURRENT_DESKTOP: "i3" })).toBe(false);
    expect(dockTransparent("linux", { DISPLAY: ":0", INTUITION_DOCK_OPAQUE: "0" })).toBe(true);
    expect(dockTransparent("macos", { INTUITION_DOCK_OPAQUE: "1" })).toBe(false);
  });

  test("an opaque dock is the state's island at the top centre of the transparent window's place", () => {
    const place = dockBounds(bounds);
    expect(opaqueDockBounds(place, islandRect("idle"))).toEqual({ x: place.x + 166, y: 0, width: 128, height: 22 });
    expect(opaqueDockBounds(place, islandRect("peek"))).toEqual({ x: place.x + 40, y: 0, width: 380, height: 40 });
    expect(opaqueDockBounds(place, islandRect("open"))).toEqual(place);
  });
});

describe("Linux", () => {
  test("X11 whenever there is a DISPLAY (XWayland included); Wayland only without one", () => {
    expect(linuxOzone({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe("x11");
    expect(linuxOzone({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(linuxOzone({})).toBeNull();
  });

  test("GNOME without an AppIndicator extension is told how to get a tray icon; pure Wayland that the hotkeys may not register", () => {
    expect(isGnome({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(true);
    expect(isGnome({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
    expect(hasAppIndicator("ding@rastersoft.com\nubuntu-appindicators@ubuntu.com\n")).toBe(true);
    expect(hasAppIndicator("appindicatorsupport@rgcjonas.gmail.com")).toBe(true);
    expect(hasAppIndicator("ding@rastersoft.com\n")).toBe(false);
    const gnome = { XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" };
    expect(linuxNotices(gnome, "ding@rastersoft.com").map((n) => n.title)).toEqual(["intuition: GNOME shows no tray icon"]);
    expect(linuxNotices(gnome, "appindicatorsupport@rgcjonas.gmail.com")).toEqual([]);
    // gnome-extensions missing or failing: nothing is claimed about the tray.
    expect(linuxNotices(gnome, null)).toEqual([]);
    expect(linuxNotices({ WAYLAND_DISPLAY: "wayland-0" }, null).map((n) => n.title)).toEqual(["intuition: the hotkeys may not work under Wayland"]);
    expect(linuxNotices({ DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" }, null)).toEqual([]);
  });

  test("start on login: an XDG autostart file that runs Electron on the app folder; the command line writes the same one", () => {
    expect(autostartFile("/home/a", {})).toBe("/home/a/.config/autostart/intuition.desktop");
    expect(autostartFile("/home/a", { XDG_CONFIG_HOME: "/x" })).toBe("/x/autostart/intuition.desktop");
    const entry = autostartEntry("/home/a/.local/share/intuition/shell/node_modules/electron/dist/electron", ["--no-sandbox", "/home/a/my $dir/100%"]);
    expect(entry).toContain('Exec="/home/a/.local/share/intuition/shell/node_modules/electron/dist/electron" "--no-sandbox" "/home/a/my \\$dir/100%%"\n');
    expect(cliAutostartEntry).toBe(autostartEntry);
  });
});

describe("macOS", () => {
  test("start on login: a launch agent that runs Electron on the app folder, since a login item would open Electron.app without it", () => {
    expect(launchAgentFile("/Users/a")).toBe(`/Users/a/Library/LaunchAgents/${LAUNCH_AGENT}.plist`);
    const plist = launchAgentPlist("/Users/a/Library/Application Support/intuition/shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", ["/Users/a/Library/Application Support/intuition/shell", "<&>"]);
    expect(plist).toContain(`<key>Label</key><string>${LAUNCH_AGENT}</string>`);
    expect(plist).toContain("    <string>/Users/a/Library/Application Support/intuition/shell</string>\n");
    expect(plist).toContain("    <string>&lt;&amp;&gt;</string>\n");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });

  test("the snip needs Screen Recording on a Mac only, and the notice opens its System Settings pane", () => {
    expect(screenAllowed("macos", "granted")).toBe(true);
    for (const status of ["denied", "not-determined", "restricted", "unknown"]) expect(screenAllowed("macos", status)).toBe(false);
    expect(screenAllowed("windows", "denied")).toBe(true);
    expect(SCREEN_RECORDING_PANE).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });

  test("main.ts: hidden from the Dock, a template tray icon, on every Space, and the notice's click opens the pane", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main).toContain('if (OS === "macos") app.dock?.hide();');
    expect(main).toContain("image.setTemplateImage(true);");
    expect(main).toContain("const t = new Tray(trayIcon());");
    expect(main).toContain('win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })');
    expect(main).toContain('systemPreferences.getMediaAccessStatus("screen")');
    // On Linux the ozone switch is set before ready, with a DISPLAY only.
    expect(main).toContain('if (OS === "linux" && linuxOzone() === "x11" && !app.commandLine.hasSwitch("ozone-platform")) app.commandLine.appendSwitch("ozone-platform", "x11");');
  });
});

describe("the self-test on each layout", () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const workArea = { x: 0, y: 38, width: 1512, height: 944 };
  const url = "http://127.0.0.1:5000";
  const clipPath = "/var/folders/xy/T/intuition/clip-20261115-090507-042.png";
  const snipPath = "/var/folders/xy/T/intuition/snip-20261115-090508-000.png";
  const place = dockBounds(dockArea("macos", display, workArea));
  const mac: SelfTestResult = {
    hotkeyRegistered: true, trayCreated: true, textCaptured: true, textPosted: true, imageCaptured: true, imagePosted: true, imagePath: clipPath,
    notificationsSupported: true, popupCreated: true, popupWidth: 560, popupHeight: 380, popupUrl: `${url}/prompt`,
    popupVisible: true, popupCentred: true, foreignNavigationRefused: true, foreignWindowRefused: true, pageClosedPopup: true,
    noWindowWithoutRunner: true, clipboardRestored: true, loginItemRead: true, openAtLogin: false,
    dockOffNoWindow: true, dockCreated: true, dockUrl: `${url}/dock`, dockVisible: true, dockBridge: "object:setState:undefined:undefined",
    primaryDisplay: display, dockIgnoresMouseBeforeLoad: true, dockIdleBounds: place, dockIdleFocusable: false, dockIdleFocused: false,
    dockMouseOnIdleIsland: true, dockMouseAwayIgnored: true, dockMouseBelowPillIgnored: true,
    dockPeekBounds: place, dockPeekFocusable: false, dockMouseOnPeekIsland: true,
    dockOpenBounds: place, dockOpenFocusable: true, dockMouseOnOpenIsland: true, dockOtherValueIgnored: true,
    dockBackBounds: place, dockBackFocusable: false, dockForeignOriginIgnored: true,
    dockIgnoresMouseUnreported: true, dockIgnoresMouseAfterCrash: true,
    dockOpenedChatUrl: `${url}/?session=${STUB_SESSION}`, dockOpenedPromptUrl: `${url}/prompt`,
    dockOtherWindowRefused: true, dockHiddenWithoutRunner: true, dockShownAgain: true,
    snipHotkeyRegistered: true, snipDisplays: [{ bounds: display, scaleFactor: 1 }], snipOverlayBounds: [display], snipOverlaysShown: true,
    snipUrl: `${url}/assets/snip.html`, snipMs: 240, snipPhases: { warm: 1, captured: 150, drawn: 230 }, snipCaptured: true,
    snipBridge: "object:close,crop,getCapture:undefined:undefined", snipCropRect: SELF_TEST_CROP, snipCropPath: snipPath, snipBadRectsRefused: true,
    snipClosed: true, snipEscClosed: true, externalLinks: expectedExternal(url), errors: [],
    os: "macos", dockTransparent: true, primaryWorkArea: workArea, screenAccess: "granted",
  };
  const posts = [{ text: "intuition self-test 1" }, { imagePath: clipPath }];
  // SELF_TEST_CROP at 1x: 10.5..111.5 x 20.25..69.75 is 10..112 x 20..70.
  const header = (width: number, height: number) => {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  };
  const check = (r: Partial<SelfTestResult>, where: Parameters<typeof problems>[4] = { layout: "macos" }) => problems(r, { posts }, url, () => header(102, 50), where);

  test("native paths are <temp>/intuition/<kind>-<time>.png; Windows ones as before", () => {
    expect(savedPathPattern("macos", "clip").test(clipPath)).toBe(true);
    expect(savedPathPattern("linux", "snip").test("/tmp/intuition/snip-20261115-090508-000.png")).toBe(true);
    expect(savedPathPattern("linux", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png")).toBe(false);
    expect(savedPathPattern("windows-wsl", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png")).toBe(true);
    expect(savedPathPattern("windows-wsl", "clip").test(clipPath)).toBe(false);
  });

  test("a clean Mac result has no problems, and the dock is judged below the menu bar", () => {
    expect(check(mac)).toEqual([]);
    const top = dockBounds(display);
    expect(check({ ...mac, dockIdleBounds: top, dockPeekBounds: top, dockOpenBounds: top, dockBackBounds: top })).toHaveLength(4);
  });

  test("the shell must have run on the layout's OS, with Windows paths only on Windows", () => {
    expect(check({ ...mac, os: "windows" })).toEqual(["the shell ran on windows, not macos"]);
    expect(check(mac, { layout: "linux" }).length).toBeGreaterThan(0);
  });

  test("macOS without Screen Recording: the capture, crop and time are skipped and named, not failed", () => {
    const denied = { ...mac, screenAccess: "denied", snipCaptured: false, snipCropPath: null, snipMs: 3100 };
    expect(check(denied)).toEqual([]);
    expect(skipped(denied, { layout: "macos" })).toEqual([expect.stringContaining("macOS has not given Screen Recording (denied)")]);
    // Granted but empty is a failure, and so is an empty capture on another layout.
    expect(check({ ...denied, screenAccess: "granted" }).length).toBeGreaterThan(0);
    expect(captureWithheld({ ...denied, os: "linux" }, { layout: "linux" })).toBeNull();
    expect(skipped(mac, { layout: "macos" })).toEqual([]);
  });

  test("WSLg: an empty capture is skipped and named; a pixel short on the overlay is taken on Linux only", () => {
    const linuxPlace = dockBounds(display);
    const linux = { ...mac, os: "linux" as const, primaryWorkArea: display, dockIdleBounds: linuxPlace, dockPeekBounds: linuxPlace, dockOpenBounds: linuxPlace, dockBackBounds: linuxPlace,
      snipCaptured: false, snipCropPath: null, snipMs: 3013, snipOverlayBounds: [{ ...display, width: 1511, height: 981 }] };
    expect(check(linux, { layout: "linux", wslg: true })).toEqual([]);
    expect(skipped(linux, { layout: "linux", wslg: true })).toEqual([expect.stringContaining("WSLg gives Electron no pixels")]);
    expect(check(linux, { layout: "linux" }).length).toBeGreaterThan(0);
    expect(check({ ...linux, snipOverlayBounds: [{ ...display, width: 1510 }] }, { layout: "linux", wslg: true }).length).toBe(1);
  });

  test("an opaque dock is judged as the island of each state", () => {
    const linuxPlace = dockBounds(display);
    const island = (s: "idle" | "peek" | "open") => opaqueDockBounds(linuxPlace, islandRect(s));
    const opaque = { ...mac, os: "linux" as const, primaryWorkArea: display, dockTransparent: false,
      dockIdleBounds: island("idle"), dockPeekBounds: island("peek"), dockOpenBounds: island("open"), dockBackBounds: island("idle") };
    expect(check(opaque, { layout: "linux" })).toEqual([]);
    expect(check({ ...opaque, dockTransparent: true }, { layout: "linux" })).toHaveLength(3);
  });
});
