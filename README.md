# intuition

Fire tasks at Claude Code agents in WSL2 from anywhere in Windows. Press a hotkey, a small pop-up appears with your clipboard attached, pick a workspace, type a task, press Enter. A chat window lists every session and shows the selected one streaming, with Allow / Deny for tool calls that need approval. A dock at the top of the screen shows when a session finishes or needs you.

## Parts
- **Runner** (`src/runner/`): a bun daemon in WSL on `127.0.0.1:4777`. Starts and resumes Claude Code sessions through the Claude Agent SDK, streams events over a WebSocket, stores session metadata.
- **Web UI** (`src/web/`): the pop-up (`/prompt`) and the chat view (`/`), served by the runner.
- **Windows shell** (`shell/`): an Electron app in TypeScript: hotkey, tray icon, clipboard capture, the dock, start on login.

How they talk: [protocol](docs/protocol.md). Why it is built this way: [decisions](docs/decisions/README.md).

## Setup
1. `bun install`
2. `bun src/cli.ts up`

`up` starts the runner in the background, installs the Windows shell if it is not installed yet (the first time, a download of about 130 MB) and starts it: look for its icon in the tray, then press Ctrl+Alt+Space. Without Windows it starts only the runner; the chat view is at `http://127.0.0.1:4777/`.

## Windows
The shell (tray icon, hotkey, the dock) is installed and started from WSL, starts the runner itself when it is not running, and can start when you log in: `bun src/cli.ts shell login on`, or "Start on login" in the tray menu. Everything about it, its settings and its hand-test checklist: [the Windows shell](docs/windows-shell.md).

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

A workspace whose folder is missing is listed but can't be picked. Sessions and their events are stored in `~/.local/share/intuition`, and so are the background runner's `runner.pid`, `runner.url` and `runner.log`. `INTUITION_CONFIG`, `INTUITION_DATA_DIR` and `INTUITION_PORT` move the config file, that folder and the port, for the runner and for every command above.

## Commands
| Command | What it does |
|---|---|
| `bun src/cli.ts up` | Start the runner, install the Windows shell if needed, start it |
| `bun src/cli.ts start` | Start the runner in the background; prints its URL once it answers. Says so and exits 0 if it already runs |
| `bun src/cli.ts stop` | Stop the runner that `start` started |
| `bun src/cli.ts status` | Whether the runner runs (exit code 0 when it does, 1 when not) |
| `bun src/cli.ts logs` | The end of the runner's log |
| `bun src/cli.ts shell install` / `start` / `stop` | The Windows shell: install or update it, start it, quit it |
| `bun src/cli.ts shell login on` / `off` / `status` | Start the shell when you log in to Windows |
| `bun run start` | The runner in the foreground |
| `bun run dev` | The runner in the foreground, restarting on change |
| `bun run check` | Typecheck and tests: run before every commit |
