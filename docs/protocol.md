# Protocol

The runner is one bun process on `127.0.0.1:4777` (`port` in the config file). It serves the web pages, a JSON API and one WebSocket. The types are in [`src/shared/protocol.ts`](../src/shared/protocol.ts): change that file and this one together.

## Pages
| Path | Page |
|---|---|
| `/` | Chat view: sessions in a sidebar, the selected one streaming. `/?session=<id>` opens one. |
| `/prompt` | Pop-up prompt: workspace picker, task box, the clipboard attachment. |
| `/dock` | The dock: a pill, a peek and an open view of the sessions. See "Dock". |
| `/assets/<file>` | Files from `src/web/`. |

Pages are plain HTML, CSS and JavaScript modules served from `src/web/` with no build step.

## API
JSON in, JSON out. Errors are `{ "error": "<text>" }` with a 4xx or 5xx status.

| Method and path | Body | Answer |
|---|---|---|
| `GET /health` | | `HealthResponse`: `{ ok: true, version, build }`. `build` is a hash of the code the runner process loaded ([D0011](decisions/D0011-stale-runner-and-shell.md)): `start` and `up` restart a runner whose `build` differs from the repo's. |
| `GET /api/workspaces` | | `WorkspacesResponse`: the config's workspaces and the last one used |
| `GET /api/sessions` | | `SessionsResponse`, newest first |
| `POST /api/sessions` | `StartSessionRequest` | 201 `SessionResponse`. The turn runs in the background. Remembers the workspace as last used. 400 for an `imagePath` that is refused (see "Clipboard images"). |
| `GET /api/sessions/:id/events?after=<seq>` | | `EventsResponse`: stored events with a higher seq (all without `after`). The first request for an imported session reads its history from the transcript first. |
| `POST /api/sessions/:id/messages` | `ReplyRequest` | 202 `SessionResponse`, the session `running`. Stores the reply as a `user` event and runs a turn in the background that resumes the Claude Code session. 404 for an unknown session, 400 for an empty prompt or an `imagePath` that is refused, 409 while a turn runs or an approval is open, and 409 `OPEN_IN_TERMINAL` ("it looks open in a terminal: ...") when another process wrote to the session's transcript in the last two minutes, unless the body has `force: true` (see "Terminal sessions"). 400 for a `force` that isn't a boolean. A session in `error` takes a reply too: it resumes its conversation, or starts a new one in the same workspace when it never got a Claude Code session id. |
| `POST /api/sessions/:id/approvals/:approvalId` | `ApprovalRequest` | 200 `SessionResponse`. 404 for an unknown or already answered approval. |
| `GET /api/clipboard` | | The latest `ClipboardCapture`, or `{}` before the first one |
| `POST /api/clipboard` | `ClipboardPostRequest` | 200 the stored `ClipboardCapture`, which replaces the one before (an empty body stores an empty capture). Sent by the Windows shell on the hotkey. `text` is cut to 20,000 characters. 400 for an `imagePath` that is refused, and the capture before it stays. |
| `GET /api/clipboard/image` | | The latest capture's PNG (`image/png`), for the pop-up's thumbnail. 404 when the latest capture has no image or its file is gone. The request names no file. |
| `GET /api/notifications?after=<seq>` | | `NotificationsResponse`: the kept notifications with a higher seq, and the newest seq given out. For a client that polls; the dock gets them on the WebSocket. |

## WebSocket
`GET /ws`. The runner sends `ServerMessage`s; clients send nothing.
- On connect: `hello` with every session.
- `session` whenever a session's metadata changes (status, title, lastSeq).
- `event` for every stored event, for all sessions. A client that reconnects fetches what it missed with `GET /api/sessions/:id/events?after=<seq>`.
- `delta` for assistant text as it streams. Deltas aren't stored; the complete text follows as an `assistant_text` event, and the client replaces the streamed text with it.
- `notification` for each `Notification`, at the moment it is recorded. None is sent again on connect: a client shows only what arrives while it is connected. It follows the `session` message that carries the status it is about (`waiting_approval`, `idle` or `error`).

## Sessions and events
- A session is one Claude Code conversation in one workspace. The runner keeps its own id and stores Claude Code's session id once known, to resume with it.
- Each turn's SDK messages are reduced to `SessionEvent`s: `user`, `assistant_text`, `tool_use`, `tool_result`, `approval_request`, `approval_resolved`, `auto_denied`, `permission_mode`, `result`, `error`.
- `SessionMeta.permissionMode` is the permission mode the session runs in, as Claude Code reports it (the `init` system message at the start of each turn, and `status` messages when it changes). It is absent until the first turn reports it, and may be a mode other than the two the config allows (for example `"default"` where auto mode is unavailable).
- Status: `running` while a turn runs, `waiting_approval` while at least one approval is open, `idle` after a `result`, `error` after a failed turn.
- `SessionMeta.source`: `"intuition"` for a session the runner started, `"terminal"` for one it imported (below). The runner always sends it; a session stored before it existed reads as `"intuition"`.
- `SessionMeta.terminalTurn`: `true` while the session is `running` only because its transcript grows (a turn arriving from a terminal), absent otherwise. The pages show "in terminal" for it. See "Terminal sessions".
- Stored under the data folder (`~/.local/share/intuition`, or `INTUITION_DATA_DIR`): `sessions.json` for metadata, `events/<id>.jsonl` for events, `state.json` for the last workspace used, `sync.json` for the transcript sync.

