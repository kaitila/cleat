# D0006: How the runner is started, from WSL, from Windows and at login

Date: 2026-11-13. Status: active.

## Decision
- `bun src/cli.ts start` (`src/cli/runner.ts`) spawns the runner detached, with its output appended to `runner.log` in the data folder, and waits up to ten seconds for `GET /health`. Only then does it write `runner.pid` (the number alone) and `runner.url`. The URL is its own file because `INTUITION_PORT=0` names no port: `start` then picks a free one and hands it to the runner.
- A pid from the file is believed only while `/proc/<pid>/cmdline` names `runner/main.ts`. A file left by a dead runner, or whose number now belongs to another program, is removed, and `stop` never signals such a pid.
- A runner that answers on the configured port without a pid file (`bun run start`, `bun run dev`) counts as running: `start` and `status` say so and exit 0, and `stop` leaves it alone and exits 1.
- `status` exits 0 when the runner answers and 1 when not.
- The shell starts the runner with `wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env` (`shell/src/wsl.ts`, no Electron in it), spawned from an array of arguments with no shell and no window. `--exec` runs bun directly, so no shell in WSL reads the line either. The three values come from the `wsl` object of the shell's settings and are checked when read: the distribution name is letters, digits, `.`, `_` and `-` and does not start with a dash; the two paths are absolute. If one fails the check, the shell has no command and starts nothing.
- `shell install` and `up` write that `wsl` object (`WSL_DISTRO_NAME`, the repo the command ran from, the bun that ran it), keeping the rest of the file. The self-test installs the bundle but does not write it.
- `--login-env`: `start` runs the runner through the person's login shell as `<shell> -l -i -c 'exec "$0" "$@"' <bun> <main.ts>` (`-l` only for `sh` and `dash`; a shell that is not sh, bash, zsh, dash or ksh is replaced by `/bin/sh`). The script is fixed and the paths are its arguments. `exec` makes the shell become the runner, so the pid is the runner's.
- Start on login is Electron's login item, set with the executable `electron.exe`, the app folder in quotes as its one argument, and the name `intuition`. Reading uses the same executable and argument. It is set in two places only: the tray's checkbox and `electron.exe <app> --login on|off`, which `bun src/cli.ts shell login` runs. `--login` runs before the single-instance lock, writes `{ openAtLogin, error }` to `--login-result <file>`, then asks for the lock so that a running shell is handed the command line and redraws its menu.
- The self-test reads the login item and reports it. It fails only if the reading fails.

## Why
- The pid file is written after `/health`, not at spawn: two starts at once then cannot leave the pid of the one that lost the port.
- `--exec` and an array: the settings file is a plain file under the Windows user's AppData. Whatever is in it, the worst it can name is another program to run as bun, which whoever can write that file could do anyway; it cannot add words to a shell command.
- `--login-env`, and `-i` in it: a process started by `wsl.exe --exec` has almost no environment. Sessions run tools with the runner's PATH, and on this machine bun, node and the rest are put on PATH by `.zshrc`, which only an interactive shell reads. VS Code resolves its environment the same way. The price: the profile's own start-up runs (here it adds about four seconds and writes a few complaints about the missing terminal to the log), and a profile that replaces the shell with something else, such as `exec tmux`, would keep the runner from starting.
- The quoted app folder: Windows stores the login item as one command line and Electron joins the arguments with spaces; a user name can hold one.
- `--login` in the shell, not a registry write from WSL: the tray and the command then agree by construction, and nothing but TypeScript is involved.

## Not done here
- Saving the environment of a start from a terminal and reusing it, instead of the interactive login shell.
- Restarting a runner that dies while the shell runs: the shell starts it at its own start and at the next hotkey, Open chat or toast click, not from the poller.
- Rotating `runner.log`: it only grows.
- A Start-menu shortcut (see D0005).
