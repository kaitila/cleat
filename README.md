# intuition

Hand a task to a Claude Code agent from anywhere on your computer, without opening a terminal.

Press a hotkey and a small pop-up appears in the middle of the screen with whatever you just copied already attached: text, or a screenshot. Pick a workspace (a project folder), type what you want done, press Enter, and go back to what you were doing. The agent works in the background. A chat window lists every session and shows the selected one streaming as it works, and when a tool call needs your say it waits there for your Allow or Deny. A small dock at the top of the screen tells you when a session has finished or needs you.

There is also a snip key: the screen freezes, you drag a box around something, and type the task right beside it.

<!-- Screenshot to come: docs/images/ will hold one from the browser checks. -->
*What it looks like:* the pop-up is a plain, frameless box, about 560 by 380, with the clipboard shown as a chip above a text field and the workspace picker beside it. The chat view is a two-pane window: sessions on the left, the conversation on the right, with tool calls folded into one-line rows and approval cards in the stream.

intuition runs the agents with the [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) you already have, logged in as you, with your own settings and permissions. It is not a hosted service: nothing leaves your machine except what Claude Code itself sends.

## Requirements
On every platform:
- [git](https://git-scm.com/)
- [bun](https://bun.sh/) 1.3 or newer
- [Node.js](https://nodejs.org/) with npm: used once, to download Electron for the tray app
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), installed and logged in (run `claude` once and follow its login)

Per platform:

| Platform | Where things run | Also needed |
|---|---|---|
| Windows 10 or 11 | The agents and the runner in WSL2, the tray app on Windows | WSL2 with a Linux distribution (Ubuntu is fine). Install everything above inside WSL, and run the install below in a WSL terminal |
| macOS | Everything on the Mac | Nothing more |
| Linux | Everything on the machine | A desktop with a system tray |

The setup command checks each of these and prints a one-line fix for anything missing.

## Install
In a terminal (on Windows, a WSL terminal), clone this repository (its GitHub page gives the URL under **Code**), then in the clone run:

```sh
bun install && bun src/cli.ts setup
```

`setup` asks a few questions and takes a fresh clone to a running app:
1. checks the requirements above;
2. asks which folders are your workspaces, suggesting the folders in your home that hold a git repository or a `CLAUDE.md`;
3. asks for the hotkeys, offering the platform's defaults (Ctrl+Alt+Space for a new task and Ctrl+Alt+S for the snip on Windows and Linux);
4. installs the tray app (the first time, a download of about 130 MB) and starts it;
5. asks whether to start at login (yes by default);
6. puts the `intuition` command on your PATH;
7. opens the pop-up, so you can send a first task.

`bun src/cli.ts setup --yes` takes every default without asking, for scripts. Running `setup` again changes the answers; running plain `intuition` before there is any configuration starts it too.

Then press the hotkey anywhere.

## Start at login
`setup` turns it on unless you say no. Change it later with `intuition shell login on` or `off` (`status` says which it is), or with "Start on login" in the tray icon's menu. At login the tray app starts, and it starts the runner itself the first time you press the hotkey or open the chat. On Windows, WSL boots first, so allow a few seconds after signing in.

## Update
```sh
cd intuition && git pull && bun install && intuition up
```

`intuition up` restarts the runner and the tray app when they are older than the code. A runner with a session still running is kept until the session ends (`intuition restart --force` to stop it anyway).

## Uninstall
```sh
intuition uninstall
```

It turns start at login off, quits and removes the tray app, stops the runner and takes the `intuition` command off your PATH. Your configuration and your sessions stay, in case you come back; `intuition uninstall --purge` removes them too. Then delete the cloned folder. Your Claude Code sessions stay where Claude Code keeps them.

## Where settings live
| What | Where |
|---|---|
| Configuration: workspaces, port, permission mode, the theme, and the tray app's hotkeys, dock and start on login (the Settings window edits them) | `~/.config/intuition/config.json` |
| Sessions, their events, the runner's log | `~/.local/share/intuition/` |
| Windows: where the tray app finds the runner (`runnerUrl` and `wsl` only) | `%APPDATA%\intuition-shell\settings.json` |
| Windows: the installed tray app | `%LOCALAPPDATA%\intuition\` |

On Windows the first two are inside WSL. `INTUITION_CONFIG`, `INTUITION_DATA_DIR` and `INTUITION_PORT` move the configuration file, the data folder and the port.

A configuration looks like this:

```json
{
  "port": 4777,
  "workspaces": [
    { "name": "website", "path": "~/code/website" },
    { "name": "notes", "path": "~/notes", "permissionMode": "default" }
  ]
}
```

`permissionMode`, at the top or on one workspace, is `"auto"` (the default) or `"default"`. In `auto`, Claude Code's own classifier allows or denies each tool call, and only the calls it can't decide come to you as Allow / Deny cards. In `default`, every call that would ask you in a terminal waits for you in the chat view. No other mode is accepted: intuition never skips permissions. See [D0012](docs/decisions/D0012-auto-mode.md).

## Sessions and the terminal
Sessions sync with Claude Code both ways ([D0015](docs/decisions/D0015-transcript-sync.md)). A session you start with `claude` in a workspace's folder shows up in intuition within a few seconds, and intuition's sessions show up in `claude --resume` by their title. If a terminal wrote to a session in the last two minutes, a reply from intuition asks before sending, so two programs don't write to one conversation at once.

## Commands
| Command | What it does |
|---|---|
| `intuition setup [--yes]` | Check requirements, ask for workspaces and hotkeys, install and start everything |
| `intuition up`, or `intuition` alone | Start the runner and the tray app, installing or updating the tray app if needed |
| `intuition start` / `stop` / `restart [--force]` | The runner alone |
| `intuition status` | Whether the runner runs (exit code 0 when it does, 1 when not) |
| `intuition logs` | The end of the runner's log |
| `intuition shell install` / `start` / `stop` | The tray app: install or update it, start it, quit it |
| `intuition shell login on` / `off` / `status` | Start the tray app at login |
| `intuition uninstall [--purge]` | Remove everything `setup` set up |
| `intuition help` | The list of commands |

Without the tray app, the chat view is a web page at `http://127.0.0.1:4777/`.

## How it is built
- **Runner** (`src/runner/`, bun and TypeScript): a small server on `127.0.0.1:4777` that starts and resumes Claude Code sessions through the Claude Agent SDK, streams their events over a WebSocket and stores session metadata. On Windows it runs in WSL.
- **Pages** (`src/web/`): the pop-up (`/prompt`), the chat view (`/`) and the dock, plain HTML, CSS and JavaScript served by the runner.
- **Tray app** (`shell/`, Electron and TypeScript): the tray icon, the global hotkeys, clipboard capture, the snip, the dock and start at login.

How the parts talk: [protocol](docs/protocol.md). The tray app in detail: [the Windows shell](docs/windows-shell.md). Why it is built this way: [decisions](docs/decisions/README.md). Security: [SECURITY.md](SECURITY.md).

## Contributing
`bun run check` runs the typecheck and the tests; CI runs the same. `bun run dev` runs the runner in the foreground and restarts it on change. The tests use a fake agent, so they need no Claude Code login. The project's working rules are in [AGENTS.md](AGENTS.md).

## License
[MIT](LICENSE)
