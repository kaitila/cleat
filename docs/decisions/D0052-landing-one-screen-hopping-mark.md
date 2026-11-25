# D0052: The landing page is one screen that never scrolls, and its mark hops now and then

Date: 2026-11-25. Status: active. Task T-0007. Follows [D0041](D0041-landing-page-one-screen.md) (the page as one screen around the notch) and [D0051](D0051-quiet-tool-calls-and-working-mark.md) (the working mark's hop).

## Context
The owner, on 2026-11-25: "update the landing page to include the animated logo somehow, subtle, and make it so that the landing page doesnt scroll". The page was meant as one screen, but `.screen` was at least `100svh` with a fixed 420 px gap above the words, so it was 927 px tall at every desktop size and over 1000 px on a phone: every window scrolled.

## Decision
- **Exactly one screen.** `html, body` don't scroll, and `.screen` is `100svh`. The words keep their height at the bottom; the notch's stage takes the rest (`flex: 1`), no longer a fixed 406 px.
- **Shorter windows draw the notch smaller** rather than scrolling: `scale` steps of 0.86, 0.72 and 0.58 at heights of 760, 660 and 560 px. Below 660 px the fine print goes. The scale is from the notch's top edge, so it still hangs from the screen's top.
- **Desktop: two columns of words.** The name, the line and the install line are on the left; the keys and the links are on the right. Their height is about halved, which leaves the chat state room above them.
- **Narrow windows leave the keys out.** They are a desktop app's hotkeys. The words are one column, and a phone draws the notch at 0.72 (0.6 on a short one).
- **The mark beside the name hops now and then.** Its dot (`.mark-dot` in base.css) does the working mark's hop once every four `--dur-hop` (about 6 s) and rests in between. It is black on the light page, as the mark always is (D0044). Under reduced motion it doesn't move. The keyframes are in base.css with the app's hop, because the site's own stylesheet takes curves only from tokens.

## Checked
Built and measured in headless Chrome at 1440×900, 1280×720, 1024×640, 390×844 and 375×667: `scrollHeight` equals the window's height, and the notch's box (its largest state's size) ends above the name.

## Risk
- A window shorter than about 450 px cuts the words off rather than scrolling to them.
