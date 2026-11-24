// The dock: a pill that says what the sessions are doing, a peek when one finishes or needs the
// person, and, on hover, an open view where a session is read, approved and continued.
// The contract with the shell is docs/protocol.md, "Dock": the page picks one of four states (the fourth, chat, is the chat view grown out of the notch: D0042) and
// tells the shell through window.cleatDock.setState, which is absent in a normal browser.
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
  resumeCommand,
  resultLine,
  sessionStatus,
  startedInTerminal,
  TERMINAL_MARK_TITLE,
  toolSummary,
  unknownNote,
} from "./chat-format.js";
import { canStop, manage, menuItems, renameInline, sessionMenu, visible } from "./chat-manage.js";
import { renderMarkdown } from "./markdown.js";
import { answersList, questionDecidedLabel, questionForm, questionsOf } from "./questions.js";
import { agentMark, agentName, agentOf, agentSvg, setAgentMark } from "./agent.js";
import { commandLabel, MAC } from "./keys.js";
import { guide, tip } from "./shortcuts.js";
import { shortcutsSheet, tooltips } from "./shortcuts-sheet.js";
import {
  CLOSE_MS,
  clickAction,
  DOCK_SIZES,
  dockWindow,
  OPEN_MS,

  PEEK_MS,
  RECENT_EVENTS,
  asPeek,
  dockKey,
  dockOrder,
  dockSizes,
  dockWorkspaces,
  enqueue,
  inWorkspace,
  islandSize,
  isLive,
  justStarted,
  liveOthers,
  LIVE_MAX,
  mayClose,
  nextPeek,
  onIsland,
  parseChat,
  parseNotch,
  peekLabel,
  peekOver,
  peekStatus,
  pillOf,
  preselect,
  recentEvents,
  savedSession,
  savedWorkspace,
  saveSession,
  saveWorkspace,
  stepSession,
} from "./dock-state.js";

/** A Mac's notch, from the shell (`?notch=WxH`): the island grows out of it. Null without one. */
const NOTCH = parseNotch(location.search);
/** How large the island grows into the chat on this display, from the shell (`?chat=WxH`, D0042). */
const CHAT = parseChat(location.search) ?? DOCK_SIZES.chat;
/** The most the island covers in each state, out of the notch or not (docs/protocol.md, "Dock"). */
const SIZES = dockSizes(NOTCH, CHAT);
/** The shell's window: as large as the largest state, for the page's whole life. */
const WINDOW = dockWindow(CHAT);

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
  workspace: $("workspace"),
  switcher: $("switcher"),
  switcherDot: $("switcher-dot"),
  live: $("live"),
  find: $("find"),
  sessionsList: $("sessions-list"),
  sessions: $("sessions"),
  sessionsEmpty: $("sessions-empty"),
  session: $("session"),
  title: $("title"),
  more: $("more"),
  scroller: $("scroller"),
  stream: $("stream"),
  reply: $("reply"),
  text: $("reply-text"),
  hint: $("reply-hint"),
  expand: $("expand"),
  chat: $("chat"),
  chatFrame: $("chat-frame"),
};
/** In the switch, before the title: the agent the session runs on, its glyph, its name as the tooltip. */
const headAgent = h("span", "session-agent");
headAgent.setAttribute("role", "img");
els.title.before(headAgent);
/** In the head: "in terminal" while a turn arrives from a terminal, or a refusal for a moment, else nothing. */
const headStatus = h("span", "session-status muted small");
/** While the runner runs a turn of the session shown: it stops it. */
const stopButton = h("button", "stop quiet small", "Stop");
stopButton.type = "button";
stopButton.hidden = true;
els.more.before(headStatus, stopButton);

/** True while the list of sessions is open under the head. Each opening of the dock starts with it closed. */
let listOpen = false;
/** The row Up, Down and Enter in the find field work on: the first that matches, until moved. */
let activeRow = null;
const COMMAND = commandLabel();
const newTaskLink = els.panel.querySelector(".new-task");

/** The shell's part of the settings (GET /api/settings, then each { type: "settings" }), for the global hotkeys' tooltips and the guide. */
let shellKeys = null;
/** The tooltips that name a key: the global ones are the person's own, so they are written again when the settings change. */
function renderTips() {
  const keys = { mac: MAC, shell: shellKeys };
  els.expand.title = tip("Open in the chat", "chatHotkey", keys);
  newTaskLink.title = tip("New task", "hotkey", keys);
  els.more.title = "More: the session's actions, keyboard shortcuts";
}

/**
 * Opens or closes the switch under the head; the island follows its height. Open, the keyboard is in
 * its find field, so typing narrows the rows at once; closed, the find is empty again.
 */
function showList(on) {
  listOpen = on;
  els.sessionsList.hidden = !on;
  els.switcher.setAttribute("aria-expanded", String(on));
  els.panel.toggleAttribute("data-list", on);
  els.find.value = "";
  activeRow = on ? selected : null;
  renderList();
  if (!on) return;
  // The session shown is one of the rows in view.
  if (selected) rows.get(selected)?.item.scrollIntoView({ block: "nearest" });
  els.find.focus({ preventScroll: true });
}
els.switcher.addEventListener("click", () => {
  showList(!listOpen);
  // Closed again from its own button: the keyboard goes back to the reply.
  if (!listOpen) focusReply(true);
});

