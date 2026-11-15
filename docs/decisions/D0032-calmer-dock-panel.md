# D0032: The open dock is calmer: a workspace switch in its head, the session's actions in a "…", and nothing scrolls sideways

Date: 2026-11-15. Status: active. Task: T-0047. Builds on [D0010](D0010-dock-fixed-window.md), [D0017](D0017-lively-dock-and-chat-motion.md), [D0020](D0020-session-management.md) and [D0027](D0027-custom-select.md).

## Context
The owner, on the open dock: "make this a whole lot simpler, remove the horizontal scroll and super clean, easy to switch workspace". A title with a URL pushed its row wider than the panel and the list scrolled sideways; the panel stacked the brand, New task, the list, the session's head with "Continue in terminal" and "Open in chat", the stream, the reply box and a key-hint line; and there was no way to see one workspace alone.

## Decision
- **The head is the workspace switch and New task.** The brand is gone. The switch is `.select quiet small` (D0027) with "All workspaces" and each workspace that has a session the dock lists (and the one chosen, even with none left). It filters the list, and the dock opens on a session of that workspace. The pill and the peeks still count every workspace: they say what is going on anywhere.
- **The choice is the dock's, in its own `localStorage`** (`intuition.dock.workspace`, read and written in try/catch by `savedWorkspace` and `saveWorkspace` in `dock-state.js`). It is not a setting: the chat view has its own filter, and a person who picks one in the dock hasn't asked for the chat view to change.
- **A peek from another workspace still opens on its session.** Opening from it shows all workspaces that one time; the remembered choice stays, and the next opening uses it again.
- **The session's head is its title, Stop while a turn runs, and a quiet "…".** The "…" opens the same small menu as a row's right-click, with Open in chat and Continue in terminal (when the session has a Claude Code id) above Rename, Pin and Archive. "Copied" is said in the head for a moment. The dock no longer uses `chat-resume.js`; the chat view still does.
- **The reply's hint is its placeholder.** The line under the box shows only when a reply went wrong (the error, or "It looks open in a terminal" with Send anyway).
- **Nothing in the panel scrolls sideways.** The list is a one-column grid whose rows may shrink (`minmax(0, 1fr)`), so a title ends in "…"; the list and the stream are `overflow-x: hidden`; the stream wraps long words and URLs (`overflow-wrap: anywhere`), and in the dock a code block wraps and a table fits its columns to the width. The chat view keeps code blocks on their lines; the dock is for a glance.
- **The list keeps its "about four rows" as a maximum, not a fixed height**, so one or two sessions don't leave an empty band above the stream. The selected row is scrolled into view.

## Alternatives
- Icons for Open in chat and Continue in terminal in the head: still two more controls in view, and an icon set the app doesn't have.
- Keeping the workspace in the runner's settings: shared with the chat view and the other pages, which the owner didn't ask for, and a protocol change for a view preference.
- A fixed height for the list: steadier, but an empty band with one session, which is the calm case.

## Risk
- A workspace chosen in the dock and then forgotten hides the other workspaces' sessions from the list (not from the pill or the peeks). The switch is the first thing in the head and names the workspace.

## Screenshots
From `bun test/web/dock-ui.ts` (the island is the same dark in both page schemes, D0017):
- [Open, dark](D0032/dock-open-dark.png): All workspaces, the session's head with its quiet "…", the hint as the placeholder.
- [A long URL title, light](D0032/dock-open-long-url-light.png): the row and the head end in "…", the stream wraps; no sideways scroll.
- [One workspace chosen, light](D0032/dock-open-workspace-light.png): the list shows only that workspace's sessions.
- [The "…" menu, light](D0032/dock-open-more-light.png).
