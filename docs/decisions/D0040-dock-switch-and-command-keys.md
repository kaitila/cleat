# D0040: The open dock shows the other sessions at work and finds one by typing, and the pages' hotkeys are on ⌘, never Option+digit

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner). Changes the head and the list of [D0038](D0038-dock-session-switch.md) and the hotkeys of [D0036](D0036-dock-keyboard.md); the pop-up's and the snip's workspace key from [D0034](D0034-agent-choice-in-the-pages.md) and the pop-up.

## Context
The owner, on 2026-11-24: "rethink how to make it super easy to switch between sessions and super intuitive how it works and shows active sessions etc. the workspace switching hotkey (opt+number) is also not ideal, thus now i cant write the at sign again." On a Finnish Mac keyboard Option+2 is @, and Option with 7, 8 and 9 types |, [ and ]. The dock, the pop-up and the snip each took Alt+1..9 for the workspace, so those characters could not be typed there. In the open dock the other sessions showed only once the list was opened, so a session that waited for the person, or ran, beside the one shown, was not seen.

The same day, of Settings: "this shows wrong on mac, why windows key? also - if I press the existing input while changing the input, it pops up". The shortcuts were drawn with Windows' words (Win, Ctrl, Alt), and the shell's global hotkey opened the pop-up while a new shortcut was being recorded.

## Decision
- **The other sessions at work are in the head.** Beside the switch, each other session that waits for the person or runs is a small chip: its status's dot and the start of its title, the whole title and the status its tooltip. Waiting ones come first. At most two, then "+n", which opens the switch. A press shows that session and puts the keyboard in its reply. A session that newly waits nudges its dot once.
- **The switch finds by typing.** Opened (a press on the head's title, or ⌘K), it has a find field at the top with the keyboard in it, and the workspace filter beside it. Typing narrows the rows by title and workspace; Up and Down move the highlight; Enter shows the highlighted session, closes the switch and puts the keyboard back in the reply. Esc closes the switch, and a second Esc the dock. A typed find holds the dock open as a typed reply does; an empty one does not.
- **One order everywhere in the dock:** the sessions that wait for the person, then the running ones, then the rest as before (pinned first, then the newest). The switch, ⌘1..9 and the steps all use it, so what needs a look is at the top.
- **The dock's keys:** ⌘K opens and closes the switch; ⌘1..9 shows the session in that row; Ctrl+Tab and Ctrl+Shift+Tab, and Alt+Down and Alt+Up, the next and the one before (in the open switch they move the highlight). While ⌘ is held, the switch's first nine rows show ⌘1..⌘9 where their time was. The workspace has no key in the dock: it is the filter in the switch, or typed in the find.
- **The pop-up and the snip pick a workspace with ⌘1..9.** Off a Mac the command key is Ctrl: Ctrl+1..9 and Ctrl+K. `src/web/keys.js` decides it for every page. No page takes Alt or Option with a digit.
- **Settings draws a Mac's keys as a Mac does:** ⌘ for Super, ⌃ ⌥ ⇧ for Control, Option and Shift. Its texts say "the desktop app" and "when you log in", not "the Windows shell" and "when Windows starts".
- **The shell's hotkeys do nothing while Settings has the keyboard**, so pressing the shortcut one has now while recording a new one no longer opens the pop-up or the snip over the page.

## Why
- **Chips over bare dots.** A first version had a dot alone per session: an amber dot with no words says something waits, not what. The start of a title does, in the width of a short word or two.
- **⌘ for the page's own keys.** On a Mac ⌘ never types a character, and ⌘K and ⌘1..9 are the switcher and tab keys of browsers, Slack and Linear. Option is how a Mac keyboard types the characters it has no key for, so a hotkey on Option takes one from the person on some layout. Off a Mac, Ctrl+digit types nothing either. Alt+arrows stay: they type nothing anywhere.
- **Find, not more rows.** With many sessions, scrolling four rows to find one is slower than typing two letters of its title.
- **Guarding the press, not unregistering the hotkeys.** Registering a new shortcut is how the shell learns that another app holds it; unregistering them while Settings is open would put that off until it closes.

## Alternatives
- Tabs of sessions across the head: no room at 460px for more than two titles (as in D0038).
- Keeping Option+digit and reading only the physical key: it is the reading of the physical key that took @ away.
- A preload bridge so the Settings page tells the shell it is recording: more surface for the same effect, as long as the Settings window having the keyboard is a good enough sign.

## Risk
- The order moves as sessions change state, so ⌘2 may name another session a minute later. The hints while ⌘ is held show which.
- Pressing the shortcut one has now while recording records nothing (the OS gives the press to the shell, which drops it); the old one stays, which is what was pressed.

## Screenshots
From a run of `bun test/web/dock-ui.ts`: [the switch open with its find](D0040/dock-open-switch-dark.png), [a waiting session as a chip beside the switch](D0040/dock-open-live-dark.png).
