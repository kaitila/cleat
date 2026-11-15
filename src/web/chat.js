// The chat view: sessions in the sidebar, the selected one's events as a stream, a reply box.
// The contract is docs/protocol.md. Text from the model, from tools and from the person is untrusted:
// it reaches the page only as text nodes (textContent), never as markup.
import {
  approvalView,
  backoffMs,
  cutResult,
  decidedLabel,
  inputText,
  isOpenInTerminal,
  OPEN_IN_TERMINAL_HINT,
  pickSession,
  relativeTime,
  replyState,
  resultLine,
  sessionStatus,
  startedInTerminal,
  TERMINAL_MARK_TITLE,
  toolSummary,
  unknownNote,
} from "./chat-format.js";
import { archivedLine, canStop, deleteConfirm, manage, menuItems, renameInline, sessionMenu, UNDO_MS, visible, workspacesOf } from "./chat-manage.js";
import { resumeControl } from "./chat-resume.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const els = {
  sessions: $("sessions"),
  sessionsEmpty: $("sessions-empty"),
  connection: $("connection"),
  head: $("head"),
  title: $("title"),
  dot: $("dot"),
  workspace: $("workspace"),
  status: $("status"),
  scroller: $("scroller"),
  stream: $("stream"),
  empty: $("empty"),
  reply: $("reply"),
  text: $("reply-text"),
  hint: $("reply-hint"),
  meta: $("meta"),
  search: $("search"),
  workspaceFilter: $("workspace-filter"),
  archivedView: $("archived-view"),
  undo: $("undo"),
  stop: $("stop"),
  confirm: $("confirm"),
  confirmTitle: $("confirm-title"),
  confirmBody: $("confirm-body"),
  confirmOk: $("confirm-ok"),
  main: document.querySelector(".main"),
};
const resume = resumeControl(document);
els.meta.append(resume.el);

/** An element with a class and text. The text is set as textContent, so it is never parsed. */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** id -> SessionMeta, as last told by the runner. */
const sessions = new Map();
/** id -> { link, dot, title, workspace, time } in the sidebar. */
const rows = new Map();
let selected = null;
/** Goes up with every selection, so an answer that arrives for an earlier one is dropped. */
let generation = 0;
/** seq of the newest event of the selected session that is on the page. */
let lastSeq = 0;
let loading = false;
let loadAgain = false;
/** toolUseId -> the parts of its <details>, to put the result into. */
const tools = new Map();
/** approvalId -> its card in the stream: { el, actions, error, buttons, decided }. */
const approvals = new Map();
/** sessionId -> assistant text streamed so far and not yet replaced by its assistant_text event. */
const streamed = new Map();
let streamedEl = null;
let loadErrorEl = null;
/** sessionId -> a reply typed but not sent, kept while another session is looked at. */
const typed = new Map();
let sending = false;
let replyError = "";
/** The session whose last reply was refused as open in a terminal: its hint offers "Send anyway". */
let openElsewhere = null;
let wantFocus = true;
/** True while the person is at the bottom of the stream: new events keep it there. */
let stick = true;
let followQueued = false;
/** What the sidebar lists: the archived sessions or the others, one workspace or all, and the search. */
const view = { archived: false, workspace: "", query: "" };
const menu = sessionMenu(document);

// ---------- the stream ----------

function follow() {
  if (!stick || followQueued) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
  });
}

els.scroller.addEventListener("scroll", () => {
  stick = els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 48;
});

/**
 * True while an event that just happened is drawn, not one loaded with the rest of a session: what
 * it adds rises in (chat.css, .arrive).
 */
let live = false;

/**
 * Adds to the end of the stream, above the text that is still streaming. `still`: text that takes
 * the place of the same text streamed, which doesn't rise in again.
 */
function add(el, still = false) {
  if (live && !still) el.classList.add("arrive");
  els.stream.insertBefore(el, streamedEl?.parentNode === els.stream ? streamedEl : null);
  follow();
  return el;
}

function renderText(el, text, streaming = false) {
  el.replaceChildren(renderMarkdown(text, document, { streaming }));
}

let streamQueued = false;

/** Deltas come faster than frames: the streaming text is drawn again at most once a frame. */
function streamSoon(rising = false) {
  if (streamQueued) return;
  streamQueued = true;
  requestAnimationFrame(() => {
    streamQueued = false;
    live = rising && selected !== null;
    try {
      renderStreamed();
    } finally {
      live = false;
    }
  });
}

