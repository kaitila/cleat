// The dock: a pill that says what the sessions are doing, a peek when one finishes or needs the
// person, and, on hover, an open view where a session is read, approved and continued.
// The contract with the shell is docs/protocol.md, "Dock": the page picks one of three states and
// tells the shell through window.intuitionDock.setState, which is absent in a normal browser.
// The shell's window never changes size: the page draws the island inside it and animates it alone.
// Text from the model, from tools and from the person is untrusted: it reaches the page only as
// text nodes (textContent), never as markup.
import {
  approvalView,
  backoffMs,
  decidedLabel,
  isOpenInTerminal,
  OPEN_IN_TERMINAL_HINT,
  relativeTime,
  replyState,
  resultLine,
  sessionStatus,
  startedInTerminal,
  TERMINAL_MARK_TITLE,
  toolSummary,
  unknownNote,
} from "./chat-format.js";
import { canStop, manage, menuItems, renameInline, sessionMenu, visible } from "./chat-manage.js";
import { resumeControl } from "./chat-resume.js";
import { renderMarkdown } from "./markdown.js";
import {
  CLOSE_MS,
  DOCK_SIZES,
  DOCK_WINDOW,
  OPEN_MS,
  PEEK_MS,
  RECENT_EVENTS,
  asPeek,
  enqueue,
  islandSize,
  mayClose,
  nextPeek,
  onIsland,
  peekLabel,
  peekOver,
  peekStatus,
  pillOf,
  preselect,
  recentEvents,
} from "./dock-state.js";

const $ = (id) => document.getElementById(id);
const els = {
  island: $("island"),
  surface: document.querySelector("#island > .surface"),
  pill: $("pill"),
  pillDot: $("pill-dot"),
  pillText: $("pill-text"),
  pillFailed: $("pill-failed"),
  peek: $("peek"),
  peekDot: $("peek-dot"),
  peekTitle: $("peek-title"),
  peekLabel: $("peek-label"),
  peekBody: $("peek-body"),
  panel: $("panel"),
  connection: $("connection"),
  sessions: $("sessions"),
  sessionsEmpty: $("sessions-empty"),
  session: $("session"),
  title: $("title"),
  openChat: $("open-chat"),
  scroller: $("scroller"),
  stream: $("stream"),
  reply: $("reply"),
  text: $("reply-text"),
  hint: $("reply-hint"),
};
/** Beside the title: "in terminal" while a turn arrives from a terminal, else nothing. */
const headStatus = h("span", "session-status muted small");
const resume = resumeControl(document);
/** While the runner runs a turn of the session shown: it stops it. */
const stopButton = h("button", "stop small", "Stop");
stopButton.type = "button";
stopButton.hidden = true;
els.openChat.before(headStatus, stopButton, resume.el);
/** The list rows' right-click menu: Rename, Pin, Archive. It lives in the panel, inside the island. */
const menu = sessionMenu(document, els.panel);
/** True while a row's title is being edited: like a reply being typed, it holds the dock open. */
let renaming = false;
/** A refusal of Stop, Rename, Pin or Archive, said in the head for a few seconds. */
let manageError = "";
let manageErrorTimer = 0;

/** An element with a class and text. The text is set as textContent, so it is never parsed. */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** id -> SessionMeta, as last told by the runner. */
const sessions = new Map();
/** The sessions the dock counts and lists: archived ones are out of the way here too. */
const shown = () => [...sessions.values()].filter((s) => s.archived !== true);

// ---------- the three states ----------

/** What the island shows: "idle", "peek" or "open". */
let state = "idle";
/** What the shell was last told. Null before the first call. */
let told = null;
/** The size the island is drawn at now (or is on its way to). */
let drawn = { width: 0, height: 0 };

/**
 * Tells the shell the state, at once, growing or shrinking: its window never changes, it only needs
 * to know where the island is for the mouse.
 */
function tellShell(next) {
  if (told === next) return;
  told = next;
  try {
    window.intuitionDock?.setState(next);
  } catch {
    // No bridge worth the name: the page works the same without it.
  }
}

const LAYERS = { idle: els.pill, peek: els.peek, open: els.panel };

