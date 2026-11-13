# intuition

Fire tasks at Claude Code agents in WSL2 from anywhere in Windows. Press a hotkey, a small pop-up appears with your clipboard attached, pick a workspace, type a task, press Enter. A chat window lists every session and shows the selected one streaming, with Allow / Deny for tool calls that need approval. A dock at the top of the screen shows when a session finishes or needs you.

## Parts
- **Runner** (`src/runner/`): a bun daemon in WSL on `127.0.0.1:4777`. Starts and resumes Claude Code sessions through the Claude Agent SDK, streams events over a WebSocket, stores session metadata.
- **Web UI** (`src/web/`): the pop-up (`/prompt`) and the chat view (`/`), served by the runner.
- **Windows shell** (`shell/`): an Electron app in TypeScript: hotkey, tray icon, clipboard capture, the dock, start on login.

How they talk: [protocol](docs/protocol.md). Why it is built this way: [decisions](docs/decisions/README.md).

## Setup
1. `bun install`
2. `bun src/cli.ts link`, once: it puts the `intuition` command on the PATH
3. `intuition up`, from any folder (`intuition` alone does the same)

`link` makes a symlink named `intuition` to `src/cli.ts` in the folder bun itself is in (`~/.bun/bin`), or in the folder you give it (`bun src/cli.ts link ~/.local/bin`), and says whether that folder is on the PATH. It replaces its own link and nothing else: a file, or a link to another program, stays, and `link` says what it is. The command finds the repo from where the link points, so the repo can be anywhere, but a moved repo needs the old link removed and `link` run again. `bun src/cli.ts <command>` from the repo keeps working, with or without the link.

`up` starts the runner in the background, installs the Windows shell if it is not installed yet (the first time, a download of about 130 MB) and starts it: look for its icon in the tray, then press Ctrl+Alt+Space. Without Windows it starts only the runner; the chat view is at `http://127.0.0.1:4777/`.

## Windows
The shell (tray icon, hotkey, the dock) is installed and started from WSL, starts the runner itself when it is not running, and can start when you log in: `intuition shell login on`, or "Start on login" in the tray menu. Everything about it, its settings and its hand-test checklist: [the Windows shell](docs/windows-shell.md).

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
| `bun src/cli.ts link [dir]` | Put `intuition` on the PATH: a symlink in `dir`, or else in the folder bun is in. `intuition unlink [dir]` removes it |
| `intuition up`, or `intuition` alone | Start the runner, install the Windows shell if needed, start it |
| `intuition start` | Start the runner in the background; prints its URL once it answers. Says so and exits 0 if it already runs |
| `intuition stop` | Stop the runner that `start` started |
| `intuition status` | Whether the runner runs (exit code 0 when it does, 1 when not) |
| `intuition logs` | The end of the runner's log |
| `intuition shell install` / `start` / `stop` | The Windows shell: install or update it, start it, quit it |
| `intuition shell login on` / `off` / `status` | Start the shell when you log in to Windows |
| `intuition help` | The list of commands. An unknown command prints it too, and exits 2 |
| `bun run start` | The runner in the foreground |
| `bun run dev` | The runner in the foreground, restarting on change |
| `bun run check` | Typecheck and tests: run before every commit |