/** Shows (or removes) the selected session's streaming text as the last thing in the stream. */
function renderStreamed() {
  const text = selected ? streamed.get(selected) : undefined;
  if (!text) {
    streamedEl?.remove();
    streamedEl = null;
    return;
  }
  if (!streamedEl) streamedEl = h("div", `msg assistant md streaming${live ? " arrive" : ""}`);
  renderText(streamedEl, text, true);
  if (streamedEl.parentNode !== els.stream) els.stream.append(streamedEl);
  follow();
}

function toolCard(toolUseId, name, input) {
  const details = h("details", "tool");
  details.dataset.toolUseId = toolUseId;
  const summary = h("summary");
  const mark = h("span", "tool-mark small");
  summary.append(h("span", "tool-name", name), h("span", "tool-line mono", toolSummary(name, input)), mark);
  const body = h("div", "tool-body");
  const result = h("pre", "tool-result well muted", "Waiting for the result.");
  body.append(h("div", "label", "Input"), h("pre", "tool-input well", inputText(input, 2)), h("div", "label", "Result"), result);
  details.append(summary, body);
  summary.addEventListener("click", (e) => {
    e.preventDefault();
    toggleTool(details, body);
  });
  const tool = { details, body, result, mark, done: false };
  tools.set(toolUseId, tool);
  add(details);
  return tool;
}

function toolResult(event) {
  const tool = tools.get(event.toolUseId) ?? toolCard(event.toolUseId, "Tool result", undefined);
  const content = typeof event.content === "string" ? event.content : inputText(event.content, 2);
  const { text, cut } = cutResult(content);
  tool.done = true;
  tool.result.classList.toggle("muted", content === "");
  tool.result.textContent = content === "" ? "No output." : text;
  tool.body.querySelector(".show-all")?.remove();
  if (cut) {
    showAll(tool.result, content, tool.body);
  }
  if (event.isError) {
    tool.details.dataset.error = "true";
    tool.mark.textContent = "failed";
  }
  follow();
}

/** A turn that ended leaves no call waiting: one without a result says so. */
function endOpenTools() {
  for (const tool of tools.values()) {
    if (!tool.done) tool.result.textContent = "No result.";
    tool.done = true;
  }
}

// ---------- motion ----------

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** A spring of base.css as an animation's timing: its curve and the duration that goes with it. */
function spring(name) {
  const style = getComputedStyle(document.documentElement);
  return { easing: style.getPropertyValue(`--ease-${name}`).trim(), duration: parseFloat(style.getPropertyValue(`--dur-${name}`)) };
}

/**
 * Changes the stream's layout with `change` and lets what comes after `el` glide to its new place
 * on a spring (a FLIP: drawn where it was with a transform, which then goes). Only what is in view
 * moves; with reduced motion, nothing does.
 */
function flipAfter(el, change, name) {
  if (reducedMotion.matches) return change();
  const view = els.scroller.getBoundingClientRect();
  const before = new Map();
  for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
    const box = next.getBoundingClientRect();
    if (box.top > view.bottom) break;
    before.set(next, box.top);
  }
  change();
  const timing = spring(name);
  for (const [next, top] of before) {
    const dy = top - next.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) next.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing);
  }
}

/**
 * Opens or closes a tool row. Opening, its body springs in (chat.css, .tool[open] > .tool-body)
 * while the rows below it glide down; closing, the body fades out first, then the rows below
 * gather up on the softer spring.
 */
function toggleTool(details, body) {
  if (details.dataset.closing !== undefined) return;
  if (!details.open) {
    flipAfter(details, () => (details.open = true), "bouncy");
    return;
  }
  details.dataset.closing = "";
  const done = () => {
    delete details.dataset.closing;
    flipAfter(details, () => (details.open = false), "gentle");
  };
  if (reducedMotion.matches) return done();
  const end = (e) => {
    if (e.target !== body || e.animationName !== "fade-out") return;
    body.removeEventListener("animationend", end);
    done();
  };
  body.addEventListener("animationend", end);
}

/**
 * Selecting another session: a copy of the stream as it was, over the new one, fades away, while
 * the new one and its head fade in (chat.css, .stream-leaving and .entering).
 */
