# Protocol

The runner is one bun process on `127.0.0.1:4777` (`port` in the config file). It serves the web pages, a JSON API and one WebSocket. The types are in [`src/shared/protocol.ts`](../src/shared/protocol.ts): change that file and this one together.

## Pages
| Path | Page |
|---|---|
| `/` | Chat view: sessions in a sidebar, the selected one streaming. `/?session=<id>` opens one. |
| `/prompt` | Pop-up prompt: workspace picker, task box, the clipboard attachment. |
| `/assets/<file>` | Files from `src/web/`. |

Pages are plain HTML, CSS and JavaScript modules served from `src/web/` with no build step.

## API
JSON in, JSON out. Errors are `{ "error": "<text>" }` with a 4xx or 5xx status.

| Method and path | Body | Answer |
|---|---|---|
| `GET /health` | | `{ ok: true, version }` |
| `GET /api/workspaces` | | `WorkspacesResponse`: the config's workspaces and the last one used |
| `GET /api/sessions` | | `SessionsResponse`, newest first |
| `POST /api/sessions` | `StartSessionRequest` | 201 `SessionResponse`. The turn runs in the background. Remembers the workspace as last used. |
| `GET /api/sessions/:id/events?after=<seq>` | | `EventsResponse`: stored events with a higher seq (all without `after`) |
| `POST /api/sessions/:id/messages` | `ReplyRequest` | 202 `SessionResponse`. Resumes the Claude Code session. 409 while a turn runs. |
| `POST /api/sessions/:id/approvals/:approvalId` | `ApprovalRequest` | 200 `SessionResponse`. 404 for an unknown or already answered approval. |
| `GET /api/clipboard` | | The latest `ClipboardCapture`, or `{}` |
| `POST /api/clipboard` | `ClipboardPostRequest` | 200 the stored `ClipboardCapture`. Sent by the Windows shell on the hotkey. |
| `GET /api/notifications?after=<seq>` | | `NotificationsResponse`. Polled by the Windows shell for toasts. |

## WebSocket
`GET /ws`. The runner sends `ServerMessage`s; clients send nothing.
- On connect: `hello` with every session.
- `session` whenever a session's metadata changes (status, title, lastSeq).
- `event` for every stored event, for all sessions. A client that reconnects fetches what it missed with `GET /api/sessions/:id/events?after=<seq>`.
- `delta` for assistant text as it streams. Deltas aren't stored; the complete text follows as an `assistant_text` event, and the client replaces the streamed text with it.

## Sessions and events
- A session is one Claude Code conversation in one workspace. The runner keeps its own id and stores Claude Code's session id once known, to resume with it.
- Each turn's SDK messages are reduced to `SessionEvent`s: `user`, `assistant_text`, `tool_use`, `tool_result`, `approval_request`, `approval_resolved`, `result`, `error`.
- Status: `running` while a turn runs, `waiting_approval` while at least one approval is open, `idle` after a `result`, `error` after a failed turn.
- Stored under the data folder (`~/.local/share/intuition`, or `INTUITION_DATA_DIR`): `sessions.json` for metadata, `events/<id>.jsonl` for events, `state.json` for the last workspace used.

## Permissions
Sessions run with `permissionMode: "default"` and the workspace's own Claude Code settings (user, project and local), so its allow and deny rules apply. Any call that would prompt goes through the SDK's `canUseTool` and becomes an `approval_request`; the call waits until the person answers in the chat view. The runner never answers one itself. Denying sends the model a message that the person declined.

## Clipboard images
The shell saves a clipboard image as a PNG under the Windows user's temp folder and posts its Windows path. The runner turns `C:\Users\x\...` into `/mnt/c/Users/x/...`, and a session started with `imagePath` gets the path in its prompt, so Claude reads the file.

## Notifications
The runner records a `Notification` when a session finishes a turn (`finished`), opens an approval (`needs_approval`) or fails (`error`). The shell polls `GET /api/notifications?after=<seq>` every two seconds and shows each one as a Windows toast. Its first poll only reads `latest`, so old notifications don't replay.

## Guarding the port
The runner binds `127.0.0.1` only. A web page in any browser can still send requests to a local port, so every request is checked:
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
- A request with an `Origin` header must have the runner's own origin. The WebSocket upgrade is checked the same way.
- `POST` bodies must be `content-type: application/json`.

## Test hooks
- `INTUITION_CONFIG`: path of the config file. `INTUITION_DATA_DIR`: the data folder. `INTUITION_PORT`: the port (0 picks a free one).
- `INTUITION_FAKE_AGENT=1`: sessions run against a scripted fake instead of Claude Code, so tests and CI need no login. The fake is described where it is defined, in `src/runner/`.