/** Shows a state's content, or lets it fade out and then takes it away. */
function show(el, on) {
  if (on) {
    el.classList.remove("leaving");
    el.hidden = false;
    return;
  }
  if (el.hidden || el.classList.contains("leaving")) return;
  el.classList.add("leaving");
  // Under prefers-reduced-motion nothing runs, and it goes at once.
  void Promise.allSettled(el.getAnimations().map((a) => a.finished)).then(() => {
    if (!el.classList.contains("leaving")) return;
    el.hidden = true;
    el.classList.remove("leaving");
  });
}

/**
 * Draws the island at the size its state and content ask for. Only the clip changes (dock.css):
 * no box changes size, here or in the shell.
 */
function resize() {
  const size = islandSize(state, { pill: els.pill.offsetWidth, panel: els.panel.offsetHeight, quiet: els.pill.dataset.tone === "none" });
  if (size.width === drawn.width && size.height === drawn.height) return;
  drawn = size;
  // Both the island and its surface: the size is not inherited, so each springs to it (dock.css).
  for (const el of [els.island, els.surface]) {
    el.style.setProperty("--island-w", `${size.width}px`);
    el.style.setProperty("--island-h", `${size.height}px`);
  }
}

/** Plays an element's animations again from their start: a peek that follows another pops in anew. */
function replay(el) {
  for (const a of el.getAnimations({ subtree: true })) {
    a.cancel();
    a.play();
  }
}

/** One gentle nudge of a dot (dock.css, [data-nudge]); it is taken off when the nudge is over. */
function nudge(el) {
  delete el.dataset.nudge;
  void el.offsetWidth;
  el.dataset.nudge = "";
}
els.pillDot.addEventListener("animationend", (e) => {
  if (e.animationName === "nudge") delete els.pillDot.dataset.nudge;
});

/** Changes the state: the content swaps and the island's shape follows. */
function go(next) {
  state = next;
  tellShell(next);
  els.island.dataset.state = next;
  for (const [name, el] of Object.entries(LAYERS)) show(el, name === next);
  resize();
}

// The pill is as wide as its text and the panel as tall as its content: when either changes
// (another count, the font arriving, an answer streaming in), the island follows.
const sized = new ResizeObserver(() => resize());
sized.observe(els.pill);
sized.observe(els.panel);

// ---------- idle: the pill ----------

<<<<<<< HEAD
function renderPill() {
  const pill = pillOf(shown());
=======
/**
 * Draws the pill. `quiet`: what the runner said on connecting, not news: a "needs you" in it doesn't
 * nudge.
 */
function renderPill(quiet = false) {
  const pill = pillOf(sessions.values());
  const news = !quiet && pill.tone === "needs" && els.pill.dataset.tone !== "needs" && state === "idle";
>>>>>>> origin/main
  els.pill.dataset.tone = pill.tone;
  els.island.dataset.tone = pill.tone;
  els.pillText.textContent = pill.text;
  els.pill.setAttribute("aria-label", pill.text);
  // Nothing going on: the dot alone, dimmed. The words come with something to say.
  els.pillText.hidden = pill.tone === "none";
  if (pill.status) els.pillDot.dataset.status = pill.status;
  else delete els.pillDot.dataset.status;
  // Beside "2 running" or "needs you": the newest one that finished failed.
  els.pillFailed.hidden = !pill.failed || pill.tone === "failed";
  if (news) nudge(els.pillDot);
  // With nothing going on the sliver is shorter still.
  els.pill.style.height = `${islandSize("idle", { quiet: pill.tone === "none" }).height}px`;
  resize();
}

// ---------- peek ----------

/** The peeks that wait their turn, newest last. */
let queue = [];
/** The peek on show, and when it came up. */
let peeking = null;
let peekShownAt = 0;
let peekTimer = 0;
/** The session that peeked last, since the dock was last open: it is preselected on opening. */
let lastPeeked = null;

/** Shows the next peek that waits, or goes back to the pill when none does. */
function showPeek() {
  clearTimeout(peekTimer);
  const next = nextPeek(queue, shown());
  queue = next.queue;
  peeking = next.peek;
  if (!peeking) {
    if (state === "peek") go("idle");
    return;
  }
  lastPeeked = peeking.sessionId;
  peekShownAt = Date.now();
  els.peek.dataset.kind = peeking.kind;
  els.peekDot.dataset.status = peekStatus(peeking.kind);
  els.peekTitle.textContent = peeking.title;
  els.peekLabel.textContent = peekLabel(peeking.kind);
  els.peekBody.textContent = peeking.body;
  // One peek after another: the island is already its size, the new line pops in all the same.
  if (state === "peek") replay(els.peek);
  go("peek");
  // One that waits for an approval stays until its session no longer waits (checkPeek).
  if (peeking.kind !== "needs_approval") peekTimer = setTimeout(showPeek, PEEK_MS);
}

/** After the sessions changed: a peek for an approval that was answered is over. */
function checkPeek() {
  if (state === "peek" && peeking && peekOver(peeking, shown(), Date.now() - peekShownAt)) showPeek();
}

function onNotification(notification) {
  const peek = asPeek(notification);
  // Open, the list shows it.
  if (!peek || state === "open") return;
  queue = enqueue(queue, peek);
  if (!peeking) showPeek();
}

// ---------- open: the selected session's stream ----------

let selected = null;
/** Goes up with every selection, so an answer that arrives for an earlier one is dropped. */
let generation = 0;
/** seq of the newest event of the selected session that is on the page. */
let lastSeq = 0;
let loading = false;
let loadAgain = false;
/** toolUseId -> the mark of its row, to say that it failed. */
const tools = new Map();
/** approvalId -> its card in the stream: { el, actions, state }. */
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
/** True when the box was switched off while it had the focus: the focus goes back to it when the turn ends. */
let wantFocus = false;
/** True while the person is at the bottom of the stream: new events keep it there. */
let stick = true;
let followQueued = false;

function follow() {
  if (!stick || followQueued) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
  });
}

