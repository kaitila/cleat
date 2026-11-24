// Pure logic for the dock: no DOM, no network, so it is unit tested with bun (test/web/dock.test.ts).
// dock.js draws what these return. The contract with the shell is docs/protocol.md, "Dock".
import { byActivity } from "./chat-format.js";
import { commandDigit, commandK, MAC } from "./keys.js";

/**
 * The most the island covers in each state, hanging from the top centre of the window: the same
 * numbers as the shell's DOCK_SIZES. The shell takes the mouse only inside this rectangle, so the
 * island is never drawn outside it. Idle is as narrow as its text, open as short as its content.
 * Chat is the chat view, the notch grown large (D0042): this size when the shell tells none
 * (`?chat=WxH`, parseChat).
 */
export const DOCK_SIZES = {
  idle: { width: 128, height: 22 },
  peek: { width: 380, height: 40 },
  open: { width: 460, height: 480 },
  chat: { width: 960, height: 680 },
};

/** The shell's window for a chat size: as large as the largest state, for the dock's whole life. The same as the shell's dockWindow. */
export function dockWindow(chat = DOCK_SIZES.chat) {
  return { width: Math.max(DOCK_SIZES.open.width, chat.width), height: Math.max(DOCK_SIZES.open.height, chat.height) };
}
/** The window for the chat's default size: the same numbers as the shell's DOCK_WINDOW. */
export const DOCK_WINDOW = dockWindow();

/**
 * The chat's size the shell worked out for its display, from the page's query (`?chat=912x726`, in
 * CSS pixels), or null: none, or one smaller than the open dock or larger than any screen.
 */
export function parseChat(search) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(new URLSearchParams(search).get("chat") ?? "");
  if (!m) return null;
  const chat = { width: Number(m[1]), height: Number(m[2]) };
  const fits = (v, least) => v >= least && v <= 4000;
  return fits(chat.width, DOCK_SIZES.open.width) && fits(chat.height, DOCK_SIZES.open.height) ? chat : null;
}

/**
 * Beside a Mac's notch, a wing on each side shows the idle pill's dot (left) and words (right): the
 * notch hides what is drawn under it. The same number as the shell's NOTCH_WING.
 */
export const NOTCH_WING = 76;

/**
 * The notch the shell measured, from the page's query (`?notch=179x32`, in CSS pixels), or null: no
 * notch, or a value that is not a sensible one.
 */
export function parseNotch(search) {
  const m = /^(\d{2,3})x(\d{2})$/.exec(new URLSearchParams(search).get("notch") ?? "");
  if (!m) return null;
  const notch = { width: Number(m[1]), height: Number(m[2]) };
  return notch.width >= 40 && notch.width <= 400 && notch.height >= 16 && notch.height <= 64 ? notch : null;
}

/**
 * The most the island covers in each state, with a notch or without one. With one, it hangs from the
 * notch: idle is the notch and its wings at the notch's height, peek the peek's line below the
 * notch's band, open as before. The same as the shell's dockSizes.
 */
export function dockSizes(notch, chat = DOCK_SIZES.chat) {
  if (!notch) return { ...DOCK_SIZES, chat };
  const idle = { width: notch.width + 2 * NOTCH_WING, height: notch.height };
  return {
    idle,
    peek: { width: Math.max(DOCK_SIZES.peek.width, idle.width), height: notch.height + DOCK_SIZES.peek.height },
    open: DOCK_SIZES.open,
    chat,
  };
}

/** The pill with nothing going on is shorter still: a dot in a sliver. */
export const QUIET_HEIGHT = 16;

/** How long a peek shows, unless it waits for an approval. */
export const PEEK_MS = 5000;
/** How long the pointer rests on the island before it opens: a pointer that brushes past the top edge opens nothing. */
export const OPEN_MS = 80;
/** How long after the pointer left the open dock closes. */
export const CLOSE_MS = 400;
/** The most peeks that wait their turn: older ones are dropped. */
export const PEEK_MAX = 5;
/** How many of a session's newest events the open dock draws. */
export const RECENT_EVENTS = 30;

const KINDS = ["finished", "needs_approval", "error"];

/**
 * The island's rectangle in a state, inside the window: the same as the shell's islandRect. With a
 * notch, idle's is the notch alone: the wings let clicks through to the menu bar.
 */
