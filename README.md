# intuition

Fire tasks at Claude Code agents in WSL2 from anywhere in Windows. Press a hotkey, a small pop-up appears with your clipboard attached, pick a workspace, type a task, press Enter. A chat window lists every session and shows the selected one streaming, with Allow / Deny for tool calls that need approval. Windows toasts tell you when a session finishes or needs you.

## Parts
- **Runner** (`src/runner/`): a bun daemon in WSL on `127.0.0.1:4777`. Starts and resumes Claude Code sessions through the Claude Agent SDK, streams events over a WebSocket, stores session metadata.
- **Web UI** (`src/web/`): the pop-up (`/prompt`) and the chat view (`/`), served by the runner.
- **Windows shell** (`shell/`): an Electron app in TypeScript: hotkey, tray icon, clipboard capture, toasts, start on login.

How they talk: [protocol](docs/protocol.md). Why it is built this way: [decisions](docs/decisions/README.md).

## Setup
1. `bun install`
2. `bun run start`, then open `http://127.0.0.1:4777/`.

## Configuration
A file, `~/.config/intuition/config.json`, written with these defaults on first start:

```json
{
  "port": 4777,
  "workspaces": [
    { "name": "agents", "path": "/root/agents" },
    { "name": "theta", "path": "~/.projects/theta" }
  ]
}
```

A workspace whose folder is missing is listed but can't be picked. Sessions and their events are stored in `~/.local/share/intuition`.

## Commands
| Command | What it does |
|---|---|
| `bun run start` | The runner |
| `bun run dev` | The runner, restarting on change |
| `bun run check` | Typecheck and tests: run before every commit |
