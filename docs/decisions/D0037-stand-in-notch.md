# D0037: On a Mac display without a notch, the dock draws a stand-in notch and grows out of it

Date: 2026-11-23. Status: active. No foreman task (asked for in a session by the owner). Changes the last line of [D0035](D0035-dock-from-the-notch.md) ("without a notch nothing changes") on a Mac; Windows and Linux are unchanged.

## Context
The owner, on 2026-11-23, with an external screen (HP E243i, 1920x1200, no notch) as the primary display and the MacBook's built-in display beside it: "make it so that it works on my external screen. currently it does not work properly if my external screen doesn't have the notch". Under D0035 the dock fell back there to the glass pill below the menu bar, a different object from the black island the owner uses on the MacBook. Asked which they wanted, the owner chose the black notch island on every screen.

## Decision
- **On a Mac there is always a notch for the dock.** The shell measures the primary display's notch as before (D0035). When it has none, or the measurement fails, `dockNotchOf` in `shell/src/os.ts` gives a stand-in: 180 points wide (`STAND_IN_NOTCH_WIDTH`, about a MacBook's own), at the top centre of the display, 30 points tall (`STAND_IN_NOTCH_HEIGHT`, a menu bar's height there). Fixed: not read from the work area, which a full-screen app or a menu bar that hides itself changes.
- **Everything else is D0035's.** The window hangs from the very top edge over the menu bar, centred on the stand-in, at the `status` level; the page gets `/dock?notch=WxH` and draws the same black island, with the stand-in in the place of the notch and the wings beside it. No change to the contract: the page cannot tell a stand-in from a notch.
- **A change of display measures again** (D0035), so moving the menu bar between the built-in display and an external one swaps a real notch for a stand-in and back, and reloads the page for its shape. **A change of the work area alone does not** (`movesDock` in `shell/src/dock.ts`): the dock hangs from the display's edge, and a full-screen app hides and shows the menu bar on every switch of Space. The measurements run one at a time, and one during which the primary display changed is taken again, so the notch and the window's place come from the same display.

## Why
- **One dock on every Mac screen.** The owner moves between the MacBook alone and the MacBook with an external primary; a dock that changes material, place and shape with the screen reads as two apps.
- **The same shape as the notch, not a pill.** The wings, the handle and the page's layout already follow a notch; a stand-in reuses all of it, with no second set of sizes to keep in step.
- **A fixed height.** A first version took the menu bar's height from the work area. On the owner's screen a full-screen app hid the menu bar on every switch of Space, the stand-in went from 30 to 32 points and back, and each change reloaded the dock's page: the island vanished a moment after it closed. A recording of the screen showed it, and the window jumping between displays when a measurement mixed two of them.

## Closing without a gap
The owner, the next day, with a recording: the island still vanished for a moment after every close. The recording showed it gone for about 230 ms, 600 ms after the close began: the shell's deferred `blur()`, which gives the keyboard back. On a Mac Electron's `blur()` takes the window off the screen and puts it back, and a window put back fades in; a test panel showed the same gap for `blur()` then `moveTop()` and for `hide()` then `showInactive()`. Now the shell hands the keyboard to an invisible 1-point non-activating panel and blurs that one (`giveKeyboardBack` in `shell/src/main.ts`): the dock is never moved, and the test panel showed no gap. The keyboard goes back at once, not 600 ms later.

## Risk
- On a screen without a notch the stand-in is visible: a black tab of 180 points in the middle of the menu bar, also when nothing is going on, where a real notch shows nothing. The menu bar's middle is usually empty (menus are on the left, status items on the right); an app with many menus can reach it, and the tab takes the mouse there, as the notch's place does on a MacBook.
- A person has not yet seen it on the real screen; the unit tests check the stand-in's size and the window's place.
