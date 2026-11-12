# The Windows shell

An Electron app in TypeScript (`shell/src/`) that lives in the tray. It does what a web page can't: the global hotkey, the clipboard capture, the tray icon, toasts for sessions, and small windows on the runner's pages. Why Electron: [D0001](decisions/D0001-runner-web-shell.md). What it sends the runner: [protocol](protocol.md).

It is installed and started from WSL. Nothing is built or run with the Node on the Windows side.

## Install, start, stop
| Command | What it does |
|---|---|
| `bun src/cli.ts up` | The one command: starts the runner (`bun src/cli.ts start`), installs the shell if it is not installed, writes the `wsl` settings below, and starts the shell. It does not replace an installed bundle: after changing `shell/src/`, run `shell install`. |
| `bun src/cli.ts shell install` | Bundles `shell/src/main.ts` into one file, `main.cjs`, and copies it with `shell/package.json` to `%LOCALAPPDATA%\intuition\shell`. The first time, it also installs Electron there for Windows (npm and node from WSL, with `npm_config_platform=win32` and `npm_config_arch=x64`): a download of about 130 MB. Later installs only replace the bundle, unless `shell/package.json` pins another Electron version. It also writes where the runner lives into the shell's settings (`wsl`, below). |
| `bun src/cli.ts shell start` | Starts `electron.exe` on that folder and leaves it running. If the shell already runs, this opens its chat window instead. |
| `bun src/cli.ts shell stop` | Asks the running shell to quit. Does nothing when none runs. |
| `bun src/cli.ts shell login on` | Start the shell when you log in to Windows. `off` turns that off, `status` says which it is. See "Start on login" below. |
| `bun src/cli.ts shell selftest` | The same as `bun src/shell/selftest-run.ts`, below. |

After installing again, stop and start the shell: a running one keeps the old bundle and the old settings.

## Settings
`%APPDATA%\intuition-shell\settings.json`, written with these defaults on first start. Stop and start the shell after changing it.

```json
{
  "runnerUrl": "http://127.0.0.1:4777",
  "hotkey": "Control+Alt+Space",
  "wsl": {
    "distro": "Ubuntu",
    "repo": "/root/projects/intuition",
    "bun": "/root/.bun/bin/bun"
  }
}
```

- `runnerUrl`: where the runner listens. The shell's windows load this origin and nothing else.
- `hotkey`: an [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator). If another program holds it, the shell says so in a notification at start.

- `wsl`: where the runner lives, so the shell can start it. Not in the defaults: `shell install` and `up` write it, from `WSL_DISTRO_NAME`, the repo the command was run from and the bun that ran it, and keep everything else in the file. `distro` is letters, digits, `.`, `_` and `-`; `repo` and `bun` are absolute WSL paths. Run from a git worktree, the command writes that worktree's path.

A value that is missing or malformed falls back to its default; a `wsl` with any part missing or malformed counts as absent, and the shell then starts no runner.

## What it does
- **Tray**: an icon with a menu: New task, Open chat, Open last session, a "Start on login" checkbox, Quit. "Open last session" opens the chat on the session of the newest toast, and is greyed out until there has been one. A double-click opens the chat. There is no window at start.
- **Hotkey, and New task**: captures the clipboard and opens the pop-up, both at once. The pop-up is a frameless 560x380 window, always on top, on the runner's `/prompt`, in the middle of the display the cursor is on. Esc or a click elsewhere hides it. Pressing the hotkey while it is up focuses it. The page closes it with `window.close()`.
- **Clipboard capture**: an image is saved as `%TEMP%\intuition\clip-<time>.png` (the newest 20 are kept) and its Windows path posted to `/api/clipboard` as `{ imagePath }`. Otherwise the text, cut to 20,000 characters, as `{ text }`. An empty clipboard posts `{}`. When the clipboard holds both an image and text, the image wins.
- **Open chat**: a 1100x720 window on `/`, or `/?session=<id>` (`electron.exe <app> --session <id>`, and a link to `/?session=<id>` that a page opens in a new window). Focused if already open.
- **Runner not running**: when `GET /health` does not answer within 1.5 seconds, the shell starts the runner itself: at its own start, on the hotkey and New task, on Open chat and on a toast's click. It runs `wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env` from its `wsl` settings, with no window, and asks `/health` again for up to ten seconds. The pop-up or the chat then opens as if the runner had been there; the clipboard was read when the key was pressed and is posted once the runner answers. If nothing answers after ten seconds, or there are no `wsl` settings, no window opens and a notification says the runner is not running. See "Starting the runner" below.
- **Toasts**: every two seconds the shell asks the runner for `/api/notifications?after=<newest seen>`, giving up after 1.5 seconds. Each notification becomes a Windows toast titled `intuition: <session title>`: a session finished a turn (the body is the start of what it said), a tool call waits for approval (the tool and its command or file), or a turn failed (the error). Clicking the toast opens the chat on that session. See "Toasts" below.
- **One instance**: a second copy hands its command line to the first and exits. That is how `shell stop` works (`--quit`).

