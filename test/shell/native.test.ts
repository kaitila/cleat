// The shell on macOS and Linux: what differs per OS (shell/src/os.ts), start on login's files
// (shell/src/login.ts) and the settings' local runner. The self-test on each layout is in shell.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatSize, DOCK_SIZES, dockBounds as placeFor, dockSizes as sizesFor, islandRect as rectFor, movesDock, NOTCH_WING, type Notch, takesMouse as mouseFor } from "../../shell/src/dock";
import type { Area } from "../../shell/src/geometry";

// The placement below is checked with a chat no larger than the open dock, so the window is the open
// dock's 460x480, as it was before the chat (D0042); each test checks the chat's own size once too.
const SMALL = DOCK_SIZES.open;
const dockBounds = (area: Area) => placeFor(area, SMALL);
const dockSizes = (notch: Pick<Notch, "width" | "height"> | null) => sizesFor(notch, SMALL);
const islandRect = (state: Parameters<typeof rectFor>[0], notch: Notch | null = null) => rectFor(state, notch, SMALL);
const takesMouse = (win: Area, state: Parameters<typeof mouseFor>[1], cursor: { x: number; y: number }, notch: Notch | null = null) => mouseFor(win, state, cursor, notch, SMALL);
import { autostartEntry, autostartFile, LAUNCH_AGENT, launchAgentFile, launchAgentPlist } from "../../shell/src/login";
import {
  ACRYLIC_BUILD, CLEAR, defaultHotkeys, dockArea, dockNotchOf, NOTCH_PROBE, STAND_IN_NOTCH_HEIGHT, STAND_IN_NOTCH_WIDTH, parseNotch, materialOptions, windowMaterial, windowsBuild, dockTransparent, hasAppIndicator, isGnome, linuxNotices, linuxOzone, opaqueDockBounds, parseLocalRunner,
  runnerDownHint, runnerSpawn, SCREEN_RECORDING_PANE, screenAllowed, shellOs,
} from "../../shell/src/os";
import { SHELL_DEFAULTS } from "../../shell/src/prefs";
import { parseSettings } from "../../shell/src/settings";
import { autostartEntry as cliAutostartEntry, parseLocalRunner as cliParseLocalRunner } from "../../src/shell/platform";
import { REPO } from "../../src/shell/paths";
import { savedPathPattern } from "../../src/shell/selftest-run";

const runner = { kind: "local" as const, repo: "/home/a/holm", bun: "/home/a/.bun/bin/bun" };
const wsl = { distro: "Ubuntu", repo: "/home/you/holm", bun: "/home/you/.bun/bin/bun" };

