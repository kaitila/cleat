# D0009: The `intuition` command is a symlink to `src/cli.ts`

Date: 2026-11-13. Status: active.

## Decision
- `src/cli.ts` starts with `#!/usr/bin/env bun` and is committed executable. `bun src/cli.ts link [dir]` (`src/cli/link.ts`) makes a symlink named `intuition` to it, by default in the folder bun itself is in (`dirname(process.execPath)`, `~/.bun/bin` here), and says whether that folder is on the PATH. There is no wrapper script and no `bin` entry in `package.json`.
- Nothing was changed to find the repo: bun runs a linked script from its real path, so `import.meta.dir` in `src/cli/runner.ts`, `src/shell/paths.ts` and `src/runner/server.ts` is the repo's folder whatever the link or the current folder is. No code reads `process.cwd()`. A test runs `start`, `status` and `stop` through a link in a temp folder, from another folder.
- A link is ours only when it ends at this checkout's `src/cli.ts` (real paths compared). `link` replaces ours; `unlink` removes ours. Anything else in its place (a file, a folder, a link to another program, to another checkout, or to nothing) is left alone, named in the message, and the command exits 1.
- `intuition` alone is `up`. `help`, `--help` and `-h` print the usage on stdout and exit 0. An unknown command, or a word a command does not take, prints the usage on stderr and exits 2 (it was 1), so a wrong line can be told from a command that failed (1).
- The shell still starts the runner with `<bun> <repo>/src/cli.ts start --login-env` ([D0006](D0006-start-stop-and-login.md)): it does not depend on the link or on the PATH.

## Why
- The folder bun is in is on the PATH of anyone who can type `bun`, and needs no root. `bun link` and a `bin` entry would put the same symlink there, but need a change to `package.json` and make a second, global copy of the package's metadata.
- A link to another checkout is refused, not replaced, so that an agent running `link` in a worktree cannot take over the owner's command. The cost: after moving the repo, the person removes the old link by hand before `link` works.
- Tests always give `link` a temp folder. `intuition` alone is tested as a pure function (`src/cli/command.ts`), never run: it would install and start the real Windows shell.