## Starting the runner
- **The command.** `wsl.exe` is given an array of arguments and `--exec`, so neither Windows nor a shell in WSL reads the settings' values as a command line: a path with spaces, quotes or `;` stays one argument. A `wsl` setting that could be read as an option (a name starting with `-`, a path not starting with `/`) is refused when the settings are read. Why: [D0006](decisions/D0006-start-stop-and-login.md).
- **The environment.** `--login-env` makes `start` run the runner through your login shell (`zsh -l -i -c …` or bash's equivalent), so sessions get the PATH your terminal has. Whatever your profile prints lands at the top of the runner's log (`bun src/cli.ts logs`). A profile that takes several seconds leaves less of the ten. A profile that replaces the shell with another program (`exec tmux`) would keep the runner from starting: start it from a terminal then.
- **Ten seconds may be short.** On this machine the command took about six seconds with WSL already up, four of them the profile. Right after a login WSL itself has to boot first, so the first notification may say the runner is not running although it comes up moments later; the next hotkey press finds it. This has not been tried after a real login.
- **A runner that dies later** is not restarted by the toast poller, only at the next hotkey, New task, Open chat or toast click.
- **`bun scripts/smoke-start.ts`** runs that very command through the real `wsl.exe` for a runner in temp folders on a free port with the fake agent, and checks that the runner is still up, as its own process and with the login shell's PATH, after `wsl.exe` has returned. It needs Windows and is skipped in CI. It passed on this machine on 2026-11-13. It does not involve Electron: the shell's own spawn of `wsl.exe` (no window, from a Windows program) has not been seen.

## Start on login
- **On and off.** The "Start on login" checkbox in the tray menu, or `bun src/cli.ts shell login on` and `off` from WSL. `bun src/cli.ts shell login status` only reads. All three use Electron's login item (`app.setLoginItemSettings`), which is a value named `intuition` under the Windows user's `Run` registry key: `"<…>\electron.exe" "<…>\intuition\shell"`. Windows lists it under Task Manager > Startup apps, where it can also be switched off.
- **At login** Windows starts the shell, and the shell starts the runner as above. WSL has to boot first, so allow some seconds.
- **The command and a running shell.** `shell login on` works whether or not the shell runs, and a running shell's checkbox follows it. It needs the installed bundle to know `--login`: after updating the repo, `shell install` first.
- **It names the installed folder,** not the repo: installing again does not change it. Removing `%LOCALAPPDATA%\intuition` while it is on leaves a login item that starts nothing: turn it off first.
- **Nothing automatic turns it on.** Not the install, not `up`, not the self-test (which reads it and prints which it is), not any test or script.

## Toasts
- **Nothing replays.** The shell's first poll after it starts only reads the runner's newest number and shows nothing, so a shell started in the morning doesn't toast last night's sessions. The runner keeps its notifications in memory: restarting the runner forgets them, and the shell then shows what the new runner records.
- **A poll that fails is silent.** While the runner is down there is no toast about it; the shell keeps asking and carries on from where it was. (Pressing the hotkey then starts the runner, or says it is not running.)
- **At most five at once.** If more than five arrive between two polls (the machine slept), the newest five are shown. The chat view has all of them.
- **Clicking.** A click opens the chat window on `/?session=<id>`. The shell remembers its newest 20 toasts; an older one, or one from before the shell restarted, may do nothing when clicked in the notification centre. "Open last session" in the tray is the other way there.
- **The app id.** Windows ties a toast to an app user model id; the shell sets `intuition` (`app.setAppUserModelId`).

If no toast appears although a session finished:
1. **Do Not Disturb** (called Focus Assist on Windows 10) is on: the toast goes straight to the notification centre (Win+N), with no banner and no sound. Turn it off from the bell in the taskbar corner, or in Settings > System > Notifications. Windows also turns it on by itself while a full-screen app or a game runs, or while the display is duplicated.
2. **Notifications are off**, for everything or for this app: Settings > System > Notifications. The shell may be listed there as "intuition" or as "Electron", and only after its first toast. If the switch is off, nothing is shown anywhere.
3. **The shell is not running, or runs an old bundle**: look for the tray icon; after `shell install`, stop and start it.
4. **The runner has nothing for it**: `curl http://127.0.0.1:4777/api/notifications` in WSL lists what the runner recorded. If the session's notification is there and its `seq` is higher than at the shell's start, the shell got it and Windows held it back.
5. **Windows wants a Start-menu shortcut.** An app without a shortcut that carries its app id may get no toasts on some Windows versions. The shell has none yet ([D0005](decisions/D0005-toasts.md)). On this machine the self-test's toast was accepted without one.

## What pages can do
The windows are sandboxed, with context isolation, no Node integration and no preload script. Navigation or a redirect to any origin but the runner's is refused, and so is every new window (a link to the runner's own chat view opens in the chat window). Pages get no permissions (camera, location, notifications and the rest) except writing to the clipboard. There is no application menu, so no reload or developer-tools shortcuts.

