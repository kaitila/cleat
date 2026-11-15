# D0019: Three layouts behind one platform module, `runner` for the native shells, and no Chromium sandbox as root on Linux

Date: 2026-11-15. Status: active. Task: T-0040.

## Context
The owner on 2026-11-15: intuition must set up on macOS and Linux as well as Windows with WSL, for everyone, from a clone. Until now the command line assumed one machine: the runner in WSL and the shell on Windows, installed from WSL through `/mnt/c`, `cmd.exe`, `wslpath` and `tasklist.exe`. T-0032 makes the shell's own code (`shell/src`) work on macOS and Linux; this decision is the command line's side.

## Decision
- **Three layouts, one module.** `src/shell/platform.ts` names the layout: `windows-wsl` (the runner in WSL, the shell on Windows), `macos` and `linux` (the runner and the shell on one machine). It is detected: `INTUITION_PLATFORM` when set, else WSL (`WSL_DISTRO_NAME`, or `microsoft` in `/proc/version`), else `process.platform`. Each layout gives the shell's folder, its settings file, the npm environment that fetches Electron for its OS, how Electron is handed the app folder, how a pid is checked and how start at login is set. `install.ts`, `cli.ts` and `doctor.ts` ask it, and nothing else in `src/shell` or `src/cli` tests for Windows. The Windows-only self-test (`selftest-run.ts`) and `paths.ts` stay as they were: they are the `windows-wsl` layout's own code.
- **The settings: `wsl` stays, `runner` is new.** For `windows-wsl`, `shell install` and `up` write `wsl: { distro, repo, bun }` exactly as before, and nothing else. The shell on Windows reads that today. For `macos` and `linux` they write `runner: { kind: "local", repo, bun }`, which T-0032's shell reads to start the runner as a detached child process. The task's spec asked for `runner: { kind: "wsl", … }` on Windows too. That would add a key no shell reads yet, and it would break the existing test that the Windows settings hold `wsl` and nothing else. So T-0032 (or a later task) moves Windows to `runner.kind = "wsl"` when the shell reads it, keeping `wsl` as the fallback.
- **Start at login on Linux is a file the command line writes.** Electron's login item does nothing on Linux. `intuition shell login on` writes `$XDG_CONFIG_HOME/autostart/intuition.desktop` (default `~/.config/autostart`), whose `Exec` runs the installed Electron on the app folder, as `shell start` does. `off` removes it, and `status` says whether it exists. Windows and macOS keep the shell's Electron login item (`--login on|off|status`).
- **`--no-sandbox` only on Linux, and only as root.** Chromium refuses to start as root with its sandbox, and WSL's default user is root. Only then does the linux layout pass `--no-sandbox`, on `shell start`, on `shell stop`, and in the autostart file. A normal user on a normal Linux desktop keeps the sandbox.
- **`intuition doctor` splits needed from not yet up.** git, bun, Node 22.12 or later with npm (Electron's installer needs it), Claude Code installed and logged in (`claude auth status`), a readable config and, for `windows-wsl`, the Windows disk are needed: doctor exits 1 when one is missing. The runner, the shell installed and running, start at login, and a display on Linux are parts that `intuition up` or one command brings up. They are printed with their fix but don't change the exit code.

## Why
- Putting each layout behind one object keeps the windows-wsl code path the same calls in the same order. `up` on this machine printed what it printed before, wrote the same `wsl` settings, and kept the shell installed.
- Leaving `wsl` alone means an older shell on Windows keeps working with a newer command line, and the reverse.
- doctor's exit code is for scripts and for T-0033's `intuition setup`. A machine with everything needed but nothing running yet is healthy: one `intuition up` finishes it.

## Risk
- macOS is untested: nobody has run the macos layout on a Mac. Its paths follow Electron's own (`~/Library/Application Support`), and its Electron executable is `Electron.app/Contents/MacOS/Electron`.
- `--no-sandbox` as root turns off Chromium's OS sandbox for the shell's renderers. They load only the runner's origin (`127.0.0.1`), and the windows still run with `sandbox: true` and no Node.