function crossFade() {
  els.main.querySelector(".stream-leaving")?.remove();
  for (const el of [els.stream, els.head]) {
    el.classList.remove("entering");
    void el.offsetWidth;
    el.classList.add("entering");
  }
  if (els.stream.childElementCount === 0) return;
  const copy = els.stream.cloneNode(true);
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  for (const el of copy.querySelectorAll(".arrive")) el.classList.remove("arrive");
  copy.style.translate = `0 ${-els.scroller.scrollTop}px`;
  const ghost = h("div", "stream-leaving");
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.top = `${els.scroller.offsetTop}px`;
  ghost.style.height = `${els.scroller.clientHeight}px`;
  ghost.append(copy);
  ghost.addEventListener("animationend", () => ghost.remove(), { once: true });
  els.main.append(ghost);
}

/** A cut text with a "show all" button after it, as a tool result has. */
function showAll(pre, full, parent) {
  const all = h("button", "show-all quiet small", "Show all");
  all.type = "button";
  all.addEventListener("click", () => {
    pre.textContent = full;
    all.remove();
  });
  parent.append(all);
}

/**
 * A tool call that waits for the person: what it is about to do, and Allow and Deny. The answer is
 * sent to the runner; the card changes when the runner's approval_resolved event arrives.
 */
function approvalCard(event) {
  const sessionId = selected;
  const el = h("section", "approval");
  el.dataset.approvalId = event.approvalId;
  el.dataset.state = "open";
  el.setAttribute("aria-label", "Approval needed");
  const head = h("div", "approval-head");
  const state = h("span", "approval-state small", "Needs your approval");
  head.append(h("span", "approval-tool", String(event.toolName ?? "Tool")), state);
  el.append(head);
  const view = approvalView(event.toolName, event.input);
  if (view.path) el.append(h("div", "approval-path mono", view.path));
  if (view.text) {
    const pre = h("pre", "approval-input well", view.text);
    el.append(pre);
    if (view.text.length < view.full.length) showAll(pre, view.full, el);
  }
  if (typeof event.reason === "string" && event.reason) el.append(h("div", "approval-reason muted small", event.reason));
  const actions = h("div", "approval-actions");
  const allow = h("button", "primary", "Allow");
  const deny = h("button", "", "Deny");
  const error = h("span", "approval-error muted small");
  error.setAttribute("role", "status");
  const buttons = [allow, deny];
  const answer = async (decision) => {
    for (const b of buttons) b.disabled = true;
    error.textContent = "";
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(event.approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.status === 404) throw new Error("this approval is no longer open");
      if (!res.ok) throw new Error(await errorText(res));
      // The buttons stay off: approval_resolved follows on the WebSocket and replaces them.
    } catch (e) {
      error.textContent = `Couldn't send: ${e instanceof TypeError ? "the runner is not reachable" : e.message}`;
      for (const b of buttons) b.disabled = false;
    }
  };
  allow.type = deny.type = "button";
  allow.addEventListener("click", () => void answer("allow"));
  deny.addEventListener("click", () => void answer("deny"));
  actions.append(allow, deny, error);
  el.append(actions);
  approvals.set(event.approvalId, { el, actions, state });
  add(el);
}

/** The card after its answer: what was decided, and no buttons. `decision` undefined: nobody answered. */
function approvalDecided(card, decision) {
  if (card.el.dataset.state !== "open") return;
  card.el.dataset.state = decision === "allow" || decision === "deny" ? decision : "unanswered";
  card.el.removeAttribute("aria-label");
  card.state.textContent = decidedLabel(decision);
  card.actions.remove();
  follow();
}

/** A turn that ended leaves no approval to answer. */
function endOpenApprovals() {
  for (const card of approvals.values()) approvalDecided(card, undefined);
}