## Self-test
`bun src/shell/selftest-run.ts` runs on this machine only (it prints `skipped` and exits 0 when `CI` is set or there is no `/mnt/c`). It installs the shell, starts a stub runner on a free port, runs `electron.exe <app> --self-test <result file> --runner-url <stub>`, and checks the JSON the shell writes. The self-test uses its own user data folder and its own hotkey (`Control+Alt+Shift+F11`), so it runs beside a running shell. It puts text and then a small image on the clipboard, then puts back what was there (text or an image; other kinds, such as copied files, are not put back). The pop-up flashes on screen for about a second, without taking focus, and so does the chat window.

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
- toasts: the stub runner starts with two notifications and records a third after the shell's first poll. The first poll sent no `after` and created no toast; the second sent `after=2` and created exactly one, titled `intuition: self-test, please ignore`; Windows answered it with Electron's `show` event; running its click handler opened the chat window on `/?session=self-test-session`; and that session is the one "Open last session" would open. The toast is real: it may show on screen for a few seconds before the test removes it. With Do Not Disturb on, or notifications off, this step may fail: that has not been tried.

What nobody has seen. The self-test cannot press keys, click or look at the screen, and the shell was written from WSL:
- the hotkey being pressed: only that it registers. Pressing it, and pressing it again to focus the pop-up, are untested;
- the tray icon's look, its menu, and the double-click;
- the pop-up taking keyboard focus, hiding on Esc and hiding on a click elsewhere;
- the chat window;
- any notification on screen. **No toast has ever been seen by anyone**: not a session's (finished, approval, error), not "the runner is not running", not "the hotkey is taken". The self-test counts the toasts the shell creates and hears Windows accept one; whether a banner appeared, what it looked like and whether it made a sound are unknown. Windows may hold back toasts from an app that has no Start-menu shortcut;
- a real click on a toast: the self-test calls the click handler itself. Whether Windows delivers the click, from the banner or from the notification centre, is untested;
- "Open last session" in the tray menu being clicked, and its greyed-out state;
- a clipboard image copied by a real program (a screenshot, a browser), as opposed to the PNG the self-test writes itself;
- more than one display, and displays with different scaling;
- the shell starting the runner: its `wsl.exe` command was run from WSL by `scripts/smoke-start.ts`, never by the shell itself, and never after a real login;
- start on login being on. `bun src/cli.ts shell login status` was run on 2026-11-13 and said off. Nobody has turned it on, by the checkbox or by the command, so the checkbox, the registry value and a login with it on are all unseen.

`shell start` and `shell stop` were run once by hand on 2026-11-12: the process list showed the shell running after start, still one shell after a second start, and none after stop.

