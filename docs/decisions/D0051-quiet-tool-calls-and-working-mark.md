# D0051: Quiet tool calls in runs, and the Ledge as the working mark

Date: 2026-11-25. Status: active. Task T-0006.

## Context
The owner, on 2026-11-25, with a screenshot of the chat in the notch showing eleven tool rows in a row (`mcp__claude_ai_Gamma__search_organizations {"name":"Pyrami…`): "make the tool use thing nicer, a bit more discrete and improve the mid response animation and loading thing. maybe animating our logo?"

Each call was a bordered card with the raw tool name and its input as JSON, so a turn's tool calls filled more of the stream than its answer. While a turn ran, nothing moved apart from text arriving, and the streaming text was muted, then jumped to the text's colour when it was complete.

## Decision
- **Labels people read.** `toolLabel` in `chat-format.js`: an MCP tool is its server's name without the "claude.ai " prefix and its tool's words ("Gamma" / "list deals"; an action that starts with the source's name drops it, "Slack" / "search public and private"); ToolSearch is "Tools" / "load". `toolSummary` takes the input's telling text field (query, q, pattern, url, skill, name, description, prompt, else the first text), and ToolSearch's `select:` list as labels; JSON only for an input with no text. The dock's tool rows use the same.
- **No card.** A closed call is one row of `--text-s` `--muted` text with no border or fill; opened, it gets `--surface`.
- **Runs.** Calls in a row fold into one `<details class="steps">` line: "11 steps", then the first three sources (ToolSearch left out while there is anything else) with "+n" for the rest, or the call under way while one is, and how many failed. A lone call stays a row of its own; the second call in a row folds both into a run. Text, an approval card or the next turn ends a run.
- **The Ledge works.** While the selected session's status is `running`, the logo sits at the stream's end in `--muted`, and its dot hops on the ledge: a small squash, a rise, a squash on landing, a rest (`--dur-hop`, 1.5 s). It stays black-and-white like every other use of the mark (D0044): the motion is the only thing that is new. Under reduced motion the dot breathes (an opacity fade) instead. The SVG lives in `chat.html` as a `<template>`, so `chat.js` keeps its no-markup-strings rule.
- **Streaming text is the text's colour.** The working mark now says the turn is under way, so the text doesn't need to.

## Alternatives
- **A spinner or three dots**: the owner asked for the logo, and a dot waiting on a ledge already looks like waiting.
- **Hiding tool calls entirely**: they are the record of what the agent did, and approvals depend on seeing them; a run keeps them one click away.
- **The whole mark moving (a pulse or a spin)**: louder, and it would stop reading as the logo.

## Risk
- A run hides which call failed until it is opened; its line says "n failed" in `--danger`.
- Sources shown are only the first three: "+n" says there are more.
