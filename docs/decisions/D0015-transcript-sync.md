# D0015: Sessions sync with Claude Code in WSL through its transcripts

Date: 2026-11-13. Status: active.

## Context
The owner asked on 2026-11-13: "can we make it so that it syncs the sessions so that they show up also when I have claude code open on wsl?" Read as both directions: the runner's sessions in the terminal, and the terminal's in intuition.

Claude Code keeps every session as a transcript, `~/.claude/projects/<project>/<id>.jsonl`, whoever started it. The runner's are already there, and `claude --resume <id>` continues them. But Claude Code's resume picker (`claude --resume` with no id, and `/resume`) hid them. In Claude Code 2.1.323 the picker drops every transcript whose first `entrypoint` is `sdk-cli`, `sdk-ts` or `sdk-py` (its `isHiddenFromSessionPicker`), and the SDK's sessions record one of those. There is no setting, flag or SDK option that shows them. The SDK's own `listSessions` has `includeProgrammatic`, but that only filters the SDK's listing, not the CLI's picker.

## Decision
- **The runner's sessions record the entrypoint `intuition`.** The driver passes `env` with `CLAUDE_CODE_ENTRYPOINT=intuition` (`agent-claude.ts`, `ENTRYPOINT`). The SDK only sets `sdk-ts` when the variable is unset, so Claude Code keeps ours and writes it in the transcript, and the picker lists the session. `cli` can't be used: Claude Code turns `cli` into `sdk-cli` when it runs headless, as under the SDK. This is the only way found, and it changes what the CLI records, so the task's condition applied: every smoke script (`smoke-session`, `smoke-reply`, `smoke-approval`, `smoke-auto`, and the new `smoke-sync`) passes with it. Streaming, resume, approvals and auto mode run under the SDK's stream-json flags, not the entrypoint.
- **A new conversation gets the session's title** through the SDK's `title` option on `query`, so the picker shows it by name. No `renameSession`: nothing outside `query` writes to a transcript. A resumed conversation keeps its title.
- **Terminal sessions are imported by polling.** Every 3 seconds the runner calls `listSessions({ dir, limit: 50, includeWorktrees: false })` for each configured workspace. A transcript of the last 30 days that no runner session owns becomes a session with `source: "terminal"`, idle, titled by its custom title, else summary, else first prompt. Its events are read with `getSessionMessages` the first time they are asked for (`GET .../events`, or a reply), not at start.
- **Growth is streamed.** When a transcript's `lastModified` moves on and the runner isn't running that session's turn, the entries after the last one seen become events (`user`, `assistant_text`, `tool_use`, `tool_result`, and `result` after an assistant message with `stop_reason: "end_turn"`), whole messages, no deltas. The session shows `running` until 5 seconds after its last entry when that entry is the assistant's (10 minutes after it otherwise).
- **One id per session.** `sync.json` in the data folder maps every Claude Code session id the runner has known to its own session id, and keeps each session's cursor (the newest transcript message already stored), so a restart keeps the ids and nothing is imported or stored twice. When a runner turn ends, the cursor moves to the transcript's end without storing anything: that turn's events are already stored.
- **A reply to a session open elsewhere needs force.** A reply first stores what the transcript gained, then: when another process wrote to the transcript in the last two minutes (later than 5 seconds after the runner's own last turn), it is a 409 `OPEN_IN_TERMINAL`, unless the body has `force: true`. Two processes appending to one transcript at once would interleave it.

## Why
- The entrypoint is what the picker reads, and the SDK leaves it to the caller. A name of our own changes nothing else the SDK relies on. The smoke scripts are the check that this holds.
- Polling `listSessions` uses the SDK's own reader of the transcript format, which changes between versions; a file watch of `~/.claude/projects` would mean parsing the files ourselves. Three seconds is quick enough to read along with a terminal and cheap for 50 transcripts per workspace.
- Reading history on first request keeps a start with many terminal sessions quick.

## Risk
- An entrypoint Claude Code doesn't know is outside what it documents. A later version may treat unknown names differently: run `scripts/smoke-sync.ts` and the other smoke scripts after upgrading the SDK. If the picker stops listing the sessions, `claude --resume <claudeSessionId>` still continues them.
- Sessions started before this change still record `sdk-ts` or `sdk-cli` and stay hidden from the picker.
- Telemetry Claude Code sends names the entrypoint `intuition`.
- The 409 guard goes by the transcript's modification time. A terminal left open but idle for more than two minutes takes a reply without force, and the two processes can then both write to the transcript.

## Not done here
- The pages: a terminal marker, a force reply, and `intuition resume` (T-0026).
