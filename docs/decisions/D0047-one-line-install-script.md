# D0047: The install line is one `curl | sh`, and that script is the repo's one shell file

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner). Builds on [D0045](D0045-install-with-bun-only.md), which proposed it; makes the one exception to AGENTS.md's "TypeScript only".

## Context
D0045 made the install need only bun's installer, but its line was four commands joined by `&&`, with a PATH export in the middle, and on Linux `unzip` to install first. D0045 proposed a script of our own behind a `curl | sh` line, which needed an exception to the rule against shell files. The owner, on 2026-11-24: "maybe just do the real one-liner, its a lot cleaner".

## Decision
- **The line:** `curl -fsSL https://kaitila.github.io/holm/install.sh | sh`, in the README, on the landing page and in docs/platforms.md.
- **The script** is `site/install.sh`, served by the landing page's GitHub Pages build (any change under `site/` deploys it). POSIX `sh`, `set -eu`. It:
  1. refuses anything but macOS and Linux (WSL included), and needs curl;
  2. puts `$BUN_INSTALL/bin` (default `~/.bun/bin`) on its own PATH;
  3. without bun: installs `unzip` with apt when it is missing and there is a terminal to ask for sudo, otherwise stops and says so; then runs bun's own installer;
  4. `bun install -g github:kaitila/holm`;
  5. runs `holm setup` with `/dev/tty` as its input (the script's own input is the pipe from curl), or `holm setup --yes` when there is no terminal;
  6. says to open a new terminal if this one doesn't know `holm` yet (bun's installer adds its folder to the shell's profile).
- **The rule's exception is this one file.** AGENTS.md says so. It stays small: it only gets bun and hands over to `holm setup`, which is TypeScript and does the rest.

## Why
- One line to copy, nothing to edit, the shape people know from bun, uv, rustup and Claude Code.
- `/dev/tty` for setup: piped from curl, setup's prompts would read the script's text as answers.

## Alternatives
- Keeping D0045's `&&` line: no shell file, but the PATH export and `unzip` were the parts people get wrong.
- A compiled `holm` binary as the script's download (D0045): no bun at all, but a large change to how the app finds its pages and shell, and each binary would carry both agents.

## Risk
- `curl | sh` runs what the site serves: the site is this repo's GitHub Pages, deployed from `main`.
- A distribution without apt and without `unzip` stops with a message instead of installing it.
- Tried by hand only on macOS; not on a clean Linux machine or WSL.
