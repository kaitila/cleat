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

## The Windows shell is Electron, in TypeScript
The whole app is TypeScript, by the owner's decision on 2026-11-12: no AutoHotkey, no PowerShell or batch helpers, no Tauri or Rust.

Electron gives the shell everything it needs from TypeScript: tray, global shortcut, clipboard text and images, notifications, windows on the runner's pages, start on login. It needs no compiler on Windows. Tauri was the first target, but it is Rust, and on this machine `rustc` could not link (`link.exe` not found).

How it is installed, tried on 2026-11-12:
- Electron 45.3.1's installer needs Node 22.12 or newer. Windows has Node 20.11, WSL has Node 22. So Electron is installed from WSL with npm for the Windows platform (`npm_config_platform=win32 npm install`, then `node node_modules/electron/install.js`), into a folder on the Windows disk, and `electron.exe` is started from WSL or from Windows.
- Started that way it registered a global shortcut. Its clipboard API in 45 differs from older versions, so the shell is written against `electron.d.ts`.
- The shell's code is bundled from `shell/src` with `bun build` into one CommonJS file and copied next to `shell/package.json` in that Windows folder. Electron does not load an app from a `\\wsl.localhost` path reliably, hence the copy.
- `electron` is also a devDependency of the root package, for its types only: bun does not run its postinstall, so no binary is downloaded in WSL or CI.
