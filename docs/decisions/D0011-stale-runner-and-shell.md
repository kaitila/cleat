# D0011: A runner or shell older than the repo is restarted by `start` and `up`

Date: 2026-11-13. Status: active.

## Decision
- **The build id** (`src/runner/build.ts`) is the first 12 hex digits of a SHA-256 over the relative names and the contents of every file in `src/runner/`, `src/shared/`, `src/web/`, `package.json` and `bun.lock`. The runner takes it once, at its start, and reports it as `build` in `GET /health`. `INTUITION_BUILD_ID` (read in `config.ts`) replaces it, for the tests only.
- **`start` and `up`** compare a recorded runner's `build` with the repo's. Equal: "already running", exit 0. Different, or missing (a runner from before build ids): the runner is stopped and started again, and the command says so. When a session is `running` or `waiting_approval`, the runner is kept instead: the command names those sessions and exits **3** (`KEPT`). A runner this command did not start (no pid file) is never restarted: a different build exits 3 with "restart it where it runs".
- **`restart`** always stops and starts, with the same guard; `--force` cuts the sessions off and says which.
- **`up`** goes on to the shell after a kept runner (exit 3 at the end), and compares the installed shell with a fresh bundle built into a temp folder: `main.cjs`, `dock-preload.cjs` and `package.json` byte for byte, and the Electron version. Any difference: it asks the shell to quit, waits for its process to end, installs and starts it.
- **Waiting for the shell to end**: the shell writes its Windows pid to `shell.pid` beside its settings and removes it as it quits. `up` polls `tasklist.exe` for that pid, up to ten seconds; a shell from before the pid file is given two seconds.
- **The shell**, when `/dock` loads with an HTTP error while `/health` answers, shows one notification, "the runner is older than the shell", and keeps loading the page at every dock check (4 seconds). A dock that loads clears the flag.

## Why
- A content hash, not the git commit and a dirty marker: it needs no git (a copy of the repo works), it does not change for an edit to the command line or the docs, which the runner does not run, and a touched but unchanged file is not a new build. Hashing those files (under half a megabyte) takes about 5 ms.
- Exit 3, not 1: a kept runner still works and is not a failure to start, but a script or a person must be able to see it. 2 is a wrong command line ([D0009](D0009-intuition-command.md)).
- A turn cut off by a restart is recorded as failed at the next start; an approval waiting for the person would be lost. So the guard, and `--force` for when the person decides.
- The shell is compared with a fresh bundle rather than a hash recorded at install: an install from before this change is caught too, and there is nothing more to keep in step. Bun's bundler gives the same bytes for the same source (a test checks it).
- A second Electron started while the first is still quitting would hand its command line to the dying one and exit, leaving no shell: hence the wait for the pid.
