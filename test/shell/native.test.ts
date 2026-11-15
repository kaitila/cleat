// The shell on macOS and Linux: what differs per OS (shell/src/os.ts), start on login's files
// (shell/src/login.ts) and the settings' local runner. The self-test on each layout is in shell.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dockBounds, islandRect } from "../../shell/src/dock";
import { autostartEntry, autostartFile, LAUNCH_AGENT, launchAgentFile, launchAgentPlist } from "../../shell/src/login";
import {
  ACRYLIC_BUILD, CLEAR, defaultHotkeys, dockArea, materialOptions, windowMaterial, windowsBuild, dockTransparent, hasAppIndicator, isGnome, linuxNotices, linuxOzone, opaqueDockBounds, parseLocalRunner,
  runnerDownHint, runnerSpawn, SCREEN_RECORDING_PANE, screenAllowed, shellOs,
} from "../../shell/src/os";
import { SHELL_DEFAULTS } from "../../shell/src/prefs";
import { parseSettings } from "../../shell/src/settings";
import { autostartEntry as cliAutostartEntry, parseLocalRunner as cliParseLocalRunner } from "../../src/shell/platform";
import { REPO } from "../../src/shell/paths";
import { savedPathPattern } from "../../src/shell/selftest-run";

const runner = { kind: "local" as const, repo: "/home/a/intuition", bun: "/home/a/.bun/bin/bun" };
const wsl = { distro: "Ubuntu", repo: "/home/you/intuition", bun: "/home/you/.bun/bin/bun" };

describe("the OS", () => {
  test("from process.platform: win32, darwin, and everything else Linux", () => {
    expect([shellOs("win32"), shellOs("darwin"), shellOs("linux"), shellOs("freebsd")]).toEqual(["windows", "macos", "linux", "linux"]);
  });

  test("hotkeys: Command+Shift on a Mac, Control+Alt elsewhere", () => {
    expect(defaultHotkeys("macos")).toEqual({ hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S" });
    for (const os of ["windows", "linux"] as const) expect(defaultHotkeys(os)).toEqual({ hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S" });
  });

  test("savedPathPattern: native paths are <temp>/intuition/<kind>-<time>.png; Windows ones as before", () => {
    const clipPath = "/var/folders/xy/T/intuition/clip-20261115-090507-042.png";
    expect(savedPathPattern("macos", "clip").test(clipPath)).toBe(true);
    expect(savedPathPattern("linux", "snip").test("/tmp/intuition/snip-20261115-090508-000.png")).toBe(true);
    expect(savedPathPattern("linux", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png")).toBe(false);
    expect(savedPathPattern("windows-wsl", "clip").test("C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\clip-1.png")).toBe(true);
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
      file: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Ubuntu", "--exec", wsl.bun, "/home/you/intuition/src/cli.ts", "start", "--login-env"], detached: false,
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
