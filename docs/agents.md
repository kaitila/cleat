# Agents

A session runs on one of two agents: **Claude Code** (the default) or **OpenAI Codex**. Both sit behind the same `AgentDriver` interface (`src/runner/agent.ts`), so the pages, the dock, the notifications and the WebSocket see the same `SessionEvent`s whichever one runs. The choice and its limits are in [D0029](decisions/D0029-codex-agent.md).

| | Claude Code | Codex |
|---|---|---|
| Driver | `agent-claude.ts`, the Claude Agent SDK's `query()` | `agent-codex.ts`, the Codex SDK (`@openai/codex-sdk`), which runs the `codex exec --experimental-json` it brings and reads its events |
| Login | Claude Code's (`cleat login`, which runs the Agent SDK's Claude Code's `auth login`) | Codex's (`cleat login codex`, kept in `~/.codex`) |
| New conversation, resume | a Claude Code session id; a reply resumes it | a Codex thread id (stored in `claudeSessionId`); a reply resumes the thread (`resumeThread`) |
| Streaming | text deltas as Claude Code writes | Codex sends a message only once it is complete, so the text arrives in one piece (a message that grows would stream as deltas) |
| Tools in the chat | Claude Code's tool calls | a command is `Bash` (`{ command }`), a file change is `Edit` (`{ changes: [{ path, kind }] }`), an MCP call is `mcp__<server>__<tool>`, a web search is `WebSearch`, each with its `tool_result`. Reasoning and the to-do list are left out |
| `auto` mode | the SDK's classifier, which asks the person when unsure | Codex's `workspace-write` sandbox (writes in the workspace, no network) with its default `on-request` approval policy |
| `default` mode | every call that would prompt asks the person | Codex's `read-only` sandbox with `on-request` approvals |
| Approvals | `approval_request` and Allow / Deny in the chat view | none reach the person: see below |
| Stop | the SDK's interrupt, then abort | the turn is aborted, which ends the `codex` process |
| Terminal sync | transcripts in `~/.claude/projects` are imported and followed ([D0015](decisions/D0015-transcript-sync.md)) | rollout files in `~/.codex/sessions` (or `$CODEX_HOME/sessions`) are imported and followed, read-only (`codex-sync.ts`, [D0031](decisions/D0031-codex-transcript-sync.md)) |
| Rename, fork, delete | act on the transcript too | rename and delete are the runner's alone (the thread stays in `~/.codex/sessions`); fork is refused with 409 |

## Choosing
- Config `agent`: `"claude"` (the default) or `"codex"`, at the top level and on any workspace, where it overrides the top level. Any other value is refused when the config is read. `GET` and `PUT /api/settings` carry both (the settings page will show them).
- `POST /api/sessions` takes an optional `agent` that overrides both for that session.
- The pages ([D0034](decisions/D0034-agent-choice-in-the-pages.md)): the pop-up and the snip have an agent switch beside the workspace that starts on the workspace's agent (`GET /api/workspaces` gives each its `agent`); a click or **Alt+A** flips it, the flip holds for that pop-up whichever workspace is picked after, and the task goes with `agent` set to what it shows. The task box asks "What should Codex do?" when it is Codex. The settings page has the default agent (Agents) and each workspace's own (Default agent, Claude Code or Codex), and a line per agent from `GET /api/agents`: what it needs and what doctor found, red when sessions would run on an agent that can't, amber when nothing uses it. The chat view and the dock put the agent's glyph on each session's row (Claude Code an eight-ray spark, Codex a hexagon; the name only as the tooltip) and name the agent in the session's head.
- The session keeps its agent (`SessionMeta.agent`) for good: every reply goes to it, whatever the config says by then. A session stored before agents existed is Claude Code's. One imported from the terminal is the agent whose transcript it came from: a Codex thread is `codex`, whatever the workspace's `agent` says.
- With `CLEAT_FAKE_AGENT=1` (tests, CI) the fake agent stands in for both.

## Approvals
`codex exec`, which the SDK runs, can't ask the host anything: the SDK has no approval callback, and Codex tells the model that escalation requests are not available in this environment. So with Codex no call ever waits for the person, in either mode. What keeps it safe is Codex's own sandbox: in `auto` it can write inside the workspace and nowhere else, without the network; in `default` it can only read. A call the sandbox blocks fails (a `tool_result` with `isError: true`, as "read-only file system") and the model is told. The runner never passes `danger-full-access`, the `never` approval policy or any bypass flag; the mapping is one function, `codexPermissions()`, with unit tests.

