# D0038: The open dock's session is its own switch, the list stays closed until asked for, and the reply box is quieter

Date: 2026-11-24. Status: active; the head's other sessions at work, the switch's find and its keys are [D0040](D0040-dock-switch-and-command-keys.md). No foreman task (asked for in a session by the owner). Changes the head and the list of [D0032](D0032-calmer-dock-panel.md); builds on [D0034](D0034-agent-choice-in-the-pages.md) and [D0036](D0036-dock-keyboard.md).

## Context
The owner, on 2026-11-24, with a screenshot of the open dock out of the notch: "make it clearer to read, now the actual chat field is unclear and cluttered. maybe the session switcher could be better?" The panel stacked the workspace switch and New task, four session rows, a second head that repeated the selected row's title with the agent's name and "…", the stream, and a reply box with an accent ring. The list and the repeated title took a third of the panel before the session's own text began.

## Decision
- **The head is one line, and the session shown is its own switch.** A quiet button with the session's status dot, its agent's glyph (the agent's name is the tooltip), its title in one line that ends in "…", and a chevron. After it: Stop while a turn runs, a refusal or "Copied" for a moment, the quiet "…" (Open in chat, Continue in terminal, Rename, Pin, Archive), and New task at the right. The second head, with the title again and the agent's name, is gone.
- **The list is closed until the switch is pressed.** Open, it lies under the head and pushes the stream down; the island grows with it, as with any change of its content. It has the workspace switch at its top, then the rows as before (D0032). Picking a row shows that session, closes the list and puts the keyboard back in the reply. Esc closes the list first, and a second Esc the dock. Every opening of the dock starts with it closed. Rename from "…" opens the list, since the title is edited in its row. Alt+Up and Alt+Down step through the sessions and Alt+1..9 pick a workspace with the list closed (D0036).
- **The reply box is quieter.** A faint `--line` edge on `--surface`, no rule above it, and focused only its edge firms up to `--line-strong`, without the accent ring. The dock puts the keyboard in it on every opening, so a ring there was always lit.
- **The stream keeps its parts apart** (asked for the same day: "make the separation clearer, now it's a bit jumbled still"). A hairline is drawn under the head while the stream is scrolled down, and above the reply box while there is more below, so text no longer runs straight into either. A tool call is a small muted line, so it reads as a step and not as the agent's words, and calls in a row stay together. The stream's parts are `--space-3` apart, and a new message of the person's has more air above it.

## Why
- **The session is what the open dock is for.** The list is for switching, which is a moment; reading and replying is the rest of the time. A list always in view and a title shown twice cost the stream a third of the panel.
- **In the flow, not over the stream.** The island is translucent glass without a notch; a list floating over the stream would show the text through it. In the flow, the list and the stream never overlap, and the island's own spring carries the change of height.
- **No accent ring on the dock's reply.** The focus is still visible (the edge firms up, the caret blinks), but the brightest thing in the panel is no longer an empty box.

## Alternatives
- A dropdown over the stream: the same one-line head, but over translucent glass, and a second way to dismiss it.
- Keeping the list and shortening it to two rows: still a title shown twice, and still the list's band on every opening.
- Tabs of sessions across the head: no room at 460px for more than two titles.

## Risk
- Switching takes one press more than before (the switch, then a row). Alt+Up and Alt+Down still step without it.
- `focus-visible` on the dock's reply is no longer the accent ring of every other input (design.md, "Focus is always visible"); the firmer edge is the dock's own focus mark.

## Screenshots
From a run of `bun test/web/dock-ui.ts` and the same harness with a stand-in notch:
- [Open, dark](D0038/dock-open-dark.png): the one-line head over a long answer.
- [The list open, out of a notch](D0038/dock-list-notch.png): the workspace switch and the rows under the head, the stream pushed down.
- [A running session, light](D0038/dock-open-stop-light.png): Stop in the head, the quiet reply box.