/** Picks a session from the switch or the head: it is shown, the switch closes, typing goes to its reply. */
function pick(id) {
  select(id);
  if (listOpen) showList(false);
  focusReply(true);
}

/** The sessions of the switch as it shows them: the dock's order (dock-state.js), narrowed by the find while open. */
function switchOrder() {
  return dockOrder(visible(sessions.values(), { workspace, query: listOpen ? els.find.value : "" }));
}

els.find.addEventListener("input", () => {
  activeRow = switchOrder()[0]?.id ?? null;
  renderList();
});
els.find.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const ids = switchOrder().map((s) => s.id);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeRow = stepSession(ids, activeRow, e.key === "ArrowDown" ? 1 : -1);
    renderList();
    if (activeRow) rows.get(activeRow)?.item.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const id = ids.includes(activeRow) ? activeRow : ids[0];
    if (id) pick(id);
  }
});

/** While the command key is held, the switch's first nine rows show the digit that picks them. */
function commandHeld(on) {
  els.panel.toggleAttribute("data-command", on);
}
document.addEventListener("keydown", (e) => commandHeld(e.key === (COMMAND === "⌘" ? "Meta" : "Control") && !e.altKey && !e.shiftKey));
document.addEventListener("keyup", () => commandHeld(false));
window.addEventListener("blur", () => commandHeld(false));

/**
 * The list rows' right-click menu (Rename, Pin, Archive) and the head's "…" (Open in chat, Continue
 * in terminal, then the same three). It lives in the panel, inside the island.
 */
const menu = sessionMenu(document, els.panel);

/**
 * The keyboard shortcuts (D0046): ? in the open dock while the keyboard is not in a text box, or
 * "Keyboard shortcuts" in the head's "…". Over the whole panel, which is as tall as the open dock
 * may be while it shows; Esc puts it away and nothing else.
 */
const sheet = shortcutsSheet(document, els.panel, {
  sections: () => guide({ mac: MAC, shell: shellKeys }),
  keys: () => state === "open",
  onChange: (on) => {
    els.panel.toggleAttribute("data-sheet", on);
    els.panel.style.minHeight = on ? `${SIZES.open.height}px` : "";
    if (!on) scheduleClose();
  },
});
// No shadow in the dock (its window is the island): the sheet is the panel's own colour (dock.css).
sheet.el.classList.remove("glass-float");
// Tooltips drawn inside the island, where the shell takes the mouse (an OS tooltip may not show for the dock at all).
tooltips(document, els.panel, { enabled: () => state === "open" });
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
/** The sessions the dock counts: archived ones are out of the way here too. */
const shown = () => [...sessions.values()].filter((s) => s.archived !== true);
/** The workspace the open dock lists ("" for all), remembered for the next time (dock-state.js). */
let workspace = savedWorkspace(storage());
/** The sessions the open dock lists and opens on: those of the workspace chosen. The pill counts them all. */
const listed = () => inWorkspace(shown(), workspace);

/** localStorage, or null where the page may not have it. */
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---------- the states ----------

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
    window.cleatDock?.setState(next);
  } catch {
    // No bridge worth the name: the page works the same without it.
  }
}

const LAYERS = { idle: els.pill, peek: els.peek, open: els.panel, chat: els.chat };

/**
 * Whether a layer is off. The chat is never taken out of the layout, only out of sight and reach
 * (data-off and inert, dock.css): its page stays laid out at its full size, ready to be seen.
 */
const isOff = (el) => (el === els.chat ? el.hasAttribute("data-off") : el.hidden);
function setOff(el, off) {
  if (el !== els.chat) {
    el.hidden = off;
    return;
  }
  el.toggleAttribute("data-off", off);
  el.inert = off;
}

/** Shows a state's content, or lets it fade out and then takes it away. */
function show(el, on) {
  if (on) {
    el.classList.remove("leaving");
    setOff(el, false);
    return;
  }
  if (isOff(el) || el.classList.contains("leaving")) return;
  el.classList.add("leaving");
  // Under prefers-reduced-motion nothing runs, and it goes at once.
  void Promise.allSettled(el.getAnimations().map((a) => a.finished)).then(() => {
    if (!el.classList.contains("leaving")) return;
    setOff(el, true);
    el.classList.remove("leaving");
  });
}

/**
 * Draws the island at the size its state and content ask for. Only the clip changes (dock.css):
 * no box changes size, here or in the shell.
 */