els.scroller.addEventListener("scroll", () => {
  stick = els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight < 32;
});

/**
 * What arrives together (a session's events as it is opened): null when events arrive one by one.
 * Its last few rise in one after the other (dock.css, data-stagger).
 */
let batch = null;
/** How many of a batch's last events rise one after the other: about what the stream shows. */
const STAGGERED = 6;

/**
 * Adds to the end of the stream, above the text that is still streaming. Only the last few stay.
 * It rises in (dock.css, .arrive), except `still`: text that takes the place of the same text streamed.
 */
function add(el, still = false) {
  if (!still) el.classList.add("arrive");
  if (batch && !still) batch.push(el);
  els.stream.insertBefore(el, streamedEl?.parentNode === els.stream ? streamedEl : null);
  while (els.stream.childElementCount > RECENT_EVENTS + 10) els.stream.firstElementChild.remove();
  follow();
  return el;
}

function renderText(el, text, streaming = false) {
  el.replaceChildren(renderMarkdown(text, document, { streaming }));
}

let streamQueued = false;

/** Deltas come faster than frames: the streaming text is drawn again at most once a frame. */
function streamSoon() {
  if (streamQueued) return;
  streamQueued = true;
  requestAnimationFrame(() => {
    streamQueued = false;
    renderStreamed();
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
  if (!streamedEl) streamedEl = h("div", "msg assistant md streaming arrive");
  renderText(streamedEl, text, true);
  if (streamedEl.parentNode !== els.stream) els.stream.append(streamedEl);
  follow();
}

/** A tool call as one line: its name and what it works on. The chat view has its input and result. */
function toolRow(event) {
  const row = h("div", "tool-row");
  const mark = h("span", "tool-mark small");
  row.append(h("span", "tool-name", String(event.name ?? "Tool")), h("span", "tool-line mono", toolSummary(event.name, event.input)), mark);
  tools.set(event.toolUseId, mark);
  add(row);
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

const unreachable = (e) => (e instanceof TypeError ? "the runner is not reachable" : e.message);

/**
 * A tool call that waits for the person: what it is about to do, and Allow and Deny. The answer is
 * sent to the runner; the card changes when the runner's approval_resolved event arrives.
 */
function approvalCard(event) {
  const sessionId = selected;
  const el = h("section", "approval");
  el.dataset.state = "open";
  el.setAttribute("aria-label", "Approval needed");
  const head = h("div", "approval-head");
  const stateEl = h("span", "approval-state small", "Needs your approval");
  head.append(h("span", "approval-tool", String(event.toolName ?? "Tool")), stateEl);
  el.append(head);
  const view = approvalView(event.toolName, event.input);
  if (view.path) el.append(h("div", "approval-path mono", view.path));
  if (view.text) {
    const pre = h("pre", "approval-input well", view.text);
    el.append(pre);
    if (view.text.length < view.full.length) {
      const all = h("button", "show-all quiet small", "Show all");
      all.type = "button";
      all.addEventListener("click", () => {
        pre.textContent = view.full;
        all.remove();
      });
      el.append(all);
    }
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
      error.textContent = `Couldn't send: ${unreachable(e)}`;
      for (const b of buttons) b.disabled = false;
    }
  };
  allow.type = deny.type = "button";
  allow.addEventListener("click", () => void answer("allow"));
  deny.addEventListener("click", () => void answer("deny"));
  actions.append(allow, deny, error);
  el.append(actions);
  approvals.set(event.approvalId, { el, actions, state: stateEl });
  // It arrives with a small bounce (dock.css, .approval.arrive).
  add(el);
}

/** The card after its answer: what was decided, and no buttons. `decision` undefined: nobody answered. */
function approvalDecided(card, decision) {
  if (card.el.dataset.state !== "open") return;
  card.el.dataset.state = decision === "allow" || decision === "deny" ? decision : "unanswered";
  card.el.removeAttribute("aria-label");
  card.state.textContent = decidedLabel(decision);
  card.actions.remove();
  card.el.querySelector(".show-all")?.remove();
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
    case "user":
      add(h("div", "msg user card", event.text));
      break;
    case "assistant_text":
      // The streamed text is on the page already: the complete text takes its place without rising again.
      renderText(add(h("div", "msg assistant md"), streamedEl?.parentNode === els.stream), event.text);
      break;
    case "tool_use":
      toolRow(event);
      break;
    case "tool_result": {
      const mark = tools.get(event.toolUseId);
      if (mark && event.isError) mark.textContent = "failed";
      break;
    }
    case "approval_request":
      approvalCard(event);
      break;
    case "approval_resolved": {
      const card = approvals.get(event.approvalId);
      if (card) approvalDecided(card, event.decision);
      break;
    }
    case "result":
      endOpenApprovals();
      add(h("div", event.ok ? "note num muted small" : "note num error small", resultLine(event)));
      if (!event.ok && event.text) add(h("div", "error small", event.text));
      break;
    case "error":
      endOpenApprovals();
      add(h("div", "error small", event.message));
      break;
    case "stopped":
      endOpenApprovals();
      add(h("div", "note muted small", "Stopped"));
      break;
    default:
      add(h("div", "note muted small", unknownNote(event)));
  }
}

/** Fetches the selected session's events after the newest one on the page: at first, its last few. */
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
    const events = recentEvents(Array.isArray(body.events) ? body.events : []);
    // The older ones are the chat view's: here they count as drawn.
    if (lastSeq === 0 && typeof events[0]?.seq === "number") lastSeq = events[0].seq - 1;
    batch = [];
    try {
      for (const event of events) apply(event);
    } finally {
      arrived(batch);
      batch = null;
    }
    renderStreamed();
  } catch (e) {
    if (mine !== generation) return;
    loadErrorEl?.remove();
    loadErrorEl = add(h("div", "note muted small", `Couldn't load this session: ${unreachable(e)}`));
  } finally {
    loading = false;
    if (loadAgain) {
      loadAgain = false;
      void catchUp();
    }
  }
}

