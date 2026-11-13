// Pure logic for the dock: no DOM, no network, so it is unit tested with bun (test/web/dock.test.ts).
// dock.js draws what these return. The contract with the shell is docs/protocol.md, "Dock".
import { byActivity } from "./chat-format.js";

/** The window's exact size in each state, in CSS pixels: the same numbers as the shell's DOCK_SIZES. */
export const DOCK_SIZES = {
  idle: { width: 280, height: 40 },
  peek: { width: 420, height: 76 },
  open: { width: 460, height: 600 },
};
const RANK = { idle: 0, peek: 1, open: 2 };

/** How long a peek shows, unless it waits for an approval. */
export const PEEK_MS = 5000;
/** How long the pointer rests on the island before it opens: a pointer that only crosses it opens nothing. */
export const OPEN_MS = 120;
/** How long after the pointer left the open dock closes. */
export const CLOSE_MS = 400;
/** The most peeks that wait their turn: older ones are dropped. */
export const PEEK_MAX = 5;
/** How many of a session's newest events the open dock draws. */
export const RECENT_EVENTS = 30;

const KINDS = ["finished", "needs_approval", "error"];

/**
 * When to tell the shell about a change of state: "before" the island animates when the window has
 * to grow, "after" when it shrinks, "same" when the window is already that size.
 * `windowState` is what the shell was last told.
 */
export function resizeOrder(windowState, target) {
  const from = RANK[windowState] ?? 0;
  const to = RANK[target] ?? 0;
  return to > from ? "before" : to < from ? "after" : "same";
}

/**
 * What the idle pill says for a set of sessions: { tone, text, status, failed }.
 * `status` is the dot's data-status (null: no dot). A session that waits for approval wins over
 * running ones. `failed` is true when the newest session that finished its turn failed: the pill
 * says so when nothing else is going on, and marks it beside "2 running" otherwise.
 */
export function pillOf(sessions) {
  const all = [...sessions];
  const finished = byActivity(all.filter((s) => s.status === "idle" || s.status === "error"));
  const failed = finished[0]?.status === "error";
  if (all.some((s) => s.status === "waiting_approval")) return { tone: "needs", text: "needs you", status: "waiting_approval", failed };
  const running = all.filter((s) => s.status === "running").length;
  if (running > 0) return { tone: "running", text: `${running} running`, status: "running", failed };
  if (failed) return { tone: "failed", text: "failed", status: "error", failed };
  return { tone: "none", text: "intuition", status: null, failed };
}

/** A notification from the WebSocket, or null when it isn't one the dock can show. */
export function asPeek(notification) {
  if (typeof notification !== "object" || notification === null) return null;
  const { kind, sessionId, title, body } = notification;
  if (!KINDS.includes(kind) || typeof sessionId !== "string" || !sessionId) return null;
  return { kind, sessionId, title: typeof title === "string" && title ? title : "Untitled", body: typeof body === "string" ? body : "" };
}

/**
 * The queue with one more peek, newest last. A session's newer peek replaces its older one that
 * still waits (finished after needs approval: only the end is worth showing), and only the newest
 * `max` wait.
 */
export function enqueue(queue, peek, max = PEEK_MAX) {
  const next = [...queue.filter((p) => p.sessionId !== peek.sessionId), peek];
  return next.slice(Math.max(0, next.length - max));
}

/** A peek for an approval is worth showing only while its session still waits for one. */
function stale(peek, sessions) {
  if (peek.kind !== "needs_approval") return false;
  return [...sessions].find((s) => s.id === peek.sessionId)?.status !== "waiting_approval";
}

/** The next peek to show and what stays queued: { peek, queue }. `peek` is null when nothing waits. */
export function nextPeek(queue, sessions) {
  const all = [...sessions];
  const rest = [...queue];
  while (rest.length) {
    const peek = rest.shift();
    if (!stale(peek, all)) return { peek, queue: rest };
  }
  return { peek: null, queue: rest };
}

/**
 * Whether the peek on show is over: after five seconds, except one for an approval, which stays
 * until its session no longer waits (answered here, in the chat view, or its turn ended).
 */
export function peekOver(peek, sessions, shownMs) {
  if (peek.kind === "needs_approval") return stale(peek, sessions);
  return shownMs >= PEEK_MS;
}

/** The word beside a peek's title. */
export function peekLabel(kind) {
  return kind === "needs_approval" ? "needs you" : kind === "error" ? "failed" : "done";
}

/** The dot of a peek, as a session status. */
export function peekStatus(kind) {
  return kind === "needs_approval" ? "waiting_approval" : kind === "error" ? "error" : "idle";
}

/**
 * Whether the open dock may close now. It stays open while the pointer is on it or held down
 * (a selection dragged out of it), and while the reply box has the focus or text in it.
 */
export function mayClose({ pointerInside, pointerDown, replyFocused, replyText }) {
  return !pointerInside && !pointerDown && !replyFocused && !(replyText ?? "").trim();
}

/**
 * The session the dock opens on: the one peeking now; else the newest that waits for approval;
 * else the one that peeked last, since the dock was last open; else the newest.
 */
export function preselect(sessions, peeking, lastPeeked) {
  const ordered = byActivity(sessions);
  const has = (id) => typeof id === "string" && ordered.some((s) => s.id === id);
  if (has(peeking)) return peeking;
  const waiting = ordered.find((s) => s.status === "waiting_approval");
  if (waiting) return waiting.id;
  if (has(lastPeeked)) return lastPeeked;
  return ordered[0]?.id ?? null;
}

/** The newest events of a session: all the open dock draws of it. */
export function recentEvents(events, max = RECENT_EVENTS) {
  return events.slice(Math.max(0, events.length - max));
}
