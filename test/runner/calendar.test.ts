// The built-in Calendar plugin (D0059): the Google Calendar API called directly, through a stubbed
// fetch; the sign-in's OAuth pieces; no Claude Code anywhere.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, calendarLogin, calendarsOf, calendarView, dateIn, eventRow, midnightIn, NOT_SIGNED_IN, overlaps } from "../../plugins/calendar/plugin";
import calendar from "../../plugins/calendar/plugin";
import { accessToken, authUrl, EVENTS_URL, forgetTokens, type Grant, GRANT_FILE, pkce, readGrant, TOKEN_URL, writeGrant } from "../../plugins/calendar/google";
import { definitionOf } from "../../src/runner/plugins";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
beforeEach(() => forgetTokens());

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "cleat-calendar-"));
  dirs.push(d);
  return d;
}

const GRANT: Grant = { clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" };

interface Call {
  url: URL;
  init?: RequestInit;
}

/** A fake Google: the token endpoint and events.list, each calendar's answer from `byCalendar`. */
function google(byCalendar: Record<string, { items?: unknown[]; timeZone?: string }>, o: { tokenStatus?: number; tokenError?: string } = {}) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.href === TOKEN_URL) {
      if (o.tokenStatus) return Response.json({ error: o.tokenError ?? "server_error" }, { status: o.tokenStatus });
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "authorization_code") return Response.json({ access_token: "access-1", refresh_token: "refresh-new", expires_in: 3599 });
      return Response.json({ access_token: "access-1", expires_in: 3599 });
    }
    const m = url.pathname.match(/\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    if (m) {
      if (new Headers(init?.headers).get("authorization") !== "Bearer access-1") return Response.json({ error: { message: "no auth" } }, { status: 401 });
      return Response.json(byCalendar[decodeURIComponent(m[1]!)] ?? { items: [] });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher, calls, events: () => calls.filter((c) => c.url.href.startsWith(EVENTS_URL)) };
}

function signedIn(): string {
  const d = folder();
  writeGrant(d, GRANT);
  return d;
}

const ctx = (dataDir: string, options: Record<string, unknown> = {}) => ({ options, dataDir, signal: new AbortController().signal });