## Terminal sessions
Claude Code keeps every session as a transcript under `~/.claude/projects`, the runner's and the terminal's alike. The runner reads them through the SDK (`listSessions`, `getSessionInfo`, `getSessionMessages`) and never writes to them except through its own turns (`query`). The reasons are in [D0015](decisions/D0015-transcript-sync.md).
- **Import.** Every 3 seconds the runner lists each workspace's transcripts (its folder only, not its git worktrees). One written in the last 30 days, among the workspace's newest 50, that no runner session owns becomes a session with `source: "terminal"`, status `idle`, `lastSeq` 0, `createdAt` and `updatedAt` from the transcript, and the title from its custom title, else its summary, else its first prompt (cut as any title). Its events are read the first time they are asked for: `GET .../events`, or a reply.
- **Events from a transcript.** Each user and assistant message of the main conversation becomes the events a turn gives: `user` (its text), `tool_result`, `assistant_text`, `tool_use`, and a `result` (`ok: true`, the last text) after an assistant message that ended its turn. An event keeps the message's time as `ts`. Subagents' messages and text Claude Code keeps for itself are left out. There are no deltas.
- **Live.** When any session's transcript grows while the runner isn't running that session's turn (it was continued in a terminal, say), the new entries are stored as events and sent on the WebSocket, and the session is `running` with `terminalTurn: true`, until 5 seconds after its last entry when that entry is the assistant's (10 minutes after it otherwise); then `idle`. `SessionMeta.terminalTurn` is absent in every other case: any other change of status (a runner turn starting, the end of the live turn, a restart) drops it.
- **One id each.** A transcript the runner owns (any Claude Code session id its sessions have had) is never imported, and an imported one keeps its runner id across restarts (`sync.json`).
- **Replies.** A reply to any session resumes it through the SDK, as for the runner's own. It first stores what the transcript gained since the last round. When another process wrote to the transcript in the last two minutes (later than 5 seconds after the runner's own last turn of it), the reply is a 409 `OPEN_IN_TERMINAL` unless the body has `force: true`. A session shown `running` only because its transcript grows takes a reply on the same terms; one whose runner turn runs is busy, force or not.
- **In the terminal.** The runner's sessions record the entrypoint `intuition`, so Claude Code's resume picker (`claude --resume`, `/resume`) lists them, by the session's title, and `claude --resume <claudeSessionId>` continues them.

## Permissions
Each turn asks for the permission mode of its workspace: the workspace's own `permissionMode` in the config file, else the top-level one, else `"auto"` ([D0012](decisions/D0012-auto-mode.md)). Only `"auto"` and `"default"` are accepted; any other value is refused when the config is read. Sessions also load the workspace's own Claude Code settings (user, project and local), so its allow and deny rules apply.
- `auto`: the SDK's classifier allows or denies each call itself, and asks through `canUseTool` only when it can't decide.
- `default`: every call that would prompt asks through `canUseTool`.

A call that reaches `canUseTool`, in either mode, becomes an `approval_request` and waits until the person answers in the chat view. The runner never answers one itself. Denying sends the model a message that the person declined.

A call denied without asking (the classifier, a deny rule, the mode: the SDK's `system`/`permission_denied` message) is stored as `auto_denied` with `toolUseId`, `toolName`, `input` (a one-line summary of the call's input, at most 200 characters, when the call's `tool_use` was seen) and `reason` (the deciding component's reason, else the message the model got). Nobody is asked about it.

A session that asked for `auto` and runs in another mode gets one `permission_mode` event (`requested`, `mode`), the first time it is reported, so the person knows why calls come to them. Every change of the mode in effect is logged by the runner.

The pages show `auto_denied` and `permission_mode` as quiet notes, as any kind they don't know.

## Clipboard images
The shell saves a clipboard image as a PNG under the Windows user's temp folder (`%TEMP%\\intuition\\clip-<time>.png`, the newest 20 kept) and posts its Windows path. The runner turns `C:\Users\x\...` into `/mnt/c/Users/x/...` (drive letter lowercased, backslashes to slashes, normalised) and stores that.

