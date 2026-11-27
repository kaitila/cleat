# Plugins

A plugin is a tab in the open dock, with a hotkey of its own if you want one: your calendar for today, a search of your CRM, anything you can turn into a list of rows. It is one TypeScript file. It gives back plain data, sections of rows, and the dock draws them; there is no HTML or CSS to write. Why it is built this way: [D0057](decisions/D0057-plugins.md).

## Where plugins live
- **Yours**: `plugins/<id>/plugin.ts` beside the config file, so `~/.config/cleat/plugins/<id>/plugin.ts` by default (`CLEAT_CONFIG` moves it with the file).
- **Built in**: the repo's `plugins/` folder. One of yours with a built-in's id takes its place.

The folder's name is the plugin's id: lowercase letters, digits and dashes, at most 40, starting with a letter or digit. A folder with another name, or without a `plugin.ts`, is skipped.

The runner loads every plugin when it starts. After you add or change one, press **Reload plugins** in Settings → Plugins (or `POST /api/plugins/reload`): the changed files are imported afresh, no restart needed.

## A first plugin
The quickest start is

```sh
cleat plugin new hacker-news
```

It writes `plugins/hacker-news/plugin.ts` beside the config file: a working plugin that searches Hacker News as you type (a plain `fetch`, no connector), with a `view()` that calls a connector's tool in comments. Its import is `import type` of this install's `src/plugin.ts`, so your editor knows the types and it keeps working if the install moves. If the runner is running, it is asked to reload and the tab is in the dock at once; otherwise the runner loads it when it starts. The name is the plugin's id (see above), and one that is taken is refused. Edit the file, then Reload plugins.

By hand, a plugin's file has one default export: an object with a `title` and a `view()`, a `search`, or both. A plain object works without any import:

```ts
// ~/.config/cleat/plugins/clocks/plugin.ts
export default {
  title: "Clocks",
  icon: "globe",
  hotkey: "CommandOrControl+Alt+T",
  async view(ctx) {
    const zones = (ctx.options.zones as string[] | undefined) ?? ["Europe/Helsinki", "America/New_York", "Asia/Tokyo"];
    const now = new Date();
    return {
      sections: [
        {
          title: "Now",
          rows: zones.map((zone) => ({
            title: zone.split("/").pop()!.replace(/_/g, " "),
            meta: now.toLocaleTimeString([], { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }),
          })),
        },
      ],
    };
  },
};
```

Save it, press Reload plugins, turn it on if it isn't, and press ⌘⌥T (Ctrl+Alt+T elsewhere): the dock opens on the Clocks tab.

With types, in the repo use `definePlugin` from `src/plugin.ts`, as the built-in ones do:

```ts
import { definePlugin } from "../../src/plugin";

export default definePlugin({ title: "Clocks", async view(ctx) { /* ... */ } });
```

A plugin of yours, outside the repo, takes the types alone, as `cleat plugin new` writes it: `import type { PluginDefinition } from "<cleat>/src/plugin";` and `export default { ... } satisfies PluginDefinition;`. Bun drops a type-only import when it runs the file, so only your editor reads the path. `<cleat>` is your clone, or the install's folder (`~/.bun/install/global/node_modules/cleat`).

## What a plugin defines
| Field | What it is |
|---|---|
| `title` | The tab's name, at most 40 characters. Required. |
| `icon` | The tab's glyph: `calendar`, `search`, `people`, `mail`, `note`, `star`, `bolt`, `globe`, `chart` or `list` (the default). |
| `hotkey` | An Electron accelerator (`"CommandOrControl+Alt+C"`) that opens the dock on the tab. The config's `hotkey` replaces it. |
| `tools` | The MCP tools `ctx.tool()` and `ctx.ask()` may call, by full name (`mcp__<server>__<tool>`), at most 50. Nothing else runs for the plugin. |
| `enabled` | Whether it is on before Settings or the config says either way. Default: on for yours, off for the built-in ones. |
| `refreshMs` | How long a view is shown before opening the tab works it out again. Default 5 minutes, at least 1000. |
| `view(ctx)` | The tab's content when it opens, and while the find field is empty. |
| `search` | `{ placeholder?, live?, run(query, ctx) }`: a find field at the tab's top. `run` gives a view for the query. A plugin with a search and no view is asked `run("")` when its tab opens, so a hint (a `note`) shows there; answer it without calling a tool. |
| `login(ctx)` | A sign-in the plugin needs first, such as an OAuth grant for an API it calls directly. `cleat plugin login <id>` runs it in the terminal (not in the runner), and it gives back one line saying what it did. Its `ctx` has `id`, `options`, `dataDir` and `signal` as a view's does, plus `openUrl(url)` (the person's browser), `input(question, { secret?, initial? })` (asks in the terminal) and `log`. Keep what it gets (a refresh token) in `ctx.dataDir`, where `view()` and `search()` find it. |

A plugin needs a `view()`, a `search`, or both. One that doesn't load (a syntax error, no default export, a field of the wrong kind) is listed in Settings with the reason and never runs.

