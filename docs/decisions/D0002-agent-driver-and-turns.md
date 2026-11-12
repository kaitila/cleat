# D0002: One agent driver interface, and what a turn stores

Date: 2026-11-12. Status: active.

## Decision
- The runner talks to the agent through one interface, `AgentDriver` in `src/runner/agent.ts`: `run()` yields Claude Code's session id, text deltas and events, and ends after a `result` or an `error` event. Claude Code (`agent-claude.ts`) and the scripted fake (`agent-fake.ts`) both implement it; `INTUITION_FAKE_AGENT=1` picks the fake, read in `config.ts`.
- Only the main conversation is stored. A subagent's own messages (`parent_tool_use_id` set) are left out; what it did arrives as the Agent tool's `tool_result`.
- Thinking blocks are not stored or streamed.
- A `result` with `ok: false` (the SDK's error results, or a success result marked `is_error`) sets the session to `error`, as an `error` event does. A driver that throws, or ends without a result, is stored as an `error` event.
- The real driver's `canUseTool` waits for the person's Allow or Deny for every call that would prompt ([D0004](D0004-approvals.md)). Calls the workspace's own allow rules cover still run: `settingSources` is left out, so user, project and local settings load.
- Storage writes are synchronous: an event is appended to `events/<id>.jsonl`, then `sessions.json` is rewritten through a temporary file. Two events can't get the same seq, and no file is left half written.
- A turn cut off by the runner stopping is left `running` on disk. The next start reads the last seq from the events file and records `the runner restarted`.

## Why
- CI has no Claude Code login, so everything above the driver (routes, storage, the WebSocket) has to be testable without it. One narrow interface keeps the fake honest: the code under test is the same for both.
- A subagent's stream interleaves with the main one and would need its own place in the chat view. Nothing in the protocol carries that yet, and the tool result already says what came of it.
- Sessions are few and their files small, so synchronous writes cost nothing that matters and remove a class of ordering bugs.

## Not done here
- `imagePath` in `StartSessionRequest` is accepted and ignored: the clipboard handoff is T-0006.
- Replies and resume (T-0003), approvals (T-0007) and notifications (T-0012).
