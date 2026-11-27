# D0057: Plugins are TypeScript files that give back rows, a tab in the notch, and reach connectors through a locked-down Claude Code call

Date: 2026-11-27. Status: active. Task T-0013. Adds tabs to the open dock of [D0035](D0035-dock-from-the-notch.md) and [D0042](D0042-chat-in-the-notch.md); the plugin calls wait for their MCP server as turns do in [D0050](D0050-wait-for-mcp-connectors.md).

## Context
The owner, on 2026-11-27: "build out infrastructure to develop easy to implement plugins for cleat. for example I could have a hotkey / tab in the notch to view my calendar or search gamma". Both examples need the owner's claude.ai connectors (Google Calendar, Gamma), which live in their Claude login, not in Cleat. Until now the only way to reach them was a full session: a prompt, an agent, a stream in the chat.

The Claude Agent SDK (0.3.322) has no public way to call an MCP tool directly. Its types have an `mcp_call` control request, but `Query` exposes no method that sends it. Measured on the owner's Mac: a prompt asking for today's events as JSON, on the default model, took 34 s.

## Decision
- **A plugin is one file**, `plugins/<id>/plugin.ts`: beside the config file for the person's own (`~/.config/cleat/plugins/`), the repo's `plugins/` for the built-in ones; one of the person's with a built-in's id takes its place. Its default export is a definition (`src/plugin.ts`, `definePlugin`): a title, an icon, a hotkey, the MCP `tools` it may call, and a `view()`, a `search`, or both. The runner imports it (`src/runner/plugins.ts`), with the file's mtime in the import's address so a reload imports a changed file afresh. How to write one: [plugins](../plugins.md).
- **Declarative views.** `view()` and `search.run()` give back sections of rows (`title`, `detail`, `meta`, `tone`, `url`, `task`) and a note: data, not HTML. The runner checks the shape with zod, cuts it to size (20 sections, 200 rows, 500 characters a field) and keeps only `http(s)` links; the dock draws it in its own tokens, as text nodes only. A row's `task` is an Ask button that starts a session on it.
- **`ctx.tool(name, args)` is one tool call through Claude Code** (`src/runner/plugin-agent.ts`): a one-off `query()` on Haiku, told to call the tool once; a `PreToolUse` hook replaces whatever input the model wrote with the plugin's arguments (`updatedInput`); the first `tool_result` of that call is taken raw and the process aborted. About 7 to 10 s (the calendar's day 8.8 s, a Gamma search 10 s), against 34 s for the prompt. `ctx.ask(prompt, schema)` is the slow path, a structured-output query on Sonnet, for work one call can't do.
- **The plugin call's permissions are fixed** (`pluginOptions`): `tools: []` (no built-in tool), `allowedTools` the plugin's declared tools, `permissionMode: "dontAsk"` (any other call refused without asking, since no one is there to ask), `settingSources: []` (none of the person's allow rules widen it; the claude.ai connectors still come with the login), `persistSession: false` (no transcript), the plugin's data folder as cwd, never a workspace. No `canUseTool` is given, and nothing can reach one: the rule that a call waiting for the person is never answered without them holds.
- **Each call waits for its own server by name** (`waitForServers`), up to 15 s: the status list is empty until Claude Code has started, so an empty list means wait, not settled. A server that failed or needs a sign-in fails the call with that reason.
- **Views are cached** for the plugin's `refreshMs` (default 5 minutes), in memory and in `<data>/plugins/<id>/view.json`, so a tab shows its last view at once and a new one comes in the background (`plugin_view`). A view or a search is given up after 90 s. Whatever a plugin throws stays in its tab.
- **Tabs in the open dock.** Sessions first, then one per plugin that is on. With a notch they sit in the notch's band, on its left wing; without one, a row at the panel's top. A plugin's hotkey is registered by the shell from `GET /api/plugins` and the `plugins` message, after its own three, and opens the dock on the tab through `cleat-dock:plugin` (`onPlugin`); pressed again on that tab it closes the dock.
- **Settings → Plugins**: a switch and a hotkey per plugin (`PUT /api/plugins/:id`, written into the config's `plugins.<id>`), and Reload plugins (`POST /api/plugins/reload`). Options are the file's alone.
- **The built-in plugins are off by default.** Calendar (today and tomorrow, ⌘⌥C) and Gamma (people and companies on Enter, ⌘⌥G) need connectors only the owner has; the person's own are on by default, since they wrote them.

## Why
- **Rows, not HTML per plugin.** "Easy to implement" means no markup, styling or scripts in a page; the dock draws every plugin in the same calm look and tokens; and text set as text leaves no XSS surface on the runner's origin, which every page and the approvals route share.
- **TypeScript files the runner loads.** AGENTS.md allows TypeScript only, and bun imports a `.ts` file directly: no build, no package, no manifest. A plugin is the shortest program that can do the job, and it can use `fetch` and the file system as any runner code can.
- **Connectors through Claude Code** because that is where they are: the claude.ai connectors come with the person's login, and the SDK offers no direct MCP call. One pinned call on the smallest model is the fastest, cheapest and narrowest use of it: the model chooses nothing, and the result is the tool's own JSON, not the model's retelling.
- **`dontAsk` and no settings** because a plugin's call has no person watching it. The person's consent is turning the plugin on, with its declared tools listed in Settings, as an allow rule would be.
- **Off by default for the built-ins**, so a fresh install shows no tabs that fail for want of connectors.

## Alternatives
- **HTML or an iframe per plugin**: any look at all, but every plugin a web page to write and style, and script on (or beside) the runner's origin.
- **Plugins as MCP servers**: a standard, but a server is a process with a protocol to speak, it still needs a way to draw, and the connectors would still be out of its reach.
- **Asking the model to write the data** (a prompt with JSON output): it works, at 34 s and a model's tokens on every refresh, and the data is the model's retelling.
- **A long-lived Claude Code process per plugin, or the SDK's prewarm**, so the connectors connect once: would cut the 7 to 10 s, kept for later.

## Risk
- **Latency**: 7 to 10 s a call, so the cache and Enter-only searches carry the feel. A connector slower than 15 s to connect still fails the call.
- **Cost**: each refresh and each search is a short Haiku turn, on the person's plan.
- **Plugin code runs in the runner's process**, with the person's rights. Only what the person installs runs; the built-in ones are the repo's.
- **Declared tools may write.** Nothing stops a plugin from listing a tool that sends or deletes, and once it is on, its calls are not asked about. Settings shows the tools beside the switch.
