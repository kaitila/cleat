# Design

Small, clean and calm: a tool that lives in the tray. Everything is in `src/web/base.css`: tokens, type and components. A page's own stylesheet is layout only, and takes every colour, length, font size, border width, radius and shadow from a token. `test/web/design.test.ts` fails on a raw value outside `base.css`, and checks the contrasts below. Why these fonts and this hairline: [D0007](decisions/D0007-design-system.md).

## Tokens
| Token | For |
|---|---|
| `--sunken`, `--bg`, `--surface` | Surfaces, back to front: sidebar, foot and code wells; the page; cards and inputs |
| `--hover`, `--selected` | A row or quiet control under the pointer; the selected row |
| `--line`, `--line-strong` | Hairlines between things; hairlines around controls |
| `--text`, `--muted` | Text (at least 4.5:1 everywhere); secondary text (4.5:1 on the three surfaces, 3:1 on a hovered or selected row) |
| `--accent`, `--accent-text`, `--accent-soft` | The one accent: the primary button, links, focus rings. Its label colour. Its halo around a focused input, and text selection |
| `--running`, `--warn`, `--danger` | Status: green, a session is running; amber, it needs approval; red, it failed |
| `--space-1` … `--space-6` | 4, 8, 12, 16, 24, 40px: every gap and padding |
| `--radius`, `--radius-s` | 8px for cards and inputs; 5px for buttons, rows, key hints and wells |
| `--control`, `--control-s`, `--dot` | Heights: 28px for buttons, inputs and rows; 20px for small buttons and key hints; the 7px status dot |
| `--hairline`, `--ring` | Border width (below); the 2px focus ring |
| `--shadow` | Only for what floats above the page (a menu). Nothing in the page's flow has one, and neither has the dock (below) |
| `--motion`, `--ease` | 150ms for colour changes, and the curve for fades. `prefers-reduced-motion` turns all motion off but fades |
| `--ease-gentle`, `--ease-bouncy`, `--ease-snappy` with `--dur-gentle`, `--dur-bouncy`, `--dur-snappy` | The springs, below ("Motion") |
| `--dur-fade`, `--dur-out`, `--rise`, `--pop` | 120ms for a fade in, 110ms for the way out; how far a thing that springs in travels (6px) and the scale it grows from (0.96) |
| `--device-px`, `--snip-line`, `--snip-mark`, `--snip-mark-w`, `--snip-label`, `--snip-dim`, `--snip-edge` | The snip overlay, the same in both schemes (below) |
| `--island-quiet` | How much of the dock's island shows (0.55) while nothing is going on |
| `--sidebar`, `--measure` | Chat view: the sidebar's width; the widest the stream gets |

Light and dark each have their own values: in both the page is the middle surface, the sidebar sits behind it and cards in front.

## Themes
The setting `theme` (Settings, Appearance) is `system`, `light` or `dark` ([D0018](decisions/D0018-themes-and-settings-page.md)). `src/web/theme.js` sets it on the page: `data-theme="light"` or `"dark"` on `<html>`, and no attribute for `system`, which leaves it to `prefers-color-scheme`. A page that follows the setting loads it first, as a plain script before its stylesheets: `<script src="/assets/theme.js"></script>`. It applies the value cached in `localStorage` at once, so a page never flashes the other theme, then the runner's (`GET /api/settings`), then each `settings` message on `/ws`, live. Every page loads it: the pop-up, the snip, the settings page and the chat view follow it, and the dock loads it too but stays dark (below). The chat view's sidebar has a gear, a square quiet button, that opens the settings page.

base.css has four sets of the colour tokens: `:root` (light), `prefers-color-scheme: dark`, `:root[data-theme="light"]` and `:root[data-theme="dark"]`. The forced sets are the schemes' own values, so one palette is designed per scheme and its contrasts (below, in `design.test.ts`) hold for both ways of choosing it; `test/web/theme.test.ts` fails when they differ and checks the contrasts again. An attribute on `:root` outranks the media rule's plain `:root`, so the order in the file doesn't matter. Change a colour in all of its sets together.

