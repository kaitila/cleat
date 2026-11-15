# D0008: A dock instead of toasts

Date: 2026-11-13. Status: active, except the window: its sizes, "the window resizes" and the order of `setState` and the animation are replaced by [D0010](D0010-dock-fixed-window.md), and opening takes 80 ms, not 120. Replaces the shell's half of [D0005](D0005-toasts.md).

## Decision
- What the sessions are doing is shown by a dock: the runner's page `/dock`, in a small window of the shell at the top centre of the primary display. The shell shows no toasts for sessions and no longer polls. The contract between page and shell is in [protocol](../protocol.md) under "Dock"; the window is described in [windows-shell](../windows-shell.md).
- **Three states, three exact window sizes**: idle 280x40 (a pill that says what is going on), peek 420x76 (a session finished, failed or needs approval), open 460x600 (the sessions, one session's stream, Allow and Deny, a reply box). The numbers are in `shell/src/dock.ts` and in `src/web/dock-state.js`, and a test fails when they differ.
- **The page decides the state** and tells the shell through `window.intuitionDock.setState(state)`, the only thing the bridge has. Growing, it calls `setState` first and animates inside the larger window; shrinking, it animates first and calls `setState` when the island is small.
- **The window resizes. It is not a click-through overlay.** The island fills its window in every state.
- **Notifications are pushed.** The runner sends each one to the WebSocket clients as `{ type: "notification", notification }` when it is recorded. Nothing is replayed on connect. `GET /api/notifications` stays.
- **A peek** lasts five seconds; one for an approval stays until its session no longer waits or the dock is opened. At most five wait their turn, and a session's newer one replaces its older one that still waits. Nothing peeks while the dock is open.
- **Opening** takes the pointer resting on the island for 120 ms; closing, 400 ms after it left, or Esc. The open dock does not close while the pointer is held down or while the reply box has the focus or text in it.
- **The dock is dark in both colour schemes.** `base.css` has a `.dark` scope that repeats the dark scheme's values; the dock's page is `<body class="dark">` (it was `<html class="dark">` until T-0042 loaded theme.js there: a forced theme on `<html>` outranks `.dark` on the same element). The island has no shadow.
- The rules (what the pill says, the peek queue, when the dock may close, which session it opens on) are pure functions in `src/web/dock-state.js`, unit tested; `src/web/dock.js` draws.

## Why
- **A dock, not toasts.** The owner asked for it: "a dock in the top of the screen, which expands when hovered over... like the apple style dynamic island almost. Then you could continue the session in the dock." A toast can't be replied to, Windows decides whether it shows at all (Do Not Disturb, notification settings, an app id without a Start-menu shortcut), and in all the time the shell had toasts nobody saw one. The dock is the shell's own window: what it shows is up to the page.
- **The page decides, through a one-word bridge.** Hover, a finished session and an open approval are things the page knows; the shell only knows the window. The bridge is one-way and carries one of three words, so a page that went wrong can at worst pick another of the three sizes. The dock keeps the sandbox, context isolation and no Node, like the other windows.
- **Resizing, not an overlay.** The other way is one large clear window that lets clicks through wherever the island isn't (`setIgnoreMouseEvents`, switched as the mouse moves). A bug there, a missed mouse-leave or a page that crashed at the wrong moment, leaves a dead zone: a part of the screen that looks empty and swallows every click. A window exactly as big as what it draws cannot do that: the worst it can do is stay open, visibly. The price is the order of things when animating, which `resizeOrder` in `dock-state.js` settles in one place, and that the island cannot have a shadow or a margin: either would be clear pixels that take clicks.
- **Pushed, not polled.** The page already holds the WebSocket for the pill and the stream, and a peek two seconds late feels broken beside a pill that changed at once. Each notification is sent after the `session` message with the status it is about, so the page never peeks "needs you" for a session it still believes is running. No replay on connect, for the reason the shell's first poll showed nothing: a dock that starts should not play back a night's worth.
- **An approval's peek stays.** It is the one notification that blocks work until the person acts. Five seconds is enough for "done"; it is not enough for "waiting for you" when the person looked away.
- **A newer peek replaces the same session's older one.** After "needs approval" and then "finished" for one session, only the end is worth showing.
- **120 ms before opening.** The dock sits where browser tabs and title bars are. A pointer that crosses it on the way to a tab would otherwise throw a 460x600 panel over what the person was reaching for.
- **Text or focus holds it open.** Half a reply must not vanish because the mouse drifted. Esc still closes it: the person asked. The draft is kept for that session.
- **Dark in both schemes.** A light island on a light desktop is a white box at the top of the screen; a dark one reads as one object, as the notch it borrows from does. The scope repeats the values instead of the tokens being rewritten with `light-dark()`, because the design test reads each token as a plain colour to compute contrast.
- **The open dock draws only the last 30 events and no tool bodies.** It is for a glance and a reply. "Open in chat" has everything.

## Not done here
- Nobody has yet seen the dock in the shell's real window on Windows. The browser script (`test/web/dock-ui.ts`) drives the page with a stand-in for the bridge that resizes the viewport; the shell's self-test checks the window against its own stub page. The steps for a person are in [windows-shell](../windows-shell.md), "Hand-test checklist", steps 10 to 18.
- The peeks are silent, and there are no per-kind settings (only approvals, for example).
- Starting a task in the dock. "New task" opens the pop-up.
- An attached image on a reply from the dock.
