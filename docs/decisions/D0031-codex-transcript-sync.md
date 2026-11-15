# D0031: Codex threads in the transcript sync, read from their rollout files

Date: 2026-11-15. Status: active. Takes up what [D0029](D0029-codex-agent.md) left out ("Codex sessions are left out of the transcript sync").

## Context
[D0015](D0015-transcript-sync.md) imports Claude Code sessions started in a terminal and follows the ones that grow there, through the Claude Agent SDK's read-only session functions. Codex (T-0053) kept its threads out: a Codex thread started with `codex` or `codex exec` in a workspace's folder never showed up, and a runner session continued with `codex resume` didn't grow. T-0057 asked for the same behaviour for Codex, reading `~/.codex/sessions` only.

The Codex SDK (`@openai/codex-sdk` 0.169) has no function to list or read threads: it runs `codex exec` and streams one turn's events. Codex's app-server protocol has thread listing, but it is a long-lived process with its own login, locks and state database, and it can write.

What Codex keeps, read from real files of codex 0.167.1 (TUI, VS Code) and 0.169.0 (`codex exec`, the SDK) on the owner's machine and from the strings of the binary:
- Each thread is `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` (`CODEX_HOME` is `~/.codex` unless set). The runner's own threads are there too (originator `codex_sdk_ts`).
- The first line is `session_meta`: the thread id, `cwd`, `timestamp`, `source` (`cli`, `vscode`, `exec`; an object for a subagent's thread) and `thread_source`. It carries the base instructions, tens of kilobytes.
- Lines are appended as the thread runs, one JSON object each with `timestamp`, `type` and `payload`. `response_item` lines are what the model is sent and answers, developer instructions and the environment context included. `event_msg` `item_completed` lines carry each finished item as the person saw it (`UserMessage`, `AgentMessage`, `CommandExecution`, `FileChange`, `McpToolCall`, `WebSearch`, `Reasoning`). `task_complete` ends a turn, `turn_aborted` ends an interrupted one.
- A resumed thread appends to the same file. `session_index.jsonl` holds the TUI's name for a thread (`thread_name`).

## Decision
- **`src/runner/codex-sync.ts` reads the rollout files itself**, with no dependency: `codexThreads(home)` lists `sessions/` again on every round (3 seconds), stats each rollout, and reads a file again only when its size or mtime moved (its first line once, for the id and cwd). A thread belongs to a workspace when its `cwd` is the workspace's folder, links resolved. Subagents' threads are left out.
- **One sync for both agents.** `sync.ts` reads through a small `Threads` interface (list, info, entries), with one reader per agent: Claude Code's transcripts through the SDK, as before, and Codex's rollouts. Everything D0015 does applies to both: import as `source: "terminal"` (with `agent: "codex"` for a thread), history read on first request, growth streamed while the runner isn't running the turn, one id per session in `sync.json` (thread ids and Claude Code ids share the map), the runner's own turns never taken for another process's, and the 409 `OPEN_IN_TERMINAL` for a reply within two minutes of another process's write.
- **Events from `item_completed` and the turn ends**, not from `response_item`: they are what the person saw, without the instructions Codex sends the model, and they map one to one onto what `reduceCodex()` stores for a runner turn (same tool names and inputs). `task_complete` is the `result`; `turn_aborted` and `task_complete` end the live turn (idle 5 seconds later), as an assistant message does for Claude Code. The cursor is the line number of the last entry read: a rollout only grows. A line without its newline yet is not read.
- **Titles**: the TUI's name in `session_index.jsonl`, else the first prompt. For both agents a terminal session's title now changes only when its transcript's title changes, so a Codex session renamed in the runner (its thread can't be renamed from here) keeps that name.
- **Read-only.** Nothing writes under `CODEX_HOME`; a test snapshots the temp home's files before and after a whole round of import, read, rename and reply. With the fake agent the runner reads no Codex threads (`noThreads()`), so tests and CI never touch a real `~/.codex`.
- `CODEX_HOME` is read from the environment as Codex reads it, not from intuition's config: it is Codex's setting, and the runner's Codex turns (the SDK's `codex exec`) use the same one.

## Why
- Reading the files is the only read-only way: the SDK can't list threads, and the app-server would be a second Codex process with write access to the same state. The sync already polls; statting a few hundred files every 3 seconds is cheap.
- `item_completed` is the shape the SDK's own events are made from, so a terminal turn reads in the chat exactly like a runner turn.

## Risk
- The rollout format is Codex's internal one and has changed between versions (older Codex wrote `event_msg` `user_message` / `agent_message` and no `item_completed`; those threads import with no events). After a Codex upgrade, run `scripts/smoke-codex-sync.ts`; `test/runner/codex-sync.test.ts` pins the format read here.
- The open-elsewhere guard goes by the file's mtime, as for Claude Code: an idle TUI left open longer than two minutes takes a reply without force.
- Every round walks the whole `sessions/` tree (a thread resumed today can sit in an old day's folder). Many thousands of threads would make each round slower; the walk stats files only.

## Not done here
- The pages: a resume command for a Codex session (`codex resume <thread id>`) in the chat view and `intuition resume`.
- Whether Codex's own resume picker lists the runner's threads (`source: "exec"`) was not checked; `codex resume <thread id>` continues them.