An `imagePath`, on `POST /api/clipboard` and on a session or a reply, is accepted only when, once converted, it is an existing PNG file named `.png` under `/mnt/<drive>/`; a WSL path that passes the same test is taken as it is. A link is followed and its target must pass too. Anything else (`/etc/passwd`, a path that climbs out with `..`, a missing file, a file that doesn't start as a PNG) is a 400.

The capture is kept in memory only, the latest one. The pop-up asks for it on load and a few more times over its first two seconds, since the shell captures while the window opens, and attaches one whose `capturedAt` is within the last 30 seconds: a thumbnail for an image, the first lines for text, with a remove control (also Alt+Backspace). An attached image is sent as the session's `imagePath`; attached text goes into the prompt after the task, under a line `Clipboard:`.

A session started, or replied to, with `imagePath` gets the path in the prompt Claude sees, after the task: a blank line, then `Attached image (read this file): <path>`, so Claude reads the file. The stored `user` event keeps `text` and `imagePath` apart. Reading a file outside the workspace is a tool call like any other: it may need the person's approval.

## Notifications
The runner records a `Notification` when a session finishes a turn (`finished`), opens an approval (`needs_approval`) or fails (`error`). Its `title` is the session's; its `body` is one line of at most 140 characters: the start of the answer, the tool and its target (`Write: /path`), or the error's message. Each one is pushed to the WebSocket clients as a `notification` message, which the dock shows as a peek, and the newest 200 are kept in memory for `GET /api/notifications?after=<seq>`. The seq starts at 1 each time the runner starts.

## Dock
The contract between the dock's page and the Windows shell. The shell's half is in [windows-shell](windows-shell.md) ("The dock"), the reasons in [D0008](decisions/D0008-dock.md) and, for the window and the mouse, [D0010](decisions/D0010-dock-fixed-window.md).
- The dock is the page `/dock`, served by the runner, shown by the shell in a frameless, transparent, always-on-top window that touches the top edge of the primary display, centred.
- The window is 460x480 CSS pixels for its whole life (`DOCK_WINDOW`). It is never resized or moved for a change of state. The page fills it, its own background transparent, and draws the island inside it, hanging from the top centre.
- It has three states, and in each the island stays inside a rectangle at the top centre of the window (`DOCK_SIZES`, `islandRect`): idle 128x22, peek 380x40, open 460x480. The page may draw less (idle as narrow as its words, open as short as its content), never more. The numbers are in `shell/src/dock.ts` and `src/web/dock-state.js`, and a test fails when they differ.
- The window lets the mouse through everywhere but on that rectangle. The shell decides, from the cursor's position and the state the page last reported; the page is not asked. Until the page has reported a state, and again after a reload, a failed load or a crash, the window lets the mouse through everywhere. While it does, mouse moves still reach the page, so it sees the pointer leave.
- The page decides the state and tells the shell through `window.intuitionDock.setState("idle" | "peek" | "open")`, the only thing the bridge exposes, at once when the state changes, growing or shrinking. The shell changes nothing about the window but where it takes the mouse and whether it can take the keyboard. Every change of shape is the page's own, in CSS, and none waits for the shell. In a normal browser the bridge is absent and the page works the same without it.
- Only in "open" can the window take keyboard focus. In idle and peek it never takes focus from what the person is doing.
- A link the page opens in a new window to `/?session=<id>` opens the chat window on that session, and one to `/prompt` opens the pop-up.

What the page does in each state (`src/web/dock.js`; the rules are pure functions in `src/web/dock-state.js`):
- **Idle**, the pill: one line from the sessions on the WebSocket, as wide as its words. `needs you` when any session waits for approval; else `2 running`; else `failed` when the newest session that finished its turn failed; else nothing but a dot, 16 pixels tall and faint (its name for a screen reader is `intuition`). Beside `needs you` or `2 running` a red dot marks that the newest finished one failed.
- **Peek**: a `notification` grows the island to one line, the session's title, the start of the notification's body and `done`, `needs you` or `failed`, for five seconds. One for an approval stays until its session no longer waits or the dock is opened. Others wait their turn behind it, newest last, at most five; a session's newer one replaces its older one that still waits. While the dock is open nothing peeks.
- **Open**: when the pointer has rested on the island for 80 ms, anywhere in the state's rectangle. It closes 400 ms after the pointer left, or at once on Esc or on a press beside it, but not while the pointer is held down, or while the reply box has the focus or text in it (a press beside it closes it all the same, and the draft is kept). It lists the sessions, newest activity first, and shows the last 30 events of one: the session peeking when it opened, else the newest that waits for approval, else the one that peeked last, else the newest. Allow and Deny answer through `POST /api/sessions/:id/approvals/:approvalId`, and the reply box continues the session through `POST /api/sessions/:id/messages`, as in the chat view.
- **The motion**: the island is one shape whose clip grows out of the pill in 320 ms and shrinks back in 220 ms; the new state's content fades in when the shape is most of the way there. With `prefers-reduced-motion` the shape changes at once and the content fades in.

## Guarding the port
The runner binds `127.0.0.1` only. A web page in any browser can still send requests to a local port, so every request is checked:
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
- A request with an `Origin` header must have the runner's own origin. The WebSocket upgrade is checked the same way.
- `POST` bodies must be `content-type: application/json`.

## Test hooks
- `INTUITION_CONFIG`: path of the config file. `INTUITION_DATA_DIR`: the data folder. `INTUITION_PORT`: the port (0 picks a free one).
- `INTUITION_FAKE_AGENT=1`: sessions run against a scripted fake instead of Claude Code, so tests and CI need no login. The fake is described where it is defined, in `src/runner/`.
  With the fake agent the runner reads no transcripts; tests give the sync their own (`startServer`'s `sync` argument).
