# D0025: The settings page's Setup section: the shell reports its side to the runner, holds a marked socket, and opens Screen Recording's pane when the runner asks on it

Date: 2026-11-15. Status: active. Task: T-0045. Builds on [D0019](D0019-platform-layouts.md), [D0021](D0021-shell-settings-from-the-runner.md) and [D0023](D0023-native-shell.md).

## Context
T-0032 left the settings page's Setup section for later: one place that shows the layout, whether the runner and the shell run, start on login and, on a Mac, Screen Recording, each with what to do when it is not ok. The runner knows its layout, but the rest is the shell's: only the shell can read its login item or launch agent, its hotkeys and Screen Recording. And the page cannot open `x-apple.systempreferences:` links: the shell keeps pages on the runner's origin and opens only links it knows (`externalLink`).

## Decision
- **The shell reports; the runner keeps the report.** `PUT /api/platform/shell` with `ShellReport` (OS, start on login, each hotkey registered, the dock transparent, and on macOS Screen Recording), when its socket opens and whenever it differs from the last one the runner took: after every settings change, a Screen Recording check, a `--login` from the command line, and when the Settings window gets the focus (back from System Settings). `GET /api/platform` answers the layout (`detectLayout`), the runner, and the report. A `platform` message on `/ws` follows each change, so the page redraws without polling.
- **"The shell runs" is its socket being open.** The shell's settings socket connects as `/ws?client=shell`. The runner counts those sockets; the report is kept while any is open and dropped when the last closes. A report alone would say the shell runs long after it quit.
- **Opening the pane goes through the runner, as a named action.** The page posts `POST /api/platform/open-screen-recording`; the runner sends `{ type: "shell_action", action: "open_screen_recording" }` to the shell's sockets only (their own topic, never the pages'), or answers 409 when no shell on macOS is connected. The shell takes only actions it knows and opens its own constant `SCREEN_RECORDING_PANE`: no URL crosses the wire. The task offered a preload bridge instead; the route needs no new preload on the Settings window, works for the page in any browser on the runner's origin, and reuses the socket the shell already holds.
- **What each line says is a pure function** (`setupLines` in `settings-model.js`), tested in bun; the page only draws it.

## Why
- Every new route is under `/api/`, passes `refusal()`, and changes nothing but what the page shows or one fixed pane opening, so a page on another origin can do neither.

## Risk
- Another program on the runner's origin could connect as `?client=shell` or send a report. It can only make the Setup section wrong, or open a System Settings pane; anything on that origin can do more already.
- macOS usually applies Screen Recording only after the shell restarts, so the line may stay "Not allowed" until then; the line says to restart.