## Views, sections and rows
`view()` and `search.run()` give back a view:

```ts
{
  sections: [
    { title: "Today", rows: [ /* rows */ ], empty: "Nothing else today." },
  ],
  note: "A line under the sections.",
}
```

- A **section** has an optional `title`, its `rows`, and `empty`, the line shown when it has no rows.
- A **row** has a `title`, and optionally:
  - `detail`: a second, muted line;
  - `meta`: small text at the right end (a time, a count, a word);
  - `tone`: a dot before the title, `"accent"` (now, live), `"muted"` (past: the title is muted too) or `"error"`;
  - `url`: opens in your browser on a click. Only `http:` and `https:`; anything else is dropped;
  - `task`: a prompt. The row then has an **Ask** button that starts a session on it, in the workspace you used last, and grows the dock into the chat on it.
- `note`: an optional line under the sections.

Everything is text. The dock sets it as text, never as markup, so a plugin can't break the page or run script in it. What doesn't fit is cut: at most 20 sections, 200 rows a section, 500 characters a field (80 for a section's title, 60 for `meta`, 8000 for `task`), with "…" where it was cut. Anything that isn't a view is an error, shown in the tab.

## The context
`view(ctx)` and `search.run(query, ctx)` get a `PluginContext`:

| | |
|---|---|
| `ctx.id` | The plugin's id. |
| `ctx.options` | The plugin's own options: the config's `plugins.<id>.options` (`{}` when none). |
| `ctx.dataDir` | A folder of its own, `<data folder>/plugins/<id>/`, for files it keeps. The runner keeps the last view there too, as `view.json`. |
| `ctx.signal` | Aborts when the work is no longer wanted: a newer search of the same plugin, or the runner stopping. Pass it to `fetch`. |
| `ctx.tool(name, args)` | Calls one MCP tool. See below. |
| `ctx.ask(prompt, schema, options?)` | Asks Claude for an answer of a JSON schema's shape. See below. |
| `ctx.log(...parts)` | A line in the runner's log, with the plugin's id. |

There is no `ctx.fetch`: plain `fetch` works, with `{ signal: ctx.signal }`.

## Your connectors: `ctx.tool`
`ctx.tool(name, args)` calls one MCP tool, such as one of your claude.ai connectors (Google Calendar, Gmail, a CRM), with exactly those arguments, and gives back its result: parsed JSON when the result is JSON, else its text. A tool that answers an error throws with the tool's own words.

It runs through Claude Code with your login and your connectors, in a one-off process allowed to run that one tool and nothing else: no built-in tools, none of your allow rules, no approvals (nobody is there to answer one). A small model makes the call, and the runner pins the arguments to yours whatever it wrote. It takes some seconds, about 7 to 10 on the owner's Mac, so a view built on it is kept for `refreshMs` and a search on it runs on Enter.

The tool must be in the plugin's `tools`; any other name throws before anything runs. If its connector isn't connected, or needs a sign-in, the call says so.

**A tool's full name** is `mcp__<server>__<tool>`, the server's name with every character but letters, digits, `_` and `-` turned into `_`. A claude.ai connector's server is `claude_ai_<its name>`: `mcp__claude_ai_Google_Calendar__list_events`, `mcp__claude_ai_Gamma__search_people`. To find one, run `/mcp` in Claude Code and look at the server's tools. The chat shows a call in words ("Google Calendar list events"), which is the full name with `mcp__claude_ai_` dropped and `_` for the spaces; a session's `tool_use` events (`GET /api/sessions/:id/events`) carry the full name itself.

## When one call is not enough: `ctx.ask`
`ctx.ask(prompt, schema, { tools?, model? })` asks Claude, allowed only the plugin's `tools` (or the ones you list, which must be among them), for an answer of the JSON schema's shape. Use it for what one call can't do: several calls, sorting, summing up. It is slower than `ctx.tool`, tens of seconds on the default model (`sonnet`); pick another with `model`.

```ts
const answer = await ctx.ask<{ unread: { from: string; subject: string }[] }>(
  "List my unread email from today that needs an answer.",
  { type: "object", properties: { unread: { type: "array", items: { type: "object", properties: { from: { type: "string" }, subject: { type: "string" } }, required: ["from", "subject"] } } }, required: ["unread"] },
);
```

## A search
```ts
// ~/.config/cleat/plugins/wikipedia/plugin.ts: a live search of a public API, no agent at all.
export default {
  title: "Wikipedia",
  icon: "search",
  search: {
    placeholder: "Search Wikipedia",
    live: true,
    async run(query, ctx) {
      const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=10&search=${encodeURIComponent(query)}`;
      const [, titles, , links] = (await (await fetch(url, { signal: ctx.signal })).json()) as [string, string[], string[], string[]];
      return {
        sections: [{ rows: titles.map((title, i) => ({ title, url: links[i], task: `Summarise the Wikipedia article "${title}" for me.` })), empty: "Nothing found." }],
      };
    },
  },
};
```

`live: true` searches as you type, 350 ms after the last key: only for a cheap search like this one. Without it a search runs when you press Enter, which is right for one that calls `ctx.tool`. A newer search aborts the one before (its `ctx.signal`). The built-in Gamma plugin (`plugins/gamma/plugin.ts`) is a search on Enter through a connector; the Calendar plugin (`plugins/calendar/plugin.ts`) is a view that calls an API directly, after a `login` (D0059).

## Turning plugins on, hotkeys, options
In Settings → Plugins each plugin has a switch and a hotkey (record it, or Clear for none), and the line under its name says whether it is built in or yours, and which tools it uses. Settings refuses a plugin's hotkey that is one of Cleat's own three or another plugin's; set by hand in the file, Cleat's own win, then the first plugin (built-in ones first, then by id) that asks for the key. Both are saved into the config file, beside the plugin's `options`, which only the file sets:

```json
{
  "plugins": {
    "calendar": { "enabled": true },
    "clocks": { "hotkey": "CommandOrControl+Alt+K", "options": { "zones": ["Europe/Helsinki", "Asia/Tokyo"] } },
    "gamma": { "enabled": false, "hotkey": null }
  }
}
```

`hotkey: null` means none; left out, the plugin's own. The ids are checked when the config is read: a bad one stops the runner from starting, with the reason.

## The built-in plugins
Both are off until turned on.

| Plugin | What it shows | Hotkey |
|---|---|---|
| `calendar` | Today's and tomorrow's events, read from the Google Calendar API directly (no Claude, a fraction of a second; D0059): times, place, a Meet link, the event now in the accent, past and declined ones muted; Ask prepares you for the meeting. Refreshed every 2 minutes. Needs `cleat plugin login calendar` once (below). | CommandOrControl+Alt+C |
| `gamma` | People and companies in Gamma (`search_people`, `search_organizations`) on Enter: a name or a company searches both, three words or more search people by description; Ask tells you about the person or company. | CommandOrControl+Alt+G |

### Calendar: signing in to Google
Calendar calls Google with an OAuth client of your own (Google doesn't let a shared one read calendars without its review). Making one takes a couple of minutes, once:

1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, and under **APIs & Services → Library** enable the **Google Calendar API**.
2. Under **APIs & Services → OAuth consent screen**, set it up: **Internal** if your Google account is a Workspace one (only your organization can use it, no review), otherwise **External** with yourself added as a test user. The scope it asks is `calendar.readonly`.
3. Under **APIs & Services → Credentials**, **Create credentials → OAuth client ID**, application type **Desktop app**. Keep its client ID and client secret.
4. Run `cleat plugin login calendar`. It asks for the client ID and secret (or takes `clientId` and `clientSecret` from the config's `plugins.calendar.options`), opens Google's consent page, and takes Google's answer on `127.0.0.1`. The refresh token is kept in `<data folder>/plugins/calendar/google.json`, readable by you only; the tab shows your events at once.

Signed out (no `google.json`, or the sign-in revoked or expired) the tab says to run the command again. By default it shows your primary calendar; `"options": { "calendars": ["primary", "team@group.calendar.google.com"] }` shows several (the ids are in Google Calendar's settings for each calendar).

## In the dock
The tabs show when at least one plugin is on: Sessions first, then one per plugin, an icon each (the name and hotkey as the tooltip). On a Mac's notch they sit in the notch's band, on its left wing; without one, as a row at the panel's top. A plugin's tab has its title, the find field when it has a search, Refresh when it has a view, the rows, and a status line: when the view was worked out, "updating…" while a new one loads, or the last error.

Every opening of the dock, by the pointer or a click, starts on Sessions; a click on a tab or a plugin's hotkey shows a plugin's. A plugin's hotkey opens the dock on its tab with the keyboard in its find field. Pressed again on that tab, it closes the dock; from the chat it steps down to the tab. Opened by the key, the dock stays until the pointer has been on it and left, or Esc. Text in the find field holds the dock open, as a reply being typed does.

## How it runs
- **Views** are kept, in memory and in `view.json`, so a tab shows its last view at once, after a restart too. Opening the tab works out a new one in the background when the kept one is older than `refreshMs` (or the last try failed, or you press Refresh), and the tab updates when it is done.
- **Timeouts**: a `view()` or a search that takes longer than 90 s is given up, with an error.
- **Errors**: whatever a plugin throws, or gives back that isn't a view, is shown in its tab ("Failed: …", or "the last update failed" over the last good view) and logged. It never stops the runner or another plugin.
- **Tests and CI** (`CLEAT_FAKE_AGENT=1`): `ctx.tool` answers `{ fake: true, tool, args }` and `ctx.ask` `{ fake: true, prompt }`, so nothing reaches Claude Code.

## Trust
A plugin is code, and it runs in the runner's process with your rights: it can read and write your files and reach the network as you can. Only install a plugin you would run yourself. Its `tools` are what it may call on your connectors, without asking you each time, once you turn it on; read them (Settings lists them) before you do, and be wary of a plugin that lists tools that write or send.
