# D0016: Synced sessions in the pages and the CLI

Date: 2026-11-13. Status: active.

## Context
D0015 made the runner import terminal sessions and stream their turns as their transcripts grow. T-0026 shows that: a mark for a session started in the terminal, "in terminal" while a turn arrives from one, "Send anyway" for the 409 `OPEN_IN_TERMINAL`, a "Continue in terminal" control and `intuition resume`.

## Decision
- **The runner says when a turn comes from a terminal: `SessionMeta.terminalTurn: true`.** The sync sets it with `running` when a transcript grows outside a runner turn; any other change of status drops it (`Store.update`), so a runner turn starting, the live turn ending and a restart all clear it. This changes the contract (`protocol.ts`, `protocol.md`).
- **While it is set the reply box stays on.** The runner takes a reply to such a session on the same terms as an idle one, so the pages offer it; the reply is usually a 409, which the hint says inline, with a "Send anyway" button that sends the same text with `force: true`. The typed text stays in the box until a reply goes through.
- **The mark is a glyph, `>_`, in the mono face and the muted colour**, with the tooltip and accessible name "started in the terminal". It sits before the workspace's name.
- **"Continue in terminal" copies `cd <cwd> && claude --resume <claudeSessionId>`**, each part single-quoted for a POSIX shell when it has anything but plainly safe characters (`shellWord` in `chat-format.js`). It is hidden while the session has no Claude Code session id. One module, `chat-resume.js`, serves the chat view and the dock.
- **`intuition resume [id]`** asks the runner that answers for its sessions. No id: the newest by activity that has a Claude Code session id. An id: the runner's or Claude Code's, whole or its start, naming exactly one session; no match lists the newest ten, several list the matches. It runs `claude --resume <claudeSessionId>` in the session's folder with stdin, stdout and stderr inherited, ignores Ctrl+C itself while Claude Code runs, and exits with Claude Code's code.

## Why
- The pages can't tell a terminal's turn from the runner's: both show `running`, and either window (the chat view or the dock) may have sent the reply. A guess in one window would say "in terminal" for a reply sent from the other. The sync already knows (its live map), so the contract carries it.
- Copying a command, rather than starting a terminal, needs nothing from Windows and works for any terminal the person uses.

## Risk
- A session left `running` with `terminalTurn` on disk when the runner stops is recorded as failed at the next start, as any running session is (the sync settles live ones on a clean stop).
