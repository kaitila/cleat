# Agents

A session runs on one of two agents: **Claude Code** (the default) or **OpenAI Codex**. Both sit behind the same `AgentDriver` interface (`src/runner/agent.ts`), so the pages, the dock, the notifications and the WebSocket see the same `SessionEvent`s whichever one runs. The choice and its limits are in [D0029](decisions/D0029-codex-agent.md).

| | Claude Code | Codex |
|---|---|---|
| Driver | `agent-claude.ts`, the Claude Agent SDK's `query()` | `agent-codex.ts`, the Codex SDK (`@openai/codex-sdk`), which runs the `codex exec --experimental-json` it brings and reads its events |
| Login | Claude Code's (`claude auth login`) | Codex's (`codex login`, kept in `~/.codex`) |
| New conversation, resume | a Claude Code session id; a reply resumes it | a Codex thread id (stored in `claudeSessionId`); a reply resumes the thread (`resumeThread`) |
| Streaming | text deltas as Claude Code writes | Codex sends a message only once it is complete, so the text arrives in one piece (a message that grows would stream as deltas) |
| Tools in the chat | Claude Code's tool calls | a command is `Bash` (`{ command }`), a file change is `Edit` (`{ changes: [{ path, kind }] }`), an MCP call is `mcp__<server>__<tool>`, a web search is `WebSearch`, each with its `tool_result`. Reasoning and the to-do list are left out |
| `auto` mode | the SDK's classifier, which asks the person when unsure | Codex's `workspace-write` sandbox (writes in the workspace, no network) with its default `on-request` approval policy |
| `default` mode | every call that would prompt asks the person | Codex's `read-only` sandbox with `on-request` approvals |
| Approvals | `approval_request` and Allow / Deny in the chat view | none reach the person: see below |
| Stop | the SDK's interrupt, then abort | the turn is aborted, which ends the `codex` process |
| Terminal sync | transcripts in `~/.claude/projects` are imported and followed ([D0015](decisions/D0015-transcript-sync.md)) | not yet: `~/.codex/sessions` is not read |
| Rename, fork, delete | act on the transcript too | rename and delete are the runner's alone (the thread stays in `~/.codex/sessions`); fork is refused with 409 |

## Choosing
- Config `agent`: `"claude"` (the default) or `"codex"`, at the top level and on any workspace, where it overrides the top level. Any other value is refused when the config is read. `GET` and `PUT /api/settings` carry both (the settings page will show them).
- `POST /api/sessions` takes an optional `agent` that overrides both for that session.
- The session keeps its agent (`SessionMeta.agent`) for good: every reply goes to it, whatever the config says by then. A session stored before agents existed, and every session imported from the terminal, is Claude Code's.
- With `INTUITION_FAKE_AGENT=1` (tests, CI) the fake agent stands in for both.

## Approvals
`codex exec`, which the SDK runs, can't ask the host anything: the SDK has no approval callback, and Codex tells the model that escalation requests are not available in this environment. So with Codex no call ever waits for the person, in either mode. What keeps it safe is Codex's own sandbox: in `auto` it can write inside the workspace and nowhere else, without the network; in `default` it can only read. A call the sandbox blocks fails (a `tool_result` with `isError: true`, as "read-only file system") and the model is told. The runner never passes `danger-full-access`, the `never` approval policy or any bypass flag; the mapping is one function, `codexPermissions()`, with unit tests.

A workspace that is not a git repository is accepted (`skipGitRepoCheck`): a workspace is a folder the person added on purpose.

## doctor
`intuition doctor` reports **Codex** (the version of the `codex` binary the SDK runs, the one `@openai/codex` installs for this platform) and **Codex login** (`codex login status`). Both are optional: they never make doctor fail.

## Tested where
- `test/runner/codex.test.ts` (CI): the permission mapping, the reduction of every Codex event kind, and the driver's start, resume, Stop and failure against a stand-in for the SDK.
- `test/runner/agents.test.ts` (CI): the config's `agent`, the start override, a reply going to the session's own agent after the config changed, the settings keeping `agent` on a PUT that leaves it out, and fork refused for a Codex session.
- `scripts/smoke-codex.ts` (real Codex, the owner's machine, WSL, codex 0.169.0 from the SDK, logged in with ChatGPT; 2026-11-15): a session answers pong, a reply remembers it through the resumed thread, and a third turn writes `proof.txt` in a throwaway workspace with a `Bash` tool_use and its tool_result. It exits 2 when Codex is not installed or not logged in. Also checked by hand there: in `default` (read-only) a write fails with "read-only file system", and Codex says it can't ask for escalation.
- Not tested: Codex on macOS or on Windows (the SDK has binaries for both), and Stop against a real Codex turn.

## Follow-ups
- Terminal sync for Codex: import and follow the threads in `~/.codex/sessions`, as D0015 does for Claude Code.
- The pages: an agent choice in the settings page and the pop-up, and a resume command for a Codex session (`codex resume <thread id>`, not `claude --resume`) in the chat view and `intuition resume`.
- Approvals from Codex to the person, if the SDK gains a way for the host to answer them (or through Codex's app-server protocol).
