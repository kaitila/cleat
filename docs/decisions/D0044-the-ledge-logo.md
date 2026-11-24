# D0044: The logo is the Ledge, in black and white only

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner, with the rename to holm).

## Context
The app had no mark: the tray showed an indigo disc, the windows and notifications reused it, and the pages had no favicon. With the rename to holm the owner looked at eleven candidates side by side (A to K below, each at 16, 22, 32 and 128 px, in a light and a dark menu bar) and picked one: "H - ledge, but just b&w, no green".

## Decision
- **The mark is the Ledge:** a dot waiting on a ledge, off to one side. In a 24-unit viewBox, a circle at (16.5, 10) of radius 4.5 over a 20 x 4 bar at y 16.5 with round ends. Its numbers live in `MARK` in `shell/src/geometry.ts`; the SVG copies are `src/web/mark.svg` (the tile) and the inline marks in `chat.html` and `site/index.html`.
- **Black and white only.** Black on light, white on dark, never green or any status colour, in any size or place. The status dots stay in the app; the mark is not one of them.
- **The macOS menu bar:** the mark alone, 18 points at 1x and 2x, as a template image, so macOS draws it in the bar's own colour. `markBitmap()` draws it per pixel with 8 x 8 samples for anti-aliasing, and puts the bar's top and bottom edges on whole pixels so it is crisp at 16 px; the dot stays round.
- **The app icon** (window icons, notifications, and the tray off a Mac): the mark in white, at 0.8 of the size, on a black rounded tile (radius 5.4 of 24). `tileBitmap()` draws it; off a Mac the tray is 16 points at 1x and 2x. Windows and Linux do not tint tray icons, and their taskbars and panels are light or dark by theme: the black tile reads on a light one, its white mark on a dark one.
- **The pages:** `src/web/mark.svg` is the favicon of every page the runner serves and of the landing page (the site build copies it from `src/web/`). The mark stands beside the name in the chat's sidebar and on the landing page, in `currentColor`, so it is the text's own token colour. The landing page's green running dot beside the name is gone.

## Why the Ledge
- It reads at 16 px: two simple shapes with a clear gap, no counter or cut to close up (A, D and E blur at that size).
- It is calm: something set down and waiting, which is what a handed-off task is, without drawing the notch literally (A, B, D, G, I) or a letter (E, J, K).
- It is asymmetric enough to be a mark and not a generic glyph (J's dot is just a dot; F reads as a hat).

## Candidates considered
- **A Island:** the notch as a tab hanging from the top, a session dot knocked out of it.
- **B Notch:** the screen's top edge and the notch hanging from it; a session drops out below.
- **C Catch:** the notch's profile as one line, a dot caught in its dip.
- **D Screen:** the screen with the notch cut into its top edge, one session dot below it.
- **E h:** a geometric lowercase h, a session dot resting in its counter.
- **F Islet:** a holm in water: a small rounded mass on a horizon line.
- **G Peek:** the top edge, and a session peeking out from under its right end.
- **H Ledge:** a session dot waiting on a ledge, off to one side. Chosen.
- **I Two pills:** the notch, and the smaller peek dropping out of it.
- **J Wordmark, dot:** holm with its o as a solid dot; alone, the dot (the old tray disc).
- **K Wordmark, notch o:** holm with the o's hole shaped as the notch; alone, that o.

## Not done
- **No macOS bundle icon or Linux .desktop icon.** The shell runs Electron.app as installed, with no bundle of its own, and on a Mac it has no Dock icon; Linux only writes an autostart entry, where an icon shows nowhere. Both wait for a packaged app.
- The favicon's two colours are written in `mark.svg`: a browser draws it outside any page, where base.css's tokens cannot reach.

## Screenshots
[The candidates, light and dark](D0044/candidates@2x.png), [the Ledge in the preview](D0044/cand-h@2x.png), and [the tray bitmap as drawn](D0044/tray-pixels.png): 16, 18 and 22 points at 1x and 2x on a light and a dark bar, each pixel shown 6x.
