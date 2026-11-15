# D0029: Codex as a second agent

Date: 2026-11-15. Status: active.

## Context
The owner asked on 2026-11-15: "add codex integration possibility also". OpenAI publishes a TypeScript SDK for Codex, `@openai/codex-sdk`, and the owner allowed it as a dependency for this. The runner had one real agent, Claude Code, behind the `AgentDriver` interface (D0002).

## Decision
- `@openai/codex-sdk` 0.169.0, pinned. It brings `@openai/codex` and its binary for the platform, and runs that binary (`codex exec --experimental-json`), so the runner's Codex is the SDK's version, not whatever `codex` is on the PATH. `codexBinary()` finds that binary the way the SDK does, so doctor asks the same one.
- A second driver, `agent-codex.ts`, reduces Codex's thread events to the same `SessionEvent`s: commands as `Bash` and file changes as `Edit` tool calls with their results, agent messages as `assistant_text`, `turn.completed` as an ok `result`, `turn.failed` and stream errors as `error`. Reasoning and the to-do list are left out. `byAgent()` sends each turn to its session's agent.
- Config `agent` (`"claude"` default, or `"codex"`) at the top and per workspace, as `permissionMode`; `StartSessionRequest.agent` overrides both; `SessionMeta.agent` records it and a reply always goes to it. The thread id is stored in `claudeSessionId`, which now means "the agent's conversation id".
- A `PUT /api/settings` that leaves `agent` out keeps the current one (at the top, and on a workspace of the same name), and a workspace's `agent: null` clears its own. The shell and the settings page PUT whole settings and don't know `agent` yet: without this, any change there would silently put every workspace back on Claude Code.
- Permissions, in one pure function `codexPermissions()`: `auto` is Codex's `workspace-write` sandbox with its default `on-request` policy; `default` is `read-only` with `on-request`. Never `danger-full-access`, never `never`, no bypass flag.
- Approvals: `codex exec` has no way to ask the host (no callback in the SDK, and Codex tells the model escalation is unavailable), so nothing from Codex reaches the person's Allow / Deny. A call outside the sandbox fails and the model is told. This is the task's stated fallback.
- `skipGitRepoCheck`: a workspace is a folder the person added on purpose, git repository or not.
- Codex sessions are left out of the transcript sync, and of the transcript side of rename, fork and delete (fork is refused): their threads are no Claude Code transcripts.
- `intuition doctor` reports Codex and its login as optional. Its `firstLine` reads stderr when stdout is empty, as `codex login status` answers there.

## Why
- One interface and one event model keep every page working unchanged on either agent.
- Codex's sandbox is its own safety boundary and the one thing `exec` enforces without a person; mapping `default` to read-only keeps "the person sees anything that writes" as close as Codex allows: there it doesn't run at all.
- Keeping `agent` on a PUT that omits it costs one rule and protects the setting from clients written before it.

## Risk
- In `auto`, Codex writes anything inside the workspace without asking, as Claude Code's classifier may; there is no classifier, only the sandbox. A workspace where every write should be seen first should use `permissionMode: "default"` (Codex then can't write at all) or stay on Claude Code.
- The SDK and its event format change often; the driver is tested against the 0.169.0 types and `scripts/smoke-codex.ts` checks it end to end.

## Not done here
- Terminal sync for `~/.codex/sessions`.
- The agent choice in the pages, and a Codex resume command (the chat view and `intuition resume` still offer `claude --resume`).
- Approvals from Codex to the person.