export function islandRect(state, notch = null, chat = DOCK_SIZES.chat) {
  const { width, height } = state === "idle" && notch ? notch : dockSizes(notch, chat)[state];
  return { x: (dockWindow(chat).width - width) / 2, y: 0, width, height };
}

/**
 * The size the island is drawn at: never more than the state's rectangle. Idle is as wide as the
 * pill's content (`measured.pill`, in pixels) and at least as wide as it is tall, and shorter with nothing going on
 * (`measured.quiet`); open is as tall
 * as the panel's content (`measured.panel`); peek and chat are exactly their rectangles.
 */
export function islandSize(state, measured, notch = null, chat = DOCK_SIZES.chat) {
  const sizes = dockSizes(notch, chat);
  const most = sizes[state];
  const fit = (value, least, limit) => Math.min(limit, Math.max(least, Math.ceil(Number.isFinite(value) ? value : 0)));
  // With a notch, idle is the notch itself when nothing goes on (black on black: nothing shows), else the notch and its wings.
  if (state === "idle" && notch) return measured?.quiet ? { width: notch.width, height: notch.height } : { ...most };
  if (state === "idle") {
    const height = measured?.quiet ? Math.min(QUIET_HEIGHT, most.height) : most.height;
    return { width: fit(measured?.pill, height, most.width), height };
  }
  if (state === "open") return { width: most.width, height: fit(measured?.panel, sizes.peek.height, most.height) };
  return { ...most };
}

/**
 * Whether a point is on the island: `x` from the island's middle, `y` from the top edge. On what
 * is drawn (`drawn`), and, closed, anywhere in the state's rectangle, which is where the shell
 * takes the mouse: the dot of a quiet pill is small, its rectangle is the handle.
 */
export function onIsland(state, drawn, x, y, notch = null, chat = DOCK_SIZES.chat) {
  const inside = (size) => y >= 0 && y < size.height && Math.abs(x) <= size.width / 2;
  // Idle under a notch: the notch is the handle, as the shell takes the mouse there only.
  if (state === "idle" && notch) return inside(notch);
  return inside(drawn) || (state !== "open" && inside(dockSizes(notch, chat)[state]));
}

/**
 * What a click on the island does (D0042): "chat" grows it into the chat, "down" steps the chat back
 * down to the open dock, null leaves it to what was clicked. One click from the notch: on the pill or
 * the peek; on the open dock, on the notch's band above its head or on the head itself, but not on
 * one of the head's controls (`control`); on the chat, the notch's band steps it back down. `y` is
 * from the island's top edge; `head`: the click was on the open dock's head.
 */