function resize() {
  const size = islandSize(state, { pill: els.pill.offsetWidth, panel: els.panel.offsetHeight, quiet: els.pill.dataset.tone === "none" }, NOTCH, CHAT);
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

/**
 * The most the island is drawn at (dock.css, --cap-w and --cap-h): open and chat are held inside
 * their rectangles, so a spring's overshoot flattens there; idle and peek are not held (null).
 */
function cap(size) {
  for (const el of [els.island, els.surface]) {
    if (size) {
      el.style.setProperty("--cap-w", `${size.width}px`);
      el.style.setProperty("--cap-h", `${size.height}px`);
    } else {
      el.style.removeProperty("--cap-w");
      el.style.removeProperty("--cap-h");
    }
  }
}

/** A duration of base.css, in milliseconds (`--dur-soft`, `--lag`). */
function ms(name) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

let fromTimer = 0;

/** Changes the state: the content swaps and the island's shape follows. */
function go(next) {
  const before = state;
  state = next;
  tellShell(next);
  els.island.dataset.state = next;
  clearTimeout(fromTimer);
  delete els.island.dataset.from;
  if (before === "chat" && next === "open") {
    // Back down from the chat: the shape shrinks on the soft spring, not held to the open dock's
    // rectangle until it is inside it (dock.css, [data-from="chat"]).
    els.island.dataset.from = "chat";
    cap(null);
    // Arrived: the height's spring, the later of the two, has ended. A timer in case no transition runs (reduced motion, nothing to move).
    const arrived = () => {
      clearTimeout(fromTimer);
      els.island.removeEventListener("transitionend", onEnd);
      if (els.island.dataset.from !== "chat") return;
      delete els.island.dataset.from;
      if (state === "open") cap(SIZES.open);
    };
    const onEnd = (e) => {
      if (e.target === els.island && e.propertyName === "--island-h") arrived();
    };
    els.island.addEventListener("transitionend", onEnd);
    fromTimer = setTimeout(arrived, 3 * (ms("--dur-soft") + 2 * ms("--lag")) + 200);
  } else cap(next === "open" || next === "chat" ? SIZES[next] : null);
  for (const [name, el] of Object.entries(LAYERS)) show(el, name === next);
  resize();
}

// The pill is as wide as its text and the panel as tall as its content: when either changes
// (another count, the font arriving, an answer streaming in), the island follows.
const sized = new ResizeObserver(() => resize());
sized.observe(els.pill);
sized.observe(els.panel);

// ---------- idle: the pill ----------

/**
 * Draws the pill. `quiet`: what the runner said on connecting, not news: a "needs you" in it doesn't
 * nudge.
 */
function renderPill(quiet = false) {
  const pill = pillOf(shown());
  const news = !quiet && pill.tone === "needs" && els.pill.dataset.tone !== "needs" && state === "idle";
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
  els.pill.style.height = `${islandSize("idle", { quiet: pill.tone === "none" }, NOTCH).height}px`;
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
  // Open, the list shows it; grown into the chat, its sidebar.
  if (!peek || state === "open" || state === "chat") return;
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
/**
 * True while the box has the focus only because the dock gave it (on opening, or after a hotkey):
 * the person has not clicked or typed in it, so it does not hold the dock open (holds). `pendingAuto`
 * is the same for a focus that waits for the box to be switched on again (wantFocus).
 */
let autoFocused = false;
let pendingAuto = false;
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
  edgesSoon();
});

let edgesQueued = false;

/**
 * Marks the stream's edges that have text past them (dock.css draws a hairline there): under the
 * head when it is scrolled down, above the reply box when there is more below.
 */
function edgesSoon() {
  if (edgesQueued) return;
  edgesQueued = true;
  requestAnimationFrame(() => {
    edgesQueued = false;
    const s = els.scroller;
    s.toggleAttribute("data-above", s.scrollTop > 1);
    s.toggleAttribute("data-below", s.scrollHeight - s.scrollTop - s.clientHeight > 1);
  });
}

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
  edgesSoon();
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
  edgesSoon();
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
  // An agent's questions: the card is a form to answer them, Answer and Skip (questions.js, D0039).
  const questions = questionsOf(event.toolName, event.input);
  const stateEl = h("span", "approval-state small", questions ? "Needs your answer" : "Needs your approval");
  head.append(h("span", "approval-tool", questions ? "Question" : String(event.toolName ?? "Tool")), stateEl);
  el.append(head);
  const view = questions ? { path: "", text: "", full: "" } : approvalView(event.toolName, event.input);
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
  const allow = h("button", "primary", questions ? "Answer" : "Allow");
  const deny = h("button", "", questions ? "Skip" : "Deny");
  const form = questions ? questionForm(questions, { onChange: () => (allow.disabled = !form.answers()), onSubmit: () => form.answers() && !allow.disabled && void answer("allow") }) : null;
  if (form) {
    el.append(form.el);
    allow.disabled = true;
  }
  const error = h("span", "approval-error muted small");
  error.setAttribute("role", "status");
  const buttons = [allow, deny];
  const answer = async (decision) => {
    const answers = decision === "allow" && form ? form.answers() : null;
    if (decision === "allow" && form && !answers) return;
    for (const b of buttons) b.disabled = true;
    form?.setDisabled(true);
    error.textContent = "";
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(event.approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(answers ? { decision, answers } : { decision }),
      });
      if (res.status === 404) throw new Error("this approval is no longer open");
      if (!res.ok) throw new Error(await errorText(res));
      // The buttons stay off: approval_resolved follows on the WebSocket and replaces them.
    } catch (e) {
      error.textContent = `Couldn't send: ${unreachable(e)}`;
      for (const b of buttons) b.disabled = false;
      form?.setDisabled(false);
      if (form) allow.disabled = !form.answers();
    }
  };
  allow.type = deny.type = "button";
  allow.addEventListener("click", () => void answer("allow"));
  deny.addEventListener("click", () => void answer("deny"));
  actions.append(allow, deny, error);
  el.append(actions);
  approvals.set(event.approvalId, { el, actions, state: stateEl, questions, form });
  // It arrives with a small bounce (dock.css, .approval.arrive).
  add(el);
}

