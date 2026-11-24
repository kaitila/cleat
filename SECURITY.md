# Security

Cleat starts Claude Code agents that can read and change files and run commands on your computer. This page says what protects that and how to report a problem.

## What cleat does and doesn't do
- **The runner listens on your own machine only.** It binds `127.0.0.1` (port 4777 by default), never `0.0.0.0`, so nothing else on your network can reach it.
- **Every request is checked.** The runner refuses a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`, one whose `Origin` is any other site, and a `POST` that is not `application/json`. This keeps a web page you happen to visit from sending tasks to it, including through DNS rebinding.
- **Agents run as you, with your Claude Code permissions.** Sessions run through the Claude Agent SDK with your own Claude Code login and the workspace's own Claude Code settings (`.claude/settings.json`, `CLAUDE.md`, your allow and deny rules). Cleat adds no permissions of its own.
- **Auto mode by default.** A session runs in Claude Code's `auto` permission mode unless the configuration says `"default"`. In `auto`, Claude Code's classifier allows or denies each tool call; a call it can't decide waits for your Allow or Deny in the chat view, and nothing answers it for you. In `default`, every call that would ask in a terminal waits for you. The configuration accepts only these two: `bypassPermissions`, `acceptEdits` and any other mode are refused when the file is read.
- **Sessions start only in the folders you listed** as workspaces in `~/.config/cleat/config.json`.
- **No accounts, no telemetry.** Cleat has no server of its own and sends nothing anywhere. Claude Code talks to Anthropic as it does in a terminal.
- **What is kept on disk.** Sessions and their events are stored under `~/.local/share/cleat/`, readable by your user. On Windows a clipboard image is saved as a PNG in `%TEMP%\cleat` for the agent to read. Anything you attach to a task ends up in the session and in the Claude Code transcript.

What it does not protect against: another program running as your user on the same machine can talk to the runner, as it could run `claude` itself. Treat access to your user account as access to your agents.

## Reporting a problem
Please don't open a public issue for a security problem. Report it privately through GitHub: on the repository's GitHub page, open **Security**, then **Report a vulnerability**. Say what you found, how to reproduce it, and which version (`git rev-parse HEAD`) and platform you used.

You can expect an answer within a week. A confirmed problem is fixed on `main`, and the advisory is published once the fix is in, with credit to you unless you'd rather not.

Supported: the latest commit on `main`. There are no releases or older versions to patch.