/** The end of a batch: its last few rise one after the other. */
function arrived(added) {
  const shown = added.filter((el) => el.isConnected);
  shown.forEach((el, i) => {
    const at = i - (shown.length - STAGGERED);
    if (at >= 0) el.dataset.stagger = String(at);
  });
}

// ---------- open: the list, the head, the reply box ----------

/** id -> { item, link, dot, title, workspace, time } in the list. */
const rows = new Map();

function renderList() {
  const ordered = visible(sessions.values());
  const listed = new Set(ordered.map((s) => s.id));
  for (const id of [...rows.keys()]) {
    if (!listed.has(id)) {
      rows.get(id).item.remove();
      rows.delete(id);
    }
  }
  const now = Date.now();
  ordered.forEach((session, i) => {
    let row = rows.get(session.id);
    if (!row) {
      const item = h("li");
      // A link to the chat view on this session: a plain click selects it here instead.
      const link = h("a", "session-row row");
      link.href = `/?session=${encodeURIComponent(session.id)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(session.id);
      });
      link.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const current = sessions.get(session.id);
        if (current) menu.open(menuItems(current, false), { x: e.clientX, y: e.clientY }, (action) => void act(session.id, action));
      });
      row = {
        item,
        link,
        dot: h("span", "dot"),
        title: h("span", "row-title"),
        mark: h("span", "terminal-mark mono muted small", ">_"),
        workspace: h("span", "row-workspace muted small"),
        time: h("time", "row-time muted small"),
      };
      row.mark.title = TERMINAL_MARK_TITLE;
      row.mark.setAttribute("aria-label", TERMINAL_MARK_TITLE);
      row.mark.setAttribute("role", "img");
      link.append(row.dot, row.title, row.mark, row.workspace, row.time);
      item.append(link);
      rows.set(session.id, row);
    }
    row.dot.dataset.status = session.status;
    row.dot.title = sessionStatus(session);
    row.title.textContent = session.title || "Untitled";
    row.title.classList.toggle("pinned", session.pinned === true);
    row.mark.hidden = !startedInTerminal(session);
    row.workspace.textContent = session.workspace;
    row.time.dateTime = session.updatedAt;
    row.time.textContent = relativeTime(session.updatedAt, now);
    if (session.id === selected) row.link.setAttribute("aria-current", "true");
    else row.link.removeAttribute("aria-current");
    // Moved only when the order changed, so a focused row keeps its focus.
    if (els.sessions.children[i] !== row.item) els.sessions.insertBefore(row.item, els.sessions.children[i] ?? null);
  });
  els.sessionsEmpty.hidden = ordered.length > 0;
  els.sessions.hidden = ordered.length === 0;
}

/** A refusal said in the head, for a few seconds. */
function sayError(text) {
  clearTimeout(manageErrorTimer);
  manageError = text;
  renderHead();
  manageErrorTimer = setTimeout(() => {
    manageError = "";
    renderHead();
  }, 4000);
}

async function run(verb, id, action, body) {
  try {
    return await manage(id, action, body);
  } catch (e) {
    sayError(`Couldn't ${verb}: ${e.message}`);
    return null;
  }
}

/** The menu's choice. Archived, a session leaves the list; the chat view's Archived view brings it back. */
async function act(id, action) {
  const session = sessions.get(id);
  if (!session) return;
  if (action === "pin") await run(session.pinned ? "unpin" : "pin", id, "pin", { pinned: !session.pinned });
  else if (action === "archive") await run(session.archived ? "unarchive" : "archive", id, "archive", { archived: !session.archived });
  else if (action === "rename") {
    const row = rows.get(id);
    if (!row) return;
    renaming = true;
    await renameInline(document, row.title, session.title || "", (title) => run("rename", id, "rename", { title }));
    renaming = false;
    scheduleClose();
  }
}

let stopping = null;
stopButton.addEventListener("click", async () => {
  const id = selected;
  if (!id || stopping) return;
  stopping = id;
  renderHead();
  await run("stop", id, "stop");
  stopping = null;
  renderHead();
});

function renderHead() {
  const session = selected ? sessions.get(selected) : undefined;
  els.session.hidden = !session;
  if (!session) return;
  els.title.textContent = session.title || "Untitled";
  els.openChat.href = `/?session=${encodeURIComponent(session.id)}`;
  const status = sessionStatus(session);
  headStatus.textContent = manageError || (status === "in terminal" ? status : "");
  stopButton.hidden = !canStop(session);
  stopButton.disabled = stopping === session.id;
  stopButton.textContent = stopping === session.id ? "Stopping" : "Stop";
  resume.show(session);
}

function grow() {
  els.text.style.height = "auto";
  els.text.style.height = `${els.text.scrollHeight + els.text.offsetHeight - els.text.clientHeight}px`;
}

function renderReply() {
  const session = selected ? sessions.get(selected) : undefined;
  const replying = replyState(session);
  const enabled = replying.enabled && !sending;
  // Switched off under the person's caret (their reply was sent): the focus comes back with the box.
  if (!enabled && document.activeElement === els.text) wantFocus = true;
  els.text.disabled = !enabled;
  if (!sending && openElsewhere === selected && selected) {
    // Refused as open in a terminal: say so, and offer to send it all the same.
    const anyway = h("button", "send-anyway quiet small", "Send anyway");
    anyway.type = "button";
    anyway.addEventListener("click", () => void send(true));
    els.hint.replaceChildren(`${OPEN_IN_TERMINAL_HINT} `, anyway);
  } else {
    els.hint.textContent = replyError ? `Couldn't send: ${replyError}` : sending ? "Sending." : replying.hint;
  }
  // Back to the box after the turn, unless the person has moved on or the dock has closed.
  if (enabled && wantFocus) {
    wantFocus = false;
    const active = document.activeElement;
    if (state === "open" && (active === null || active === document.body || active === els.text)) els.text.focus();
  }
  // The box may have lost the focus by being switched off: nothing else says so.
  scheduleClose();
}

/** Sends the typed reply. `force`: even though the session looks open in a terminal ("Send anyway"). */
async function send(force = false) {
  const id = selected;
  const prompt = els.text.value;
  if (!id || sending || !prompt.trim() || !replyState(sessions.get(id)).enabled) return;
  sending = true;
  replyError = "";
  openElsewhere = null;
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
    if (selected === id) replyError = unreachable(e);
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
  scheduleClose();
});
els.text.addEventListener("blur", () => scheduleClose());
els.reply.addEventListener("submit", (e) => e.preventDefault());

/** Shows a session in the open dock. The one already shown only fetches what it missed. */
function select(id) {
  if (id === selected && id !== null) {
    stick = true;
    void catchUp();
    follow();
    return;
  }
  if (selected) {
    if (els.text.value) typed.set(selected, els.text.value);
    else typed.delete(selected);
  }
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
  wantFocus = false;
  els.text.value = (id && typed.get(id)) || "";
  renderList();
  renderHead();
  renderReply();
  grow();
  renderStreamed();
  void catchUp();
}

// ---------- opening and closing ----------

/** The pointer is on the island; a button of it is held down. */
let inside = false;
let down = false;
/** Closed with Esc under the pointer: it has to leave before it can open the dock again. */
let dismissed = false;
let openTimer = 0;
let closeTimer = 0;

/**
 * Whether a point of the page is on the island. The island's box never changes, so it does not say:
 * the size it is drawn at does, and, closed, the state's whole rectangle (dock-state.js).
 */
function over(x, y) {
  const box = els.island.getBoundingClientRect();
  return onIsland(state, drawn, x - (box.left + box.width / 2), y - box.top);
}

/** The pointer is on the island, or not. Opening waits a moment: a pointer that brushes past opens nothing. */
function point(on) {
  if (!on) dismissed = false;
  const next = on && !dismissed;
  if (next === inside) return;
  inside = next;
  clearTimeout(openTimer);
  if (!inside) {
    scheduleClose();
    return;
  }
  clearTimeout(closeTimer);
  if (state !== "open") openTimer = setTimeout(() => inside && open(), OPEN_MS);
}

function holds() {
  return {
    pointerInside: inside,
    pointerDown: down,
    // A row's menu or its title being edited holds it open as a focused reply box does.
    replyFocused: (document.hasFocus() && document.activeElement === els.text) || menu.isOpen || renaming,
    replyText: els.text.value,
  };
}

function open() {
  if (state === "open") return;
  clearTimeout(peekTimer);
  const pick = preselect(shown(), peeking?.sessionId ?? null, lastPeeked);
  // Opened, the peeks are answered by the list.
  peeking = null;
  queue = [];
  lastPeeked = null;
  go("open");
  renderList();
  // The rows rise in one after the other as the panel comes in; one added later rises on its own.
  [...els.sessions.children].forEach((item, i) => {
    item.dataset.stagger = String(Math.min(i, STAGGERED - 1));
  });
  select(pick);
  renderHead();
  renderReply();
  grow();
}

function close() {
  clearTimeout(closeTimer);
  if (state !== "open") return;
  // Closed under the pointer (Esc): it stays closed until the pointer has left.
  dismissed = inside;
  inside = false;
  wantFocus = false;
  // The shell gives the keyboard back to the window below when it hears "idle".
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  go("idle");
}

/** Closes the open dock a moment from now, if nothing holds it open then either. */
function scheduleClose() {
  clearTimeout(closeTimer);
  if (state !== "open" || !mayClose(holds())) return;
  closeTimer = setTimeout(() => {
    if (state === "open" && mayClose(holds())) close();
  }, CLOSE_MS);
}

// The pointer is followed by where it is, not by which element it is on: the island's box is as
// large as the window in every state, and only its clip says where the island is.
window.addEventListener("pointermove", (e) => point(over(e.clientX, e.clientY)));
document.documentElement.addEventListener("pointerleave", () => point(false));
window.addEventListener("pointerdown", (e) => {
  const on = over(e.clientX, e.clientY);
  point(on);
  // A press beside the open dock puts it away at once, whatever is typed in it: the draft is kept.
  if (state === "open" && !on) close();
  else down = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    down = false;
    scheduleClose();
  });
}
// The person went to another window: an empty reply box no longer holds the dock open.
window.addEventListener("blur", () => {
  down = false;
  scheduleClose();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || state !== "open") return;
  e.preventDefault();
  close();
});

