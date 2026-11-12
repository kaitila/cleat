// The toast poller's logic: what to ask the runner for, which notifications to show, and what to ask
// for next. No Electron imports here: main.ts does the fetching and shows the toasts.
import type { Notification, NotificationsResponse } from "../../src/shared/protocol";

export const POLL_MS = 2000;
/** A poll that takes longer counts as failed. */
export const POLL_TIMEOUT_MS = 1500;
/** At most this many toasts from one poll, the newest: a backlog (the machine slept) doesn't flood the screen. */
export const MAX_TOASTS = 5;

export interface PollState {
  /** The newest seq seen. Null before the first poll that got an answer. */
  after: number | null;
  /** The session of the newest notification shown: the tray's "Open last session". */
  lastSession: string | null;
}

export const START: PollState = { after: null, lastSession: null };

/** The first poll sends no `after`: it only wants `latest`. */
export function pollUrl(runnerUrl: string, state: PollState): string {
  const url = new URL("/api/notifications", runnerUrl);
  if (state.after !== null) url.searchParams.set("after", String(state.after));
  return url.href;
}

const KINDS = ["finished", "needs_approval", "error"];

/** The runner's answer, or null when it isn't one. Notifications that are malformed are left out. */
export function parseResponse(value: unknown): NotificationsResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const { notifications, latest } = value as Record<string, unknown>;
  if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < 0 || !Array.isArray(notifications)) return null;
  const good = notifications.filter((n): n is Notification => {
    if (typeof n !== "object" || n === null) return false;
    const o = n as Record<string, unknown>;
    return (
      typeof o.seq === "number" && Number.isSafeInteger(o.seq) && o.seq > 0 && KINDS.includes(o.kind as string) &&
      typeof o.sessionId === "string" && o.sessionId !== "" && typeof o.title === "string" && typeof o.body === "string"
    );
  });
  return { notifications: good, latest };
}

/**
 * One poll's outcome: the next state and the notifications to show, oldest first.
 * - A failed poll (null) changes nothing: the same `after` is asked again.
 * - The first answer shows nothing and only takes `latest`, so what was recorded before the shell
 *   started doesn't replay.
 * - A `latest` below `after` means the runner restarted and counts from 1 again: everything it has
 *   recorded since is new, so the next poll asks from 0.
 */
export function step(state: PollState, response: NotificationsResponse | null): { state: PollState; show: Notification[] } {
  if (!response) return { state, show: [] };
  if (state.after === null) return { state: { ...state, after: response.latest }, show: [] };
  const after = state.after;
  if (response.latest < after) return { state: { ...state, after: 0 }, show: [] };
  const fresh = response.notifications.filter((n) => n.seq > after).sort((a, b) => a.seq - b.seq);
  const show = fresh.slice(-MAX_TOASTS);
  return {
    state: { after: Math.max(response.latest, fresh.at(-1)?.seq ?? 0), lastSession: show.at(-1)?.sessionId ?? state.lastSession },
    show,
  };
}

/** What the toast says. */
export function toastOf(n: Pick<Notification, "title" | "body">): { title: string; body: string } {
  const title = n.title.trim();
  return { title: title ? `intuition: ${title}` : "intuition", body: n.body };
}