export function clickAction(state, { y, head = false, control = false }, notch = null) {
  const band = notch !== null && y >= 0 && y < notch.height;
  if (state === "idle" || state === "peek") return "chat";
  if (state === "open") return !control && (band || head) ? "chat" : null;
  if (state === "chat") return band ? "down" : null;
  return null;
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
 * (a selection dragged out of it), and while the reply box has the focus or text in it. A focus
 * the dock gave the box itself, on opening, is not the person's, and text counts only while the
 * dock has the keyboard: dock.js does not count either.
 */
export function mayClose({ pointerInside, pointerDown, replyFocused, replyText }) {
  return !pointerInside && !pointerDown && !replyFocused && !(replyText ?? "").trim();
}

/**
 * The session the dock opens on: the one peeking now; else the one that peeked last, since the dock
 * was last open (news the person may be opening it for); else the one it was last left on
 * (`remembered`), while it is listed; else the newest that waits for approval; else the newest.
 */
export function preselect(sessions, peeking, lastPeeked, remembered = null) {
  const ordered = byActivity(sessions);
  const has = (id) => typeof id === "string" && ordered.some((s) => s.id === id);
  if (has(peeking)) return peeking;
  if (has(lastPeeked)) return lastPeeked;
  if (has(remembered)) return remembered;
  const waiting = ordered.find((s) => s.status === "waiting_approval");
  if (waiting) return waiting.id;
  return ordered[0]?.id ?? null;
}

/** The newest events of a session: all the open dock draws of it. */
export function recentEvents(events, max = RECENT_EVENTS) {
  return events.slice(Math.max(0, events.length - max));
}

/** Where the open dock keeps the session it was last left on (localStorage), to open on it again. */
export const SESSION_KEY = "intuition.dock.session";

/** The session the dock was last left on, from `storage` (localStorage); null when there is none or it can't be read. */
export function savedSession(storage) {
  try {
    const value = storage?.getItem(SESSION_KEY);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the session shown, for the next opening. Nothing to remember (null) forgets it. */
export function saveSession(storage, id) {
  try {
    if (id) storage?.setItem(SESSION_KEY, id);
    else storage?.removeItem(SESSION_KEY);
  } catch {
    // Not remembered: the dock opens on its usual pick.
  }
}

/**
 * What a key does in the open dock, or null (D0040). ⌘K (Ctrl+K off a Mac) opens or closes the
 * switch ({ find: true }); ⌘1..9 shows the session in that row of the switch ({ nth: 1..9 });
 * Ctrl+Tab and Ctrl+Shift+Tab, and Alt+Down and Alt+Up, the next or the one before ({ step }).
 * Never Alt with a digit: on a Finnish or German Mac, Option+2 is @.
 */
export function dockKey(event, mac = MAC) {
  if (!event || event.isComposing) return null;
  if (commandK(event, mac)) return { find: true };
  const nth = commandDigit(event, mac);
  if (nth !== null) return { nth };
  if (event.key === "Tab" && event.ctrlKey && !event.altKey && !event.metaKey) return { step: event.shiftKey ? -1 : 1 };
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowUp") return { step: -1 };
  if (event.key === "ArrowDown") return { step: 1 };
  return null;
}

/** A session at work: running a turn, or waiting for the person. */
export const isLive = (session) => session?.status === "waiting_approval" || session?.status === "running";

/**
 * The open dock's order of sessions (its switch, ⌘1..9, the steps): the ones that wait for the
 * person first, then the running ones, then the rest as they come (`list` is already pinned first,
 * then the newest: chat-manage.js, visible). So what needs a look is always at the top.
 */
export function dockOrder(list) {
  const rank = (s) => (s.status === "waiting_approval" ? 0 : s.status === "running" ? 1 : 2);
  return [...list].map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
}

/** The head's other sessions at work, beside the one shown: in the dock's order, at most `max`. */
export function liveOthers(order, selected, max = LIVE_MAX) {
  return order.filter((s) => s.id !== selected && isLive(s)).slice(0, max);
}
/** The head shows this many other sessions at work at most, as chips; the switch shows them all. */
export const LIVE_MAX = 2;

/** The session `step` rows from `current` in the list `ids`, stopping at either end; from outside the list, the first (down) or the last (up). */
export function stepSession(ids, current, step) {
  if (ids.length === 0) return null;
  const at = ids.indexOf(current);
  if (at === -1) return step > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}

/** Where the open dock keeps the workspace it shows (localStorage): "" or absent for all of them. */
export const WORKSPACE_KEY = "intuition.dock.workspace";

/** The workspace the dock was last left on, from `storage` (localStorage); "" for all, or when it can't be read. */
export function savedWorkspace(storage) {
  try {
    const value = storage?.getItem(WORKSPACE_KEY);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Remembers the workspace chosen ("" for all). Storage that refuses (a private window) only forgets. */
export function saveWorkspace(storage, workspace) {
  try {
    if (workspace) storage?.setItem(WORKSPACE_KEY, workspace);
    else storage?.removeItem(WORKSPACE_KEY);
  } catch {
    // Not remembered: the dock still filters until it is reloaded.
  }
}

/**
 * The workspace switch's choices after "All workspaces": each workspace that has a session the dock
 * lists (archived ones are out of the way), by name, and the one chosen even when none is left in it.
 */
export function dockWorkspaces(sessions, chosen = "") {
  const names = new Set();
  for (const s of sessions) if (s.archived !== true && typeof s.workspace === "string" && s.workspace) names.add(s.workspace);
  if (chosen) names.add(chosen);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The sessions of one workspace, or all of them for "". */
export function inWorkspace(sessions, workspace) {
  return workspace ? [...sessions].filter((s) => s.workspace === workspace) : [...sessions];
}
