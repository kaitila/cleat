# D0005: How notifications become toasts

Date: 2026-11-13. Status: replaced in part by [D0008](D0008-dock.md). The shell no longer polls or shows toasts: the dock shows notifications as peeks. What the runner records, and each notification's body, still stand as written here.

## Decision
- The runner keeps notifications in memory only (`src/runner/notifications.ts`): the newest 200, with a seq that starts at 1 each time the runner starts. `Sessions` records them where a turn's state changes: `needs_approval` when an approval opens, `finished` for a result that is ok, `error` for a result that is not ok, an `error` event, a driver that throws or ends without a result.
- Not recorded: anything while the runner stops, and the `the runner restarted` error the store writes at the next start. The person restarted the runner; a toast for each cut-off session would tell them nothing.
- A `finished` body is the result's text, or the turn's last assistant text when the result carries none, as one line cut to 140 characters; `Finished.` when the turn said nothing. A `needs_approval` body is `<tool>: <summary>`, the summary being the command for Bash, the path for file tools, otherwise the input as JSON: the chat view's rule, written again in the runner because pages are plain JavaScript the runner does not import.
- The shell polls (`shell/src/poller.ts`, no Electron in it). Its first poll sends no `after`, shows nothing and only keeps `latest`; every later poll sends `after=<newest seen>`. A failed poll changes nothing.
- When `latest` is below what the shell last saw, the runner has restarted: the shell asks again from 0 and shows what the new runner has recorded, since all of it is newer than the shell's last poll.
- One poll shows at most its newest 5 notifications; older ones in the same answer are skipped, not queued.
- A toast's click handler lives on its `Notification` object, so the shell holds on to the newest 20. A toast clicked later, from the notification centre, or after the shell restarted, may do nothing.
- The self-test shows one real toast ("self-test, please ignore") and removes it, waits for Electron's `show` event, and runs the click handler itself with `emit("click")`.

## Why
- Polling, not the WebSocket: the shell needs only this, a poll survives runner restarts with no reconnect logic, and two seconds is soon enough for a toast.
- No `after` on the first poll rather than a stored "last seen": a seq means nothing across runner restarts, and a shell that starts should never replay a night's worth of toasts.
- The cap: after the machine sleeps, or a runner restart with many sessions, dozens of toasts at once are noise. The chat view has everything.
- A real toast in the self-test: `show` is the only evidence from WSL that Windows accepted it. It still doesn't say anyone saw it.

## Not done here
- A Start-menu shortcut carrying the app user model id, which Windows may want before it shows an app's toasts or lists it under Settings > Notifications.
- `Notification.handleActivation`, which would make clicks work for toasts whose object is gone.
- Per-kind settings (only approvals, sound off).
