# D0033: The chat view's sidebar groups sessions under foldable workspace headings

Date: 2026-11-16. Status: active. Task: T-0048. Builds on [D0020](D0020-session-management.md) and [D0027](D0027-custom-select.md).

## Context
Every session row in the sidebar was two lines, and the second repeated its workspace ("work", ">_ work") on every row, so a list from one workspace was a tall column of the same word. Nothing grouped or folded. The owner asked for the workspaces to "fold and stack nicer".

## Decision
- **One group per workspace**, a heading over each: the name, a muted count, a chevron. A group's sessions are in the list's usual order (pinned first, then the newest); the groups are ordered by their newest session, pinned or not (`grouped` in `chat-manage.js`). Groups are `<li class="group">` in `#sessions`, each a heading button and its own `<ul>` of rows.
- **Rows are one line**: dot, the terminal mark (">_") if the session came from a terminal, the title (ellipsized), "Pinned" if pinned, the time. The workspace line is gone: the heading says it.
- **Headings only when there is something to tell apart** (`showHeadings`): more than one workspace among the sessions of the list shown (the Archived view counts its own), and no workspace chosen in the filter. Otherwise no heading is drawn and nothing is folded, so a person with one workspace sees a plain list.
- **A heading folds its group**: a `<button>` with `aria-expanded` and `aria-controls`, so click, Enter and Space all work with no key handling of ours. The folded workspaces are remembered in `localStorage` (`intuition.chat.folded`, a JSON list of names), read and written in try/catch: where storage is refused the folds last the page.
- **The selected session is never hidden.** A folded group still shows the open session's row, and only that one. Selecting a session that was asked for (a click, the search, a `?session=` link, back and forward) unfolds its group and forgets that fold. A session the page picks by itself (the newest, on opening or after a delete) leaves the folds alone, and the pick prefers a group that isn't folded, so a reload keeps the folds.
- **Search opens every group.** While a query is typed every group with a match is unfolded and counts its matches; a heading clicked during the search folds the group for that search only (a separate set, cleared when the query is), so searching never undoes a remembered fold.
- **Motion**: unfolding, the group's rows drop in on the gentle spring with a fade while the groups below glide down (a FLIP on the gentle spring); folding, the rows go at once and the groups below gather up on the same spring. The chevron turns on the gentle spring. Under reduced motion all of it is instant.

## Alternatives
- `<details>` per group: its `open` state would be the fold, but `<summary>` can't be hidden for the one-workspace case without hiding the content too, and the selected row's exception needs per-row control anyway.
- Folding the selected session's row away with the rest: the head still names it, but the sidebar would then hide where you are, which the task rules out.
- Remembering folds in the runner's config: per-device layout, not a setting; localStorage is what the theme cache does too.

## Risk
- A workspace renamed in the config leaves its old name in the folded list; it matches nothing and does no harm.
