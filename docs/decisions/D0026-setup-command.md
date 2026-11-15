# D0026: `intuition setup` asks, then does; `--yes` takes defaults and opens no pop-up; the shell opens the pop-up with `--prompt`

Date: 2026-11-15. Status: active; how setup asks, its order and the login are now [D0030](D0030-console-setup.md). Task: T-0033. Builds on [D0019](D0019-platform-layouts.md), [D0022](D0022-runner-owns-the-settings.md) and [D0024](D0024-no-default-workspaces.md).

## Context
The owner wants a fresh clone to run with one copy-paste line, on any machine (Windows with WSL, macOS, Linux), with start at login on by default, and a way back out (`intuition uninstall`).

## Decision
- **Check, ask, then do.** `src/cli/setup.ts` checks the prerequisites first (doctor's `prerequisites`, the same checks and fixes), asks every question next (workspaces, hotkeys, start at login), writes the config through the runner's `writeSettings` (unknown keys kept), and only then starts the runner, installs the shell (`up`'s `installCurrentShell`), sets start at login, links the command and starts the shell. A missing git, Node with npm or Claude Code stops it before anything is written; a missing login is offered (`claude auth login`) and otherwise only warned about, since everything else can be set up without it.
- **Workspace suggestions** are folders one or two levels under the home folder with a `.git` or a `CLAUDE.md`, not inside one, skipping hidden folders and dependency or OS folders, at most 30. The default answer is the workspaces the config already has: none on a first run, as D0024 says.
- **`--yes` is for scripts**: every default (start at login on), and the shell is started without the pop-up, since nobody is there. `--workspace` and `--link-dir` give what a script cannot be asked.
- **The pop-up is opened by the shell**: `--prompt` on its command line, handed to a running shell as a second instance, or taken by a shell that starts with it once the runner answers. The command line has no other way to show a window.
- **Plain `intuition` runs setup** while there is no config file; once there is one, it is `up` as before.
- **Uninstall keeps the data folder's other contents**: it removes the shell's app folder and its user data folder, and the shell's home only when it is empty, because on macOS and Linux that home is also the default data folder (the sessions).
- **The fresh-clone check** (`scripts/setup-check.ts`) runs in a temp HOME; inside WSL it forces the linux layout under WSLg, so the Windows user's real shell, settings and login item are never replaced by a throwaway clone's.

## Risk
- `setup --yes` on a machine that already runs intuition replaces the shell when it is older and keeps the config's workspaces: it is safe to run again, but it is the real machine.