/**
 * The card after its answer: what was decided, and no buttons. `decision` undefined: nobody answered.
 * A question card shows each question with the answer given, in the place of its form.
 */
function approvalDecided(card, decision, answers) {
  if (card.el.dataset.state !== "open") return;
  card.el.dataset.state = decision === "allow" || decision === "deny" ? decision : "unanswered";
  card.el.removeAttribute("aria-label");
  card.state.textContent = card.questions ? questionDecidedLabel(decision) : decidedLabel(decision);
  card.actions.remove();
  if (card.form) card.form.el.replaceWith(answersList(card.questions, decision === "allow" ? answers : null));
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
      if (card) approvalDecided(card, event.decision, event.answers);
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
  const ordered = switchOrder();
  const ids = new Set(ordered.map((s) => s.id));
  for (const id of [...rows.keys()]) {
    if (!ids.has(id)) {
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
        // Picked: the list makes way for the session, and typing goes to its reply.
        pick(session.id);
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
        agent: agentMark(document, agentOf(session)),
        title: h("span", "row-title"),
        mark: h("span", "terminal-mark mono muted small", ">_"),
        workspace: h("span", "row-workspace muted small"),
        time: h("time", "row-time muted small"),
        key: h("kbd", "row-key"),
      };
      row.mark.title = TERMINAL_MARK_TITLE;
      row.mark.setAttribute("aria-label", TERMINAL_MARK_TITLE);
      row.mark.setAttribute("role", "img");
      link.append(row.dot, row.agent, row.title, row.mark, row.workspace, row.time, row.key);
      item.append(link);
      rows.set(session.id, row);
    }
    row.dot.dataset.status = session.status;
    row.dot.title = sessionStatus(session);
    setAgentMark(row.agent, agentOf(session));
    row.title.textContent = session.title || "Untitled";
    row.title.classList.toggle("pinned", session.pinned === true);
    row.mark.hidden = !startedInTerminal(session);
    row.workspace.textContent = session.workspace;
    // One workspace chosen: every row is in it, so none says so.
    row.workspace.hidden = workspace !== "";
    row.time.dateTime = session.updatedAt;
    row.time.textContent = relativeTime(session.updatedAt, now);
    row.key.textContent = i < 9 ? `${COMMAND}${i + 1}` : "";
    row.key.hidden = i >= 9;
    row.link.toggleAttribute("data-active", listOpen && session.id === activeRow);
    if (session.id === selected) row.link.setAttribute("aria-current", "true");
    else row.link.removeAttribute("aria-current");
    // Moved only when the order changed, so a focused row keeps its focus.
    if (els.sessions.children[i] !== row.item) els.sessions.insertBefore(row.item, els.sessions.children[i] ?? null);
  });
  els.sessionsEmpty.textContent =
    listOpen && els.find.value.trim() ? "No session matches that." : workspace && shown().length > 0 ? `No sessions in ${workspace}.` : "No sessions yet. Start one with New task.";
  els.sessionsEmpty.hidden = ordered.length > 0;
  els.sessions.hidden = ordered.length === 0;
  renderWorkspaces();
  renderLive();
}

/** The waiting sessions the head has shown, so one that newly waits nudges its dot once. */
let liveWaiting = new Set();

/**
 * Beside the switch: the other sessions at work (waiting for the person first, then running), a
 * small chip each with its status's dot and the start of its title, the whole title and status the
 * tooltip. A press shows it. More than fit say "+n", which opens the switch.
 */
