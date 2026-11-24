# D0041: The landing page is one screen around a live notch

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner). Replaces the page of commit 38f6240 (the Glass landing page with screenshots).

## Context
The owner, on 2026-11-24: "make the landing page in the new style, super minimal, if it looks like basic AI-made slop, then redo it". The page was a centred title over a gradient backdrop, a glass install card, a glass box for the dock, three feature rows with screenshots and a "How it works" card: the shape of most generated landing pages. Its dock was the old one (D0032), before the notch (D0035) and the one-line head (D0038, D0040).

## Decision
- **The browser window is the screen.** A Mac's notch hangs from the page's top edge, black on the page's plain ground in either scheme, and does what the app's does on sample sessions: two running in its wings, a peek that one needs you, the open dock (the session as its own switch, another one at work as a chip, the stream, a Bash call waiting), Allow, and back into the notch. It springs on the app's own curves and plays only while it is in view.
- **The words are a caption at the screen's bottom left:** the name, one sentence, the two keys and the hover, the install line with Copy, and one small line on what it runs on. The links sit at the bottom right. On a phone they stack and the dock is drawn smaller.
- **No images, no glass, no backdrop.** The screenshots and `scripts/site-shots.ts` are gone: the live notch shows more than they did.
- **The keys are the visitor's:** Cmd Shift on a Mac, Ctrl Alt elsewhere, as the app's defaults are (`shell/src/os.ts`).
- The rules stay: everything is a token of base.css, nothing loads from another host, links are relative (`test/site.test.ts`).

## Why
- **One object.** The product is the notch; a page that is a screen with the notch on it says that before a word is read, and needs nothing else.
- **A caption, not a hero.** Anchored at the bottom, the empty screen above reads as intended room for the notch to open into, where a centred column under it left a gap.

## Alternatives
- Keeping the layout and swapping in new screenshots: the same template with newer pictures.
- The open dock over the words, as the real one floats over windows: it hid the name for a third of every loop.

## Risk
- A visitor without a notch on their computer may not read the black tab as one. The first line names it, and both agents (Claude Code and Codex).
- Without JavaScript the notch stays idle and the keys are a Mac's.

## Screenshots
From headless Chromium on a build of the page: [idle, light](D0041/site-idle-light.png), [open, dark](D0041/site-open-dark.png), [a phone, light](D0041/site-phone-light.png).