`.dark` and `.light` give everything inside them one scheme whatever the theme: the settings page's previews, and the snip's dim and labels. The dock's `<body>` has `class="dark"`: on `<body>`, not `<html>`, because theme.js puts `data-theme` on `<html>` and `:root[data-theme="light"]` outranks `.dark` on the same element. `.dark` repeats the dark scheme's values, and `test/web/dock.test.ts` fails when the two differ.

## Type
Inter for the interface, JetBrains Mono for code (`--font`, `--mono`), both variable and served from `/assets/fonts`; the pages ask no other host for anything. Weights are `--regular` 400, `--medium` 500 and `--semibold` 600, never synthesised; an `<em>` in a message is slanted by the browser (D0013).

| Size | For |
|---|---|
| `--text-xs` 11px | `.label` captions (uppercase, `--track-caps`) and key hints |
| `--text-s` 12px | `.small` meta lines, and all code (`.mono`, `code`, `pre`) |
| `--text-m` 13px | The interface and prose, line height `--leading` 1.5 |
| `--text-l` 16px | `.title` and the pop-up's task box, with `--track-l` tightening |

Times, durations and costs use tabular numbers (`time`, `.num`).

## Hairlines
Every border is `var(--hairline) solid` a line colour: one device pixel, so 1px, and 0.5px where a CSS pixel is two or more device pixels. Things are separated by hairlines and space, not by shadows or filled boxes. A colour on a hairline carries meaning: amber around an open approval, red around an error.

## Components
- **Button**: `<button>` or `.button` (a link). Plain has a hairline; `.primary` is filled with the accent, one per view at most; `.quiet` has no border until hovered. `.small` is 20px tall.
- **Input**: `.input` on an `<input>` or `<textarea>`. Focus is an accent border and a soft halo.
- **Dropdown**: `.select` on a `<select>` whose first child is `<button><selectedcontent></selectedcontent></button>` (so a long choice ends in "…"); `.quiet` and `.small` as for buttons. Code that rebuilds the options keeps that button. Closed, it is an input with a chevron, focused like one (accent border and halo; `.quiet` takes the plain ring). Open, its list floats like a menu (surface, `--shadow`, `--radius`, springing in on `--ease-snappy` and fading out): rows highlighted with `--selected` under the pointer or the keys, a muted check at the end of the chosen one. Drawn by `appearance: base-select`, so it stays the browser's select, keys and all; a browser without it shows the OS's list ([D0027](decisions/D0027-custom-select.md)).
- **Card**: `.card`, a surface inside a hairline with the larger radius. Padding is the page's.
- **List row**: `.row`, 28px or taller, hover and `aria-current="true"` (or `aria-selected`) backgrounds, no border.
- **Session list** (the chat view's sidebar, [D0033](decisions/D0033-sidebar-workspace-groups.md)): grouped by workspace. A group's heading is a `.group-head` button, a `.row` in `--text-s` medium `--muted` (the `--text` under the pointer): the workspace's name, its count in `--muted` regular, a chevron of two `--muted` hairlines at the end that points down when open and right when folded. Groups are a `--hairline` of `--line` apart; the groups with the newest session come first. Each session is one 28px `.row`: dot, the `>_` terminal mark if it came from a terminal, the title (ellipsized), "Pinned" in the accent, the time; the "…" button takes the time's place under the pointer. No row names its workspace. With one workspace, or one chosen in the filter, no heading is drawn. A heading (click, Enter or Space; `aria-expanded`) folds its group, remembered in `localStorage`; a folded group still shows the open session's row; while a search is typed every group with a match is open.
- **Status dot**: `.dot` with `data-status` set to the session's status. `running` pulses.
- **Key hint**: `<kbd>`, one per key, its meaning in plain text after it.
- **Well**: `.well`, a sunken block for code and output.
- **Tool call**: `<details class="tool">` with `.tool-name`, `.tool-line`, `.tool-mark` in its summary and a `.tool-body`: one 28px row until opened.
- **Approval card**: `.approval` with `data-state` `open`, `allow`, `deny` or `unanswered`; `.approval-head`, `-tool`, `-state`, `-path`, `-input`, `-reason`, `-actions`. Open, it is the one amber thing on the page; decided, it is as quiet as a tool call.
- **Setting**: `.setting` in a `.card`, the settings page's row: a name over one muted line on the left, its control on the right, rows a hairline apart. A choice of two is a `.segmented` radio group; on or off is a `.switch` (a checkbox, `role="switch"`); a shortcut is its keycaps on a quiet button that records the next keys pressed. A 400's error is a `.field-error` line in `--danger` right under the field it names, and the field's border turns red; "Saved" is a muted word at the top that fades.
- **Markdown**: `.md` on an assistant's message, drawn by `markdown.js` ([D0013](decisions/D0013-markdown-renderer.md)). Compact, a chat and not a document: blocks `--space-2` apart, headings at `--text-m` semibold (`h1` at `--text-l`, `h5`/`h6` muted), lists indented by one and a half times the type size with muted markers, task marks as small boxes (done: filled with the accent), quotes behind a `--line-strong` hairline in `--muted`, rules and table rows as hairlines, code blocks as `.well` that scroll sideways with their language as a quiet caption. Links are the accent, underlined in `--accent-soft`. `<em>` is the browser's slanted Inter, the one synthesis allowed. The person's own messages stay plain text.

## Motion
Things move like objects with a little weight, not on straight lines: they spring. Three springs, as CSS `linear()` curves, each with the duration it takes to come to rest:

| Spring | Feel | Duration | Use it for |
|---|---|---|---|
| `--ease-gentle` | Near critical, under 1% overshoot | `--dur-gentle` 290ms | Something appearing or sliding without fuss: a page's contents as its window opens |
| `--ease-bouncy` | About 11% past its end, then back | `--dur-bouncy` 350ms | Something that arrives or is chosen: the snip's prompt box, a clipboard attachment, the workspace mark sliding |
| `--ease-snappy` | Critical in effect, under 0.2% | `--dur-snappy` 190ms | A quick answer to a key or a click |

Always pair a curve with its own duration (`animation: x var(--dur-bouncy) var(--ease-bouncy)`): the curve is the spring's path over exactly that time. Opacity doesn't spring: a thing that springs in also fades in on `--dur-fade` and `--ease`, as a second animation. Leaving is a fade on `--dur-out`, quick and soft, with no spring.

Animate `transform` and `opacity` only, never size or position: a change of size is a FLIP (set the new size at once, draw it where it was with a transform, let the transform go), as the pop-up's workspace mark does. Travel is small: `--rise` and `--pop`. Something that follows the pointer (the snip's selection while dragging) follows it exactly, with no easing; it may settle with a spring when let go. The focus never waits for an animation: put it in place first, then start the motion.

