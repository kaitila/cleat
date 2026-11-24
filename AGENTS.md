# Cleat

A background app that fires tasks at Claude Code agents: a global hotkey opens a small pop-up with the clipboard attached, you pick a workspace and type a task, and a chat window shows every session streaming. Setup and layout: [README](README.md). The contract between the parts: [protocol](docs/protocol.md). Decisions: [decisions](docs/decisions/README.md). It runs in one of three layouts ([platforms](docs/platforms.md), `src/shell/platform.ts`): `windows-wsl` (the runner in WSL 2, the shell on Windows; the owner's machine), `macos` and `linux` (the runner and the shell on one machine).

Three parts:
- **Runner** (`src/runner/`, bun + TypeScript; in WSL for windows-wsl, on the machine itself otherwise): a daemon on `127.0.0.1:4777` that starts and resumes Claude Code sessions through the Claude Agent SDK (and OpenAI Codex sessions through the Codex SDK: [agents](docs/agents.md)), streams their events over a WebSocket and stores session metadata.
- **Web UI** (`src/web/`, served by the runner): the pop-up prompt (`/prompt`) and the chat view (`/`). Plain HTML, CSS and JavaScript modules, no build step.
- **Shell** (`shell/`, Electron + TypeScript; on Windows, macOS or Linux): tray icon (the menu bar on a Mac), global hotkey, clipboard capture, the dock, start on login, and small windows on the runner's pages. Its code is `shell/src/`, bundled by bun, with what differs per OS in `shell/src/os.ts`; Electron itself is installed into the layout's shell folder by `cleat shell install`.

## Commands
- `bun run check`: typecheck and tests. Run it before every commit; CI runs the same.
- `bun test test/base.test.ts`: one test file.
- `bun run typecheck`.
- `bun run dev`: the runner with reload on change. `bun run start`: without.
- `bun src/cli.ts <command>`: the app's own commands (start, stop, status, and the shell's install and start), once their tasks have built them. They print through `src/cli/ui.ts` (marks, spinners, colour): plain lines into a pipe.
- `env -u CI bun scripts/cli-setup-pty.ts`: setup for real in a pseudo-terminal, typed by the script, rendered at 80 and 120 columns.
- `bun src/shell/selftest-run.ts`: the shell's self-test on this machine's layout; `CLEAT_PLATFORM=linux` runs the linux layout under WSLg. Skipped when `CI` is set (CI's desktop jobs run it with `env -u CI`).
- Windows programs run from WSL directly: `/mnt/c/.../electron.exe <args>` (start from a `/mnt/c` folder and pass Windows paths; `wslpath -w` converts).

## Tasks
Work here is tracked in foreman: the MCP server `foreman` in `.mcp.json`, or its CLI, `fm help` (install it with `bun add -g @foreman-kit/foreman`). Its board is in `.foreman/`, which git ignores.
- Before starting: `next_tasks`, then `claim_task`. A request that has no task yet: search `list_tasks`, then `create_task` with acceptance checks and the paths it may touch.
- Code tasks follow the `ship` skill. Report with `report_progress`, hand in with `submit_task` and the PR.
- The work needs files outside your task's paths: `edit_task` with `addPaths`. A gap found after you submitted: `rework_task` with the reason, then claim it again. Once a person has approved it, don't rework it (foreman refuses): file the new work as its own task with `discoveredFrom`, or ask the person.
- Found other work on the way: search `list_tasks`, then `create_task` with `discoveredFrom`.
- Numbers that must be unique (decision files, migrations): take them from `reserve_number`.
- Never verify your own task, and never approve: a fresh session runs the `verify` skill, and a person signs off changes to the paths listed in `foreman.json`.

## Rules
- **TypeScript only.** Runner, scripts, command line and the shell are TypeScript run by bun or Electron; pages are plain JavaScript modules. No AutoHotkey, PowerShell, batch, bash or Rust files, and no Tauri. The one exception is `site/install.sh`, the POSIX `sh` behind the install line (D0047): it only gets bun and runs `cleat setup`, and stays that small. A step that seems to need one is done from TypeScript (spawn the OS's program with an argument array, or use Electron's API).
- The app is installed with bun alone (`bun install -g github:kaitila/cleat`, D0045): it runs from bun's global folder as well as from a clone, so nothing may assume a `.git`, Node, npm or a separately installed `claude`; the agents are the SDKs' own binaries (`claudeBinary`, `codexBinary`).
- Electron's API changes between versions (the clipboard API in 45 is not the old one). Before writing against it, read `node_modules/electron/electron.d.ts`; don't rely on memory.
- Electron is installed only by `cleat shell install`, for the layout's OS, into the layout's shell folder (`src/shell/platform.ts`): the zip from Electron's GitHub release, checked against its `SHASUMS256.txt` and unpacked by `src/shell/unzip.ts` (`src/shell/electron-fetch.ts`, D0045); no npm or Node. windows-wsl fetches the Windows build from WSL into the Windows user's `AppData\Local\cleat`; macOS into `~/Library/Application Support/cleat`; Linux into `~/.local/share/cleat`. Never into the repo, and for windows-wsl never into a WSL path.
- `src/shared/protocol.ts` and [protocol](docs/protocol.md) are the contract between runner, pages and shell. Follow them; a task that needs to change the contract changes both files and says so in its PR.
- The Claude Agent SDK changes often. Before writing against it, read its types in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (and its README there); don't rely on memory for its API.
- The Codex SDK (`@openai/codex-sdk`) changes often too. Before writing against it, read `node_modules/@openai/codex-sdk/dist/index.d.ts` and its README. The runner never gives Codex `danger-full-access`, the `never` approval policy or a bypass flag: its permissions come only from `codexPermissions()` in `src/runner/agent-codex.ts`.
- Sessions run in the SDK's `auto` mode by default (config `permissionMode`, `"auto"` or `"default"`, per workspace too) and with the workspace's own settings. A call that reaches `canUseTool` still waits for the person's Allow or Deny in the chat view: never answer it without the person. Never pass `bypassPermissions`, `acceptEdits` or `allowDangerouslySkipPermissions`.
- The runner binds `127.0.0.1` only, and every request passes `refusal()` in `src/runner/server.ts` (Host, Origin, JSON content type). New routes go through the same check.
- Read configuration only through `src/runner/config.ts`. Tests set `CLEAT_CONFIG`, `CLEAT_DATA_DIR` and `CLEAT_PORT=0`, and never touch the real `~/.config/cleat` or `~/.local/share/cleat`.
- Tests that run in CI use the fake agent (`CLEAT_FAKE_AGENT=1`): CI has no Claude Code login. A check that needs real Claude Code, Windows or a desktop is a script under `scripts/` that a person or verifier runs on a machine that has them, and the test suite skips it when `CI` is set.
- Never start a real Claude Code or Codex session in a real workspace from a test or a script. Use a throwaway folder made with `mkdtemp`.
- Pages use only the tokens in `src/web/base.css`: no colours or font sizes anywhere else. The feel is small, clean and calm.
- Don't add dependencies: `package.json` and `bun.lock` need a person's approval. Use bun's built-ins and what is installed. The approved ones: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` (for the Codex agent, approved by the owner on 2026-11-15), `@clack/prompts` (setup's prompts, approved by the owner on 2026-11-15; colour is written by `src/cli/ui.ts`, not picocolors), `zod`, and the dev tools.
- Every non-obvious choice gets a decision file in `docs/decisions/` (number from foreman's `reserve_number`), and a line in its README.
