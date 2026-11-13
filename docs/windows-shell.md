# The Windows shell

An Electron app in TypeScript (`shell/src/`) that lives in the tray. It does what a web page can't: the global hotkey, the clipboard capture, the tray icon, the dock at the top of the screen, and small windows on the runner's pages. Why Electron: [D0001](decisions/D0001-runner-web-shell.md). What it sends the runner: [protocol](protocol.md).

It is installed and started from WSL. Nothing is built or run with the Node on the Windows side.

The commands below are written `intuition …`. That command exists once `bun src/cli.ts link` has been run in the repo, one time ([README](../README.md), "Setup"); before that, or without it, `bun src/cli.ts …` from the repo does the same. The shell itself never uses the link: it starts the runner with bun and the repo's path ("Starting the runner" below).

## Install, start, stop
| Command | What it does |
|---|---|
| `intuition up` | The one command: starts the runner (`intuition start`), installs the shell if it is not installed, writes the `wsl` settings below, and starts the shell. It does not replace an installed bundle: after changing `shell/src/`, run `shell install`. (An install from before the dock, without `dock-preload.cjs`, counts as not installed and is replaced.) |
| `intuition shell install` | Bundles `shell/src/main.ts` into one file, `main.cjs`, and the dock's preload script into another, `dock-preload.cjs`, and copies them with `shell/package.json` to `%LOCALAPPDATA%\intuition\shell`. The first time, it also installs Electron there for Windows (npm and node from WSL, with `npm_config_platform=win32` and `npm_config_arch=x64`): a download of about 130 MB. Later installs only replace the bundle, unless `shell/package.json` pins another Electron version. It also writes where the runner lives into the shell's settings (`wsl`, below). |
| `intuition shell start` | Starts `electron.exe` on that folder and leaves it running. If the shell already runs, this opens its chat window instead. |
| `intuition shell stop` | Asks the running shell to quit. Does nothing when none runs. |
| `intuition shell login on` | Start the shell when you log in to Windows. `off` turns that off, `status` says which it is. See "Start on login" below. |
| `intuition shell selftest` | The same as `bun src/shell/selftest-run.ts`, below. |

After installing again, stop and start the shell: a running one keeps the old bundle and the old settings.

## Settings
`%APPDATA%\intuition-shell\settings.json`, written with these defaults on first start. Stop and start the shell after changing it.

```json
{
  "runnerUrl": "http://127.0.0.1:4777",
  "hotkey": "Control+Alt+Space",
  "dock": true,
  "wsl": {
    "distro": "Ubuntu",
    "repo": "/root/projects/intuition",
    "bun": "/root/.bun/bin/bun"
  }
}
```

- `runnerUrl`: where the runner listens. The shell's windows load this origin and nothing else.
- `hotkey`: an [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator). If another program holds it, the shell says so in a notification at start.
- `dock`: whether the dock is shown. The tray's "Show dock" checkbox changes it at once and writes it here, keeping everything else in the file. Anything but `false` counts as `true`.
- `wsl`: where the runner lives, so the shell can start it. Not in the defaults: `shell install` and `up` write it, from `WSL_DISTRO_NAME`, the repo the command was run from and the bun that ran it, and keep everything else in the file. `distro` is letters, digits, `.`, `_` and `-`; `repo` and `bun` are absolute WSL paths. Run from a git worktree, the command writes that worktree's path.

A value that is missing or malformed falls back to its default; a `wsl` with any part missing or malformed counts as absent, and the shell then starts no runner.

