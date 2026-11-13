# D0012: Sessions run in auto mode

Date: 2026-11-13. Status: active.

## Context
The owner asked on 2026-11-13: "make it more auto mode, no need to accept every permission". Until now every session ran with `permissionMode: "default"`, so nearly every write and most commands waited for Allow or Deny in the chat view (D0004).

## Decision
- Sessions ask the Claude Agent SDK for `permissionMode: "auto"` by default. In auto mode a model classifier allows or denies each tool call itself, and asks through `canUseTool` only when it can't decide.
- The config file takes `permissionMode`, `"auto"` or `"default"`, at the top level (default `"auto"`) and on any workspace, where it overrides the top level. `config.ts` refuses any other value when the config is read, so `bypassPermissions`, `acceptEdits`, `dontAsk` and `plan` can't be configured. The mode is read at the start of every turn, so a changed config applies to the next turn of an existing session after the runner restarts.
- What still reaches the person: every call that reaches `canUseTool`, in either mode, waits for their Allow or Deny exactly as in D0004. The runner never answers one itself, and never passes `allowDangerouslySkipPermissions`.
- Auto mode can be unavailable (the account, the model, or a setting such as `disableAutoMode`); the SDK then runs the session in `default`. The mode in effect is reported in the `init` system message at the start of each turn (and in `status` messages when it changes). The runner stores it as `SessionMeta.permissionMode`, logs each change, and a session that asked for auto but runs in another mode gets one `permission_mode` event, so the person knows why calls come to them.
- A call denied without asking (the SDK's `system`/`permission_denied`: the classifier, a deny rule, the mode) is stored as an `auto_denied` event with the tool, a one-line summary of its input and the reason. The pages show it as a quiet note; styling it is left to another task.
- `scripts/smoke-approval.ts` runs with `permissionMode: "default"` in its temp config, so it still checks the Allow / Deny path. `scripts/smoke-auto.ts` checks the default config end to end.

## Why
- It is what the owner asked for, and the classifier is the SDK's own way to drop the prompts for routine calls while still stopping the dangerous ones, unlike `acceptEdits` (every edit allowed) or `bypassPermissions` (everything allowed).
- Allowing only two values keeps the configurable set to modes where the person is still asked whenever the classifier is unsure.
- Reporting the mode in effect, rather than the one asked for, keeps the chat honest when auto mode falls back.

## Risk
The classifier can approve a call the person would have denied: a command that deletes or overwrites more than intended, a network call, a write outside what the task needed. Nothing in the runner catches that; the call runs and shows only as an ordinary `tool_use`. The mitigations are the workspace's own deny rules (they still apply), the chat view showing every call as it runs, and setting `permissionMode: "default"` for a workspace where every call should be seen first.

## Not done here
- Styling `auto_denied` and `permission_mode` in the pages.
- Switching a running session's mode from the chat view (`setPermissionMode`).
