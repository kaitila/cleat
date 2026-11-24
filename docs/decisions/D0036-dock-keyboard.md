# D0036: The open dock has the keyboard, hotkeys switch session and workspace, and it reopens on the last session

Date: 2026-11-22. Status: active; its hotkeys are replaced by [D0040](D0040-dock-switch-and-command-keys.md) (⌘K, ⌘1..9, no Alt+digit). Task: T-0002 (this machine's foreman board). Changes [D0008](D0008-dock.md) (the focus, what holds the dock open, the session it opens on) and builds on [D0032](D0032-calmer-dock-panel.md).

## Context
The owner, on 2026-11-22: "when I open the notch from the top, I could easily start typing there without needing to click on the field. also add hotkeys to easily switch the workspace / session from the top. also make it remember the selected session between opens / closes". And, the same day, with a half-typed reply in the open dock: "the notch doesnt close". A draft held the dock open, and nothing the person did in another app reached it: not Esc, not a press beside it.

## Decision
- **On "open" the shell focuses the dock's window**, and the page puts the keyboard in the reply box (or, while a turn runs, as soon as the box is back on). On a Mac the window is a `panel` (Electron's non-activating panel): it takes the keyboard without making the shell the active app, so the app the person was in stays in front and has the keyboard back when the dock closes. Elsewhere it stays a `toolbar` window.
- **The dock's own focus does not hold it open.** The box focused on opening counts as the person's only once they click or type in it. Moving the pointer away still closes an untouched dock.
- **A draft holds the dock open only while the dock has the keyboard.** Once another app has it, the dock closes when the pointer is away, and the draft stays in the box for the next opening.
- **Hotkeys in the open dock:** Alt+Up and Alt+Down show the session above or below in the list, stopping at the ends. Alt+1..9 picks that workspace in the switch, and Alt+0 all of them, as Alt+digit picks a workspace in the pop-up. The physical key is read, since a Mac's Alt turns digits into other characters. The keyboard stays in the box.
- **The dock reopens on the session it was left on**, kept in its `localStorage` (`intuition.dock.session`) like the workspace. News wins: the session peeking now, or the one that peeked since the dock was last open. After that comes the remembered one, then the newest that waits for approval, then the newest.

## Why
- **A panel, not an activating window.** Tried on this Mac: a `toolbar` window can't take the keyboard by `focus()` (it reports unfocused), and activating the app would steal the person's frontmost app. A non-activating panel took the keyboard while Terminal stayed in front, and gave it back on blur.
- **Alt+arrows and Alt+digits.** Alt+Up and Alt+Down are how chat apps step through conversations. Alt+digit is already the pop-up's workspace key. Ctrl/Cmd+arrows move the caret in the box.
- **News before the remembered session.** A person who opens the dock right after a "done" peek is opening it for that session.

## Risk
- Hovering the notch while typing in another app sends the next keys to the dock. The 80 ms rest before opening keeps a passing pointer from doing it.
- On Windows and Linux the focus on "open" is untried by a person: Windows may refuse to bring a window forward and flash the taskbar instead.
