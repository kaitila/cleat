# D0058: An empty MCP server list is not settled until it stays empty 1.5 s

Date: 2026-11-27. Status: active. Task T-0014 (found while building T-0013). Amends D0050.

## Context
D0050's `mcpSettled` stops once no server from `mcpServerStatus()` is `pending`. Before Claude Code has read its MCP config, though, that call answers with an empty list, and an empty list has no pending server, so the wait ended after one poll. The prompt went out before the claude.ai connectors connected: the race D0050 was meant to close was still open (a probe with Haiku answered "No calendar tool is available").

Measured on the owner's Mac (SDK 0.3.322, a `mkdtemp` folder, polling every 50 ms, four runs): the first answer comes 150–330 ms after start and is `[]`; the connectors appear, `pending`, 320–480 ms after that; all are settled by 3.3–3.8 s. With the claude.ai connectors turned off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`), the list stays `[]` until the prompt is sent. `system/init`, which lists the servers, only comes after the prompt, and `initializationResult()` carries no MCP information, so neither can be waited on.

## Decision
`mcpSettled` treats an empty list as not read yet until it has stayed empty for `MCP_EMPTY_MS` (1.5 s) after the first answer. After that it counts as no servers and the wait ends. A non-empty list is settled as before, once none of its servers is `pending`. The 10 s cap still holds.

## Alternatives
- **Settle on `system/init`**: it comes only after the first user message, which is what is being held back.
- **Treat an empty list as unsettled until the cap**, as `serversReady` in `src/runner/plugin-agent.ts` does: a plugin needs its server, but a turn on a machine with no MCP servers would start 10 s late every time.

## Risk
- A turn with no MCP servers starts about 1.5 s later than it did.
- If reading the config ever takes longer than 1.5 s, the wait ends early, as it did before this decision.