## Hand-test checklist
Steps 10 to 15 are the toasts, step 9 is the shell starting the runner, and steps 17 to 20 are start on login: nobody has seen any of them yet.

1. In WSL: `bun src/cli.ts shell install`, then `bun src/cli.ts up`. **See**: a line `intuition runner on http://127.0.0.1:4777 …`, and a small blue-violet disc in the tray (maybe under the `^` arrow), with the tooltip "intuition". No window.
2. Copy some text anywhere, then press Ctrl+Alt+Space. **See**: a small window without a title bar in the middle of the screen the mouse is on, above other windows, with the keyboard focus in it. In WSL, `curl http://127.0.0.1:4777/api/clipboard` shows the text (once the runner's clipboard route exists).
3. Press Ctrl+Alt+Space again. **See**: the same window, still there and focused, not a second one.
4. Press Esc. **See**: the window gone. Press the hotkey, then click on another window. **See**: gone again.
5. Take a screenshot to the clipboard (Win+Shift+S), then press the hotkey. **See**: the pop-up, and a new `clip-<time>.png` in `%TEMP%\intuition` that shows the screenshot.
6. Right-click the tray icon. **See**: New task, Open chat, Open last session, a "Start on login" checkbox, Quit. Choose New task. **See**: the pop-up, as in step 2.
7. Double-click the tray icon. **See**: a normal window, about 1100x720, titled "intuition", on the chat view. Double-click again. **See**: the same window brought to the front, not a second one.
8. On a second display, if there is one: move the mouse there and press the hotkey. **See**: the pop-up in the middle of that display.
9. `bun src/cli.ts stop` in WSL, then press the hotkey. **See**: no console window flashing; within about ten seconds, the pop-up, with the clipboard attached. `bun src/cli.ts status` in WSL says `running`. (If instead a notification says the runner is not running, wait a few seconds, press again, and look at `bun src/cli.ts logs`: note how long the start took.)
10. Start the runner again. Press the hotkey, pick a workspace, type `say hello` and send it. Close the chat window if it is open. **See**: within a few seconds of the session finishing, a Windows toast titled "intuition: say hello" whose text is the start of the answer.
11. Click that toast. **See**: the chat window, on that session.
12. Send a task that needs approval, for example `create a file called toast-test.txt containing hi` in a workspace whose settings don't already allow writing. **See**: a toast titled "intuition: create a file called toast-test.txt containing hi" whose text names the tool and the file (`Write: …/toast-test.txt`). Click it. **See**: the chat on that session, with the Allow and Deny card. Allow it. **See**: a second toast when the session finishes.
13. Right-click the tray icon and choose Open last session. **See**: the chat on the session of the newest toast. (Before the first toast since the shell started, the item is greyed out.)
14. `bun src/cli.ts shell stop`, then `bun src/cli.ts shell start`, with the runner left running. Wait ten seconds. **See**: no toast: the ones from steps 10 to 12 do not come back. Then send another task. **See**: one toast, for that task only.
15. If a toast did not appear in steps 10 to 14, go through "If no toast appears" under "Toasts" above, and note which point it was.
16. `bun src/cli.ts shell stop`, or Quit in the tray menu. **See**: the tray icon gone, and the hotkey does nothing.
17. Start on login, from the command: `bun src/cli.ts shell login status`. **See**: `start on login is off`. Then `bun src/cli.ts shell login on`. **See**: `start on login is on`; in Task Manager > Startup apps, an entry named "intuition" or "Electron", enabled; and, if the shell runs, its tray checkbox ticked.
18. From the tray: start the shell, untick "Start on login". **See**: `bun src/cli.ts shell login status` says off, and the entry is gone from Startup apps. Tick it again.
19. `bun src/cli.ts stop` and `bun src/cli.ts shell stop`, then sign out of Windows and in again (or restart). Touch nothing in WSL. **See**: the tray icon within a minute, no console window, and after some seconds the hotkey opens the pop-up. If a notification said the runner is not running first, note it: ten seconds was too short for WSL to boot.
20. `bun src/cli.ts shell login off` if you don't want it. **See**: `start on login is off`.

## Not built yet
A Start-menu shortcut for the app id.