## What it does
- **Tray**: an icon with a menu: New task, Open chat, a "Show dock" checkbox, a "Start on login" checkbox, Quit. A double-click opens the chat. There is no window at start.
- **Hotkey, and New task**: captures the clipboard and opens the pop-up, both at once. The pop-up is a frameless 560x380 window, always on top, on the runner's `/prompt`, in the middle of the display the cursor is on. Esc or a click elsewhere hides it. Pressing the hotkey while it is up focuses it. The page closes it with `window.close()`.
- **Clipboard capture**: an image is saved as `%TEMP%\intuition\clip-<time>.png` (the newest 20 are kept) and its Windows path posted to `/api/clipboard` as `{ imagePath }`. Otherwise the text, cut to 20,000 characters, as `{ text }`. An empty clipboard posts `{}`. When the clipboard holds both an image and text, the image wins.
- **Open chat**: a 1100x720 window on `/`, or `/?session=<id>` (`electron.exe <app> --session <id>`, and a link to `/?session=<id>` that a page, the dock among them, opens in a new window). Focused if already open.
- **Runner not running**: when `GET /health` does not answer within 1.5 seconds, the shell starts the runner itself: at its own start, on the hotkey and New task, and on Open chat (the dock's links to the pop-up and the chat among them). It runs `wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env` from its `wsl` settings, with no window, and asks `/health` again for up to ten seconds. The pop-up or the chat then opens as if the runner had been there; the clipboard was read when the key was pressed and is posted once the runner answers. If nothing answers after ten seconds, or there are no `wsl` settings, no window opens and a notification says the runner is not running. See "Starting the runner" below.
- **Dock**: a small window on the runner's `/dock` page at the top centre of the primary display, which grows when the page asks. It shows what the sessions are doing, in place of the Windows toasts the shell used to show. See "The dock" below.
- **Notifications**: only for the shell's own trouble: the runner is not running, the hotkey is taken, start on login could not be changed. Never for a session.
- **One instance**: a second copy hands its command line to the first and exits. That is how `shell stop` works (`--quit`).

## Starting the runner
- **The command.** `wsl.exe` is given an array of arguments and `--exec`, so neither Windows nor a shell in WSL reads the settings' values as a command line: a path with spaces, quotes or `;` stays one argument. A `wsl` setting that could be read as an option (a name starting with `-`, a path not starting with `/`) is refused when the settings are read. Why: [D0006](decisions/D0006-start-stop-and-login.md).
- **The environment.** `--login-env` makes `start` run the runner through your login shell (`zsh -l -i -c …` or bash's equivalent), so sessions get the PATH your terminal has. Whatever your profile prints lands at the top of the runner's log (`intuition logs`). A profile that takes several seconds leaves less of the ten. A profile that replaces the shell with another program (`exec tmux`) would keep the runner from starting: start it from a terminal then.
- **Ten seconds may be short.** On this machine the command took about six seconds with WSL already up, four of them the profile. Right after a login WSL itself has to boot first, so the first notification may say the runner is not running although it comes up moments later; the next hotkey press finds it. This has not been tried after a real login.
- **A runner that dies later** is not restarted by the dock's check, which only hides the dock: the runner starts again at the next hotkey, New task or Open chat, and the dock comes back with it.
- **`bun scripts/smoke-start.ts`** runs that very command through the real `wsl.exe` for a runner in temp folders on a free port with the fake agent, and checks that the runner is still up, as its own process and with the login shell's PATH, after `wsl.exe` has returned. It needs Windows and is skipped in CI. It passed on this machine on 2026-11-13. It does not involve Electron: the shell's own spawn of `wsl.exe` (no window, from a Windows program) has not been seen.

## Start on login
- **On and off.** The "Start on login" checkbox in the tray menu, or `intuition shell login on` and `off` from WSL. `intuition shell login status` only reads. All three use Electron's login item (`app.setLoginItemSettings`), which is a value named `intuition` under the Windows user's `Run` registry key: `"<…>\electron.exe" "<…>\intuition\shell"`. Windows lists it under Task Manager > Startup apps, where it can also be switched off.
- **At login** Windows starts the shell, and the shell starts the runner as above. WSL has to boot first, so allow some seconds.
- **The command and a running shell.** `shell login on` works whether or not the shell runs, and a running shell's checkbox follows it. It needs the installed bundle to know `--login`: after updating the repo, `shell install` first.
- **It names the installed folder,** not the repo: installing again does not change it. Removing `%LOCALAPPDATA%\intuition` while it is on leaves a login item that starts nothing: turn it off first.
- **Nothing automatic turns it on.** Not the install, not `up`, not the self-test (which reads it and prints which it is), not any test or script.

## The dock
The contract between the page and the shell is in [protocol](protocol.md) under "Dock". This is the shell's half: the window. The page (`/dock`) is the runner's.

- **The window.** Frameless and clear (the page draws the island; the rest of the window shows what is behind it), no shadow, always on top, not in the taskbar or Alt+Tab, not movable or resizable by the person. It touches the top edge of the primary display, centred, placed from the display's bounds and not its work area, so a taskbar at the top does not push it down. It is centred again when a display is added or removed or its resolution or scale changes.
- **Three states, three exact sizes**: idle 280x40, peek 420x76, open 460x600 (`DOCK_SIZES` in `shell/src/dock.ts`; `dockBounds` there is the one function that says where the window goes). It starts idle.
- **The page decides.** It calls `window.intuitionDock.setState("idle" | "peek" | "open")` and the shell resizes the window at once, keeping it centred. That function is all the bridge has: `shell/src/dock-preload.ts`, the only preload script in the shell, given only to the dock's window. The main process takes a call only from the dock window's main frame, on the runner's origin, with one of the three values; anything else changes nothing and is not answered.
- **The keyboard.** In idle and peek the window cannot be focused: showing it, growing it or clicking it takes nothing from the program the person is typing in. Only in open can it take the keyboard, when the person clicks into it; the shell never focuses it itself. Going back to idle or peek while it has the keyboard gives the focus back to the window below.
- **Its links.** A link the page opens in a new window to `/?session=<id>` opens the chat window on that session, and one to `/prompt` captures the clipboard and opens the pop-up, as the hotkey does. Every other new window is refused.
- **When it shows.** At the shell's start once the runner answers, and whenever the shell has started the runner. Every 4 seconds the shell asks `/health`: after two misses in a row the dock is hidden; when the runner answers again the page is loaded afresh and the dock shown, idle. A page that does not load (no answer, an HTTP error such as a 404 from a runner that has no `/dock` yet, a crashed page) hides the window: an empty clear window is never left on screen. The shell tries again at the next check.
- **Off.** Untick "Show dock" in the tray, or set `"dock": false`: the window is closed, not hidden, and nothing is created at the next start. With the dock off the shell shows nothing about sessions at all; the chat window still has everything.

### Why
The decision is [D0008](decisions/D0008-dock.md), which replaces the shell's half of [D0005](decisions/D0005-toasts.md). The window's reasons:
- **A dock instead of toasts.** The owner asked for it: a pill at the top of the screen that expands on hover, "like the apple style dynamic island almost", where a session can be continued. A toast can't be replied to, Windows decides whether it shows at all (Do Not Disturb, notification settings, an app id without a Start-menu shortcut), and in all the time the shell had toasts nobody saw one. The dock is the shell's own window: what it shows is up to the page.
- **The page decides the state, through a one-function bridge.** Hover, a finished session and an open approval are things the page knows; the shell only knows the window. So the page asks and the shell obeys, but only for three named sizes. The bridge is one-way and carries one word: a page that went wrong, or a frame inside it, can at worst pick another of the three sizes. The dock keeps the sandbox, context isolation and no Node, like the other windows; the preload is the single addition.
- **The window resizes; it is not a click-through overlay.** The other way to build this is one large clear window, as big as the open dock or the screen, that lets clicks through wherever the island isn't (`setIgnoreMouseEvents`, switched on and off as the mouse moves). A bug there, a missed mouse-leave or a page that crashed at the wrong moment, leaves a dead zone: a part of the screen that looks empty and swallows every click, with nothing to show why. A window that is exactly as big as what it draws cannot do that: the worst it can do is stay open, visibly, at 460x600. The price is the order of things when animating: growing, the page calls `setState` first and animates inside the larger window; shrinking, it animates first and calls `setState` after.
- **Not focusable until open.** A window that appears by itself (a session finished) or under the mouse (hover) must not take the keyboard from someone mid-sentence. Windows gives that guarantee only to a window that cannot be activated at all, so that is what the dock is in idle and peek.
- **The display's bounds, not the work area.** The island belongs on the very top edge, also over a maximised window's title bar.
- **Two misses before hiding.** One slow `/health` (the runner busy starting a session) would otherwise blink the dock away and reload its page.

## What pages can do
The windows are sandboxed, with context isolation and no Node integration. Only the dock's window has a preload script, which gives its page `window.intuitionDock.setState` and nothing else (see "The dock"). Navigation or a redirect to any origin but the runner's is refused, and so is every new window but two: a link to the runner's own chat view opens in the chat window, and the dock's link to `/prompt` opens the pop-up. Pages get no permissions (camera, location, notifications and the rest) except writing to the clipboard. There is no application menu, so no reload or developer-tools shortcuts.

## Self-test
`bun src/shell/selftest-run.ts` runs on this machine only (it prints `skipped` and exits 0 when `CI` is set or there is no `/mnt/c`). It installs the shell, starts a stub runner on a free port, runs `electron.exe <app> --self-test <result file> --runner-url <stub>`, and checks the JSON the shell writes. The self-test uses its own user data folder and its own hotkey (`Control+Alt+Shift+F11`), so it runs beside a running shell. It puts text and then a small image on the clipboard, then puts back what was there (text or an image; other kinds, such as copied files, are not put back). The pop-up flashes on screen for about a second, without taking focus, and so does the chat window. The dock's window is up for a few seconds at the top of the screen, with nothing to see in it: the stub's dock page draws no island. Run with Windows on its lock screen, the clipboard steps fail, because nothing can use the clipboard there; the runner says so in a note.

What it covers, on the real Windows desktop:
- a global hotkey registers;
- the tray icon is created (then removed at once);
- a text clipboard is captured and posted, and the stub runner received it;
- an image clipboard is captured, saved as a PNG under `%TEMP%\intuition`, and its path posted; the file exists under `/mnt/c` and starts with the PNG signature (the test then deletes it);
- Windows says notifications are supported;
- the pop-up is created at 560x380, loads `/prompt`, is visible, and is centred on the display under the cursor;
- a navigation and a new window to another origin are both refused;
- `window.close()` from the page closes the pop-up;
- with no runner answering, no window opens (the self-test has no `wsl` settings and never starts a runner);
- start on login can be read (`app.getLoginItemSettings`). The result's `openAtLogin` says which it is on this machine, and either passes. The self-test never sets it;
- the dock, against the stub runner's own tiny `/dock` page:
  - with `"dock": false` no dock window is created;
  - otherwise it is created, loads `/dock`, is shown, and is neither focusable nor focused; its bounds are the idle ones at the top centre of the primary display (checked in WSL with `dockBounds` on the display the shell reported);
  - the page sees `window.intuitionDock` with `setState` alone, and no `require` or `process`;
  - after the page calls `setState("open")` the bounds are the open ones and the window is focusable; a call with a value that is not a state changes nothing; after `setState("idle")` the bounds are the idle ones again and it is not focusable;
  - a call from a page on an origin that is not the runner's changes nothing. (The shell is told for that moment that its runner is at `localhost`, so the same page at `127.0.0.1` is the foreign one. No second server is involved.);
  - the page's new-window link to `/?session=self-test-session` opens the chat window on it, its link to `/prompt` opens the pop-up, and links to another of the runner's paths and to another site open nothing;
  - with no runner answering, the dock is still there after one check and hidden after the second; with the runner back, the next check loads the page and shows it, idle.

What nobody has seen. The self-test cannot press keys, click or look at the screen, and the shell was written from WSL:
- the hotkey being pressed: only that it registers. Pressing it, and pressing it again to focus the pop-up, are untested;
- the tray icon's look, its menu, and the double-click;
- the pop-up taking keyboard focus, hiding on Esc and hiding on a click elsewhere;
- the chat window;
- **the dock on screen. Nobody has seen it**: not idle, not growing, not with a session in it. The self-test reads the window's bounds and whether it can be focused, and that is all it knows. Unseen, each of them: whether the window is really clear around the island or shows a black or white rectangle, a border or a shadow; whether it sits above a maximised or a full-screen window; whether it stays out of Alt+Tab and the taskbar, also while open; whether showing or resizing it leaves the active program active (its title bar stays lit, nothing flashes in the taskbar) and what Windows activates when the dock gives the focus back; whether typing works in it once clicked in open; whether the resize flickers; where it lands with a second display, a taskbar at the top, or a scale other than the one here. The dock's page exists now (`src/web/dock.js`) and is driven in headless Chromium by `test/web/dock-ui.ts`, with a stand-in for the bridge; nobody has seen it in the shell's window. Both self-test runs of 2026-11-13 that covered the dock ran with Windows on its lock screen;
- any notification on screen: not "the runner is not running", not "the hotkey is taken". Windows may hold back notifications from an app that has no Start-menu shortcut;
- the dock's links being clicked by a person, and "Show dock" in the tray being ticked and unticked;
- a clipboard image copied by a real program (a screenshot, a browser), as opposed to the PNG the self-test writes itself;
- more than one display, and displays with different scaling;
- the shell starting the runner: its `wsl.exe` command was run from WSL by `scripts/smoke-start.ts`, never by the shell itself, and never after a real login;
- start on login being on. `intuition shell login status` was run on 2026-11-13 and said off. Nobody has turned it on, by the checkbox or by the command, so the checkbox, the registry value and a login with it on are all unseen.

`shell start` and `shell stop` were run once by hand on 2026-11-12: the process list showed the shell running after start, still one shell after a second start, and none after stop.

## Hand-test checklist
Steps 10 to 18 are the dock, step 9 is the shell starting the runner, and steps 20 to 23 are start on login: nobody has seen any of them yet. The dock steps need a runner that serves the dock's page (`/dock`): with an older runner, step 10 shows no dock at all, and that is right.

1. In WSL: `intuition shell install`, then `intuition up`. **See**: a line `intuition runner on http://127.0.0.1:4777 …`, and a small blue-violet disc in the tray (maybe under the `^` arrow), with the tooltip "intuition". No window but the dock (step 10).
2. Copy some text anywhere, then press Ctrl+Alt+Space. **See**: a small window without a title bar in the middle of the screen the mouse is on, above other windows, with the keyboard focus in it. In WSL, `curl http://127.0.0.1:4777/api/clipboard` shows the text.
3. Press Ctrl+Alt+Space again. **See**: the same window, still there and focused, not a second one.
4. Press Esc. **See**: the window gone. Press the hotkey, then click on another window. **See**: gone again.
5. Take a screenshot to the clipboard (Win+Shift+S), then press the hotkey. **See**: the pop-up, and a new `clip-<time>.png` in `%TEMP%\intuition` that shows the screenshot.
6. Right-click the tray icon. **See**: New task, Open chat, a ticked "Show dock" checkbox, a "Start on login" checkbox, Quit. Choose New task. **See**: the pop-up, as in step 2.
7. Double-click the tray icon. **See**: a normal window, about 1100x720, titled "intuition", on the chat view. Double-click again. **See**: the same window brought to the front, not a second one.
8. On a second display, if there is one: move the mouse there and press the hotkey. **See**: the pop-up in the middle of that display.
9. `intuition stop` in WSL, then press the hotkey. **See**: no console window flashing; within about ten seconds, the pop-up, with the clipboard attached. `intuition status` in WSL says `running`. (If instead a notification says the runner is not running, wait a few seconds, press again, and look at `intuition logs`: note how long the start took.)
10. The dock, idle. With the runner and the shell running, look at the top of the primary display. **See**: a small pill in the middle, touching the top edge, above every other window, a maximised one too. Around the pill nothing: no rectangle, no border, no shadow, and what is behind shows through. Nothing new in the taskbar or in Alt+Tab. Type in another program while it is there. **See**: the typing goes where it went before; that program's title bar stays lit.
11. Hover. While typing in another program, move the mouse onto the pill, without clicking. **See**: it grows downwards into a panel about 460 wide and 600 tall, still centred, with the sessions in it. The other program is still the active one: its title bar stays lit, a key pressed now still lands in it, and nothing flashes in the taskbar. Move the mouse away. **See**: it shrinks back to the pill. Now click on something that was under the panel. **See**: the click lands on it: no part of the screen is left dead.
12. A finished session. Press the hotkey, pick a workspace, type `say hello` and send it. Keep working in another program. **See**: when the session finishes the pill grows a little by itself (about 420x76) and says which session finished and how its answer starts, then settles back. The keyboard never left your program. No Windows toast, no sound.
13. An approval. Send a task that needs one, for example `create a file called dock-test.txt containing hi` in a workspace whose settings don't already allow writing. **See**: the dock peeks and says what waits: the tool and the file. Hover to open it. **See**: Allow and Deny for that call. Allow it. **See**: the session carries on in the open dock. Move the mouse away before it finishes. **See**: the dock peeks again when it does (while the dock is open nothing peeks: its list shows it).
14. Replying in the dock. Open the dock on a finished session and click into its reply box. **See**: now, and only now, the dock has the keyboard: the caret is in the box and typing lands there. Type `and say goodbye`, send it. **See**: the session runs again, in the dock. Move the mouse away. **See**: the dock shrinks, and the keyboard is back in the program you were in before, without a click.
15. Its links. In the open dock, use the session's link to the chat window. **See**: the chat window, on that session. Copy some text, then use the dock's new-task control. **See**: the pop-up, with that text attached, as from the hotkey.
16. Displays. In Settings > System > Display change the scale of the primary display, then change it back; if there is a second display, unplug it or make it the primary one. **See**: after each change the pill is in the top middle of the display that is primary now, at its right size.
17. The runner goes away. `intuition stop` in WSL. **See**: within about ten seconds the dock is gone, all of it: no empty patch at the top of the screen that swallows clicks. `intuition start`. **See**: within about five seconds the pill is back.
18. The dock switched off. Right-click the tray icon and untick "Show dock". **See**: the dock gone at once, and `"dock": false` in `%APPDATA%\intuition-shell\settings.json`, the rest of the file as it was. Send a task and let it finish. **See**: nothing on screen about it: no dock, no toast; the chat window has it. `intuition shell stop`, then `shell start`. **See**: still no dock, and the checkbox still unticked. Tick it. **See**: the pill back at once.
19. `intuition shell stop`, or Quit in the tray menu. **See**: the tray icon and the dock gone, and the hotkey does nothing.
20. Start on login, from the command: `intuition shell login status`. **See**: `start on login is off`. Then `intuition shell login on`. **See**: `start on login is on`; in Task Manager > Startup apps, an entry named "intuition" or "Electron", enabled; and, if the shell runs, its tray checkbox ticked.
21. From the tray: start the shell, untick "Start on login". **See**: `intuition shell login status` says off, and the entry is gone from Startup apps. Tick it again.
22. `intuition stop` and `intuition shell stop`, then sign out of Windows and in again (or restart). Touch nothing in WSL. **See**: the tray icon within a minute, no console window, the dock once the runner is up, and after some seconds the hotkey opens the pop-up. If a notification said the runner is not running first, note it: ten seconds was too short for WSL to boot.
23. `intuition shell login off` if you don't want it. **See**: `start on login is off`.

## Not built yet
A Start-menu shortcut for the app id: without one, Windows may hold back the shell's own notifications (the runner is not running, the hotkey is taken).
