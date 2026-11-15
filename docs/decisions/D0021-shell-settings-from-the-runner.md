# D0021: The shell takes its settings from the runner over one WebSocket, and applies them live

Date: 2026-11-15. Status: active. Task: T-0031.

## Context
T-0030 made the runner the owner of the person's settings: `GET` and `PUT /api/settings`, and a `{ type: "settings" }` message on `/ws` after every change. Its `shell` part (`hotkey`, `snipHotkey`, `dock`, `startOnLogin`) is the shell's to apply. Before this task the shell read the hotkeys and the dock from its own `settings.json` once at start, and start on login only from Electron's login item. The Settings page (T-0039) and the tray both change these values, and they have to agree.

## Decision
- **One WebSocket in the main process**, Electron's `net.WebSocket` (Electron 45, through Chromium's network stack). On every connect the shell asks `GET /api/settings`, and it applies each `settings` message. When the socket closes it reconnects after 1 second, then 2, 4 and 8, then every 15 seconds, without a word. It never starts the runner. `net.WebSocket` sends the runner's own origin as `Origin`, so the socket passes `refusal()` as the pages' do. There is no polling.
- **Applying.** The theme goes to `nativeTheme.themeSource`. The hotkeys are re-registered, the dock is shown or closed at once, and the login item is set when it differs from what Windows has. The tray is drawn again. Everything is applied again on each message, and it is idempotent.
- **A hotkey moves by registering the new one first, then releasing the old one** (`swapHotkey` in `shell/src/prefs.ts`). A new one that is taken by another program, already held by the shell's other hotkey (`isRegistered`), or not a valid accelerator (Electron throws for those) leaves the old one registered. A notification names the one that failed and the one that still works, once per failed value. When the two hotkeys trade keys, or one moves onto the key the other is leaving, both are released first (`releaseBoth`).
- **The tray writes through the runner.** "Show dock" and "Start on login" do `GET`, change the shell's part, then `PUT` the whole settings. They apply what the runner stored, and the change also comes back on the socket. If the runner does not answer, nothing changes and a notification says so.
- **The migration, once.** If the runner's `shell` is null, the shell PUTs its old file's `hotkey`, `snipHotkey` and `dock`, the defaults for anything missing, and start on login as Windows has it now. If the runner refuses that, the shell sends the defaults. Once the runner has stored it, the file is rewritten with `runnerUrl` and `wsl` only (plus `runner`, where D0019's same-machine layouts wrote it). A tray change made while `shell` is still null counts as the migration too.
- **`--login on|off` tells the runner too**, if it answers. Otherwise a running shell would set the login item back to the runner's old value at its next message.
- **Before the runner answers**, the shell uses the old file's values if it still has them, else the defaults. With a runner from before T-0030 (no `/api/settings`), that is all it has.
- **The contract's types are copied into `shell/src/prefs.ts`.** T-0030's `src/shared/protocol.ts` was not merged when this was written. Once it is, the shell can import them from there.

## Why
- A socket in the main process works in Electron 45 and is what the pages already use. A change made on the Settings page reaches the hotkeys at once, not on the next poll. Reconnecting quietly fits a runner that restarts often (`up` after a pull).
- Registering before releasing is the only order in which a failed change cannot leave the person with no hotkey.
- If the tray wrote the file, or applied the change locally, the tray and the Settings page could disagree. One owner, and one path back to the shell (the message), keeps them the same.

## Risk
- Until the runner answers, the defaults are registered, or the old file's values before the migration. After the migration, a shell started while the runner is down has the default hotkeys until the runner comes up (the shell starts it at its own start). It then moves them to the person's.
- A tray change needs the runner. The checkboxes do nothing while it is down, and a notification says why.