/** Draws one stored event. Events arrive in seq order; one already on the page is skipped. */
function apply(event) {
  if (!event || typeof event.seq !== "number" || event.seq <= lastSeq) return;
  lastSeq = event.seq;
  switch (event.kind) {
    case "user": {
      const el = add(h("div", "msg user card"));
      el.append(h("div", "user-text", event.text));
      if (event.imagePath) el.append(h("div", "attachment mono muted", event.imagePath));
      break;
    }
    case "assistant_text":
      renderText(add(h("div", "msg assistant md"), streamedEl?.parentNode === els.stream), event.text);
      break;
    case "tool_use":
      toolCard(event.toolUseId, event.name, event.input);
      break;
    case "tool_result":
      toolResult(event);
      break;
    case "approval_request":
      approvalCard(event);
      break;
    case "approval_resolved": {
      const card = approvals.get(event.approvalId);
      if (card) approvalDecided(card, event.decision);
      break;
    }
    case "result":
      endOpenTools();
      endOpenApprovals();
      add(h("div", event.ok ? "note num muted small" : "note num error small", resultLine(event)));
      if (!event.ok && event.text) add(h("div", "error", event.text));
      break;
    case "error":
      endOpenTools();
      endOpenApprovals();
      add(h("div", "error", event.message));
      break;
    case "stopped":
      endOpenTools();
      endOpenApprovals();
      add(h("div", "note muted small", "Stopped"));
      break;
    default:
      add(h("div", "note muted small", unknownNote(event)));
  }
}

async function errorText(res) {
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: the status says enough.
  }
  return `the runner answered ${res.status}`;
}

/** Fetches the selected session's events after the newest one on the page (all of them at first). */
async function catchUp() {
  if (!selected) return;
  if (loading) {
    loadAgain = true;
    return;
  }
  loading = true;
  const id = selected;
  const mine = generation;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events${lastSeq ? `?after=${lastSeq}` : ""}`);
    if (mine !== generation) return;
    if (!res.ok) throw new Error(await errorText(res));
    const body = await res.json();
    if (mine !== generation) return;
    loadErrorEl?.remove();
    loadErrorEl = null;
    for (const event of body.events ?? []) apply(event);
    renderStreamed();
  } catch (e) {
    if (mine !== generation) return;
    loadErrorEl?.remove();
    loadErrorEl = add(h("div", "note muted small", `Couldn't load this session: ${e instanceof TypeError ? "the runner is not reachable" : e.message}`));
  } finally {
    loading = false;
    if (loadAgain) {
      loadAgain = false;
      void catchUp();
    }
  }
}

// ---------- the sidebar and the head ----------

function wanted() {
  return new URLSearchParams(location.search).get("session");
}

/** The session the URL asks for if there is one (archived too), else the first the sidebar lists. */
function pickFor(wantedId) {
  if (wantedId && sessions.has(wantedId)) return wantedId;
  return pickSession(visible(sessions.values(), { ...view, workspace: "", query: "" }), null);
}

function renderSidebar() {
  const ordered = visible(sessions.values(), view);
  const shown = new Set(ordered.map((s) => s.id));
  for (const id of [...rows.keys()]) {
    if (!shown.has(id)) {
      rows.get(id).item.remove();
      rows.delete(id);
    }
  }
  const now = Date.now();
  ordered.forEach((session, i) => {
    let row = rows.get(session.id);
    if (!row) {
      const item = h("li", "session-item");
      item.dataset.id = session.id;
      const link = h("a", "session row");
      link.href = `/?session=${encodeURIComponent(session.id)}`;
      link.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(session.id, true);
      });
      row = {
        item,
        link,
        dot: h("span", "dot"),
        title: h("span", "session-title"),
        time: h("time", "session-time muted small"),
        workspace: h("span", "session-workspace muted small"),
        place: h("span"),
        mark: terminalMark(),
        pin: h("span", "pin-mark", "Pinned"),
        more: h("button", "more quiet small", "…"),
      };
      row.more.type = "button";
      row.more.setAttribute("aria-label", "Session actions");
      row.more.setAttribute("aria-haspopup", "menu");
      row.more.addEventListener("click", () => openMenu(session.id, row.more));
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(session.id, { x: e.clientX, y: e.clientY });
      });
      link.append(row.dot, row.title, row.time, row.workspace);
      item.append(link, row.more);
      rows.set(session.id, row);
    }
    row.dot.dataset.status = session.status;
    row.dot.title = sessionStatus(session);
    row.title.textContent = session.title || "Untitled";
    row.place.textContent = session.workspace;
    // The mark is in the line only for a session started in the terminal.
    const parts = [...(session.pinned ? [row.pin] : []), ...(startedInTerminal(session) ? [row.mark] : []), row.place];
    if (parts.some((p, k) => row.workspace.childNodes[k] !== p) || row.workspace.childNodes.length !== parts.length) row.workspace.replaceChildren(...parts);
    row.time.dateTime = session.updatedAt;
    row.time.textContent = relativeTime(session.updatedAt, now);
    if (session.id === selected) row.link.setAttribute("aria-current", "true");
    else row.link.removeAttribute("aria-current");
    // Moved only when the order changed, so a focused row keeps its focus.
    if (els.sessions.children[i] !== row.item) els.sessions.insertBefore(row.item, els.sessions.children[i] ?? null);
  });
  els.sessionsEmpty.textContent = sessions.size === 0 ? "No sessions yet." : view.query || view.workspace ? "Nothing matches." : view.archived ? "No archived sessions." : "Every session is archived.";
  els.sessionsEmpty.hidden = ordered.length > 0;
  els.empty.hidden = sessions.size > 0;
  els.stream.hidden = sessions.size === 0;
  renderWorkspaces();
}

