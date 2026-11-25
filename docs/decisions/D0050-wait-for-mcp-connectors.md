# D0050: A turn's prompt waits for the MCP servers still connecting

Date: 2026-11-25. Status: active. Task T-0005.

## Context
The owner, on 2026-11-25: "my connectors keep randomly disconnecting, or at least is says so in the notch". The notch showed what the agents wrote: "the Gamma connector disconnected partway through this session", "the Google Calendar connector has disconnected".

Nothing had disconnected. Every turn is a new `query()`, so a new Claude Code process, and the prompt went as a string the moment it started. In a new process the claude.ai connectors take 1–4 s to connect (measured on the owner's Mac with Claude Code 2.1.322: Gmail, Calendar and Docs in about 1.3 s, Gamma in about 3.9 s), and the first model request went out after about 0.3 s. Claude Code's transcript of the failing turn (session 8c98fe95, 13:51:34) starts with a `deferred_tools_delta` and an `mcp_instructions_delta` that remove every claude.ai connector. The agent answered in 6 s without calling a tool, and the next turn, three minutes later, worked with nothing reconnected. It looked random because it depended on which connector the turn needed and how fast that one connected.

## Decision
- **The prompt is streaming input** (`turnPrompt` in `src/runner/agent-claude.ts`): the person's text is yielded once `mcpSettled` resolves, and the input stays open until the turn ends, so approvals and Stop keep their channel.
- **`mcpSettled` polls `mcpServerStatus()`** every 250 ms until no server is `pending`, for at most 10 s (`MCP_WAIT_MS`). `failed`, `needs-auth` and `disabled` count as settled, since waiting won't bring them. A status call that fails, or an abort, ends the wait.

## Alternatives
- **`MCP_CONNECTION_NONBLOCKING` or other Claude Code environment variables**: undocumented, and their headless behaviour isn't part of the SDK's types.
- **One long-lived Claude Code process per session**, so connectors connect once: a larger change to how turns, Stop and resume work, kept for later.
- **Telling the agent in the prompt that connectors may still be connecting**: the tools still wouldn't be in its first request.

## Risk
- A turn starts up to 10 s later while a server stays `pending`. Measured: about 8 s from start to result for a one-word answer, against about 2.4 s before.
- A server slower than 10 s still misses the turn's first request, as before.
