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
| `--motion`, `--ease` | 150ms for colour changes; the dock changes size in two of them. `prefers-reduced-motion` turns all motion off |
| `--sidebar`, `--measure` | Chat view: the sidebar's width; the widest the stream gets |

Light and dark come from `prefers-color-scheme`, each with its own values: in both the page is the middle surface, the sidebar sits behind it and cards in front.

`.dark` gives everything inside it the dark values whatever the scheme. Only the dock's page uses it (`<html class="dark">`). It repeats the dark scheme's values, and `test/web/dock.test.ts` fails when the two differ: change both together.

## Type
Inter for the interface, JetBrains Mono for code (`--font`, `--mono`), both variable and served from `/assets/fonts`; the pages ask no other host for anything. Weights are `--regular` 400, `--medium` 500 and `--semibold` 600, never synthesised.

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

## The dock
One dark island hanging from the top edge of the screen, the same in both schemes (`.dark`), on the `--sunken` surface: the darkest, so it reads as one object on any desktop. Its top corners are square, since it hangs from the edge; the bottom ones have `--radius`. Its edge is a `--line-strong` hairline on the three free sides. It has no shadow: its window is exactly as big as the island ([protocol](protocol.md), "Dock"), so there is nowhere to draw one. The three sizes are the contract's and are set by `dock.js`, not by the stylesheet. Each state's content keeps its full size and fades in while the island changes size around it, so nothing reflows on the way. The open dock uses the components below at their usual sizes; a tool call there is one row (`.tool-name`, `.tool-line`, `.tool-mark`) with no body, which the chat view has.

Focus is always visible: a 2px accent ring (`:focus-visible`). The windows are desktop windows used with a keyboard and a pointer, so controls are 28px tall, not touch sized; below 700px the chat view stacks the sessions above the stream.
