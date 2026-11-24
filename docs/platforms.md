# Platforms

intuition runs in one of three layouts. `intuition doctor` says which one this machine is and what is missing.

| Layout | The runner | The shell (tray, hotkey, dock) | The shell's folder | Its settings |
|---|---|---|---|---|
| `windows-wsl` | in WSL 2 | on Windows, installed from WSL | `%LOCALAPPDATA%\intuition\shell` | `%APPDATA%\intuition-shell\settings.json`, with `wsl` |
| `macos` | on the Mac | on the Mac | `~/Library/Application Support/intuition/shell` | `~/Library/Application Support/intuition-shell/settings.json`, with `runner` |
| `linux` | on the machine | on the machine | `$XDG_DATA_HOME/intuition/shell` (default `~/.local/share/intuition/shell`) | `$XDG_CONFIG_HOME/intuition-shell/settings.json` (default `~/.config`), with `runner` |

The layout is detected: inside WSL (`WSL_DISTRO_NAME` set, or `microsoft` in `/proc/version`) it is `windows-wsl`, otherwise it follows the OS. `INTUITION_PLATFORM=windows-wsl|macos|linux` overrides it, for tests and for trying the linux layout inside WSL (below). Any other value is refused. Why the layouts are split this way: [D0019](decisions/D0019-platform-layouts.md). The code: `src/shell/platform.ts`.

## Setup, every layout
```sh
git clone https://github.com/kaitila/intuition && cd intuition && bun install && bun run setup
```

`bun run setup` is `bun src/cli.ts setup` (`src/cli/setup.ts`). It assumes nothing about the machine: the layout, the home folder, and for windows-wsl the WSL distribution (`WSL_DISTRO_NAME`) and the Windows user's folders (asked of `cmd.exe`) are all detected. In order:

