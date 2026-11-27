// Calendar: today's and tomorrow's events from the person's Google Calendar connector in Claude.
// A built-in plugin (docs/plugins.md): off until turned on in Settings or the config file.
import { definePlugin, type PluginRow } from "../../src/plugin";

const LIST_EVENTS = "mcp__claude_ai_Google_Calendar__list_events";

interface When {
  dateTime?: string;
  date?: string;
}
interface CalendarEvent {
  summary?: string;
  status?: string;
  start?: When;
  end?: When;
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** A day's start as the calendar wants it: local time, no offset. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`;
}

/** The zone if it is one this runtime knows, else undefined (the runner's own). */
export function knownZone(zone: unknown): string | undefined {
  if (typeof zone !== "string" || !zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The calendar date ("2026-11-27") of an instant in a zone (undefined: the runner's). */
export function dateIn(at: Date, zone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The date `days` after a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The instant a "YYYY-MM-DD" date begins in a zone (undefined: the runner's). */
export function midnightIn(date: string, zone?: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  if (!zone) return new Date(y!, m! - 1, d!);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const offset = (t: number) => {
    const p = Object.fromEntries(parts.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  const guess = Date.UTC(y!, m! - 1, d!);
  return new Date(guess - offset(guess - offset(guess)));
}

/**
 * Whether an event runs on a "YYYY-MM-DD" day: it overlaps the day, so one that began earlier and
 * still runs (several days, overnight) counts too. An all-day event's end date is exclusive; one
 * with no end, or no length, counts on the day it starts.
 */
export function overlaps(e: CalendarEvent, day: string, zone?: string): boolean {
  if (!e.start?.dateTime) {
    const start = e.start?.date;
    if (!start) return false;
    const end = e.end?.date && e.end.date > start ? e.end.date : addDays(start, 1);
    return start <= day && day < end;
  }
  const from = midnightIn(day, zone).getTime();
  const to = midnightIn(addDays(day, 1), zone).getTime();
  const start = new Date(e.start.dateTime).getTime();
  const end = e.end?.dateTime ? new Date(e.end.dateTime).getTime() : start;
  return (start >= from && start < to) || (start < to && end > from);
}

const clock = (d: Date, zone?: string) => d.toLocaleTimeString([], { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false });

/** One event as a row of the tab, its times in the calendar's zone (undefined: the runner's). */
export function eventRow(e: CalendarEvent, day: string, now: Date, zone?: string): PluginRow {
  const title = e.summary?.trim() || "(no title)";
  const allDay = !e.start?.dateTime;
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  const meta = allDay || !start ? "All day" : end ? `${clock(start, zone)}–${clock(end, zone)}` : clock(start, zone);
  const others = (e.attendees ?? []).filter((a) => !a.self).length;
  const detail = [e.location, e.hangoutLink ? "Google Meet" : "", others ? `${others} other${others === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined");
  const tone = start && end && start <= now && now < end ? "accent" : (end && end <= now) || declined ? "muted" : undefined;
  return {
    title,
    meta,
    ...(detail ? { detail } : {}),
    ...(tone ? { tone } : {}),
    ...(e.hangoutLink || e.htmlLink ? { url: e.hangoutLink ?? e.htmlLink } : {}),
    task: `Prepare me for "${title}" (${day}, ${meta}) in my calendar: who is attending, what I know about them and our last conversations, and anything I should read first.`,
  };
}

export default definePlugin({
  title: "Calendar",
  icon: "calendar",
  hotkey: "CommandOrControl+Alt+C",
  tools: [LIST_EVENTS],
  refreshMs: 10 * 60_000,
  async view(ctx) {
    const now = new Date();
    // Asked from yesterday to three days on in the runner's time, so the calendar's today and
    // tomorrow are inside it even when its zone is a day apart from the runner's (WSL's TZ).
    const local = (days: number) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
    const answer = await ctx.tool<{ events?: CalendarEvent[]; timeZone?: string }>(LIST_EVENTS, { startTime: local(-1), endTime: local(3), orderBy: "startTime", pageSize: 100 });
    const zone = knownZone(answer?.timeZone);
    const events = (answer?.events ?? []).filter((e) => e.status !== "cancelled" && e.eventType !== "WORKING_LOCATION");
    const today = dateIn(now, zone);
    const tomorrow = addDays(today, 1);
    const on = (day: string) => events.filter((e) => overlaps(e, day, zone));
    return {
      sections: [
        { title: "Today", rows: on(today).map((e) => eventRow(e, "today", now, zone)), empty: "Nothing else today." },
        { title: "Tomorrow", rows: on(tomorrow).map((e) => eventRow(e, "tomorrow", now, zone)), empty: "Nothing tomorrow." },
      ],
    };
  },
});
