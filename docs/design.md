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
| `--motion`, `--ease` | 150ms for colour changes. `prefers-reduced-motion` turns all motion off |
| `--island-open`, `--island-close`, `--settle`, `--island-quiet` | The dock's island: 320ms to grow, on a curve that leaves fast and settles long without passing its size; 220ms to shrink; how much of it shows (0.55) while nothing is going on |
| `--sidebar`, `--measure` | Chat view: the sidebar's width; the widest the stream gets |

Light and dark come from `prefers-color-scheme`, each with its own values: in both the page is the middle surface, the sidebar sits behind it and cards in front.

`.dark` gives everything inside it the dark values whatever the scheme. Only the dock's page uses it (`<html class="dark">`). It repeats the dark scheme's values, and `test/web/dock.test.ts` fails when the two differ: change both together.

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
- **Card**: `.card`, a surface inside a hairline with the larger radius. Padding is the page's.
- **List row**: `.row`, 28px or taller, hover and `aria-current="true"` (or `aria-selected`) backgrounds, no border.
- **Status dot**: `.dot` with `data-status` set to the session's status. `running` pulses.
- **Key hint**: `<kbd>`, one per key, its meaning in plain text after it.
- **Well**: `.well`, a sunken block for code and output.
- **Tool call**: `<details class="tool">` with `.tool-name`, `.tool-line`, `.tool-mark` in its summary and a `.tool-body`: one 28px row until opened.
- **Approval card**: `.approval` with `data-state` `open`, `allow`, `deny` or `unanswered`; `.approval-head`, `-tool`, `-state`, `-path`, `-input`, `-reason`, `-actions`. Open, it is the one amber thing on the page; decided, it is as quiet as a tool call.
- **Markdown**: `.md` on an assistant's message, drawn by `markdown.js` ([D0013](decisions/D0013-markdown-renderer.md)). Compact, a chat and not a document: blocks `--space-2` apart, headings at `--text-m` semibold (`h1` at `--text-l`, `h5`/`h6` muted), lists indented by one and a half times the type size with muted markers, task marks as small boxes (done: filled with the accent), quotes behind a `--line-strong` hairline in `--muted`, rules and table rows as hairlines, code blocks as `.well` that scroll sideways with their language as a quiet caption. Links are the accent, underlined in `--accent-soft`. `<em>` is the browser's slanted Inter, the one synthesis allowed. The person's own messages stay plain text.

## The dock
One dark island hanging from the top edge of the screen, the same in both schemes (`.dark`), on the `--sunken` surface: the darkest, so it reads as one object on any desktop. Its top corners are square, since it hangs from the edge; the bottom ones have `--radius`. Its edge is a hairline on the three free sides: `--line-strong`, and the quieter `--line` when nothing is going on. It has no shadow, filter or blur.

It is subtle before anything else. Idle is a sliver at most 22px tall and as wide as its words: a dot alone, 16px tall and at `--island-quiet`, when nothing is going on; muted words when something runs; colour (`--warn`, `--danger`) only for "needs you" and "failed". A peek is one 40px line. Open is as tall as its content, at most 480px.

The island's element is as large as the shell's window and never changes size ([protocol](protocol.md), "Dock"; [D0010](decisions/D0010-dock-fixed-window.md)). What is seen of it is its `clip-path`, whose size `dock.js` sets from the contract's numbers and the content; the edge is the island's colour showing around a surface clipped one hairline smaller. A change of state animates that clip, and the opacity and transform of the content, and nothing else: each state's content keeps its full size and place and fades in once the shape is most of the way there, so nothing reflows on the way. The shape never overshoots: it hangs from the screen's edge. With `prefers-reduced-motion` the shape changes at once and the content fades in plainly. The open dock uses the components above at their usual sizes; a tool call there is one row (`.tool-name`, `.tool-line`, `.tool-mark`) with no body, which the chat view has.

Focus is always visible: a 2px accent ring (`:focus-visible`). The windows are desktop windows used with a keyboard and a pointer, so controls are 28px tall, not touch sized; below 700px the chat view stacks the sessions above the stream.