The curves come from `src/web/motion.js`, which turns a stiffness and a damping into `linear()` points and a settle time; `bun src/web/motion.js` prints the tokens to paste into `base.css`, and `test/web/motion.test.ts` fails when the two differ. A new spring is a new entry there, not a hand-written curve.

**Reduced motion.** Under `prefers-reduced-motion` base.css stops every animation and transition, and sets `--rise` to 0, `--pop` to 1, every spring to `linear` and every spring's duration to `--dur-fade`. A page that wants its fades back says so in its own `@media (prefers-reduced-motion: reduce)` rule, naming only fade keyframes with `!important` (as `snip.css`, `prompt.css` and `dock.css` do): a short plain fade, nothing that moves.

**The chat view.** Something that happens while the page watches rises in on `--ease-gentle` (`.arrive`, set by `chat.js` on live events only). A session's history, loaded when it is selected, is drawn at once. The complete text that replaces streamed text doesn't rise again. An approval card arrives with a small bounce (`--ease-bouncy`, from twice `--rise` and `--pop`). A tool row's body drops in on the bouncy spring while the rows below it glide down (a FLIP with the same spring, through the Web Animations API with the token's curve). Closing, the body fades out on `--dur-out`, then the rows below gather up on the gentle spring. Selecting another session cross-fades: a copy of the old stream, over the new one, fades out on `--dur-out` while the new stream and its head fade in. Folding a sidebar group: the rows go at once and the groups below gather up on the gentle spring (a FLIP); unfolding, the rows drop in from under the heading on the gentle spring with a fade while the groups below glide down, and the chevron turns on the same spring. Under reduced motion nothing glides: only those fades remain, and a group folds and unfolds at once.

