# Decisions

One file per decision. Add a row when you add one.

| # | Decision | Date | Status |
|---|---|---|---|
| [D0001](D0001-runner-web-shell.md) | A runner in WSL, web pages for the UI, a thin Windows shell | 2026-11-12 | Active |
| [D0002](D0002-agent-driver-and-turns.md) | One agent driver interface (Claude Code and a fake), and what a turn stores | 2026-11-12 | Active |
| [D0003](D0003-windows-shell-choices.md) | How the Windows shell is stopped, tested and kept on the runner's origin | 2026-11-12 | Active |
| [D0004](D0004-approvals.md) | A tool call waits for the person: only the approvals route allows, everything else denies | 2026-11-13 | Active |
| [D0005](D0005-toasts.md) | Notifications are kept in memory and polled; the shell's first poll shows nothing | 2026-11-13 | The shell's toasts and polling replaced by [D0008](D0008-dock.md); what the runner records stands |
| [D0006](D0006-start-stop-and-login.md) | Start, stop and status keep a pid file; the shell starts the runner with `wsl.exe --exec`; start on login is Electron's login item | 2026-11-13 | Active |
| [D0007](D0007-design-system.md) | The design system: Inter and JetBrains Mono served by the runner, hairlines of one device pixel, raw values only in `base.css` | 2026-11-13 | Active |
| [D0008](D0008-dock.md) | A dock instead of toasts: one page in three window sizes, a one-word bridge to the shell, notifications pushed on the WebSocket | 2026-11-13 | Active; the window's sizes and its resizing replaced by [D0010](D0010-dock-fixed-window.md) |
| [D0009](D0009-intuition-command.md) | The `intuition` command is a symlink to `src/cli.ts` in the folder bun is in; `link` replaces only its own link; a wrong command line exits 2 | 2026-11-13 | Active |
| [D0010](D0010-dock-fixed-window.md) | The dock's window never changes size: the island is drawn and animated inside it, and the shell lets the mouse through everywhere but on the island, click-through by default | 2026-11-13 | Active |
| [D0011](D0011-stale-runner-and-shell.md) | `start` and `up` restart a runner whose build id (a hash of its code) differs from the repo's, unless sessions are in the way (exit 3); `up` reinstalls a shell whose bundle differs | 2026-11-13 | Active |
| [D0012](D0012-auto-mode.md) | Sessions run in the SDK's auto mode by default (config `permissionMode`, `"auto"` or `"default"`, per workspace): only calls the classifier can't decide reach the person; the mode in effect is stored and a fallback is said once | 2026-11-13 | Active; replaces D0004's premise that every call that would prompt reaches the person |
| [D0013](D0013-markdown-renderer.md) | Assistant messages are drawn by our own markdown renderer, which builds DOM nodes and never parses HTML; links only to http(s) and mailto; a synthesised italic | 2026-11-13 | Active |
| [D0014](D0014-snip.md) | The snip: one overlay per display, loaded ahead and hidden; a three-call bridge checked in the main process; the crop asked in DIPs and cut at device pixels; links to http, https and mailto go to the browser | 2026-11-13 | Active |
| [D0015](D0015-transcript-sync.md) | Sessions sync with Claude Code in WSL through its transcripts: the runner's record the entrypoint `intuition` so the resume picker lists them; terminal sessions are imported by polling `listSessions`, read on first request and streamed as they grow; a reply to one open elsewhere needs `force` | 2026-11-13 | Active |
| [D0016](D0016-synced-sessions-in-the-pages.md) | The runner marks a turn arriving from a terminal (`SessionMeta.terminalTurn`); the pages mark terminal sessions with `>_`, offer "Send anyway" for the 409 and copy `cd <cwd> && claude --resume <id>`; `intuition resume` runs that with the terminal handed over | 2026-11-13 | Active |
| [D0017](D0017-lively-dock-and-chat-motion.md) | The dock and the chat view move on base.css springs: the island springs its width and height as two registered lengths read only by its clip (top edge fixed, overshoot inside the window), content rises in staggered, tool rows FLIP, a new session cross-fades; reduced motion keeps only fades | 2026-11-15 | Active |
| [D0018](D0018-themes-and-settings-page.md) | Themes: `theme.js`, a classic script first in each page, sets `data-theme` on `<html>` from a localStorage cache, then `GET /api/settings`, then `settings` messages; base.css forces the schemes' own values; the settings page saves the whole Settings on change and shows a 400 at its field | 2026-11-15 | Active |
