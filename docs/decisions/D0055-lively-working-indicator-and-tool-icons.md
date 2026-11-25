# D0055: A livelier working indicator, and icons for tools and connectors

Date: 2026-11-25. Status: active. Task T-0010. Builds on [D0051](D0051-quiet-tool-calls-and-working-mark.md) and [D0053](D0053-working-mark-dock-and-island-words.md).

## Context
The owner, on 2026-11-25: "make the actual chat waiting animation even more interactive, smooth and polished. use icons for the connectors / tools", then "and everything super smooth and lively", "use this skill https://github.com/leonxlnx/taste-skill", and "on the landing page, when the logo dot jumps up, the very top of the dot gets cut off".

## Decision
- **Tool icons** (`src/web/tool-icons.js`): a 16 unit line glyph for each kind of tool and each claude.ai connector, drawn like the agent glyphs (agent.js) in the text's colour. Examples: a terminal for Bash, a pencil for edits, a magnifier for search, a globe for the web, a spark for a skill; an envelope for Gmail, a calendar, a folder for Drive, a grid for Sheets, a speech bubble for Slack, a page for Notion and Docs, a node graph for Gamma, a receipt for NoCFO. Any other connector gets a plug, any other tool a wrench. `iconKey` picks a key from the tool's name; the markup is fixed, so a name never reaches it. The icons sit on every tool row (chat and dock), up to three on a run's line (one per source, ToolSearch's left out), and beside the step under way. Under the pointer a row's icon lifts on the snappy spring.
- **The working indicator** (`src/web/working.js`, shared by the chat and the dock):
  - it names the step under way, with its icon ("Gamma search organizations"); between steps it shows an island word that cross-fades to another every 4 s and never repeats the one before;
  - a band of the text's colour sweeps across the label (`--dur-sweep`), and the time since the turn began ticks beside it (`elapsedLabel`: "4s", "1m 05s");
  - it pops in on the bouncy spring and fades out when the turn ends; a changed label rises in out of a blur; a new step's icon pops in with a little turn;
  - pointed at, the dot does a bigger hop once (`--dur-poke`);
  - the hop itself is now a 2.4 s loop (`--dur-hop`): the hop takes half of it, then a rest.
- **Runs feel live**: a call that joins a run while the page watches rises into it, and the run's count bumps.
- **The landing page's mark** draws past its box (`overflow: visible`), so the dot's hop is no longer cut off. Its occasional hop now comes every two and a half `--dur-hop` (6 s).

## The taste-skill
Its motion rules are followed:
- loops of 2.5 to 4 s that restart when pointed at;
- everything visibly answers the pointer;
- no random blinking, and nothing fading in on scroll;
- under reduced motion everything rests and nothing stays hidden (base.css stops every animation, and the fade-out has a timed fallback).

Its pipeline is not used: Node 22 scripts, a finish gate, stock photographs and dealt palettes, all for building company websites. The repo is bun and TypeScript only, adds no dependencies, and takes its values from base.css's tokens. Its rule of real full-colour product icons is not followed either: the app's own rule (D0044, the agent glyphs) is plain line shapes in the text's colour, never a product's logo.

## Risk
- The sweep and the ticking time are motion beside the text being read. Both are in `--muted` and small, and both stop under reduced motion.
