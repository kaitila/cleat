# D0001: A runner in WSL, web pages for the UI, a thin Windows shell

Date: 2026-11-12. Status: active.

## Decision
- The runner is a bun + TypeScript daemon in WSL, bound to `127.0.0.1`. It drives Claude Code through the Claude Agent SDK and is the only part that holds state.
- The pop-up and the chat view are web pages the runner serves, with no build step. Almost everything can then be built and tested inside WSL.
- The Windows shell only does what a web page can't: global hotkey, tray icon, clipboard capture, toasts, start on login. It talks to the runner over HTTP ([protocol](../protocol.md)).
- State is files under `~/.local/share/intuition`. No database.

## Why
The agents and their workspaces live in WSL, so the process that starts them does too. A Windows GUI can't be seen or clicked from WSL, so the less of the app that lives there, the more of it can be verified.

## What the preset left behind
The project was started with foreman's `bun-ts-postgres` preset, the only one there is. Removed in the first commits:
- Postgres, Drizzle, Docker and the deploy files: the app is a local daemon with file storage.
- `@foreman-kit/docs-check`, `@foreman-kit/test-kit` and `@foreman-kit/design-kit`: version 0.1.0 of each is not on the npm registry, so `bun install` failed, locally and in CI. `bun run check` is therefore the typecheck and the tests. `.foreman-kit/installed.json` still names those pieces, so `fm sync` may offer them again; add them back once they are published.
- CI is foreman's bun-only workflow (`ci-bun.yml`) instead of the Postgres one.

The guardrails, skills, agents, `foreman.json` and `.mcp.json` are the kit's, unchanged.

## The Windows shell is AutoHotkey for now
Tauri 2 is the target. On 2026-11-12 the Windows side had Rust 1.84.1 but `rustc` could not link: Build Tools 2019 is installed without a working C++ workload or Windows SDK (`link.exe` not found). The MVP shell is an AutoHotkey v2 script; the Tauri shell is a later task.
