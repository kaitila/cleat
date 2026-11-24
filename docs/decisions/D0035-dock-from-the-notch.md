# D0035: On a Mac with a notch, the dock grows out of the notch

Date: 2026-11-22. Status: active. Task: T-0001 (this machine's foreman board). Replaces, on a display with a notch, the line of [D0023](D0023-native-shell.md) that hangs a Mac's dock from the work area's top. Builds on [D0008](D0008-dock.md), [D0010](D0010-dock-fixed-window.md) and [D0028](D0028-glass-design.md).

## Context
The owner, on 2026-11-22, with a screenshot of the open dock on a 14-inch MacBook Pro: "make it work better with the notch on my macbook". The dock hung below the menu bar, a band of menu bar away from the notch it is modelled on (D0008: "like the apple style dynamic island"), and its translucent glass let the page behind it show through its text.

## Decision
- **The shell measures the notch through AppKit.** Electron's `Display` has no notch. The shell runs `osascript -l JavaScript` with an argument array (`NOTCH_PROBE` in `shell/src/os.ts`, spawned without a shell like the other spawns): it asks `NSScreen.screens[0]` (the primary display, the one with the menu bar) for its width, `auxiliaryTopLeftArea` and `auxiliaryTopRightArea` (the menu bar either side of the notch, both empty without one) and `safeAreaInsets.top`. `parseNotch` takes the notch only when the screen is as wide as Electron's primary display and the notch is a sensible bar (40 to 400 points wide, 16 to 64 tall). The shell measures before it first loads the dock and again on every change of display.
- **The window hangs from the display's very top edge, centred on the notch** (`dockArea` with a notch), above the menu bar: `enableLargerThanScreen` on a Mac, so a frameless window goes where it is put, and the `status` window level (above the menu bar; the menus that drop from it are higher still). Without a notch the level stays `floating`.
- **The page gets the notch as `/dock?notch=WxH`.** The sizes then follow it, the same in `shell/src/dock.ts` and `src/web/dock-state.js` (`dockSizes`): idle is the notch and a 76-pixel wing each side, at the notch's height; peek is 380 wide and the notch's height plus 40 tall; open is unchanged. The window keeps its one size (D0010).
- **The island is opaque black, `--notch`, the same in every scheme.** With nothing going on, idle is the notch itself, so nothing shows. With something going on, the dot is in the left wing and the words in the right one, never under the notch, which hides them. The peek's line and the panel start below the notch's band.
- **In idle the notch alone is the handle.** The shell takes the mouse there, and the page counts the pointer on the island there. The wings lie over the menu bar and let every click through to it, so a menu beside the notch can still be opened.
- **Without a notch nothing changes** (on a Mac, replaced by [D0037](D0037-stand-in-notch.md): a stand-in notch): a Mac without one, an external display as the primary, or a measurement that failed. The dock hangs below the menu bar as glass.

## Why
- **AppKit through osascript, not a native module.** The project is TypeScript only and adds no dependencies. `osascript` ships with macOS, answers in about 100 ms, and needs no permission. `NSScreen` is the only source of the notch's real width, which differs between the 14- and 16-inch models and with the display's scaling.
- **A heuristic would have been wrong.** "A built-in display with a menu bar over 30 points tall" cannot tell a notch's width, and an auto-hiding menu bar makes the work area start at 0.
- **Black, not glass.** The notch is black hardware. Glass beside it reads as two objects, and its translucency was the readability problem in the owner's screenshot. Black also merges the quiet island with the notch, so a dock with nothing to say takes no pixels at all.
- **The notch as the only idle handle.** Taking the mouse on the wings would steal clicks from the menu bar items next to the notch.

## Risk
- A person has not yet seen it on the real screen. The self-test passed on a 14-inch MacBook Pro, with the window at the very top and centred on the notch. `test/web/dock-ui.ts` checks the page's shapes and saves screenshots over a stand-in notch.
- The wings cover 76 points of the menu bar each side of the notch while something runs. An app with many menus can reach them; its clicks still go through, but the words are hidden under the wing.
- If a future macOS keeps frameless windows below the menu bar despite `enableLargerThanScreen`, the self-test's place check fails, and the page's band for the notch would be empty black under the menu bar.

## Screenshots
From `bun test/web/dock-ui.ts`, over a stand-in for the notch (a black 179x32 bar at the top centre):
- [Idle, something running](D0035/dock-notch-idle-running-dark.png): the dot in the left wing, the words in the right one.
- [Peek](D0035/dock-notch-peek-dark.png): the line below the notch's band.
- [Open](D0035/dock-notch-open-dark.png): the panel's head below the notch's band.