// ---------- the connection ----------

let attempt = 0;

function onMessage(message) {
  switch (message?.type) {
    case "hello": {
      attempt = 0;
      els.connection.hidden = true;
      sessions.clear();
      for (const session of message.sessions ?? []) sessions.set(session.id, session);
      renderPill(true);
      checkPeek();
      if (state !== "open") break;
      renderList();
      // Connected again: fetch what was missed while away, or pick one if the selected is gone.
      if (selected && sessions.has(selected)) select(selected);
      else select(preselect(shown(), null, null));
      renderHead();
      renderReply();
      break;
    }
    case "session": {
      const session = message.session;
      if (!session?.id) break;
      sessions.set(session.id, session);
      renderPill();
      checkPeek();
      if (state !== "open") break;
      if (!selected) select(session.id);
      renderList();
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
      renderPill();
      checkPeek();
      if (state !== "open") break;
      if (id === selected) select(preselect(shown(), null, null));
      renderList();
      break;
    }
    case "event": {
      const event = message.event;
      if (!event) break;
      // The complete text (or the turn's end) replaces what was streamed.
      if (event.kind === "assistant_text" || event.kind === "result" || event.kind === "error" || event.kind === "stopped") streamed.delete(message.sessionId);
      // Closed, nothing is drawn: opening fetches what was missed.
      if (state !== "open" || message.sessionId !== selected) break;
      if (loading || event.seq > lastSeq + 1) {
        // Still loading, or one was missed: take it from the stored events, in order.
        void catchUp();
      } else {
        apply(event);
        renderStreamed();
      }
      break;
    }
    case "delta":
      if (typeof message.text !== "string") break;
      streamed.set(message.sessionId, (streamed.get(message.sessionId) ?? "") + message.text);
      if (state === "open" && message.sessionId === selected) streamSoon();
      break;
    case "notification":
      onNotification(message.notification);
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
    // Quietly: the pill keeps saying what it last knew, and only the open dock says "reconnecting".
    streamed.clear();
    renderStreamed();
    els.connection.hidden = false;
    setTimeout(connect, backoffMs(attempt));
    attempt += 1;
  });
}

setInterval(() => {
  if (state !== "open") return;
  const now = Date.now();
  for (const [id, row] of rows) row.time.textContent = relativeTime(sessions.get(id)?.updatedAt ?? "", now);
}, 30_000);

// The contract's sizes (docs/protocol.md, "Dock"). The island's box is the window; each state's
// content has its own size and never changes with the island's shape.
els.island.style.width = `${DOCK_WINDOW.width}px`;
els.island.style.height = `${DOCK_WINDOW.height}px`;
els.pill.style.maxWidth = `${DOCK_SIZES.idle.width}px`;
els.peek.style.width = `${DOCK_SIZES.peek.width}px`;
els.peek.style.height = `${DOCK_SIZES.peek.height}px`;
els.panel.style.width = `${DOCK_SIZES.open.width}px`;
els.panel.style.maxHeight = `${DOCK_SIZES.open.height}px`;
renderPill();
go("idle");
connect();
