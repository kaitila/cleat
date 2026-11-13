# D0007: The design system: Inter and JetBrains Mono, served by the runner; hairlines of one device pixel

Date: 2026-11-13. Status: active.

## Decision
- The interface is set in Inter and code in JetBrains Mono, both as variable woff2 files in `src/web/fonts`, each with its OFL licence beside it. They are the `latin` and `latin-ext` subsets, upright only, from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0, fetched once with `npm pack` and copied in. Neither package is a dependency.
- `base.css` declares the faces with `font-display: swap`, and each page preloads `inter-latin.woff2`. Until Inter is there, and for scripts the subsets lack, text is in "Inter Fallback": the local Segoe UI with `size-adjust: 109%`.
- `--hairline` is the width of every border: `1px`, and `0.5px` under `@media (min-resolution: 2dppx)`.
- Raw colours, lengths, font sizes, border widths, radii, shadows and durations are only in `base.css`. `test/web/design.test.ts` reads the other stylesheets and fails on one, and computes the tokens' contrast ratios in both schemes.
- The components both pages share (button, input, card, row, dot, key hint, well, tool call, approval card) are classes in `base.css`, tool call and approval card included, so the dock uses the same ones.
- The browser scripts check true 2x rendering in a second Chromium started with `--force-device-scale-factor=2`.

## Why
- Inter: drawn for interfaces at 11 to 16px, with a real variable weight axis (no faux bold) and tabular figures. JetBrains Mono: the same tall x-height, so 12px code sits level with 13px text. Segoe UI Variable is good but differs between Windows 10 and 11 and is absent in the headless browser the checks run in; one shipped font makes the pages look the same everywhere.
- Self-hosted: the runner and its pages work with no network, and a page that only ever talks to `127.0.0.1` is the rule the port guard assumes. The scripts assert no request leaves it.
- Subsets, not the full fonts: four files, 190 KB together. Text outside Latin falls back to the system's font, which is what it did before.
- 109%: measured. A paragraph in Inter is 1.08 to 1.09 times as wide as in Segoe UI and Segoe UI Variable, so the swap doesn't rewrap lines.
- Half a CSS pixel at 2x rather than `1px` everywhere: on a 200% display `1px` is two device pixels, which reads as a soft grey band; one device pixel is the crisp line the owner asked for. Chromium draws `0.5px` as exactly one device pixel there. Between 1x and 2x (125%, 150%) the border stays `1px` and Chromium snaps it to whole device pixels.
- The forced scale factor: with only an emulated `deviceScaleFactor`, headless Chromium rounds `0.5px` borders up to `1px` (computed and drawn), so a screenshot would not show what a real 2x display does.

## Not done here
- The runner serves everything under `/assets` with `cache-control: no-store`, so the fonts are read again for each window. On localhost that is a millisecond; caching them is a change to `src/runner/server.ts`, outside this task.
- Italics. Nothing on the pages is italic; with `font-synthesis: none` an `<em>` would stay upright.
