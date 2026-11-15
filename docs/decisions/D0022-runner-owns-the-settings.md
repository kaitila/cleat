# D0022: The runner owns the settings

Date: 2026-11-15. Status: active.

## Context
The runner's settings were its config file, edited by hand, and the Windows shell kept its own `settings.json`. A settings page (T-0039) and a shell that follows it (T-0031) need one owner and one API, built at the same time against one contract.

## Decision
- All user settings (theme, permission modes, workspaces, the shell's hotkeys, dock and start on login) live in the runner's config file and are served by `GET` and `PUT /api/settings`. After every change the runner sends `{ type: "settings", settings }` on `/ws`.
- One zod schema in `config.ts` (`SettingsSchema`) reads the file and validates a PUT. A PUT is a whole `Settings`; the answer is the stored one, or 400 `{ error, field }` with the first bad field.
- The file stays hand-editable: the runner writes it pretty-printed, atomically (temp file and rename), and keeps every key it doesn't know, at the top and on a workspace of the same name.
- A workspace path must be absolute and an existing folder, except a path the current settings already have, so a folder that went missing doesn't block changing the theme.
- A change is applied to the running config at once (workspaces in place, since the transcript sync holds the list), not only after a restart.
- `port` stays file-only: it is in `Settings` read-only, and a PUT ignores it.
- `shell` is `null` until something sets it; the shell then sends its local values once and reads them from the runner after. The shell keeps its own file for what it needs before the runner answers (where the runner is).

## Why
- One owner means the page, the shell and a hand edit can't disagree about which file wins.
- The same schema for the file and the API means nothing the API accepts can make the file unreadable at the next start.
- Port is file-only because the page that would change it is served on that port: saving would cut the page off from the runner it just moved, and the shell would lose it too.
- Atomic writes keep a crash mid-write from leaving a half file the runner then refuses to start with.

## Not done here
- The settings page and the themes (T-0039), the shell reading its settings from the runner (T-0031).
- Watching the file for hand edits while the runner runs: they still apply at restart.
