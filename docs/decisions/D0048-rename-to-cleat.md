# D0048: The app is renamed cleat, and an install under either old name moves straight to it

Date: 2026-11-24. Status: active. Supersedes the name in [D0043](D0043-rename-to-holm.md); its migration approach stands and is extended here.

## Context
The app was renamed from intuition to holm earlier the same day (D0043). The owner then asked for other names and picked one from ten options (bide, stoop, moku, tarry, dais, kip, mote, cleat, molo, ondo): "lets do cleat for now". Installs existed under both old names: the owner's Mac had migrated from intuition to holm an hour before, and the owner's Windows machine with WSL was still under intuition.

## Decision
- **The name is cleat**, the fitting on a quay that a boat is tied to: the agents are made fast to it and wait there. It is written "cleat" for the command, the folders, the identifiers and in running text, and "Cleat" where a sentence starts and where a person sees the app's name (window titles, the tray's tooltip, notification titles, page titles, the dock's pill, the landing page). "For now": a later rename follows this same path.
- **Everything is renamed**, as in D0043: the command and package (`cleat`, `cleat-shell`), `CLEAT_*`, the bridges (`window.cleatDock`, `cleatSnip`, `cleatTheme`, `cleatEmbed`), the `localStorage` keys (`cleat.*`), the folders (`~/.config/cleat`, `~/.local/share/cleat`, `~/Library/Application Support/cleat`, `%LOCALAPPDATA%\cleat`, Electron's `cleat-shell`), the login items (`dev.cleat.shell`, `cleat.desktop`, the Windows Run value `cleat`), the temp folder, `SessionMeta.source` (`"cleat"`), the Claude Code entrypoint, and the repo (`github.com/kaitila/cleat`, `kaitila.github.io/cleat`, so the install line is `curl -fsSL https://kaitila.github.io/cleat/install.sh | sh`). The logo stays the Ledge (D0044).
- **Both old names migrate, each straight to cleat.** The legacy files (`src/shared/legacy.ts` and its `OLD_NAMES`, newest first: holm, then intuition) list what each old name called every thing, and every move goes through that list:
  - the config and data folders, the installed shell and Electron's user data, the macOS launch agents and the Linux autostart files, the Windows Run values (the new shell removes both at every start), the command's links (`link` and `unlink` remove an old link that points at this checkout), the pages' storage keys, stored sessions' `source`, and the environment variables (`HOLM_X`, then `INTUITION_X`, taken as `CLEAT_X` when that is not set, for one release);
  - **nothing under the new name is overwritten**: what already exists as cleat is kept, then holm's things move, then intuition's fill only what is still missing;
  - **an old runner or shell that still runs is stopped first**, as in D0043: while a holm or intuition runner runs from its data folder, that name's folders are used, so `cleat start` and `restart` find it, stop it and then move them; `cleat shell install` asks every old shell that still runs to quit before anything moves.
- **Old decision files are history**: D0043 and the others keep the names they were written under, and so do their rows in the README. `D0043-rename-to-holm.md` and `D0009-intuition-command.md` keep their file names, so links keep working.

## Why
- **Cleat over the other nine.** Short, easy to type as a command, a concrete thing with one meaning, and it says what the app is for: a place where work is tied up while it waits. "For now" means the choice is cheap to revisit, which the migration list makes true.
- **One list of old names, not a chain of migrations.** Moving holm to cleat and keeping intuition-to-holm would move a Windows install twice, through a name nobody uses any more. Each old name goes straight to the new one, newest first, so where both left the same file (a Mac that had a stray intuition folder beside its holm one) the newer one wins.
- **The clashes are small.** A search found a pre-1.0 desktop app called Cleat by zimventures and a small programming language with a `cleat` command line. Neither is a tool the owner uses, and neither is installed by a package manager the app depends on, so the command does not collide on the owner's machines.

## Risk
- A person with that programming language's `cleat` on the PATH gets whichever comes first on the PATH (`which -a cleat` shows both).
- An install made with `bun install -g github:kaitila/holm` leaves its `holm` command in bun's global folder: `bun remove -g holm` removes it. GitHub redirects the old repo's URL, so an old `holm update` installs the new package beside it.
- The fallbacks and moves are meant to go after a release, as in D0043. Until then the files named `legacy` are the only place the old names belong in code.