function renderLive() {
  const all = dockOrder(visible(sessions.values(), { workspace })).filter((s) => s.id !== selected && isLive(s));
  const others = liveOthers(all, null);
  const waiting = new Set(all.filter((s) => s.status === "waiting_approval").map((s) => s.id));
  els.live.replaceChildren();
  for (const session of others) {
    const button = h("button", "live-session quiet");
    button.type = "button";
    const label = `${session.title || "Untitled"}: ${sessionStatus(session)}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    const dot = h("span", "dot");
    dot.dataset.status = session.status;
    if (waiting.has(session.id) && !liveWaiting.has(session.id) && state === "open") {
      dot.dataset.nudge = "";
      dot.addEventListener("animationend", () => delete dot.dataset.nudge, { once: true });
    }
    button.append(dot, h("span", "live-title", session.title || "Untitled"));
    button.addEventListener("click", () => pick(session.id));
    els.live.append(button);
  }
  if (all.length > LIVE_MAX) {
    const more = h("button", "live-more quiet small", `+${all.length - LIVE_MAX}`);
    more.type = "button";
    more.title = `${all.length - LIVE_MAX} more at work`;
    more.addEventListener("click", () => showList(true));
    els.live.append(more);
  }
  liveWaiting = waiting;
  els.live.hidden = all.length === 0;
}

/** The workspace switch: "All workspaces", then each workspace that has a session, and the one chosen. */
function renderWorkspaces() {
  const names = dockWorkspaces(sessions.values(), workspace);
  const have = [...els.workspace.options].slice(1).map((o) => o.value);
  if (have.join("\n") !== names.join("\n")) {
    // Keep the first option ("All workspaces") and the select's <button> (base.css, .select).
    while (els.workspace.options.length > 1) els.workspace.options[1].remove();
    for (const name of names) {
      const o = h("option", "", name);
      o.value = name;
      els.workspace.append(o);
    }
  }
  els.workspace.value = workspace;
}

els.workspace.addEventListener("change", () => {
  workspace = els.workspace.value;
  saveWorkspace(storage(), workspace);
  renderList();
  // The session shown stays when it is in the workspace; else the dock opens on one that is.
  const current = selected ? sessions.get(selected) : undefined;
  if (!current || (workspace && current.workspace !== workspace)) select(preselect(listed(), null, null));
});

/** A refusal (or "Copied") said in the head, for a few seconds. */
function sayInHead(text) {
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
    sayInHead(`Couldn't ${verb}: ${e.message}`);
    return null;
  }
}

/** The menu's choice. Archived, a session leaves the list; the chat view's Archived view brings it back. */
async function act(id, action) {
  const session = sessions.get(id);
  if (!session) return;
  // The chat is the island grown large, on this session (D0042), not a window.
  if (action === "chat") goChat(id);
  else if (action === "keys") sheet.open();
  else if (action === "resume") await copyResume(session);
  else if (action === "pin") await run(session.pinned ? "unpin" : "pin", id, "pin", { pinned: !session.pinned });
  else if (action === "archive") await run(session.archived ? "unarchive" : "archive", id, "archive", { archived: !session.archived });
  else if (action === "rename") {
    const row = rows.get(id);
    if (!row) return;
    // The title is edited in its row: the list opens for it.
    showList(true);
    renaming = true;
    await renameInline(document, row.title, session.title || "", (title) => run("rename", id, "rename", { title }));
    renaming = false;
    scheduleClose();
  }
}

/** Copies the command that continues the session in a terminal, and says so in the head for a moment. */
async function copyResume(session) {
  const command = resumeCommand(session);
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    sayInHead("Copied");
  } catch {
    sayInHead("Couldn't copy");
  }
}

/**
 * True when the press that makes this click landed on "…" while its menu was open: the menu closed on
 * the press (chat-manage.js), and the click must not open it again. Seen first, in the capture phase.
 */
let moreWasOpen = false;
window.addEventListener("pointerdown", (e) => {
  moreWasOpen = menu.isOpen && e.target instanceof Node && els.more.contains(e.target);
}, true);

