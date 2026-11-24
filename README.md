# Holm

Website: <https://kaitila.github.io/holm/>

Hand a task to a Claude Code agent from anywhere on your computer, without opening a terminal.

Press a hotkey and a small pop-up appears in the middle of the screen with whatever you just copied already attached: text, or a screenshot. Pick a workspace (a project folder), type what you want done, press Enter, and go back to what you were doing. The agent works in the background. A chat window lists every session and shows the selected one streaming as it works, and when a tool call needs your say it waits there for your Allow or Deny. A small dock at the top of the screen tells you when a session has finished or needs you.

There is also a snip key: the screen freezes, you drag a box around something, and type the task right beside it.

<!-- Screenshot to come: docs/images/ will hold one from the browser checks. -->
*What it looks like:* the pop-up is a plain, frameless box, about 560 by 380, with the clipboard shown as a chip above a text field and the workspace picker beside it. The chat view is a two-pane window: sessions on the left, the conversation on the right, with tool calls folded into one-line rows and approval cards in the stream.

Holm runs the agents with the [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) you already have, logged in as you, with your own settings and permissions. It is not a hosted service: nothing leaves your machine except what Claude Code itself sends.

## Install
In a terminal (on Windows, a WSL terminal):

```sh
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" && bun install -g github:kaitila/holm && holm setup
```