## The snip overlay
One window over each display, on the frozen screen. The rest of the screen is dimmed by the dark back surface at `--snip-dim` (about half), fading in fast (`--dur-fade`) once the capture is up; the selection is cut out of the dim, so it shows the screen as it is. Nothing in it is the accent: its edge is a neutral light hairline (`--snip-line`), a ring one device pixel wide (`--device-px`, which `snip.js` sets from the display's scale) just outside the selection, drawn on the device pixels the crop takes, as part of `--snip-edge` with a faint light inside the edge that lifts the area a little above the dim. Its corners have short marks two device pixels wide (`--snip-mark`, `--snip-mark-w`), left out on a selection too small for them. Its size, in device pixels, sits on a dark veil (`--snip-label`) in the same light.

The prompt box is centred on the selection, below it, above it when there is no room below, inside it at its bottom when neither fits, and kept on the display (`anchorBox` in `snip-geometry.js`). While dragging, the selection follows the pointer exactly. On release the corner marks settle in from a few pixels out on `--ease-bouncy`, and the box springs in on it (from `--pop` and `--rise` below its place) with the focus already in its task box. Esc, or a started session, fades the dim, the edge and the box out (`--dur-out`) to the frozen screen, then closes the window.

## The dock
One dark island hanging from the top edge of the screen, the same in both schemes (`.dark`), on the `--sunken` surface: the darkest, so it reads as one object on any desktop. Its top corners are square, since it hangs from the edge; the bottom ones have `--radius`. Its edge is a hairline on the three free sides: `--line-strong`, and the quieter `--line` when nothing is going on. It has no shadow, filter or blur.

It is subtle before anything else. Idle is a sliver at most 22px tall and as wide as its words: a dot alone, 16px tall and at `--island-quiet`, when nothing is going on; muted words when something runs; colour (`--warn`, `--danger`) only for "needs you" and "failed". A peek is one 40px line. Open is as tall as its content, at most 480px.

The island's element is as large as the shell's window and never changes size ([protocol](protocol.md), "Dock"; [D0010](decisions/D0010-dock-fixed-window.md)). What is seen of it is its `clip-path`, whose size `dock.js` sets from the contract's numbers and the content; the edge is the island's colour showing around a surface clipped one hairline smaller. A change of state animates that clip, and the opacity and transform of the content, and nothing else: each state's content keeps its full size and place and comes in once the shape is most of the way there, so nothing reflows on the way.

The island moves like a droplet ([D0017](decisions/D0017-lively-dock-and-chat-motion.md)). Its drawn width and height are two registered lengths (`--island-w`, `--island-h`, `@property`) that only the clip reads, each on its own transition. Growing, the height leads on `--ease-bouncy` and the width follows a tenth of the spring later: a quick stretch down, a little past its size and back. The clip's top inset is always 0, so the top edge stays on the screen's edge through the whole spring. The overshoot stays inside the shell's fixed window: a peek overshoots in both ways, but the open dock is as wide as the window, so it overshoots only in height, and only when its panel is shorter than the window. Closing gathers back into the pill on `--ease-gentle`, the width a moment ahead of the height. A peek's line pops in (`--rise`, `--pop`, bouncy) and its words slide in after it, one after the other. The pill's running dot breathes slowly; a new "needs you" nudges the dot once. Opened, the session rows and the selected session's newest events rise in, staggered by a sixth of `--dur-snappy`. One that arrives on its own later rises in at once. An approval card pops in on the bouncy spring. The hover-intent delay is unchanged. With `prefers-reduced-motion` the shape changes at once and the content fades in plainly. The open dock uses the components above at their usual sizes; a tool call there is one row (`.tool-name`, `.tool-line`, `.tool-mark`) with no body, which the chat view has.

Focus is always visible: a 2px accent ring (`:focus-visible`). The windows are desktop windows used with a keyboard and a pointer, so controls are 28px tall, not touch sized; below 700px the chat view stacks the sessions above the stream.