/** The head's "…": what the person may do with the session shown. A second press puts it away. */
els.more.addEventListener("click", () => {
  const session = selected ? sessions.get(selected) : undefined;
  if (moreWasOpen || menu.isOpen) {
    moreWasOpen = false;
    menu.close();
    return;
  }
  const keysItem = { action: "keys", label: "Keyboard shortcuts" };
  els.more.setAttribute("aria-expanded", "true");
  if (!session) {
    menu.open([keysItem], els.more, (action) => action === "keys" && sheet.open());
    return;
  }
  const items = [{ action: "chat", label: "Open in chat" }];
  if (resumeCommand(session)) items.push({ action: "resume", label: "Continue in terminal" });
  menu.open([...items, ...menuItems(session, false), keysItem], els.more, (action) => void act(session.id, action));
});
new MutationObserver(() => {
  if (!menu.isOpen) els.more.setAttribute("aria-expanded", "false");
}).observe(menu.el, { attributes: true, attributeFilter: ["hidden"] });

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
  // With no session at all there is nothing to switch to (the line under the head says so).
  els.switcher.hidden = shown().length === 0;
  // With no session the "…" still has the keyboard shortcuts.
  els.more.hidden = false;
  if (!session) {
    els.title.textContent = "Sessions";
    els.switcher.title = tip("Switch session", "dock.switch");
    delete els.switcherDot.dataset.status;
    headAgent.hidden = true;
    headStatus.hidden = !manageError;
    headStatus.textContent = manageError;
    stopButton.hidden = true;
    return;
  }
  els.title.textContent = session.title || "Untitled";
  els.switcher.title = `${session.title || "Untitled"}\n${tip("Switch session", "dock.switch")}`;
  els.switcherDot.dataset.status = session.status;
  els.switcherDot.title = sessionStatus(session);
  const kind = agentOf(session);
  headAgent.hidden = false;
  if (headAgent.dataset.agent !== kind) {
    headAgent.dataset.agent = kind;
    headAgent.replaceChildren(agentSvg(document, kind));
    headAgent.title = agentName(kind);
    headAgent.setAttribute("aria-label", agentName(kind));
  }
  const status = sessionStatus(session);
  headStatus.textContent = manageError || (status === "in terminal" ? status : "");
  headStatus.hidden = !headStatus.textContent;
  stopButton.hidden = !canStop(session);
  stopButton.disabled = stopping === session.id;
  stopButton.textContent = stopping === session.id ? "Stopping" : "Stop";
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
  if (!enabled && document.activeElement === els.text) {
    wantFocus = true;
    pendingAuto = autoFocused;
  }
  els.text.disabled = !enabled;
  // What the box is for now is its placeholder; the line under it is only for what went wrong.
  els.text.placeholder = replying.hint || "Reply";
  if (!sending && openElsewhere === selected && selected) {
    // Refused as open in a terminal: say so, and offer to send it all the same.
    const anyway = h("button", "send-anyway quiet small", "Send anyway");
    anyway.type = "button";
    anyway.addEventListener("click", () => void send(true));
    els.hint.replaceChildren(`${OPEN_IN_TERMINAL_HINT} `, anyway);
    els.hint.hidden = false;
  } else {
    els.hint.textContent = replyError ? `Couldn't send: ${replyError}` : "";
    els.hint.hidden = !replyError;
  }
  // Back to the box after the turn, unless the person has moved on or the dock has closed.
  if (enabled && wantFocus) {
    wantFocus = false;
    const active = document.activeElement;
    if (state === "open" && (active === null || active === document.body || active === els.text)) {
      els.text.focus({ preventScroll: true });
      autoFocused = pendingAuto;
    }
    pendingAuto = false;
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
els.text.addEventListener("blur", () => {
  autoFocused = false;
  scheduleClose();
});
// The person's own click in the box: from now on its focus holds the dock open.
els.text.addEventListener("pointerdown", () => {
  autoFocused = false;
});

/**
 * Puts the keyboard in the reply box, so the person can type at once. `auto`: the dock did it, not
 * the person, so it does not hold the dock open. A box switched off (a turn running) gets it when it
 * comes back on.
 */
function focusReply(auto) {
  if (state !== "open") return;
  if (els.text.disabled) {
    wantFocus = true;
    pendingAuto = auto;
    return;
  }
  els.text.focus({ preventScroll: true });
  autoFocused = auto;
}
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
  // Remembered for the next opening (preselect).
  saveSession(storage(), id);
  els.text.value = (id && typed.get(id)) || "";
  renderList();
  // The list, when open, shows about four rows: the one shown is one of them.
  if (id && listOpen) rows.get(id)?.item.scrollIntoView({ block: "nearest" });
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
  return onIsland(state, drawn, x - (box.left + box.width / 2), y - box.top, NOTCH, CHAT);
}

/**
 * True after the chat stepped back down to the open dock (Esc): the pointer may be anywhere the chat
 * was, so the open dock stays until the pointer has come onto it and left it again, or Esc, a press
 * beside it or another app's window puts it away.
 */
let steppedDown = false;

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
  steppedDown = false;
  clearTimeout(closeTimer);
  // Hover opens the small dock from the pill or a peek; the chat is grown into by a click (clickAction).
  if (state === "idle" || state === "peek") openTimer = setTimeout(() => inside && (state === "idle" || state === "peek") && open(), OPEN_MS);
}

/** True while the workspace switch's list is open: it may hang past the island's edge. */
function picking() {
  try {
    return els.workspace.matches(":open");
  } catch {
    // No :open in this browser: its list is the system's own, and the pointer can't leave for it.
    return false;
  }
}

function holds() {
  return {
    pointerInside: inside,
    pointerDown: down,
    // A row's menu, its title being edited, or a find being typed holds it open as a focused reply box does.
    replyFocused: (document.hasFocus() && document.activeElement === els.text && !autoFocused) || menu.isOpen || sheet.isOpen || renaming || picking() || (document.hasFocus() && listOpen && els.find.value !== "") || steppedDown,
    // A draft holds it open only while the dock has the keyboard: once the person has gone to another
    // app, nothing they could press reaches the dock (not Esc, not a press beside it), so it closes
    // when the pointer is away, and the draft is kept for when it opens again.
    replyText: document.hasFocus() ? els.text.value : "",
  };
}

/**
 * Opens the small dock. `onto`: on that session (stepping down from the chat), else on the dock's own
 * pick (preselect).
 */
