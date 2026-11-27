# D0059: Calendar reads the Google Calendar API directly, signed in by `cleat plugin login`

Date: 2026-11-27. Status: active. Task T-0016. Amends D0057 for the Calendar plugin.

## Context
The owner, on 2026-11-27: "does the plugins fetch through claude connectors? I dont want that, i want straight accurate shit so faster", then "go with the google calendar api".

Under D0057 the Calendar tab's view went through `ctx.tool`: a one-off Claude Code process on Haiku, waiting for the claude.ai connectors to connect, and then a model writing the tool call. That took about 7–10 s a view, and a model stood between the person and their calendar.

## Decision
- **The plugin API gets `login(ctx)`**, run by a new `cleat plugin login <id>` in the terminal, not the runner. Its context has the plugin's options and data folder, as a view's does, plus `openUrl`, `input` and `log`. It is general, so any plugin that calls an API directly can sign in the same way.
- **Calendar's `login`** is Google's installed-app flow: the person's own OAuth client (a Desktop app client), a loopback redirect on `127.0.0.1` on a free port, PKCE S256, the `calendar.readonly` scope, and `access_type=offline`. The client and the refresh token are kept in `<data folder>/plugins/calendar/google.json`, mode 600.
- **Calendar's `view`** gets an access token from the refresh token (kept in memory until a minute before it expires), then calls `events.list` on each calendar in `options.calendars` (default `primary`) with `singleEvents=true` and `orderBy=startTime`, through plain `fetch`. It declares no `tools`. Not signed in, the tab says to run `cleat plugin login calendar`. Views refresh every 2 minutes, not 10, since a call is cheap now.

## Alternatives
- **The calendar's private iCal address**: no sign-in, but recurring events come as RRULEs with exceptions, and expanding them correctly with no dependency is where the errors would be. The API expands them itself (`singleEvents`).
- **A shared OAuth client shipped with Cleat**: Google requires a security review before a shared client may read calendars, and its secret would be public anyway.
- **macOS Calendar (EventKit)**: Mac only, needs the Google account added to Calendar.app and a privacy prompt.
- **Calling the claude.ai connector without a model**: the connectors' tokens stay inside claude.ai; there is no direct path to them.

## Risk
- The person has to make an OAuth client once (docs/plugins.md shows how). An External consent screen in testing mode lets refresh tokens lapse after 7 days. A Workspace account's Internal screen doesn't.
- The refresh token is a credential on disk: it is readable by the person only, and limited to reading calendars.
