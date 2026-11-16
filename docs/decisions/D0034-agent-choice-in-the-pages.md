# D0034. The agent choice in the pages

Date: 2026-11-16. Status: Active. Task: T-0054.

## Context
T-0053 let the runner run a session on Claude Code or Codex (config `agent`, per workspace, and `StartSessionRequest.agent`; [D0029](D0029-codex-agent.md)). The pages had no way to choose it, to see which agent a session is on, or to tell whether an agent can run on this machine.

## Decision
- **One module, `src/web/agent.js`**, for the names, the glyphs and the switch's logic, shared by the pop-up, the snip, the settings, the chat view and the dock. Glyphs are plain line drawings (an eight-ray spark for Claude Code, a hexagon for Codex), not either product's logo.
- **The pop-up and the snip** have an agent switch beside the workspace. It starts on the chosen workspace's agent, which `GET /api/workspaces` now gives each workspace (`agent`, resolved by the runner: one rule, in `agentFor`). A click or **Alt+A** flips it. Alt+A because Alt+digit already picks a workspace there and A is "agent"; it is read by the physical key, so Option+A on a Mac works and types nothing. A flip holds for that pop-up whichever workspace is picked after: the person said which agent, so a later workspace change doesn't undo it. The task is sent with `agent` always set to what the switch shows, so what was seen is what runs. The task box's placeholder names the agent.
- **The settings page** sets the default agent (a segmented choice, like the permission mode) and each workspace's own (a dropdown, "Default agent" clears it with `agent: null`). The workspace row puts its two dropdowns on a second line under the name and folder, which the two dropdowns side by side squeezed.
- **`GET /api/agents`**, new: each agent as `intuition doctor` checks it (the same commands), kept 30 seconds in the runner, since the commands take a moment and the page asks again on focus. The runner did not have doctor's answers to give, and the page cannot run commands. A line per agent under the default agent says what it needs, then what was found or what to do; it is red when sessions would run on an agent that can't, amber when nothing uses it.
- **The chat view and the dock** put the agent's glyph on every session's row, muted, with the name only as the tooltip and accessible name, and name the agent in words in the session's head.

## Consequences
- The contract grows by `Workspace.agent` and `GET /api/agents` (`AgentStatus`, `AgentsResponse`). A page talking to an older runner reads a missing `agent` as Claude Code and shows the agents' lines as unknown.
- Every row carries a glyph, Claude Code's too: the mark is the same on every row, so the odd one out stands out without a word.
- The "Continue in terminal" of a Codex session is still Claude Code's command until T-0056.
