# D0043: The app is renamed holm, and an install under the old name moves once

Date: 2026-11-24. Status: active. Task: T-0003 (this machine's foreman board).

## Context
The owner, on 2026-11-24: "lets rename to holm". The name "intuition" was too close to "instinct", and it said nothing about the app. The app's most visible part is the dock, a small island hanging in the notch at the top of the screen. The owner had an install under the old name on a Mac and on a Windows machine with WSL: a config, a sessions store, an installed shell and start at login.

## Decision
- **The name is holm**, an old word for a small island: the island in the notch. It is written "holm" for the command, the folders, the identifiers and in running text, and "Holm" where a sentence starts and where a person sees the app's name (window titles, the tray's tooltip, notification titles, page titles, the dock's pill, the landing page).
- **Everything is renamed**: the command (`holm`), the environment variables (`HOLM_*`), the preload bridges (`window.holmDock`, `window.holmSnip`, `window.holmTheme`), the `localStorage` keys (`holm.*`), the folders (`~/.config/holm`, `~/.local/share/holm`, `~/Library/Application Support/holm`, `%LOCALAPPDATA%\holm`, Electron's `holm-shell`), the login items (`dev.holm.shell`, `holm.desktop`, the Windows Run value `holm`), the temp folder (`<temp>/holm/`), `SessionMeta.source` (`"holm"`), the Claude Code entrypoint, and the repo (`github.com/kaitila/holm`, `kaitila.github.io/holm`).
- **Old decision files are history**: they keep the name they were written under, and so do their rows in the README. `D0009-intuition-command.md` keeps its file name, so links to it keep working.
- **An install under the old name moves once, and nothing is lost.** The old names live only in files named `legacy` (`src/shared/legacy.ts`, `src/runner/legacy.ts`, `src/shell/legacy.ts`, `shell/src/legacy.ts`, `src/web/legacy-storage.js`) and their test:
  - The runner and the CLI move `~/.config/intuition` and `~/.local/share/intuition` to the holm folders the first time they read the config, and print a line saying so. Only the default folders move, never ones named by an environment variable. When the new folder already exists, only what it lacks moves, and nothing is overwritten. While a runner from before the rename still runs from the old data folder, nothing moves and the old folders are used, so `holm start` and `restart` find that runner, stop it, and then read the folders again, which moves them.
  - Stored sessions with the old source read as `"holm"`.
  - `holm shell install` (and so `up` and `setup`) asks a still-running old shell to quit, then moves the old app folder (Electron included, so nothing is downloaded again) and Electron's old user data folder (the shell's settings and the pages' `localStorage`). It replaces the old launch agent (macOS) or autostart file (Linux) with the new one, pointing at the new install.
  - On Windows the old login item is a registry value that only Electron can remove: the shell removes the value named `intuition` at every start. The new value is written, as before, when the runner's settings have start on login on.
  - The chat and the dock load `legacy-storage.js` right after `theme.js`. It moves each `intuition.*` key to `holm.*` once, keeping a value that is already there.
- **The old environment variables work for one release.** Each `INTUITION_*` that is set is taken as its `HOLM_*` when that is not set (`adoptLegacyEnv`, at the start of the CLI, the runner and the shell).

## Why
- **Holm over the alternatives.** Eave and Sill were also considered, both parts of a house's edge, like the notch at the screen's edge. Holm names the island itself, which is what the dock is. It is short, easy to type as a command, and not taken by a tool the owner uses.
- **Move, don't copy.** A copy would leave two sessions stores that drift apart, and a second Electron of 130 MB. A rename within one disk is instant. Across disks it falls back to copy-then-remove.
- **The old runner keeps its folders until it stops.** Moving the data folder under a running runner would lose what it writes next, and the new CLI could no longer find its pid to stop it.
- **The pages' keys move in a script of their own.** `theme.js` must stay the first thing a page loads. A separate file keeps the old names out of the files the rename touches, so the rename script can run again on any checkout and change nothing it should not.

## Risk
- A Windows machine's login item is removed only once the new shell has started. Until then, the old value points at an `electron.exe` that has moved, which does nothing at login.
- The fallback for the old environment variables and the migrations are meant to go after a release. Until then, the files named `legacy` are the only place the old name belongs in code.
