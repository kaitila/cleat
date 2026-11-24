// Managing sessions from the pages (D0020): which sessions a list shows and in what order, what a
// session's menu offers, what the delete confirmation says, the runner's routes, and two small DOM
// pieces both pages use: the menu and the inline rename. Shared by chat.js and dock.js.
// The pure parts have no DOM and no network, so they are unit tested with bun (test/web/).
// Titles are untrusted: they reach the page only as textContent and input values.
import { byActivity } from "./chat-format.js";

/** Pinned sessions first, then the newest activity first. */
export function ordered(sessions) {
  const all = byActivity(sessions);
  return [...all.filter((s) => s.pinned === true), ...all.filter((s) => s.pinned !== true)];
}

/**
 * The sessions a list shows: the archived ones or the others (`archived`), in one workspace or all
 * (`workspace`, "" for all), and those whose title or workspace has every word of `query`, ignoring case.
 */
export function visible(sessions, { archived = false, workspace = "", query = "" } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return ordered(
    [...sessions].filter((s) => {
      if ((s.archived === true) !== archived) return false;
      if (workspace && s.workspace !== workspace) return false;
      const hay = `${s.title ?? ""} ${s.workspace ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }),
  );
}

/** The workspaces the sessions are in, by name. */
export function workspacesOf(sessions) {
  return [...new Set([...sessions].map((s) => s.workspace).filter((w) => typeof w === "string" && w))].sort((a, b) => a.localeCompare(b));
}

/**
 * The chat view's sidebar, grouped by workspace (D0033): [{ workspace, sessions }]. Each group is in
 * `ordered` order (pinned first, then the newest); the groups by their newest session, pinned or not.
 */
export function grouped(sessions) {
  const groups = new Map();
  for (const s of byActivity(sessions)) {
    const w = typeof s.workspace === "string" ? s.workspace : "";
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(s);
  }
  return [...groups].map(([workspace, list]) => ({ workspace, sessions: ordered(list) }));
}

/**
 * True when the sidebar draws a heading over each group: more than one workspace among the sessions
 * of the list shown (archived or not), and no workspace chosen in the filter.
 */
export function showHeadings(sessions, { archived = false, workspace = "" } = {}) {
  if (workspace) return false;
  return workspacesOf(visible(sessions, { archived })).length > 1;
}

/**
 * Whether a group is drawn folded. With no headings nothing is. While a search is typed the groups
 * start unfolded, and a heading folds only for that search (`searchFolded`); otherwise the
 * remembered folds count (`folded`).
 */
export function isFolded(workspace, { folded, searchFolded, query = "", headings = true }) {
  if (!headings) return false;
  return query.trim() ? searchFolded.has(workspace) : folded.has(workspace);
}

/** Where the folded workspaces are remembered, per browser. */
export const FOLDED_KEY = "holm.chat.folded";

/** The workspaces folded last time, from `storage` (localStorage); none when it can't be read. */
export function readFolded(storage) {
  try {
    const list = JSON.parse(storage?.getItem(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((w) => typeof w === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remembers the folded workspaces; a storage that refuses is left alone (the folds last the page). */
export function writeFolded(storage, folded) {
  try {
    if (folded.size) storage?.setItem(FOLDED_KEY, JSON.stringify([...folded].sort()));
    else storage?.removeItem(FOLDED_KEY);
  } catch {
    // Private window or storage off: nothing to keep.
  }
}

/** A turn the runner runs (not one arriving from a terminal): the person may stop it. */
export function canStop(session) {
  return (session?.status === "running" || session?.status === "waiting_approval") && session.terminalTurn !== true;
}

/** Not while a turn runs, here or in a terminal. */
function settled(session) {
  return session?.status === "idle" || session?.status === "error";
}

/** Only a session holm started, and not while a turn runs. One from the terminal is only archived. */
export function canDelete(session) {
  return session?.source !== "terminal" && settled(session);
}

/** A fork needs a conversation (a Claude Code session id) that is not mid-turn. */
export function canFork(session) {
  return Boolean(session?.claudeSessionId) && settled(session);
}

/**
 * What a session's menu offers, in order: { action, label }. `full` is the chat view's (with Fork and
 * Delete); the dock's is Rename, Pin and Archive.
 */
export function menuItems(session, full = true) {
  const items = [
    { action: "rename", label: "Rename" },
    { action: "pin", label: session?.pinned ? "Unpin" : "Pin" },
  ];
  if (full) items.push({ action: "fork", label: "Fork", disabled: !canFork(session) });
  items.push({ action: "archive", label: session?.archived ? "Unarchive" : "Archive" });
  if (full && session?.source !== "terminal") items.push({ action: "delete", label: "Delete", disabled: !canDelete(session), danger: true });
  return items;
}

/** The confirmation before a delete: what goes, and that it can't come back. */
export function deleteConfirm(session) {
  const title = session?.title || "Untitled";
  return {
    title: `Delete “${title}”?`,
    body:
      "This removes the session from holm (its messages here) and deletes its Claude Code transcript, " +
      "so claude --resume no longer lists it. It can't be undone. To keep it out of the way instead, archive it.",
    confirm: "Delete",
  };
}

/** What the line under the list says after an archive, with Undo beside it. */
export function archivedLine(session) {
  return `Archived “${session?.title || "Untitled"}”.`;
}

/** How long the archive line (and its Undo) stays. */
export const UNDO_MS = 6000;

async function errorOf(res) {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: the status says enough.
  }
  return `the runner answered ${res.status}`;
}

/**
 * POST /api/sessions/:id/<action> (rename, archive, pin, stop, fork, delete). Resolves with the
 * answer's body; throws an Error whose message says why, for a refusal or an unreachable runner.
 */
export async function manage(id, action, body = {}) {
  let res;
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("the runner is not reachable");
  }
  if (!res.ok) throw new Error(await errorOf(res));
  return res.json();
}

/**
 * A small menu that floats over the page: `open(items, at, pick)` shows it at a point ({ x, y } in
 * the page) or under an element, and calls `pick(action)` for the item chosen. Arrow keys move,
 * Enter picks, Esc and a press elsewhere close it. `within` is the element it must stay inside.
 */
export function sessionMenu(document, within = document.body) {
  const el = document.createElement("div");
  el.className = "menu glass-float";
  el.setAttribute("role", "menu");
  el.hidden = true;
  within.append(el);
  let onPick = null;
  let back = null;
  const buttons = () => [...el.querySelectorAll("button:not([disabled])")];
  const close = (refocus = true) => {
    if (el.hidden) return;
    el.hidden = true;
    onPick = null;
    if (refocus && back?.isConnected) back.focus();
    back = null;
  };
  el.addEventListener("keydown", (e) => {
    const all = buttons();
    const at = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
      all[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!el.hidden && !el.contains(e.target)) close(false);
  }, true);
  return {
    el,
    /** True while the menu is shown. */
    get isOpen() {
      return !el.hidden;
    },
    close,
    open(items, at, pick) {
      el.replaceChildren();
      for (const item of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `menu-item quiet${item.danger ? " danger" : ""}`;
        b.setAttribute("role", "menuitem");
        b.dataset.action = item.action;
        b.textContent = item.label;
        b.disabled = item.disabled === true;
        b.addEventListener("click", () => {
          const chosen = onPick;
          close();
          chosen?.(item.action);
        });
        el.append(b);
      }
      onPick = pick;
      back = document.activeElement;
      el.hidden = false;
      // Placed inside `within`, kept from running off its edges.
      const box = within.getBoundingClientRect();
      const point = at instanceof Element ? (() => { const r = at.getBoundingClientRect(); return { x: r.right - el.offsetWidth, y: r.bottom }; })() : at;
      const x = Math.max(0, Math.min(point.x - box.left, within.clientWidth - el.offsetWidth));
      const y = Math.max(0, Math.min(point.y - box.top, within.clientHeight - el.offsetHeight));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      buttons()[0]?.focus();
    },
  };
}

/**
 * Turns a title element into an input in place: Enter or leaving it saves (`save(title)`, only when
 * it changed and isn't empty), Esc puts the title back. Resolves when it is done.
 */
export function renameInline(document, titleEl, current, save) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.className = "input rename";
    input.type = "text";
    input.value = current;
    input.maxLength = 200;
    input.setAttribute("aria-label", "Session title");
    titleEl.hidden = true;
    titleEl.after(input);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      input.remove();
      titleEl.hidden = false;
      if (keep && title && title !== current) void save(title);
      resolve();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    // A click in the input doesn't follow the row's link.
    input.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  });
}
