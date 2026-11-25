# D0054: Pages reload themselves when the runner restarts onto new code

Date: 2026-11-25. Status: active. Task T-0009. Contract change: `hello` carries `build`.

## Context
After `cleat update` pulled D0053 and restarted the runner, the owner said: "the UI doesnt still show the new animation". The runner served the new pages, but the shell had been running since the day before. Its dock window, and the chat inside it, load their pages once and keep them. `up` restarts the runner when its build id is stale, but it reinstalls the shell only when the shell's own code changed, and the second shell it started quit beside the running one. So the open windows drew the old pages, with the old JavaScript, against the new runner.

## Decision
- **`hello` carries the runner's build id** (`app.build`, the hash in `src/runner/build.ts` of the runner's code, the contract, the pages and the dependencies).
- **A page remembers the first `build` it gets; a later `hello` with another one reloads it** (`pagesChanged` in `chat-format.js`, at the top of the `hello` handler in `chat.js` and `dock.js`, before anything is drawn). The chat inside the dock is its own page and reloads itself the same way. A restart on the same build (a crash, `cleat restart`) only reconnects, and the page keeps its state.

## Alternatives
- **`up` restarts the shell when it restarted the runner**: it fixes `update` only, not `cleat restart` or a runner restarted any other way, and it costs the shell's own state (its windows, a peek under way).
- **Cache headers or versioned asset URLs**: the pages are already served `no-store`; nothing was cached. The windows just never asked again.

## Risk
- A reply typed but not sent is lost when a page reloads. That happens only when the runner's code changed, which is rare and usually follows an update the person started.