/** The workspace filter's options: every workspace a session is in, and the one chosen even if none is now. */
function renderWorkspaces() {
  const names = workspacesOf(sessions.values());
  if (view.workspace && !names.includes(view.workspace)) names.push(view.workspace);
  const have = [...els.workspaceFilter.options].slice(1).map((o) => o.value);
  if (have.join("\n") === names.join("\n")) return;
  const options = names.map((name) => {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    return o;
  });
  els.workspaceFilter.replaceChildren(els.workspaceFilter.options[0], ...options);
  els.workspaceFilter.value = view.workspace;
}

// ---------- managing a session: the menu, rename, archive with undo, delete with a confirmation ----------

let undoTimer = 0;

/** The quiet line under the list, for a few seconds: what was done (with Undo), or why it couldn't be. */
function say(text, undo) {
  clearTimeout(undoTimer);
  const parts = [h("span", "undo-text", text)];
  if (undo) {
    const b = h("button", "quiet small", "Undo");
    b.type = "button";
    b.addEventListener("click", () => {
      els.undo.hidden = true;
      undo();
    });
    parts.push(b);
  }
  els.undo.replaceChildren(...parts);
  els.undo.hidden = false;
  undoTimer = setTimeout(() => (els.undo.hidden = true), UNDO_MS);
}

/** Runs one operation; a refusal is said on the line. Resolves with the answer, or null. */
async function run(verb, id, action, body) {
  try {
    return await manage(id, action, body);
  } catch (e) {
    say(`Couldn't ${verb}: ${e.message}`);
    return null;
  }
}

function openMenu(id, at) {
  const session = sessions.get(id);
  if (!session) return;
  menu.open(menuItems(session, true), at, (action) => void act(id, action));
}

async function act(id, action) {
  const session = sessions.get(id);
  if (!session) return;
  switch (action) {
    case "rename":
      return startRename(id);
    case "pin":
      return void (await run(session.pinned ? "unpin" : "pin", id, "pin", { pinned: !session.pinned }));
    case "archive":
      return archive(id, !session.archived);
    case "fork": {
      const answer = await run("fork", id, "fork");
      if (!answer?.session) return;
      sessions.set(answer.session.id, answer.session);
      // The fork is a session like the others: it shows in the list it belongs to.
      if (view.archived) setArchivedView(false);
      select(answer.session.id, true);
      return;
    }
    case "delete":
      return confirmDelete(id);
  }
}

/** Archives (with Undo on the line) or brings back. */
async function archive(id, archived) {
  const session = sessions.get(id);
  if (!session) return;
  const answer = await run(archived ? "archive" : "unarchive", id, "archive", { archived });
  if (!answer) return;
  if (archived) say(archivedLine(session), () => void run("unarchive", id, "archive", { archived: false }));
  else say(`Unarchived “${session.title || "Untitled"}”.`);
}

/** Rename in place: in its row when the list shows it, else in the head. */
function startRename(id) {
  const session = sessions.get(id);
  if (!session) return;
  const row = rows.get(id);
  const titleEl = row ? row.title : id === selected ? els.title : null;
  if (!titleEl || titleEl.hidden) return;
  void renameInline(document, titleEl, session.title || "", (title) => run("rename", id, "rename", { title }));
}

/** Delete, after a confirmation in the page that says what goes. */
function confirmDelete(id) {
  const session = sessions.get(id);
  if (!session) return;
  const text = deleteConfirm(session);
  els.confirmTitle.textContent = text.title;
  els.confirmBody.textContent = text.body;
  els.confirmOk.textContent = text.confirm;
  els.confirm.returnValue = "";
  els.confirm.onclose = async () => {
    els.confirm.onclose = null;
    if (els.confirm.returnValue !== "ok") return;
    await run("delete", id, "delete");
  };
  els.confirm.showModal();
  // The safe answer has the focus.
  els.confirm.querySelector('button[value="cancel"]').focus();
}

