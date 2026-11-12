# The Windows shell

An Electron app in TypeScript (`shell/src/`) that lives in the tray. It does what a web page can't: the global hotkey, the clipboard capture, the tray icon, toasts for sessions, and small windows on the runner's pages. Why Electron: [D0001](decisions/D0001-runner-web-shell.md). What it sends the runner: [protocol](protocol.md).

It is installed and started from WSL. Nothing is built or run with the Node on the Windows side.

## Install, start, stop
| Command | What it does |
|---|---|
| `bun src/cli.ts shell install` | Bundles `shell/src/main.ts` into one file, `main.cjs`, and copies it with `shell/package.json` to `%LOCALAPPDATA%\intuition\shell`. The first time, it also installs Electron there for Windows (npm and node from WSL, with `npm_config_platform=win32` and `npm_config_arch=x64`): a download of about 130 MB. Later installs only replace the bundle, unless `shell/package.json` pins another Electron version. |
| `bun src/cli.ts shell start` | Starts `electron.exe` on that folder and leaves it running. If the shell already runs, this opens its chat window instead. |
| `bun src/cli.ts shell stop` | Asks the running shell to quit. Does nothing when none runs. |
| `bun src/cli.ts shell selftest` | The same as `bun src/shell/selftest-run.ts`, below. |

After installing again, stop and start the shell: a running one keeps the old bundle. The runner (`bun run start`) is started separately.

## Settings
`%APPDATA%\intuition-shell\settings.json`, written with these defaults on first start. Stop and start the shell after changing it.

```json
{
  "runnerUrl": "http://127.0.0.1:4777",
  "hotkey": "Control+Alt+Space"
}
```

- `runnerUrl`: where the runner listens. The shell's windows load this origin and nothing else.
- `hotkey`: an [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator). If another program holds it, the shell says so in a notification at start.

A value that is missing or malformed falls back to its default.

## What it does
- **Tray**: an icon with a menu: New task, Open chat, Open last session, Quit. "Open last session" opens the chat on the session of the newest toast, and is greyed out until there has been one. A double-click opens the chat. There is no window at start.
- **Hotkey, and New task**: captures the clipboard and opens the pop-up, both at once. The pop-up is a frameless 560x380 window, always on top, on the runner's `/prompt`, in the middle of the display the cursor is on. Esc or a click elsewhere hides it. Pressing the hotkey while it is up focuses it. The page closes it with `window.close()`.
- **Clipboard capture**: an image is saved as `%TEMP%\intuition\clip-<time>.png` (the newest 20 are kept) and its Windows path posted to `/api/clipboard` as `{ imagePath }`. Otherwise the text, cut to 20,000 characters, as `{ text }`. An empty clipboard posts `{}`. When the clipboard holds both an image and text, the image wins.
- **Open chat**: a 1100x720 window on `/`, or `/?session=<id>` (`electron.exe <app> --session <id>`, and a link to `/?session=<id>` that a page opens in a new window). Focused if already open.
- **Runner not running**: if `GET /health` does not answer within 1.5 seconds, no window opens and a notification says the runner is not running.
- **Toasts**: every two seconds the shell asks the runner for `/api/notifications?after=<newest seen>`, giving up after 1.5 seconds. Each notification becomes a Windows toast titled `intuition: <session title>`: a session finished a turn (the body is the start of what it said), a tool call waits for approval (the tool and its command or file), or a turn failed (the error). Clicking the toast opens the chat on that session. See "Toasts" below.
- **One instance**: a second copy hands its command line to the first and exits. That is how `shell stop` works (`--quit`).

## Toasts
- **Nothing replays.** The shell's first poll after it starts only reads the runner's newest number and shows nothing, so a shell started in the morning doesn't toast last night's sessions. The runner keeps its notifications in memory: restarting the runner forgets them, and the shell then shows what the new runner records.
- **A poll that fails is silent.** While the runner is down there is no toast about it; the shell keeps asking and carries on from where it was. (Pressing the hotkey then does say the runner is not running.)
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
- with no runner answering, no window opens;
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
- more than one display, and displays with different scaling.

`shell start` and `shell stop` were run once by hand on 2026-11-12: the process list showed the shell running after start, still one shell after a second start, and none after stop.

## Hand-test checklist
Steps 10 to 15 are the toasts, which nobody has seen yet.

1. In WSL: `bun run start`, then `bun src/cli.ts shell install` and `bun src/cli.ts shell start`. **See**: a small blue-violet disc in the tray (maybe under the `^` arrow), with the tooltip "intuition". No window.
2. Copy some text anywhere, then press Ctrl+Alt+Space. **See**: a small window without a title bar in the middle of the screen the mouse is on, above other windows, with the keyboard focus in it. In WSL, `curl http://127.0.0.1:4777/api/clipboard` shows the text (once the runner's clipboard route exists).
3. Press Ctrl+Alt+Space again. **See**: the same window, still there and focused, not a second one.
4. Press Esc. **See**: the window gone. Press the hotkey, then click on another window. **See**: gone again.
5. Take a screenshot to the clipboard (Win+Shift+S), then press the hotkey. **See**: the pop-up, and a new `clip-<time>.png` in `%TEMP%\intuition` that shows the screenshot.
6. Right-click the tray icon. **See**: New task, Open chat, Quit. Choose New task. **See**: the pop-up, as in step 2.
7. Double-click the tray icon. **See**: a normal window, about 1100x720, titled "intuition", on the chat view. Double-click again. **See**: the same window brought to the front, not a second one.
8. On a second display, if there is one: move the mouse there and press the hotkey. **See**: the pop-up in the middle of that display.
9. Stop the runner (Ctrl+C in WSL), then press the hotkey. **See**: no window, and a Windows notification "intuition: the runner is not running".
10. Start the runner again. Press the hotkey, pick a workspace, type `say hello` and send it. Close the chat window if it is open. **See**: within a few seconds of the session finishing, a Windows toast titled "intuition: say hello" whose text is the start of the answer.
11. Click that toast. **See**: the chat window, on that session.
12. Send a task that needs approval, for example `create a file called toast-test.txt containing hi` in a workspace whose settings don't already allow writing. **See**: a toast titled "intuition: create a file called toast-test.txt containing hi" whose text names the tool and the file (`Write: …/toast-test.txt`). Click it. **See**: the chat on that session, with the Allow and Deny card. Allow it. **See**: a second toast when the session finishes.
13. Right-click the tray icon and choose Open last session. **See**: the chat on the session of the newest toast. (Before the first toast since the shell started, the item is greyed out.)
14. `bun src/cli.ts shell stop`, then `bun src/cli.ts shell start`, with the runner left running. Wait ten seconds. **See**: no toast: the ones from steps 10 to 12 do not come back. Then send another task. **See**: one toast, for that task only.
15. If a toast did not appear in steps 10 to 14, go through "If no toast appears" under "Toasts" above, and note which point it was.
16. `bun src/cli.ts shell stop`, or Quit in the tray menu. **See**: the tray icon gone, and the hotkey does nothing.

## Not built yet
Start on login is a later task, and so is a Start-menu shortcut for the app id.
