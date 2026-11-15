# D0017: Lively spring motion in the dock and the chat view

Date: 2026-11-15. Status: active. Task: T-0028.

## Context
The owner on 2026-11-13: "all of the animations should be a bit more lively, fluidlike and bouncy, instead of direct, straight, stiff." T-0027 added spring tokens to `base.css` (`--ease-gentle`, `--ease-bouncy`, `--ease-snappy`, each with its duration) and used them in the snip and the pop-up. The dock's island was drawn by a clip that grew on one Bézier curve and never overshot, and the chat view had no motion of its own.

## Decision
- **The island's size springs in two parts.** The drawn width and height are registered custom properties (`@property --island-w / --island-h`, `<length>`, not inherited) that only the clip-path reads. Each has its own transition. Opening, the height leads on `--ease-bouncy` and the width follows `--dur-bouncy / 10` later, so the island stretches down and then out, like a droplet. Closing uses `--ease-gentle`, the width a moment ahead of the height. `dock.js` sets both properties on the island and on its surface, because they are not inherited and each layer's clip springs on its own.
- **The top edge never moves.** The clip's top inset is always 0. Only its sides and bottom spring, so an overshoot grows down and outward, never off the screen's edge. `dock-ui.ts` samples the island's first row of pixels in every frame of the open, the close and a peek.
- **The overshoot stays inside the fixed window** (D0010). The open dock is as wide as the window, so it overshoots only in height, and only when its panel is shorter than the window. A peek (380 of 460px) overshoots in both, to about 413px wide. For those few frames the drawn island is a little wider than the shell's mouse rectangle for a peek. It takes no clicks there, which is harmless for a moment.
- **Content motion.** A peek's line pops in (bouncy) and its words slide in after it, staggered. The pill's running dot breathes. A new "needs you" on the pill nudges its dot once, but not on connect: what the runner reports on connecting is not news. The rows and the newest events of the opened dock rise in with a stagger of a sixth of `--dur-snappy`, at most six of them.
- **Chat view.** Only what happens while the page watches rises in (`live` in `chat.js`). History loaded on selecting a session doesn't, because the cross-fade covers it. Tool rows open and close with a spring: a FLIP of the rows below, with the spring read from the tokens (`getComputedStyle`) into `Element.animate`. The size never animates. Selecting a session cross-fades with an inert copy of the old stream that fades out over the new one.
- **Reduced motion: short fades only.** base.css already makes the springs linear and short. The pages' own reduced-motion rules name only fade keyframes, and the FLIP is skipped.

## Why
- Animating the two lengths, rather than the clip-path as one value, lets width and height take different curves and delays. That is what makes the opening a droplet rather than a box being scaled. The paint stays a clip, so layout never changes and the worst frame stays at one 60 Hz frame (16.8 ms in `dock-ui.ts`).
- A FLIP keeps the chat view's tool rows to transform and opacity, as docs/design.md asks, while the content below still moves with the spring rather than jumping.
- The approval card is wide, so a 4% scale overshooting by 11% is under half a percent and doesn't show. Looking at its frame strip showed no visible bounce, so it rises from twice `--rise`.

## Risk
- `@property` needs Chromium 85+, which Electron and the test browser both have.
- The cross-fade copies the stream's DOM for about 110 ms. It has no ids and is inert, so nothing in it can be focused or clicked.