function setArchivedView(on) {
  view.archived = on;
  els.archivedView.setAttribute("aria-pressed", String(on));
  renderSidebar();
}

els.search.addEventListener("input", () => {
  view.query = els.search.value;
  renderSidebar();
});
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.search.value) {
    e.preventDefault();
    els.search.value = "";
    view.query = "";
    renderSidebar();
  }
});
els.workspaceFilter.addEventListener("change", () => {
  view.workspace = els.workspaceFilter.value;
  renderSidebar();
});
els.archivedView.addEventListener("click", () => setArchivedView(!view.archived));

let stopping = null;
els.stop.addEventListener("click", async () => {
  const id = selected;
  if (!id || stopping) return;
  stopping = id;
  renderHead();
  await run("stop", id, "stop");
  stopping = null;
  renderHead();
});

/** The session a key acts on: the row with the focus, else the one shown. */
function keyTarget() {
  const item = document.activeElement?.closest?.(".session-item");
  return item?.dataset.id ?? selected;
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || menu.isOpen || els.confirm.open) return;
  const typing = document.activeElement?.matches?.("input, textarea, select, [contenteditable]");
  if (e.key === "F2") {
    const id = keyTarget();
    if (!id || typing) return;
    e.preventDefault();
    startRename(id);
  } else if (e.key === "Delete" && !typing) {
    const id = keyTarget();
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.archived) return;
    e.preventDefault();
    void archive(id, true);
  }
});

/** The quiet glyph of a session started in the terminal, with its words as the tooltip. */
function terminalMark() {
  const mark = h("span", "terminal-mark mono", ">_");
  mark.title = TERMINAL_MARK_TITLE;
  mark.setAttribute("aria-label", TERMINAL_MARK_TITLE);
  mark.setAttribute("role", "img");
  return mark;
}

function renderHead() {
  const session = selected ? sessions.get(selected) : undefined;
  els.head.hidden = !session;
  document.title = session ? `${session.title || "Untitled"} · intuition` : "intuition";
  if (!session) return;
  els.title.textContent = session.title || "Untitled";
  els.dot.dataset.status = session.status;
  els.workspace.textContent = session.workspace;
  els.status.textContent = session.archived ? `${sessionStatus(session)} · archived` : sessionStatus(session);
  els.stop.hidden = !canStop(session);
  els.stop.disabled = stopping === session.id;
  els.stop.textContent = stopping === session.id ? "Stopping" : "Stop";
  resume.show(session);
}

// ---------- the reply box ----------

function grow() {
  els.text.style.height = "auto";
  els.text.style.height = `${els.text.scrollHeight + els.text.offsetHeight - els.text.clientHeight}px`;
}

function renderReply() {
  const session = selected ? sessions.get(selected) : undefined;
  els.reply.hidden = !session;
  const state = replyState(session);
  const enabled = state.enabled && !sending;
  if (!enabled && document.activeElement === els.text) wantFocus = true;
  els.text.disabled = !enabled;
  if (!sending && openElsewhere === selected && selected) {
    // Refused as open in a terminal: say so, and offer to send it all the same.
    const anyway = h("button", "send-anyway quiet small", "Send anyway");
    anyway.type = "button";
    anyway.addEventListener("click", () => void send(true));
    els.hint.replaceChildren(`${OPEN_IN_TERMINAL_HINT} `, anyway);
  } else {
    els.hint.textContent = replyError ? `Couldn't send: ${replyError}` : sending ? "Sending." : state.hint;
  }
  // Back to the box once, at the start and after a turn, unless the person has moved on to something else.
  if (enabled) {
    const active = document.activeElement;
    if (wantFocus && (active === null || active === document.body || active === els.text)) els.text.focus();
    wantFocus = false;
  }
}