A workspace that is not a git repository is accepted (`skipGitRepoCheck`): a workspace is a folder the person added on purpose.

## Terminal sync
Codex writes every thread, the runner's and a terminal's (`codex`, `codex exec`, the VS Code extension), to a rollout file `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, and a resumed thread appends to the same file. `src/runner/codex-sync.ts` reads them for the sync, as the SDK's session functions do Claude Code's transcripts ([D0031](decisions/D0031-codex-transcript-sync.md)):
- A thread whose first line (`session_meta`) has a workspace's folder as its `cwd` is imported as a terminal session with `agent: "codex"`, unless the runner owns it (its thread id is one of its sessions'), Codex started it for itself (a subagent's), or it is older than 30 days. Its title is the TUI's name for it in `~/.codex/session_index.jsonl`, else its first prompt.
- Its events are the `event_msg` `item_completed` lines (the person's message, agent messages, commands, file changes, MCP calls, web searches) and the turn ends (`task_complete`, `turn_aborted`, `error`), mapped as `reduceCodex()` maps a runner turn. The cursor is the line number of the last line read.
- A thread that grows while the runner isn't running its turn streams, shows `running` with `terminalTurn`, and goes idle 5 seconds after the turn's end. A reply within two minutes of another process's write needs `force`, as for Claude Code.
- Nothing writes under `~/.codex`: the runner's own turns go through the SDK, and a rename in the runner stays the runner's (the thread keeps its name in Codex; a new name given there replaces the runner's).
- The format is Codex's own, not a documented interface: it was read from real files of codex 0.167.1 and 0.169.0. After a Codex upgrade, run `scripts/smoke-codex-sync.ts`.
- "Continue in terminal" (the chat view and the dock, `resumeCommand` in `src/web/chat-format.js`) copies `cd <cwd> && codex resume <thread id>` for a Codex session, and `cleat resume` runs `codex resume <thread id>` in its folder (`claude --resume <id>` for the rest). A Codex session without a thread yet says "no Codex thread yet". The form is from `codex resume --help` (codex 0.167.1): `codex resume [SESSION_ID]`.

## doctor
`cleat doctor` reports **Codex** (the version of the `codex` binary the SDK runs, the one `@openai/codex` installs for this platform) and **Codex login** (`codex login status`). Both are optional: they never make doctor fail. `GET /api/agents` (`src/runner/agent-status.ts`) asks the same commands, for Claude Code and Codex, so the settings page shows the same answers.

## Tested where
- `test/runner/codex.test.ts` (CI): the permission mapping, the reduction of every Codex event kind, and the driver's start, resume, Stop and failure against a stand-in for the SDK.
- `test/runner/agents.test.ts` (CI): the config's `agent`, the start override, a reply going to the session's own agent after the config changed, the settings keeping `agent` on a PUT that leaves it out, and fork refused for a Codex session.
- `scripts/smoke-codex.ts` (real Codex, the owner's machine, WSL, codex 0.169.0 from the SDK, logged in with ChatGPT; 2026-11-15): a session answers pong, a reply remembers it through the resumed thread, and a third turn writes `proof.txt` in a throwaway workspace with a `Bash` tool_use and its tool_result. It exits 2 when Codex is not installed or not logged in. Also checked by hand there: in `default` (read-only) a write fails with "read-only file system", and Codex says it can't ask for escalation.
- `test/runner/codex-sync.test.ts` (CI): rollout lines to events, the listing by folder (titles, subagents' threads left out), a thread imported with agent `codex`, a thread that grows streaming live, the runner's own Codex turns not imported or stored twice, the reply guard, a rename standing, and nothing under the temp `CODEX_HOME` written.
- `scripts/smoke-codex-sync.ts` (real Codex, the owner's machine, WSL, codex 0.169.0, 2026-11-15): `codex exec` in a throwaway workspace makes a terminal session with agent `codex` and its events; `codex exec resume` while it is shown streams the new turn, running then idle; a reply right after is a 409 and with force is answered in the same thread. Exits 2 without Codex or its login.
- Not tested: Codex on macOS or on Windows (the SDK has binaries for both), Stop against a real Codex turn, and the sync against a thread from the interactive TUI written while shown (the format of its files was read from real ones, from codex 0.167.1).

## Follow-ups
- Approvals from Codex to the person, if the SDK gains a way for the host to answer them (or through Codex's app-server protocol).