1. Checks git, bun, Node 22.12 or later with npm (Electron's installer needs it), Claude Code and its login, and Codex (optional), each under a spinner and each with a one-line fix, as `intuition doctor` does. Missing git, Node or Claude Code stops it, with Check again or Quit on a terminal; a missing login is only warned about, with the command to run. Setup never installs or logs in for you.
2. Asks for the workspaces: a list to tick of the folders one or two levels under the home folder that hold a `.git` or a `CLAUDE.md` (newest first, at most 12, the config's own ticked first), and "Add a folder…" for any other path; then which one is the default.
3. Shows the two hotkeys, the layout's defaults (Control+Alt+Space and Control+Alt+S; Command+Shift+Space and Command+Shift+S on a Mac), to keep or change; a changed one must be an Electron accelerator.
4. Asks for the permission mode: auto (recommended) or default (ask for everything).
5. Asks whether to start at login: yes by default.
6. Then does the work, each step under a spinner: writes the config once, atomically, keeping what else is in it; links the command (`intuition link`); installs the shell for the layout (or installs it again when it is older than the repo's); starts the runner; starts the shell with `--prompt`, which opens the pop-up; sets start at login. Without a display (linux) or without the Windows disk (windows-wsl) the shell steps are skipped, and said so. A step that fails says why and the command that retries it.

Esc or Ctrl+C at any question ends it with nothing written (exit 130). `setup --yes` takes every default and asks nothing (the workspaces kept from an existing config, or none; start at login on), and starts the shell without the pop-up. `--workspace [name=]<folder>` (any number of times), `--hotkey`, `--snip-hotkey`, `--permission-mode auto|default`, `--no-login` answer the questions (start at login is on without it), and `--link-dir <folder>` puts the link elsewhere than the folder bun is in. Without a terminal (a pipe, CI, TERM=dumb) setup needs `--yes` or all of those flags; otherwise it says so and exits 2. `env -u CI bun scripts/cli-setup-pty.ts` runs the interactive flow for real in a pseudo-terminal. Plain `intuition` runs setup when there is no config yet. `bun scripts/setup-check.ts` runs the whole of it from a fresh clone in a temp home and then `intuition doctor`; inside WSL it uses the linux layout under WSLg, so the Windows user's real shell is not touched.

`intuition uninstall` undoes it: start at login off, the shell quit and its folders removed (the app folder and the shell's settings folder), the runner stopped, the link removed. The config and the data folder stay unless `--purge`.

By hand, the same steps are `bun src/cli.ts link`, `intuition doctor` (every ✗ line is something needed, with its fix on the line below; doctor exits 1 while one is there, and `--json` prints the checks for scripts), `intuition up` (starts the runner, installs the shell with Electron for this OS, about 130 MB the first time, writes where the runner lives into the shell's settings and starts the shell) and `intuition shell login on`.

`intuition doctor` again should show only ✓ lines. The settings page's Setup section shows the same from the running app: the layout, the runner, the shell, start at login, the shortcuts and, on a Mac, Screen Recording, each with what to do when it is not ok. A – line is a part that is not up yet (the runner, the shell, start at login, a display), with the one command that brings it up. Those don't change the exit code.

## Windows with WSL
As before this change; everything about it is in [the Windows shell](windows-shell.md). Electron is fetched for Windows x64 from WSL (`npm_config_platform=win32`), with WSL's npm and node. The shell's settings get `wsl: { distro, repo, bun }`, and nothing else is added. The shell on Windows starts the runner through `wsl.exe`. Start at login is the shell's Electron login item (the `Run` registry key).

## macOS
- Electron is fetched for `darwin` and this Mac's architecture (`arm64` or `x64`), into `~/Library/Application Support/intuition/shell`. The executable is `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- `shell install` and `up` write `runner: { "kind": "local", "repo": …, "bun": … }` into the settings. When the runner does not answer, the shell starts it from there: `bun <repo>/src/cli.ts start --login-env`, a detached child process, so it outlives the shell and has the login shell's PATH.
- **The menu bar.** The tray is a template icon in the menu bar, and the shell hides itself from the Dock and the app switcher.
- **Hotkeys** default to Command+Shift+Space (new task) and Command+Shift+S (snip). The shell sends its defaults to the runner once; after that the settings page changes them.
- **The dock** grows out of the notch on a display that has one ([D0035](decisions/D0035-dock-from-the-notch.md)): the shell measures the primary display's notch through AppKit (`osascript -l JavaScript`, an argument array), puts the window on the very top edge, centred on the notch, above the menu bar (`enableLargerThanScreen`, level `status`), and loads `/dock?notch=WxH`. The island is the notch's black: the notch itself with nothing going on, a wing each side for the dot and the words otherwise, the peek and the panel below the notch's band. Without a notch (an external display as the primary, a Mac without one, a failed measurement) the shell gives it a stand-in ([D0037](decisions/D0037-stand-in-notch.md), `dockNotchOf`): 180x30 points at the display's top centre, and the dock grows out of that the same way. On every Space either way.
- **Frosted pop-up.** The pop-up is made with vibrancy (`popover`, `visualEffectState: "active"`, so it stays frosted while it does not have the focus), the macOS material behind its transparent page. The dock has none, as on every OS ([the Windows shell](windows-shell.md), "Frosted windows").
- **Screen Recording.** The snip captures the screens with Electron's desktopCapturer, which macOS allows only with Screen Recording. The shell checks it (`systemPreferences.getMediaAccessStatus("screen")`) at start and at each snip; when it is missing it says so once, and clicking the notification opens System Settings > Privacy & Security > Screen Recording. Allow "Electron" there (the shell runs as npm's Electron.app), then quit the shell and start it again. Until then a snip shows only the wallpaper. The settings page's Setup section has a line for it, with a button that asks the shell to open that pane ([protocol](protocol.md), "Platform").
- **Start at login** is a launch agent, `~/Library/LaunchAgents/dev.intuition.shell.plist`, that runs the installed Electron on the app folder, as `shell start` does. Electron's own login item would register npm's Electron.app, which starts Electron's default app without the shell ([D0023](decisions/D0023-native-shell.md)). The tray's checkbox, the settings page and `intuition shell login on|off|status` all write or read that file. macOS shows "Background Items Added" the first time.
- Clipboard images and snips are saved in `$TMPDIR/intuition/`, and the runner takes only a PNG directly in that folder ([protocol](protocol.md), "Clipboard images").

## Linux
- Electron is fetched for `linux` and this machine's architecture, into `~/.local/share/intuition/shell`. The executable is `node_modules/electron/dist/electron`.
- The shell needs a display: `DISPLAY` or `WAYLAND_DISPLAY`. Without one, `up` starts only the runner and says why, and `shell start` refuses. `shell install` works without one.
- The settings get `runner: { "kind": "local", … }`, as on macOS.
- **Start at login** is an XDG autostart file, because Electron's login item does nothing on Linux. `intuition shell login on` writes `~/.config/autostart/intuition.desktop` (or under `$XDG_CONFIG_HOME`), whose `Exec` runs the installed Electron on the app folder. `off` removes it, `status` says whether it is there. The tray's checkbox and the settings page write and read the same file.
- **X11 or Wayland.** With `DISPLAY` set the shell runs on X11 (`--ozone-platform=x11`, XWayland on a Wayland desktop): global shortcuts, placing the pop-up and the dock, and always-on-top work there. With only `WAYLAND_DISPLAY` it runs on Wayland, where the hotkeys may not register; it says so once, and the tray's New task and Snip do the same.
- **The tray** is Electron's, a StatusNotifierItem. GNOME's top bar shows one only with the AppIndicator extension: on GNOME the shell asks `gnome-extensions list --enabled`, and when none is enabled it says to install `gnome-shell-extension-appindicator`. KDE, Xfce, Cinnamon and most others show it as they are.
- **The dock** is a transparent always-on-top window, which needs a compositor. Under Wayland and on desktops that composite by default (GNOME, KDE, Xfce, Cinnamon, MATE, LXQt, Budgie and others named in `shell/src/os.ts`) it is. Anywhere else (a bare window manager, Xvfb) the dock is an opaque window the size of the island, which follows the island as it opens and closes. `INTUITION_DOCK_OPAQUE=1` forces the opaque dock, `0` the transparent one.
- **No material.** Linux has no OS blur Electron can ask for: the pop-up and the dock are transparent windows (opaque without a compositor), and the page's translucent fill is all the glass there is.
- Clipboard images and snips are saved in `/tmp/intuition/` (the OS temp folder), and the runner takes only a PNG directly in that folder.
- **As root** (WSL's default user), Chromium will not start with its sandbox, so the linux layout then passes `--no-sandbox` to `shell start`, `shell stop` and the autostart entry. A normal user keeps the sandbox.

## The linux layout inside WSL (WSLg)
WSLg gives WSL a display (`DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`), so the linux layout runs for real on a Windows machine:

```sh
INTUITION_PLATFORM=linux intuition doctor
INTUITION_PLATFORM=linux intuition shell install    # Electron for Linux, under ~/.local/share/intuition/shell
INTUITION_PLATFORM=linux intuition shell start
INTUITION_PLATFORM=linux intuition shell stop
# start at login, in a throwaway HOME (the shell's folder from the real one):
HOME=$(mktemp -d) XDG_DATA_HOME=~/.local/share INTUITION_PLATFORM=linux intuition shell login on
```

It shares the runner (port 4777) with the Windows shell, and both shells register the same hotkeys, so stop one before trying the other.

`INTUITION_PLATFORM=linux bun src/shell/selftest-run.ts` runs the shell's self-test there. WSLg gives Electron no pixels of the screen, so the snip's capture, crop and time are skipped and named in its output; and its window manager keeps a window a pixel smaller than the display, which the self-test takes on Linux.

## The self-test, per layout
`bun src/shell/selftest-run.ts` installs the shell for this machine's layout, starts a stub runner and runs the shell with `--self-test`, then checks every field it wrote against that layout: the paths it saves (`<temp>\intuition\` on Windows, `<temp>/intuition/` elsewhere), the dock's place (on a Mac from the very top, centred on the notch it measured or its stand-in, with `?notch=WxH` in the page's address; the island's size when opaque), and the rest as on Windows. It is skipped when `CI` is set; the CI jobs with a desktop run it with `env -u CI`. What it cannot judge for a known reason is printed as `skipped:` with why, and does not fail it: macOS without Screen Recording, and WSLg's empty captures.

CI runs it on `macos-latest` (job `macos`, after the unit tests) and on `ubuntu-latest` under Xvfb with no window manager (job `linux-shell`: the opaque dock, Chromium's sandbox on, as a normal user). There `webContents.forcefullyCrashRenderer()` leaves the sandboxed page process running (`isCrashed()` stays false, no `render-process-gone`) and a load into that window hangs, so the self-test kills the dock's page process with SIGKILL itself and says so in its output; the shell's part is judged the same. The shell itself replaces a dock window whose page process died instead of loading into it, hides a crashed dock at the next check if the event was missed, and gives up on a dock page that has not loaded in 15 s (the window goes, the next check makes a new one).

## What was tried where
| What | Where | When | Seen |
|---|---|---|---|
| `intuition up` and `intuition shell install`, windows-wsl | this machine (Windows 11, WSL 2 Ubuntu) | 2026-11-15 | As before: the runner was kept, the installed shell was current, the `wsl` settings were written with nothing added, and the shell was started. `shell install` replaced the bundle and found Electron 45.3.1 already installed. `shell login status` read "off". |
| `intuition doctor`, windows-wsl | this machine | 2026-11-15 | All ok but start at login (off), exit 0 |
| `shell install`, linux | this machine's WSL, `INTUITION_PLATFORM=linux` | 2026-11-15 | Electron 45.3.1 for Linux (an x86-64 ELF) in `~/.local/share/intuition/shell`, and `runner: { kind: "local" }` in `~/.config/intuition-shell/settings.json` |
| `shell start` and `shell stop`, linux | WSLg | 2026-11-15 | Electron ran on the app folder with `--no-sandbox` (as root) on X11 (`--ozone-platform=x11`) and wrote its pid to `~/.config/intuition-shell/shell.pid`. Doctor said "shell running". `shell stop` ended it. |
| `shell login on|status|off`, linux | WSLg, temp HOME | 2026-11-15 | Wrote, read and removed `~/.config/autostart/intuition.desktop` |
| `intuition doctor`, linux | WSLg | 2026-11-15 | Exit 0 with nothing installed (parts shown with `--` and their fix), and with the shell installed and running |
| The shell's self-test, linux | WSLg, as root (`--no-sandbox`), X11 through XWayland | 2026-11-15 | Passed. Hotkeys, tray, clipboard text and image, the pop-up (placed again once shown: WSLg's window manager put it at 0,0), the dock (transparent), the snip's overlays and bridge, start on login read. The capture came back empty after about 3 s: skipped |
| The shell's self-test, linux | WSLg's Xvfb (`xvfb-run`, no window manager), as root | 2026-11-15 | Passed, the dock opaque |
| The shell's self-test, macos | a 14-inch MacBook Pro (notch 179x32 points, display 1470x956) | 2026-11-22 | Passed. The notch measured through AppKit, the dock's window at the very top edge centred on it, `/dock?notch=179x32` loaded. Seen by a person: not yet |
| The shell's self-test, linux | CI `linux-shell` (ubuntu-latest, Xvfb, sandbox on), PR #36 | 2026-11-15 | Passed. The renderer crash was not taken by `forcefullyCrashRenderer()` under the sandbox: the self-test kills it |
| The shell's self-test, windows-wsl | this machine | 2026-11-15 | Passed, after the change: the same checks as before |
| The shell's self-test with the materials (T-0050), windows-wsl | this machine, Windows build 26200 | 2026-11-15 | Passed. `materials (Windows 10.0.26200): pop-up acrylic, dock none, snip none, settings none` |
| The shell's self-test with the materials (T-0050), linux | WSLg, as root, X11 | 2026-11-15 | Passed. `materials: pop-up none, dock none, snip none, settings none`; the pop-up is now a transparent window |

## What nobody has seen
- **The macos layout on a Mac.** Nothing here has run on macOS. Its paths and its Electron executable follow Electron's own layout.
- **The linux layout on a real Linux desktop** (GNOME, KDE, a Wayland session), and as a normal user with Chromium's sandbox on. Whether npm's Electron then needs `chrome-sandbox` set up (owned by root, mode 4755) on distributions that restrict unprivileged user namespaces has not been tried.
- **What the shell does on Linux and macOS, seen by a person.** The self-test runs it on WSLg and in CI, but nobody has looked at its windows, the menu bar icon, the opaque dock, or a snip with real pixels on Linux. Starting a `local` runner from the shell has not been tried (the self-test never starts one).
- **The pop-up's vibrancy on a Mac**: chosen by the self-test's rules (`windowMaterial`), never seen.
- **Screen Recording granted on a Mac**, and the notice's click opening System Settings. The macOS CI runner cannot grant it.
- **A launch agent run at a real Mac login**, and a GNOME desktop without AppIndicator.
- **An XDG autostart entry run at a real login.**
