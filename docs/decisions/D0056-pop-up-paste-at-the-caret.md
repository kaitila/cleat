# D0056: The pop-up attaches nothing by itself; what is pasted goes in at the caret

Date: 2026-11-26. Status: active. Task T-0011. Contract change: `POST /api/images`, `GET /api/images/<name>`, and `images` on a start, a reply and a `user` event. Replaces the clipboard attachment of the pop-up (protocol "Clipboard images"; D0046's Backspace to remove it).

## Context
The owner, on 2026-11-26: "remove the automatic clipboard thing from the new session view, then make it so that pasting multiple lines or pictures paste in nicely in the place your cursor is, i cant explain it but it needs to be super polished. also by default, the window doesnt have to be that big".

Until now the hotkey captured the clipboard, and the pop-up attached it under its task box, with a thumbnail or the first lines, until it was removed. That happened whether or not the clipboard had anything to do with the task. The task box was a textarea in a fixed 560×380 window: a pasted picture went nowhere, and the window was big for a one-line task.

## Decision
- **Nothing is attached by itself.** The hotkey only opens the pop-up (`newTask()` no longer calls `captureClipboard()`; the self-test still checks the capture), and the page no longer polls `/api/clipboard` or draws an attachment. `/api/clipboard` stays for the shell's self-test.
- **The task box is a plain-text editable** (`src/web/composer.js`), `contenteditable="plaintext-only"` where the browser has it:
  - **Pasted text** goes in at the caret as plain text, through `insertText`, so undo works. Windows and old Mac line ends become `\n`, and one final newline is dropped.
  - **A long paste** (more than 8 lines, or more than 1200 characters) becomes a chip at the caret: a page icon and "Pasted text · 42 lines". A click opens it back into the text where it stood. It is sent in full.
  - **A picture**, pasted or dropped (the card's edge lights up while one is dragged over it), becomes a chip at the caret: its thumbnail and "Image 1", "Image 2" in reading order, renumbered as chips come and go. The page draws it into a canvas, so any type the browser decodes becomes a PNG, at most 3000 px on its longer side. It is posted to the runner while typing goes on; the thumbnail breathes until the upload lands, and a failed upload marks the chip red.
  - **Chips** pop in on the bouncy spring, go with one Backspace (the space after them first), and show a × under the pointer. Text never becomes markup: chips are built from elements, and a paste goes in as text.
  - **Sending** waits for uploads still under way. The prompt is the text with each picture as `[Image #n]` in its place and each pasted text in full; `images` lists the pictures' paths in that order. A failed upload stops the send and says so.
- **The runner keeps pasted pictures** in `<dataDir>/images/<uuid>.png` (`POST /api/images`, base64 PNG, at most 15 MB). `images` on a start or a reply takes at most 20 paths, each a PNG directly in that folder or one the clipboard rule takes (a snip), and anything else is a 400. The agent's prompt gets `Attached images (read these files):` and a line `[Image #n]: <path>` for each. The `user` event keeps `images` apart from the text. The chat draws them as thumbnails from `GET /api/images/<uuid>.png`.
- **The window opens small and grows.** It opens 520×172: the workspaces, two lines of task and the hint line. Its top sits where a fully grown pop-up would be centred, so it opens a little above the middle. The page asks for the height its content needs through the pop-up's own preload (`window.cleatPopup.fit(height)`, `shell/src/popup-preload.ts`). The shell takes the ask only from the pop-up's main frame on the runner's origin, clamps it to 172–520 and keeps the top edge; a Mac animates the change. Past 520 the task scrolls.

## Alternatives
- **Placeholder text tokens in a textarea** ("[Image #1]" typed into the text, as Claude Code's terminal prompt does): simpler, but a picture can't show its thumbnail, a token can be half-deleted into nonsense, and a long paste can't be folded and opened again.
- **A transparent full-size window whose card grows inside it**: smooth everywhere, but the pop-up's material (vibrancy, acrylic) covers the whole window, so its empty part would show as frosted glass.
- **Keeping the clipboard attachment, off by default**: the owner asked for it gone; pasting with ⌘V does what it did, at the place the person chooses.

## Risk
- Pasted pictures stay in the data folder; nothing prunes them yet.
- `plaintext-only` is Chromium's and Safari's: in another browser the box is a plain contenteditable, whose lines the serializer reads from its blocks.
