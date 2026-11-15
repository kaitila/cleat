# Platforms

intuition runs in one of three layouts. `intuition doctor` says which one this machine is and what is missing.

| Layout | The runner | The shell (tray, hotkey, dock) | The shell's folder | Its settings |
|---|---|---|---|---|
| `windows-wsl` | in WSL 2 | on Windows, installed from WSL | `%LOCALAPPDATA%\intuition\shell` | `%APPDATA%\intuition-shell\settings.json`, with `wsl` |
| `macos` | on the Mac | on the Mac | `~/Library/Application Support/intuition/shell` | `~/Library/Application Support/intuition-shell/settings.json`, with `runner` |
| `linux` | on the machine | on the machine | `$XDG_DATA_HOME/intuition/shell` (default `~/.local/share/intuition/shell`) | `$XDG_CONFIG_HOME/intuition-shell/settings.json` (default `~/.config`), with `runner` |

The layout is detected: inside WSL (`WSL_DISTRO_NAME` set, or `microsoft` in `/proc/version`) it is `windows-wsl`, otherwise it follows the OS. `INTUITION_PLATFORM=windows-wsl|macos|linux` overrides it, for tests and for trying the linux layout inside WSL (below). Any other value is refused. Why the layouts are split this way: [D0019](decisions/D0019-platform-layouts.md). The code: `src/shell/platform.ts`.

## Setup, every layout
From a clone of the repo:

1. Install git, [bun](https://bun.sh), Node 22.12 or later with npm (Electron's installer needs it: nvm works), and [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), and log in to Claude Code (`claude auth login`).
2. `bun install`, then `bun src/cli.ts link` once, so `intuition` is on the PATH ([README](../README.md), "Setup").
3. `intuition doctor`. Every `MISS` line is something needed, with its fix on the line below. Doctor exits 1 while one is there.
4. `intuition up`: starts the runner, installs the shell with Electron for this OS (about 130 MB the first time), writes where the runner lives into the shell's settings, and starts the shell.
5. Optional: `intuition shell login on`, so the shell starts when you log in.

`intuition doctor` again should show only `ok` lines. A `--` line is a part that is not up yet (the runner, the shell, start at login, a display), with the one command that brings it up. Those don't change the exit code.

## Windows with WSL
As before this change; everything about it is in [the Windows shell](windows-shell.md). Electron is fetched for Windows x64 from WSL (`npm_config_platform=win32`), with WSL's npm and node. The shell's settings get `wsl: { distro, repo, bun }`, and nothing else is added. The shell on Windows starts the runner through `wsl.exe`. Start at login is the shell's Electron login item (the `Run` registry key).

## macOS
- Electron is fetched for `darwin` and this Mac's architecture (`arm64` or `x64`), into `~/Library/Application Support/intuition/shell`. The executable is `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- `shell install` and `up` write `runner: { "kind": "local", "repo": …, "bun": … }` into the settings. The shell is to start the runner from it, as a detached child process. That is T-0032's part.
- Start at login is the shell's Electron login item, as on Windows (`--login on|off|status`). macOS lists it under System Settings > General > Login Items.

## Linux
- Electron is fetched for `linux` and this machine's architecture, into `~/.local/share/intuition/shell`. The executable is `node_modules/electron/dist/electron`.
- The shell needs a display: `DISPLAY` or `WAYLAND_DISPLAY`. Without one, `up` starts only the runner and says why, and `shell start` refuses. `shell install` works without one.
- The settings get `runner: { "kind": "local", … }`, as on macOS.
- **Start at login** is an XDG autostart file that the command line writes, because Electron's login item does nothing on Linux. `intuition shell login on` writes `~/.config/autostart/intuition.desktop` (or under `$XDG_CONFIG_HOME`), whose `Exec` runs the installed Electron on the app folder. `off` removes it, `status` says whether it is there. The tray's "Start on login" checkbox uses Electron's login item, so on Linux it does not change that file yet: T-0032.
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

## What was tried where
| What | Where | When | Seen |
|---|---|---|---|
| `intuition up` and `intuition shell install`, windows-wsl | this machine (Windows 11, WSL 2 Ubuntu) | 2026-11-15 | As before: the runner was kept, the installed shell was current, the `wsl` settings were written with nothing added, and the shell was started. `shell install` replaced the bundle and found Electron 45.3.1 already installed. `shell login status` read "off". |
| `intuition doctor`, windows-wsl | this machine | 2026-11-15 | All ok but start at login (off), exit 0 |
| `shell install`, linux | this machine's WSL, `INTUITION_PLATFORM=linux` | 2026-11-15 | Electron 45.3.1 for Linux (an x86-64 ELF) in `~/.local/share/intuition/shell`, and `runner: { kind: "local" }` in `~/.config/intuition-shell/settings.json` |
| `shell start` and `shell stop`, linux | WSLg | 2026-11-15 | Electron ran on the app folder with `--no-sandbox` (as root) on X11 (`--ozone-platform=x11`) and wrote its pid to `~/.config/intuition-shell/shell.pid`. Doctor said "shell running". `shell stop` ended it. |
| `shell login on|status|off`, linux | WSLg, temp HOME | 2026-11-15 | Wrote, read and removed `~/.config/autostart/intuition.desktop` |
| `intuition doctor`, linux | WSLg | 2026-11-15 | Exit 0 with nothing installed (parts shown with `--` and their fix), and with the shell installed and running |

## What nobody has seen
- **The macos layout on a Mac.** Nothing here has run on macOS. Its paths and its Electron executable follow Electron's own layout.
- **The linux layout on a real Linux desktop** (GNOME, KDE, a Wayland session), and as a normal user with Chromium's sandbox on. Whether npm's Electron then needs `chrome-sandbox` set up (owned by root, mode 4755) on distributions that restrict unprivileged user namespaces has not been tried.
- **What the shell does on Linux and macOS**: the tray icon, the hotkeys, the clipboard, the dock, the snip, and starting a `local` runner. The shell's code is still written for Windows until T-0032. On WSLg it started and stopped; nobody looked at its windows.
- **An XDG autostart entry run at a real login.**
