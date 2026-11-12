# The Windows shell

An Electron app in TypeScript (`shell/src/`) that lives in the tray. It does what a web page can't: the global hotkey, the clipboard capture, the tray icon, and small windows on the runner's pages. Why Electron: [D0001](decisions/D0001-runner-web-shell.md). What it sends the runner: [protocol](protocol.md).

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
- **Tray**: an icon with a menu: New task, Open chat, Quit. A double-click opens the chat. There is no window at start.
- **Hotkey, and New task**: captures the clipboard and opens the pop-up, both at once. The pop-up is a frameless 560x380 window, always on top, on the runner's `/prompt`, in the middle of the display the cursor is on. Esc or a click elsewhere hides it. Pressing the hotkey while it is up focuses it. The page closes it with `window.close()`.
- **Clipboard capture**: an image is saved as `%TEMP%\intuition\clip-<time>.png` (the newest 20 are kept) and its Windows path posted to `/api/clipboard` as `{ imagePath }`. Otherwise the text, cut to 20,000 characters, as `{ text }`. An empty clipboard posts `{}`. When the clipboard holds both an image and text, the image wins.
- **Open chat**: a 1100x720 window on `/`, or `/?session=<id>` (`electron.exe <app> --session <id>`, and a link to `/?session=<id>` that a page opens in a new window). Focused if already open.
- **Runner not running**: if `GET /health` does not answer within 1.5 seconds, no window opens and a notification says the runner is not running.
- **One instance**: a second copy hands its command line to the first and exits. That is how `shell stop` works (`--quit`).

## What pages can do
The windows are sandboxed, with context isolation, no Node integration and no preload script. Navigation or a redirect to any origin but the runner's is refused, and so is every new window (a link to the runner's own chat view opens in the chat window). Pages get no permissions (camera, location, notifications and the rest) except writing to the clipboard. There is no application menu, so no reload or developer-tools shortcuts.

## Self-test
`bun src/shell/selftest-run.ts` runs on this machine only (it prints `skipped` and exits 0 when `CI` is set or there is no `/mnt/c`). It installs the shell, starts a stub runner on a free port, runs `electron.exe <app> --self-test <result file> --runner-url <stub>`, and checks the JSON the shell writes. The self-test uses its own user data folder and its own hotkey (`Control+Alt+Shift+F11`), so it runs beside a running shell. It puts text and then a small image on the clipboard, then puts back what was there (text or an image; other kinds, such as copied files, are not put back). The pop-up flashes on screen for about a second, without taking focus.

What it covers, on the real Windows desktop:
- a global hotkey registers;
- the tray icon is created (then removed at once);
- a text clipboard is captured and posted, and the stub runner received it;
- an image clipboard is captured, saved as a PNG under `%TEMP%\intuition`, and its path posted; the file exists under `/mnt/c` and starts with the PNG signature (the test then deletes it);
- Windows says notifications are supported;
- the pop-up is created at 560x380, loads `/prompt`, is visible, and is centred on the display under the cursor;
- a navigation and a new window to another origin are both refused;
- `window.close()` from the page closes the pop-up;
- with no runner answering, no window opens.

What nobody has seen. The self-test cannot press keys, click or look at the screen, and the shell was written from WSL:
- the hotkey being pressed: only that it registers. Pressing it, and pressing it again to focus the pop-up, are untested;
- the tray icon's look, its menu, and the double-click;
- the pop-up taking keyboard focus, hiding on Esc and hiding on a click elsewhere;
- the chat window;
- any notification on screen: neither "the runner is not running" nor "the hotkey is taken" has been seen. Windows may hold back toasts from an app that has no Start-menu shortcut;
- a clipboard image copied by a real program (a screenshot, a browser), as opposed to the PNG the self-test writes itself;
- more than one display, and displays with different scaling.

`shell start` and `shell stop` were run once by hand on 2026-11-12: the process list showed the shell running after start, still one shell after a second start, and none after stop.

## Hand-test checklist
The runner's pages are built in other tasks. Until they are, `/prompt` and `/` answer "not found" as JSON, and the windows show that text; the steps still hold.

1. In WSL: `bun run start`, then `bun src/cli.ts shell install` and `bun src/cli.ts shell start`. **See**: a small blue-violet disc in the tray (maybe under the `^` arrow), with the tooltip "intuition". No window.
2. Copy some text anywhere, then press Ctrl+Alt+Space. **See**: a small window without a title bar in the middle of the screen the mouse is on, above other windows, with the keyboard focus in it. In WSL, `curl http://127.0.0.1:4777/api/clipboard` shows the text (once the runner's clipboard route exists).
3. Press Ctrl+Alt+Space again. **See**: the same window, still there and focused, not a second one.
4. Press Esc. **See**: the window gone. Press the hotkey, then click on another window. **See**: gone again.
5. Take a screenshot to the clipboard (Win+Shift+S), then press the hotkey. **See**: the pop-up, and a new `clip-<time>.png` in `%TEMP%\intuition` that shows the screenshot.
6. Right-click the tray icon. **See**: New task, Open chat, Quit. Choose New task. **See**: the pop-up, as in step 2.
7. Double-click the tray icon. **See**: a normal window, about 1100x720, titled "intuition", on the chat view. Double-click again. **See**: the same window brought to the front, not a second one.
8. On a second display, if there is one: move the mouse there and press the hotkey. **See**: the pop-up in the middle of that display.
9. Stop the runner (Ctrl+C in WSL), then press the hotkey. **See**: no window, and a Windows notification "intuition: the runner is not running".
10. `bun src/cli.ts shell stop`, or Quit in the tray menu. **See**: the tray icon gone, and the hotkey does nothing.

## Not built yet
Toasts for sessions (the shell polling `/api/notifications`) and start on login are later tasks. `notify()` and `openChat(sessionId)` in `shell/src/main.ts` are where they attach.
