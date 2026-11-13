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
| [D0008](D0008-dock.md) | A dock instead of toasts: one page in three window sizes, a one-word bridge to the shell, notifications pushed on the WebSocket | 2026-11-13 | Active |
