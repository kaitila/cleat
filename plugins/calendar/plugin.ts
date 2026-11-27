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

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** One event as a row of the tab. */
export function eventRow(e: CalendarEvent, day: string, now: Date): PluginRow {
  const title = e.summary?.trim() || "(no title)";
  const allDay = !e.start?.dateTime;
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : null;
  const meta = allDay || !start ? "All day" : end ? `${clock(start)}–${clock(end)}` : clock(start);
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
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const after = new Date(today.getTime() + 2 * 86_400_000);
    const answer = await ctx.tool<{ events?: CalendarEvent[] }>(LIST_EVENTS, { startTime: localDay(today), endTime: localDay(after), orderBy: "startTime", pageSize: 100 });
    const events = (answer?.events ?? []).filter((e) => e.status !== "cancelled" && e.eventType !== "WORKING_LOCATION");
    const on = (day: Date, next: Date) =>
      events.filter((e) => {
        const at = new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`);
        return at >= day && at < next;
      });
    return {
      sections: [
        { title: "Today", rows: on(today, tomorrow).map((e) => eventRow(e, "today", now)), empty: "Nothing else today." },
        { title: "Tomorrow", rows: on(tomorrow, after).map((e) => eventRow(e, "tomorrow", now)), empty: "Nothing tomorrow." },
      ],
    };
  },
});