That is the whole of it. The line installs [bun](https://bun.sh/) (skip that part if you have it: `bun install -g github:kaitila/holm && holm setup`), then holm with everything it runs: Claude Code and Codex come with it, inside the agents' own SDKs, and the tray app's Electron is downloaded by setup. No git, Node or npm is needed. What is left is logging in to the agent you use: setup offers to run Claude Code's login (a page in your browser), or later `holm login` (`holm login codex` for [Codex](docs/agents.md)). Why it is done this way: [D0045](docs/decisions/D0045-install-with-bun-only.md).

| Platform | Where things run | Before the line |
|---|---|---|
| macOS | Everything on the Mac | Nothing |
| Linux | Everything on the machine | A desktop with a system tray, and `unzip` for bun's installer (`sudo apt install -y unzip`) |
| Windows 10 or 11 | The agents and the runner in WSL 2, the tray app on Windows | WSL 2: `wsl --install` in a terminal run as administrator, restart, open Ubuntu and make its user; then `sudo apt install -y unzip`, and the line in that Ubuntu terminal |

To work on holm itself, clone it instead: `git clone https://github.com/kaitila/holm && cd holm && bun install && bun run setup`.

`setup` walks you through it, then takes a fresh install to a running app:
1. **Requirements**: checks bun, Claude Code and its login (offering to log in), Codex, and git (optional), with the command that fixes anything missing;
2. **Workspaces**: tick the folders sessions may run in (space to toggle, enter to confirm), from the git repositories and `CLAUDE.md` folders in your home, newest first, or add one by its path; then pick the one the pop-up offers first;
3. **Hotkeys**: keep the platform's defaults (Ctrl+Alt+Space for a new task, Ctrl+Alt+S for the snip and Ctrl+Alt+J for the chat on Windows and Linux; Cmd+Shift+Space, Cmd+Shift+S and Cmd+Shift+J on a Mac) or type others;
4. **Permissions**: auto (recommended: routine tool calls run, the rest ask you) or ask for everything;
5. **Start at login**: yes by default;
6. then writes the config, puts the `holm` command on your PATH, installs the tray app (the first time, a download of Electron of about 110 MB, from its own release), starts the runner and the tray app, and opens the pop-up, so you can send a first task. A step that fails says the command that retries it.

Esc or Ctrl+C at any question stops it with nothing written. For scripts: `bun run setup --yes` takes every default, and `--workspace [name=]<folder>` (repeatable), `--hotkey`, `--snip-hotkey`, `--chat-hotkey` (optional), `--permission-mode auto|default` and `--no-login` give the answers; without a terminal, setup needs `--yes` or all of them. Running `setup` again changes the answers; running plain `holm` before there is any configuration starts it too. `holm help` lists every command, and `holm doctor --json` is the check for scripts.

Then press the hotkey anywhere. Every other key is in the dock's and the chat's keyboard shortcuts: press ? there (away from a text box), or pick Keyboard shortcuts in the dock's "…"; Settings lists them too.

## Start at login
`setup` turns it on unless you say no. Change it later with `holm shell login on` or `off` (`status` says which it is), or with "Start on login" in the tray icon's menu. At login the tray app starts, and it starts the runner itself the first time you press the hotkey or open the chat. On Windows, WSL boots first, so allow a few seconds after signing in.

## Update
```sh
holm update
```

It installs holm again from GitHub (or, in a clone, runs `git pull` and `bun install`), then `holm up`, which restarts the runner and the tray app when they are older than the code. A runner with a session still running is kept until the session ends (`holm restart --force` to stop it anyway).

## Uninstall
```sh
holm uninstall
```

It turns start at login off, quits and removes the tray app, stops the runner and takes the `holm` command off your PATH. Your configuration and your sessions stay, in case you come back; `holm uninstall --purge` removes them too. Then `bun remove --global holm` removes the app itself (or delete the folder you cloned). Your Claude Code sessions stay where Claude Code keeps them.

## Where settings live
| What | Where |
|---|---|
| Configuration: workspaces, port, permission mode, the agent (`"claude"` or `"codex"`, see [agents](docs/agents.md)), the theme, and the tray app's hotkeys, dock and start on login (the Settings window edits them) | `~/.config/holm/config.json` |
| Sessions, their events, the runner's log | `~/.local/share/holm/` |
| Windows: where the tray app finds the runner (`runnerUrl` and `wsl` only) | `%APPDATA%\holm-shell\settings.json` |
| Windows: the installed tray app | `%LOCALAPPDATA%\holm\` |

On Windows the first two are inside WSL. `HOLM_CONFIG`, `HOLM_DATA_DIR` and `HOLM_PORT` move the configuration file, the data folder and the port.

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

`permissionMode`, at the top or on one workspace, is `"auto"` (the default) or `"default"`. In `auto`, Claude Code's own classifier allows or denies each tool call, and only the calls it can't decide come to you as Allow / Deny cards. In `default`, every call that would ask you in a terminal waits for you in the chat view. No other mode is accepted: holm never skips permissions. See [D0012](docs/decisions/D0012-auto-mode.md).

## Sessions and the terminal
Sessions sync with Claude Code both ways ([D0015](docs/decisions/D0015-transcript-sync.md)), and Codex threads started in a workspace's folder (`codex`, `codex exec`) show up too, read from `~/.codex/sessions` ([D0031](docs/decisions/D0031-codex-transcript-sync.md)). A session you start with `claude` in a workspace's folder shows up in holm within a few seconds, and holm's sessions show up in `claude --resume` by their title. If a terminal wrote to a session in the last two minutes, a reply from holm asks before sending, so two programs don't write to one conversation at once.

## Commands
| Command | What it does |
|---|---|
| `holm setup [--yes]` | Check requirements, ask for workspaces and hotkeys, install and start everything |
| `holm up`, or `holm` alone | Start the runner and the tray app, installing or updating the tray app if needed |
| `holm login [claude\|codex]` | Log the agent in: Claude Code's own login, or Codex's |
| `holm update` | Get the newest version, then `up` |
| `holm start` / `stop` / `restart [--force]` | The runner alone |
| `holm status` | Whether the runner runs (exit code 0 when it does, 1 when not) |
| `holm logs` | The end of the runner's log |
| `holm shell install` / `start` / `stop` | The tray app: install or update it, start it, quit it |
| `holm shell login on` / `off` / `status` | Start the tray app at login |
| `holm uninstall [--purge]` | Remove everything `setup` set up |
| `holm help` | The list of commands |

Without the tray app, the chat view is a web page at `http://127.0.0.1:4777/`.

## How it is built
- **Runner** (`src/runner/`, bun and TypeScript): a small server on `127.0.0.1:4777` that starts and resumes Claude Code sessions through the Claude Agent SDK, or OpenAI Codex sessions through the Codex SDK ([agents](docs/agents.md)), streams their events over a WebSocket and stores session metadata. On Windows it runs in WSL.
- **Pages** (`src/web/`): the pop-up (`/prompt`), the chat view (`/`) and the dock, plain HTML, CSS and JavaScript served by the runner.
- **Tray app** (`shell/`, Electron and TypeScript): the tray icon, the global hotkeys, clipboard capture, the snip, the dock and start at login.

How the parts talk: [protocol](docs/protocol.md). The tray app in detail: [the Windows shell](docs/windows-shell.md). Why it is built this way: [decisions](docs/decisions/README.md). Security: [SECURITY.md](SECURITY.md).

## Contributing
`bun run check` runs the typecheck and the tests; CI runs the same. `bun run dev` runs the runner in the foreground and restarts it on change. The tests use a fake agent, so they need no Claude Code login. The project's working rules are in [AGENTS.md](AGENTS.md).

## License
[MIT](LICENSE)