function open(onto = null) {
  if (state === "open") return;
  clearTimeout(peekTimer);
  // Each opening starts on the workspace the person chose. A session that peeked from another one is
  // shown all the same: this time the list shows them all, and the choice stays for the next.
  workspace = savedWorkspace(storage());
  const peeked = onto ?? peeking?.sessionId ?? null;
  if (workspace && peeked && sessions.has(peeked) && sessions.get(peeked).workspace !== workspace) workspace = "";
  const pick = onto && sessions.has(onto) ? onto : preselect(listed(), peeked, lastPeeked, savedSession(storage()));
  // Opened, the peeks are answered by the list.
  peeking = null;
  queue = [];
  lastPeeked = null;
  showList(false);
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
  // The keyboard is the dock's while it is open (the shell focuses the window): typing goes straight into the reply.
  focusReply(true);
}

function close() {
  clearTimeout(closeTimer);
  if (state !== "open" && state !== "chat") return;
  if (state === "chat") embed()?.hide();
  sheet.close(false);
  steppedDown = false;
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
  // The workspace switch's list may hang past the island: a press on it is a press on the dock.
  const on = over(e.clientX, e.clientY) || (e.target instanceof Element && els.workspace.contains(e.target));
  point(on);
  // A press beside the open dock or the chat puts it away at once, whatever is typed in it: the draft is kept.
  if ((state === "open" || state === "chat") && !on) close();
  else down = true;
});
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    down = false;
    scheduleClose();
  });
}
// The person went to another window: the reply box, empty or not, no longer holds the dock open (holds).
window.addEventListener("blur", () => {
  down = false;
  scheduleClose();
  focusGoneSoon();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing && state === "chat") {
    e.preventDefault();
    stepDown();
    return;
  }
  // Esc in the workspace switch's open list closes the list, not the dock.
  if (e.key !== "Escape" || e.isComposing || state !== "open" || picking()) return;
  e.preventDefault();
  // The list open: Esc puts the list away, and a second one the dock.
  if (listOpen) {
    showList(false);
    focusReply(true);
    return;
  }
  close();
});

// ⌘K: the switch, open or closed. ⌘1..9: the session in that row of the switch. Ctrl+Tab and
// Alt+Down, Ctrl+Shift+Tab and Alt+Up: the next one or the one before (dock-state.js, dockKey, D0040).
// Picked by a key, the keyboard goes to the reply box.
document.addEventListener("keydown", (e) => {
  if (state !== "open" || picking() || menu.isOpen || sheet.isOpen || renaming) return;
  const key = dockKey(e);
  if (!key) return;
  e.preventDefault();
  if ("find" in key) {
    showList(!listOpen);
    if (!listOpen) focusReply(true);
    return;
  }
  const ids = switchOrder().map((s) => s.id);
  const next = "nth" in key ? ids[key.nth - 1] : stepSession(ids, listOpen ? activeRow : selected, key.step);
  if (!next) return;
  if (listOpen && "step" in key) {
    // In the open switch a step only moves the highlight, as Up and Down do in its find.
    activeRow = next;
    renderList();
    rows.get(next)?.item.scrollIntoView({ block: "nearest" });
    return;
  }
  const auto = document.activeElement !== els.text || autoFocused;
  if (next !== selected) select(next);
  if (listOpen) showList(false);
  focusReply(auto);
});

/**
 * A task the person just started (the pop-up, the snip, New task) becomes the notch's session: the
 * next opening shows it, an open dock or chat switches to it at once, and the choice is remembered.
 * News that arrives after it (a peek) still wins, as for any session.
 */
function showStarted(session) {
  lastPeeked = session.id;
  saveSession(storage(), session.id);
  if (state === "open") {
    // In a workspace the dock is not filtering on: this time the list shows them all.
    if (workspace && session.workspace !== workspace) {
      workspace = "";
      renderList();
    }
    select(session.id);
  } else if (state === "chat") {
    embed()?.show(session.id);
  }
}

// ---------- the chat: the island grown large (D0042) ----------

/** What the chat's page lets the dock ask of it (chat.js, window.cleatEmbed), or null until it has loaded. */
function embed() {
  try {
    return els.chatFrame.contentWindow?.cleatEmbed ?? null;
  } catch {
    return null;
  }
}
/** The session to show once the chat's page is there: asked for before it had loaded ("" for its own pick). */
let chatWanted = null;

/**
 * Grows the island into the chat, on a session: the one given, else the one the small dock shows
 * (open), the one peeking, or the dock's usual pick. The chat's page is already laid out in it; it
 * comes into sight as the shape grows, and the keyboard goes to its reply box.
 */
function goChat(id = null) {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  clearTimeout(peekTimer);
  const pick = id ?? (state === "open" ? selected : preselect(listed(), peeking?.sessionId ?? null, lastPeeked, savedSession(storage())));
  peeking = null;
  queue = [];
  lastPeeked = null;
  steppedDown = false;
  if (listOpen) showList(false);
  menu.close();
  sheet.close(false);
  if (pick) saveSession(storage(), pick);
  if (state !== "chat") go("chat");
  // The frame first, so the keyboard is in the chat even while its reply box is off (a turn running).
  els.chatFrame.focus({ preventScroll: true });
  const chat = embed();
  if (chat) chat.show(pick);
  else chatWanted = pick ?? "";
}