describe("Calendar's view", () => {
  test("not signed in: no call, and the tab says how to sign in", async () => {
    const g = google({});
    const v = await calendarView(ctx(folder()), g.fetcher);
    expect(v).toEqual({ sections: [], note: NOT_SIGNED_IN });
    expect(NOT_SIGNED_IN).toContain("cleat plugin login calendar");
    expect(g.calls).toHaveLength(0);
  });

  test("today's and tomorrow's events from events.list: expanded, in order, no cancelled ones or working locations", async () => {
    const now = new Date();
    const at = (dayOffset: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour).toISOString();
    const pad = (n: number) => String(n).padStart(2, "0");
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const items = [
      { summary: "Standup", start: { dateTime: at(0, 0) }, end: { dateTime: at(0, 0) } },
      { summary: "Cancelled thing", status: "cancelled", start: { dateTime: at(0, 1) }, end: { dateTime: at(0, 2) } },
      { summary: "Home", eventType: "workingLocation", start: { dateTime: at(0, 1) }, end: { dateTime: at(0, 2) } },
      { summary: "Offsite", start: { date: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}` }, end: {} },
    ];
    const g = google({ primary: { items } });
    const v = await calendarView(ctx(signedIn()), g.fetcher, now);
    const [today, next] = v.sections;
    expect(today!.title).toBe("Today");
    expect(today!.rows.map((r) => r.title)).toEqual(["Standup"]);
    expect(next!.title).toBe("Tomorrow");
    expect(next!.rows).toMatchObject([{ title: "Offsite", meta: "All day" }]);
    // One token refresh, one events.list on the primary calendar, from yesterday to three days on.
    expect(g.calls.map((c) => c.url.origin + c.url.pathname)).toEqual([TOKEN_URL, `${EVENTS_URL}/primary/events`]);
    const q = g.events()[0]!.url.searchParams;
    expect(q.get("singleEvents")).toBe("true");
    expect(q.get("orderBy")).toBe("startTime");
    expect(q.get("timeMin")).toBe(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString());
    expect(q.get("timeMax")).toBe(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).toISOString());
    const token = new URLSearchParams(String(g.calls[0]!.init?.body));
    expect(Object.fromEntries(token)).toEqual({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1", grant_type: "refresh_token" });
  });

  test("the access token is kept until it nearly expires: a second view refreshes nothing", async () => {
    const g = google({ primary: { items: [] } });
    const d = signedIn();
    await calendarView(ctx(d), g.fetcher);
    await calendarView(ctx(d), g.fetcher);
    expect(g.calls.filter((c) => c.url.href === TOKEN_URL)).toHaveLength(1);
    expect(g.events()).toHaveLength(2);
    // An hour on, it is asked for again.
    await accessToken(g.fetcher, GRANT, undefined, Date.now() + 3600_000);
    expect(g.calls.filter((c) => c.url.href === TOKEN_URL)).toHaveLength(2);
  });

  test("an event that started before the day and still runs is on it: several days, overnight", async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const at = (dayOffset: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour).toISOString();
    const items = [
      { summary: "Conference", start: { date: date(-1) }, end: { date: date(2) } },
      { summary: "Yesterday's offsite", start: { date: date(-1) }, end: { date: date(0) } },
      { summary: "Night shift", start: { dateTime: at(-1, 22) }, end: { dateTime: at(0, 2) } },
      { summary: "Last night", start: { dateTime: at(-1, 20) }, end: { dateTime: at(-1, 23) } },
      { summary: "Into tomorrow", start: { dateTime: at(0, 23) }, end: { dateTime: at(1, 1) } },
    ];
    const v = await calendarView(ctx(signedIn()), google({ primary: { items } }).fetcher, now);
    const [today, next] = v.sections;
    expect(today!.rows.map((r) => r.title)).toEqual(["Conference", "Night shift", "Into tomorrow"]);
    expect(next!.rows.map((r) => r.title)).toEqual(["Conference", "Into tomorrow"]);
  });

  test("the calendar's time zone in the answer decides which day an event is on", async () => {
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const zone = "Pacific/Kiritimati"; // UTC+14
    const items = [{ summary: "Lunch", start: { dateTime: noon.toISOString() }, end: { dateTime: new Date(noon.getTime() + 3_600_000).toISOString() } }];
    const v = await calendarView(ctx(signedIn()), google({ primary: { items, timeZone: zone } }).fetcher, now);
    const [today, next] = v.sections;
    const onToday = dateIn(noon, zone) === dateIn(now, zone);
    expect(today!.rows.map((r) => r.title)).toEqual(onToday ? ["Lunch"] : []);
    expect(next!.rows.map((r) => r.title)).toEqual(onToday ? [] : ["Lunch"]);
  });

  test("several calendars from options.calendars, merged in start order", async () => {
    const now = new Date();
    const at = (hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).toISOString();
    const g = google({
      primary: { items: [{ summary: "Late", start: { dateTime: at(22) }, end: { dateTime: at(23) } }] },
      "team@group.calendar.google.com": { items: [{ summary: "Early", start: { dateTime: at(1) }, end: { dateTime: at(2) } }] },
    });
    const v = await calendarView(ctx(signedIn(), { calendars: ["primary", "team@group.calendar.google.com"] }), g.fetcher, now);
    expect(v.sections[0]!.rows.map((r) => r.title)).toEqual(["Early", "Late"]);
    expect(g.events()).toHaveLength(2);
    expect(calendarsOf({})).toEqual(["primary"]);
    expect(calendarsOf({ calendars: [] })).toEqual(["primary"]);
    expect(calendarsOf({ calendars: ["a", 3, ""] })).toEqual(["a"]);
  });

  test("an empty calendar says so", async () => {
    const v = await calendarView(ctx(signedIn()), google({ primary: {} }).fetcher);
    expect(v.sections.map((s) => [s.rows.length, s.empty])).toEqual([
      [0, "Nothing else today."],
      [0, "Nothing tomorrow."],
    ]);
  });

  test("a revoked sign-in says to sign in again; an API error says what Google said", async () => {
    const revoked = google({}, { tokenStatus: 400, tokenError: "invalid_grant" });
    expect(calendarView(ctx(signedIn()), revoked.fetcher)).rejects.toThrow("cleat plugin login calendar");
    const failing = async (input: string | URL) =>
      String(input) === TOKEN_URL ? Response.json({ access_token: "access-1", expires_in: 3599 }) : Response.json({ error: { message: "Calendar usage limits exceeded." } }, { status: 403 });
    expect(calendarView(ctx(signedIn()), failing)).rejects.toThrow("Google Calendar answered 403: Calendar usage limits exceeded.");
  });

  test("days and times are the calendar's time zone's, not the runner's", () => {
    expect(midnightIn("2026-11-27", "Europe/Helsinki").toISOString()).toBe("2026-11-26T22:00:00.000Z");
    expect(midnightIn("2026-07-01", "Europe/Helsinki").toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(midnightIn("2026-11-27", "America/Los_Angeles").toISOString()).toBe("2026-11-27T08:00:00.000Z");
    expect(midnightIn("2026-03-08", "America/Los_Angeles").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const late = new Date("2026-11-26T23:30:00Z");
    expect(dateIn(late, "Europe/Helsinki")).toBe("2026-11-27");
    expect(dateIn(late, "America/Los_Angeles")).toBe("2026-11-26");
    const meeting = { summary: "Sync", start: { dateTime: "2026-11-26T23:30:00Z" }, end: { dateTime: "2026-11-27T00:30:00Z" } };
    expect(overlaps(meeting, "2026-11-27", "Europe/Helsinki")).toBe(true);
    expect(overlaps(meeting, "2026-11-26", "Europe/Helsinki")).toBe(false);
    expect(overlaps(meeting, "2026-11-26", "America/Los_Angeles")).toBe(true);
    expect(eventRow(meeting, "today", late, "Europe/Helsinki").meta).toBe("01:30–02:30");
  });

  test("the definition: a view and a login, no MCP tools at all", () => {
    const d = definitionOf({ default: calendar });
    expect("error" in d).toBe(false);
    expect(calendar.tools ?? []).toEqual([]);
    expect(typeof calendar.view).toBe("function");
    expect(typeof calendar.login).toBe("function");
  });
});

describe("Calendar's sign-in", () => {
  test("the grant is kept readable by the person only, and read back", () => {
    const d = folder();
    const file = writeGrant(d, GRANT);
    expect(file).toBe(join(d, GRANT_FILE));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readGrant(d)).toEqual(GRANT);
    expect(readGrant(folder())).toBeNull();
  });

  test("the consent page asks read-only access, offline, with PKCE S256", async () => {
    const { verifier, challenge } = await pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))).toString("base64url");
    expect(challenge).toBe(expected);
    const u = new URL(authUrl("client-1", "http://127.0.0.1:5555/", challenge, "st"));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:5555/",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      access_type: "offline",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
    });
  });

  test("login: asks for the client, opens Google, takes the redirect on 127.0.0.1, keeps the refresh token", async () => {
    const d = folder();
    const g = google({ primary: { items: [] } });
    const asked: string[] = [];
    let opened = "";
    const said = await calendarLogin(
      {
        id: "calendar",
        options: {},
        dataDir: d,
        signal: new AbortController().signal,
        input: async (q, o) => (asked.push(`${q}${o?.secret ? " (secret)" : ""}`), o?.secret ? "secret-9" : "client-9"),
        log: () => {},
        // The person signs in: Google sends the browser back to the loopback address with a code.
        openUrl: async (url) => {
          opened = url;
          const u = new URL(url);
          const back = new URL(u.searchParams.get("redirect_uri")!);
          expect(back.hostname).toBe("127.0.0.1");
          // A redirect for another sign-in is turned away.
          const wrong = await fetch(`${back.href}?state=other&code=x`);
          expect(await wrong.text()).toContain("not the one Cleat started");
          void fetch(`${back.href}?state=${u.searchParams.get("state")}&code=code-1`).catch(() => {});
        },
      },
      g.fetcher,
    );
    expect(asked).toEqual(["Your Google OAuth client ID (a Desktop app client; how: docs/plugins.md)", "Its client secret (secret)"]);
    expect(new URL(opened).searchParams.get("client_id")).toBe("client-9");
    expect(readGrant(d)).toEqual({ clientId: "client-9", clientSecret: "secret-9", refreshToken: "refresh-new" });
    const exchange = new URLSearchParams(String(g.calls.find((c) => c.url.href === TOKEN_URL)!.init?.body));
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(said).toContain("signed in to Google Calendar");
    expect(said).toContain("0 events today");
  });

  test("login: the client from options is used without asking; Google's denial is an error", async () => {
    const asked: string[] = [];
    const run = calendarLogin(
      {
        id: "calendar",
        options: { clientId: "opt-client", clientSecret: "opt-secret" },
        dataDir: folder(),
        signal: new AbortController().signal,
        input: async (q) => (asked.push(q), ""),
        log: () => {},
        openUrl: async (url) => {
          const u = new URL(url);
          void fetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&error=access_denied`).catch(() => {});
        },
      },
      google({}).fetcher,
    );
    expect(run).rejects.toThrow("access_denied");
    await run.catch(() => {});
    expect(asked).toEqual([]);
  });
});