/** Sends the typed reply. `force`: even though the session looks open in a terminal ("Send anyway"). */
async function send(force = false) {
  const id = selected;
  const prompt = els.text.value;
  if (!id || sending || !prompt.trim() || !replyState(sessions.get(id)).enabled) return;
  sending = true;
  replyError = "";
  openElsewhere = null;
  wantFocus = true;
  renderReply();
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { prompt, force: true } : { prompt }),
    });
    if (!res.ok) {
      const error = await errorText(res);
      // The typed text stays in the box for "Send anyway".
      if (isOpenInTerminal(res.status, error)) {
        openElsewhere = id;
        return;
      }
      throw new Error(error);
    }
    // The reply itself arrives as a user event on the WebSocket, like everything else in the stream.
    typed.delete(id);
    if (selected === id) {
      els.text.value = "";
      grow();
      stick = true;
    }
  } catch (e) {
    if (selected === id) replyError = e instanceof TypeError ? "the runner is not reachable" : e.message;
  } finally {
    sending = false;
    renderReply();
  }
}

els.text.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  void send();
});
els.text.addEventListener("input", () => {
  grow();
  if (replyError) {
    replyError = "";
    renderReply();
  }
});
els.reply.addEventListener("submit", (e) => e.preventDefault());

// ---------- selecting ----------

function select(id, push = false) {
  if (push) history.pushState(null, "", id ? `/?session=${encodeURIComponent(id)}` : "/");
  if (id === selected) return;
  if (selected) {
    if (els.text.value) typed.set(selected, els.text.value);
    else typed.delete(selected);
  }
  if (selected) crossFade();
  selected = id;
  generation += 1;
  lastSeq = 0;
  tools.clear();
  approvals.clear();
  streamedEl = null;
  loadErrorEl = null;
  els.stream.replaceChildren();
  stick = true;
  replyError = "";
  openElsewhere = null;
  els.text.value = (id && typed.get(id)) || "";
  renderSidebar();
  renderHead();
  renderReply();
  grow();
  renderStreamed();
  void catchUp();
}

window.addEventListener("popstate", () => select(pickFor(wanted() ?? selected)));

// ---------- the connection ----------

let attempt = 0;

function onMessage(message) {
  switch (message?.type) {
    case "hello": {
      attempt = 0;
      els.connection.hidden = true;
      sessions.clear();
      for (const session of message.sessions ?? []) sessions.set(session.id, session);
      if (selected && sessions.has(selected)) {
        // Connected again: fetch what was missed while away.
        renderSidebar();
        renderHead();
        renderReply();
        void catchUp();
      } else {
        select(pickFor(wanted()));
        renderSidebar();
      }
      break;
    }
    case "session": {
      const session = message.session;
      if (!session?.id) break;
      sessions.set(session.id, session);
      if (!selected) select(pickFor(wanted()));
      renderSidebar();
      if (session.id === selected) {
        renderHead();
        renderReply();
      }
      break;
    }
    case "removed": {
      const id = message.sessionId;
      if (!sessions.delete(id)) break;
      streamed.delete(id);
      typed.delete(id);
      if (id === selected) {
        const next = pickFor(null);
        history.replaceState(null, "", next ? `/?session=${encodeURIComponent(next)}` : "/");
        select(next);
      }
      renderSidebar();
      break;
    }
    case "event": {
      const event = message.event;
      if (!event) break;
      // The complete text (or the turn's end) replaces what was streamed.
      if (event.kind === "assistant_text" || event.kind === "result" || event.kind === "error" || event.kind === "stopped") streamed.delete(message.sessionId);
      if (message.sessionId !== selected) break;
      if (loading || event.seq > lastSeq + 1) {
        // Still loading, or one was missed: take it from the stored events, in order.
        void catchUp();
      } else {
        live = true;
        try {
          apply(event);
          renderStreamed();
        } finally {
          live = false;
        }
      }
      break;
    }
    case "delta":
      if (typeof message.text !== "string") break;
      streamed.set(message.sessionId, (streamed.get(message.sessionId) ?? "") + message.text);
      if (message.sessionId === selected) streamSoon(!loading);
      break;
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("message", (e) => {
    let message;
    try {
      message = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(message);
  });
  ws.addEventListener("close", () => {
    // Deltas aren't stored, so a half-streamed text can't be completed: the stored text follows.
    streamed.clear();
    renderStreamed();
    els.connection.textContent = "reconnecting";
    els.connection.hidden = false;
    setTimeout(connect, backoffMs(attempt));
    attempt += 1;
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, row] of rows) row.time.textContent = relativeTime(sessions.get(id)?.updatedAt ?? "", now);
}, 30_000);

renderSidebar();
renderHead();
renderReply();
connect();