/** Back down from the chat to the small dock (Esc, its button, the notch's band), on the session the chat shows. */
function stepDown() {
  if (state !== "chat") return;
  const chat = embed();
  const id = chat?.selected?.() ?? selected;
  chat?.hide();
  // Wherever the pointer is, it is on the open dock only once it moves there (point).
  inside = false;
  open(typeof id === "string" ? id : null);
  steppedDown = true;
}

/** The window lost the keyboard to another app (not to the chat's own frame): the chat is put away, as a press beside it would. */
function focusGoneSoon() {
  setTimeout(() => {
    if (state === "chat" && !document.hasFocus()) close();
  }, 60);
}

els.chatFrame.addEventListener("load", () => {
  const win = els.chatFrame.contentWindow;
  win?.addEventListener("blur", focusGoneSoon);
  if (state === "chat" && chatWanted !== null) embed()?.show(chatWanted || null);
  chatWanted = null;
});

// The chat's page asks to step back down (its Esc, its button). Only its own frame, on this origin.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== els.chatFrame.contentWindow) return;
  if (e.data?.cleatEmbed === "down") stepDown();
});

// One click from the notch to the chat (dock-state.js, clickAction): the pill, the peek, the notch's
// band over the open dock or its head; the band over the chat steps it back down.
window.addEventListener("click", (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !over(e.clientX, e.clientY)) return;
  const target = e.target instanceof Element ? e.target : null;
  const control = target?.closest("button, a, input, select, textarea, label, summary, .menu, [contenteditable]") != null;
  const head = target?.closest(".panel-head") != null;
  const action = clickAction(state, { y: e.clientY - els.island.getBoundingClientRect().top, head, control }, NOTCH);
  if (action === "chat") goChat(state === "peek" ? peeking?.sessionId ?? null : null);
  else if (action === "down") stepDown();
});
els.expand.addEventListener("click", () => goChat(selected));

// The shell asks for the chat (its tray's Open chat, a link to the chat view anywhere): the island grows into it.
try {
  window.cleatDock?.onChat?.((id) => goChat(typeof id === "string" && id ? id : null));
} catch {
  // A bridge without it: the chat is grown into from the page only.
}

// The chat's own hotkey (D0046): it grows the island into the chat from wherever the dock is, and
// pressed again while the chat is shown, puts it away. The shell gives the dock the keyboard when it
// hears "chat", as for a click.
try {
  window.cleatDock?.onChatKey?.(() => {
    if (state === "chat") close();
    else goChat(null);
  });
} catch {
  // An older bridge: the hotkey opens the chat through onChat.
}

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
      else select(preselect(listed(), null, null));
      renderHead();
      renderReply();
      break;
    }
    case "session": {
      const session = message.session;
      if (!session?.id) break;
      const started = justStarted(session, sessions.has(session.id), Date.now());
      sessions.set(session.id, session);
      renderPill();
      checkPeek();
      if (started) showStarted(session);
      if (state !== "open") break;
      if (!selected && (!workspace || session.workspace === workspace)) select(session.id);
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
      if (id === selected) select(preselect(listed(), null, null));
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
    case "settings":
      shellKeys = message.settings?.shell ?? null;
      renderTips();
      if (sheet.isOpen) sheet.open();
      break;
  }
}

/** The settings, once: the person's global hotkeys, for the tooltips and the guide. Later changes come on the socket. */
async function loadKeys() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    shellKeys = (await res.json())?.shell ?? null;
    renderTips();
  } catch {
    // The defaults stay; the socket's next settings message has them.
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
els.island.style.width = `${WINDOW.width}px`;
els.island.style.height = `${WINDOW.height}px`;
// Out of a notch (dock.css, [data-notch]): the pill spans the notch and its wings, and the peek's
// line and the panel's content start below the notch's band.
if (NOTCH) {
  els.island.dataset.notch = "";
  els.island.style.setProperty("--notch-w", `${NOTCH.width}px`);
  els.island.style.setProperty("--notch-h", `${NOTCH.height}px`);
  els.island.style.setProperty("--wing", `${(SIZES.idle.width - NOTCH.width) / 2}px`);
  els.pill.style.width = `${SIZES.idle.width}px`;
} else els.pill.style.maxWidth = `${SIZES.idle.width}px`;
els.peek.style.width = `${SIZES.peek.width}px`;
els.peek.style.height = `${DOCK_SIZES.peek.height}px`;
els.panel.style.width = `${SIZES.open.width}px`;
els.panel.style.maxHeight = `${SIZES.open.height}px`;
els.chat.style.width = `${SIZES.chat.width}px`;
els.chat.style.height = `${SIZES.chat.height}px`;
renderPill();
renderTips();
go("idle");
connect();
void loadKeys();
// The chat's page, loaded once and kept (D0042): soon after the dock's own, so it does not hold up the pill.
setTimeout(() => {
  els.chatFrame.src = "/?embed=dock";
}, 300);