describe("the OS", () => {
  test("from process.platform: win32, darwin, and everything else Linux", () => {
    expect([shellOs("win32"), shellOs("darwin"), shellOs("linux"), shellOs("freebsd")]).toEqual(["windows", "macos", "linux", "linux"]);
  });

  test("hotkeys: Command+Shift on a Mac, Control+Alt elsewhere", () => {
    expect(defaultHotkeys("macos")).toEqual({ hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S", chatHotkey: "Command+Shift+J" });
    for (const os of ["windows", "linux"] as const) expect(defaultHotkeys(os)).toEqual({ hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", chatHotkey: "Control+Alt+J" });
  });

  test("savedPathPattern: native paths are <temp>/holm/<kind>-<time>.png; Windows ones as before", () => {
    const clipPath = "/var/folders/xy/T/holm/clip-20261115-090507-042.png";
    expect(savedPathPattern("macos", "clip").test(clipPath)).toBe(true);
    expect(savedPathPattern("linux", "snip").test("/tmp/holm/snip-20261115-090508-000.png")).toBe(true);
    expect(savedPathPattern("linux", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\holm\\clip-1.png")).toBe(false);
    expect(savedPathPattern("windows-wsl", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\holm\\clip-1.png")).toBe(true);
    expect(savedPathPattern("windows-wsl", "clip").test(clipPath)).toBe(false);
  });

  test("the shell's defaults, which it sends the runner once, follow the OS it runs on", () => {
    expect(SHELL_DEFAULTS).toEqual({ ...defaultHotkeys(shellOs()), dock: true });
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
      file: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Ubuntu", "--exec", wsl.bun, "/home/you/holm/src/cli.ts", "start", "--login-env"], detached: false,
    });
    for (const os of ["macos", "linux"] as const) {
      expect(runnerSpawn(os, { runner: { ...runner, repo: "/home/a/holm/" } })).toEqual({ file: runner.bun, args: ["/home/a/holm/src/cli.ts", "start", "--login-env"], detached: true });
    }
  });

  test("each OS reads only its own kind: nothing to start without it", () => {
    expect(runnerSpawn("windows", { runner })).toBeNull();
    expect(runnerSpawn("macos", { wsl })).toBeNull();
    expect(runnerSpawn("linux", {})).toBeNull();
  });

  test("the notice says where to start it", () => {
    expect(runnerDownHint("windows", false)).toBe("Start it in WSL: holm up");
    expect(runnerDownHint("macos", false)).toBe("Start it in a terminal: holm up");
    expect(runnerDownHint("linux", true)).toContain("In a terminal: holm start, and holm logs");
  });
});

describe("the dock per OS", () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  // A MacBook with a notch: the menu bar is 38 points tall.
  const workArea = { x: 0, y: 38, width: 1512, height: 944 };

  test("a Mac's dock hangs below the menu bar, centred on the display; elsewhere from the very top edge", () => {
    expect(dockArea("macos", bounds, workArea)).toEqual({ x: 0, y: 38, width: 1512, height: 944 });
    expect(dockBounds(dockArea("macos", bounds, workArea))).toEqual({ x: 526, y: 38, width: 460, height: 480 });
    // With the chat the area gives (D0042): 936x716 below the menu bar, centred the same.
    expect(placeFor(dockArea("macos", bounds, workArea), chatSize(dockArea("macos", bounds, workArea)))).toEqual({ x: 288, y: 38, width: 936, height: 716 });
    // Centred on the display, not on a work area the Dock app narrowed from the side.
    expect(dockArea("macos", bounds, { ...workArea, x: 80, width: 1432 }).x).toBe(0);
    for (const os of ["windows", "linux"] as const) expect(dockArea(os, bounds, workArea)).toEqual(bounds);
  });

  test("with a notch, a Mac's dock hangs from the very top, centred on the notch", () => {
    const notch = { x: 666.5, width: 179, height: 38 };
    expect(dockArea("macos", bounds, workArea, notch)).toEqual({ x: 0, y: 0, width: 1512, height: 982 });
    expect(dockBounds(dockArea("macos", bounds, workArea, notch))).toEqual({ x: 526, y: 0, width: 460, height: 480 });
    // A notch off the middle (and a display to the right of another): the window is centred on the notch.
    expect(dockBounds(dockArea("macos", { ...bounds, x: 1920 }, { ...workArea, x: 1920 }, { ...notch, x: 700 })).x).toBe(Math.round(1920 + 700 + 179 / 2 - 460 / 2));
    // Only a Mac has one.
    expect(dockArea("windows", bounds, workArea, notch)).toEqual(bounds);
  });

  test("a Mac display without a notch gets a fixed stand-in at its top centre (D0037)", () => {
    const measured = { x: 666.5, width: 179, height: 38 };
    // The display's own notch is kept.
    expect(dockNotchOf(measured, bounds)).toEqual(measured);
    // An external screen as the primary: 1920 wide.
    const hp = { x: 0, y: 0, width: 1920, height: 1200 };
    const standIn = dockNotchOf(null, hp);
    expect(standIn).toEqual({ x: (1920 - STAND_IN_NOTCH_WIDTH) / 2, width: STAND_IN_NOTCH_WIDTH, height: STAND_IN_NOTCH_HEIGHT });
    // The dock then hangs from the very top, centred on the display, whatever its menu bar does.
    for (const top of [30, 0]) expect(dockBounds(dockArea("macos", hp, { ...hp, y: top, height: 1200 - top }, standIn))).toEqual({ x: 730, y: 0, width: 460, height: 480 });
    // A display left of another (negative x) is centred on itself too.
    expect(dockBounds(dockArea("macos", { ...hp, x: -1920 }, workArea, dockNotchOf(null, { ...hp, x: -1920 }))).x).toBe(-1920 + 730);
    // A sensible notch for the page too: dockUrl's ?notch=WxH passes its parseNotch.
    expect(standIn.width).toBeGreaterThanOrEqual(40);
    expect(standIn.width).toBeLessThanOrEqual(400);
    expect(standIn.height).toBeGreaterThanOrEqual(16);
  });

  test("only a change of a display's bounds, scale or rotation moves the dock, not its work area alone", () => {
    // A full-screen app or a menu bar that hides itself: the work area alone. Nothing to do.
    expect(movesDock(["workArea"])).toBe(false);
    expect(movesDock([])).toBe(false);
    for (const changed of [["bounds"], ["scaleFactor"], ["rotation"], ["bounds", "workArea"]]) expect(movesDock(changed)).toBe(true);
  });

  test("the notch is measured by osascript with an argument array, and read only when it is a sensible notch on this display", () => {
    expect(NOTCH_PROBE.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(NOTCH_PROBE[3]).toContain("auxiliaryTopLeftArea");
    // A 14-inch MacBook Pro, at its default scale.
    expect(parseNotch('{"width":1512,"left":666.5,"right":666.5,"top":38}\n', bounds)).toEqual({ x: 666.5, width: 179, height: 38 });
    // No notch: the areas are empty.
    expect(parseNotch('{"width":1512,"left":0,"right":0,"top":0}', bounds)).toBeNull();
    // Another display than the primary Electron sees.
    expect(parseNotch('{"width":1470,"left":645.5,"right":645.5,"top":32}', bounds)).toBeNull();
    // Nonsense.
    for (const bad of ["", "nope", "null", "[]", '{"width":1512}', '{"width":1512,"left":10,"right":10,"top":38}', '{"width":1512,"left":666,"right":666,"top":300}']) expect(parseNotch(bad, bounds)).toBeNull();
  });

  test("out of a notch, idle is the notch and its wings, peek its line below the notch, and the mouse is taken on the notch alone in idle", () => {
    const notch = { x: 666.5, width: 179, height: 38 };
    expect(sizesFor(null)).toEqual(DOCK_SIZES);
    expect(sizesFor(notch)).toEqual({ idle: { width: 179 + 2 * NOTCH_WING, height: 38 }, peek: { width: 380, height: 78 }, open: DOCK_SIZES.open, chat: DOCK_SIZES.chat });
    expect(dockSizes(notch).chat).toEqual(SMALL);
    // Grown into the chat out of the notch: the chat's whole rectangle takes the mouse, far below the open dock's.
    const chat = chatSize(dockArea("macos", bounds, workArea, notch));
    const big = placeFor(dockArea("macos", bounds, workArea, notch), chat);
    expect(mouseFor(big, "chat", { x: big.x + 10, y: chat.height - 10 }, notch, chat)).toBe(true);
    expect(mouseFor(big, "open", { x: big.x + 10, y: chat.height - 10 }, notch, chat)).toBe(false);
    expect(islandRect("idle", notch)).toEqual({ x: (460 - 179) / 2, y: 0, width: 179, height: 38 });
    expect(islandRect("peek", notch)).toEqual({ x: 40, y: 0, width: 380, height: 78 });
    const win = dockBounds(dockArea("macos", bounds, workArea, notch));
    // On the notch: taken. On a wing, over the menu bar: let through to the menu.
    expect(takesMouse(win, "idle", { x: 756, y: 10 }, notch)).toBe(true);
    expect(takesMouse(win, "idle", { x: 666 - NOTCH_WING / 2, y: 10 }, notch)).toBe(false);
    expect(takesMouse(win, "peek", { x: 756, y: 60 }, notch)).toBe(true);
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
    expect(dockTransparent("linux", { DISPLAY: ":0", HOLM_DOCK_OPAQUE: "0" })).toBe(true);
    expect(dockTransparent("macos", { HOLM_DOCK_OPAQUE: "1" })).toBe(false);
  });

  test("an opaque dock is the state's island at the top centre of the transparent window's place", () => {
    const place = dockBounds(bounds);
    // Grown into the chat, an opaque dock is the chat's whole rectangle, the transparent window's place.
    const chat = chatSize(bounds);
    expect(opaqueDockBounds(placeFor(bounds, chat), rectFor("chat", null, chat))).toEqual(placeFor(bounds, chat));
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
    expect(linuxNotices(gnome, "ding@rastersoft.com").map((n) => n.title)).toEqual(["Holm: GNOME shows no tray icon"]);
    expect(linuxNotices(gnome, "appindicatorsupport@rgcjonas.gmail.com")).toEqual([]);
    // gnome-extensions missing or failing: nothing is claimed about the tray.
    expect(linuxNotices(gnome, null)).toEqual([]);
    expect(linuxNotices({ WAYLAND_DISPLAY: "wayland-0" }, null).map((n) => n.title)).toEqual(["Holm: the hotkeys may not work under Wayland"]);
    expect(linuxNotices({ DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" }, null)).toEqual([]);
  });

  test("start on login: an XDG autostart file that runs Electron on the app folder; the command line writes the same one", () => {
    expect(autostartFile("/home/a", {})).toBe("/home/a/.config/autostart/holm.desktop");
    expect(autostartFile("/home/a", { XDG_CONFIG_HOME: "/x" })).toBe("/x/autostart/holm.desktop");
    const entry = autostartEntry("/home/a/.local/share/holm/shell/node_modules/electron/dist/electron", ["--no-sandbox", "/home/a/my $dir/100%"]);
    expect(entry).toContain('Exec="/home/a/.local/share/holm/shell/node_modules/electron/dist/electron" "--no-sandbox" "/home/a/my \\$dir/100%%"\n');
    expect(cliAutostartEntry).toBe(autostartEntry);
  });
});

describe("macOS", () => {
  test("start on login: a launch agent that runs Electron on the app folder, since a login item would open Electron.app without it", () => {
    expect(launchAgentFile("/Users/a")).toBe(`/Users/a/Library/LaunchAgents/${LAUNCH_AGENT}.plist`);
    const plist = launchAgentPlist("/Users/a/Library/Application Support/holm/shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", ["/Users/a/Library/Application Support/holm/shell", "<&>"]);
    expect(plist).toContain(`<key>Label</key><string>${LAUNCH_AGENT}</string>`);
    expect(plist).toContain("    <string>/Users/a/Library/Application Support/holm/shell</string>\n");
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

describe("the OS's frosted material", () => {
  test("Windows' build is read from os.release()", () => {
    expect(windowsBuild("10.0.22631")).toBe(22631);
    expect(windowsBuild("10.0.19045")).toBe(19045);
    expect(windowsBuild("6.1.7601 ")).toBe(7601);
    expect(windowsBuild("")).toBeNull();
    expect(windowsBuild("Windows")).toBeNull();
  });

  test("the pop-up: acrylic on Windows 11 22H2 and later, vibrancy on macOS, none on older Windows and Linux", () => {
    expect(windowMaterial("popup", "windows", "10.0.22631", true)).toBe("acrylic");
    expect(windowMaterial("popup", "windows", `10.0.${ACRYLIC_BUILD}`, true)).toBe("acrylic");
    expect(windowMaterial("popup", "windows", "10.0.22000", true)).toBe("none");
    expect(windowMaterial("popup", "windows", "10.0.19045", true)).toBe("none");
    expect(windowMaterial("popup", "windows", "", true)).toBe("none");
    expect(windowMaterial("popup", "macos", "24.1.0", true)).toBe("vibrancy");
    expect(windowMaterial("popup", "linux", "6.8.0", true)).toBe("none");
    // Where a transparent window would be black, there is no material either.
    expect(windowMaterial("popup", "macos", "24.1.0", false)).toBe("none");
  });

  test("the dock, the snip and Settings never get one: the dock's could not follow the island's rounded shape", () => {
    for (const which of ["dock", "snip", "settings"] as const) {
      for (const os of ["windows", "macos", "linux"] as const) expect(windowMaterial(which, os, "10.0.22631", true)).toBe("none");
    }
  });

  test("each material's window options: acrylic on a clear, non-layered window; vibrancy active; none transparent or opaque", () => {
    expect(materialOptions("acrylic", true, "#0f0f11")).toEqual({ backgroundColor: CLEAR, backgroundMaterial: "acrylic" });
    expect(materialOptions("vibrancy", true, "#0f0f11")).toEqual({ transparent: true, backgroundColor: CLEAR, vibrancy: "popover", visualEffectState: "active" });
    expect(materialOptions("none", true, "#0f0f11")).toEqual({ transparent: true, backgroundColor: CLEAR });
    expect(materialOptions("none", false, "#0f0f11")).toEqual({ backgroundColor: "#0f0f11" });
  });

  test("main.ts makes the pop-up and the dock with the chosen material, and the snip and Settings without one", () => {
    const main = readFileSync(join(REPO, "shell", "src", "main.ts"), "utf8");
    expect(main).toContain('windowMaterial("popup", OS, release(), DOCK_TRANSPARENT)');
    expect(main).toContain("...materialOptions(POPUP_MATERIAL, DOCK_TRANSPARENT, OPAQUE_BACKGROUND)");
    expect(main).toContain("...materialOptions(DOCK_MATERIAL, DOCK_TRANSPARENT, OPAQUE_BACKGROUND)");
    expect(main.match(/backgroundMaterial|vibrancy:/g)).toBeNull();
  });
});
