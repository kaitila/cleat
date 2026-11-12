// The chat view: sessions in the sidebar, the selected one's events as a stream, a reply box.
// The contract is docs/protocol.md. Text from the model, from tools and from the person is untrusted:
// it reaches the page only as text nodes (textContent), never as markup.
import {
  approvalView,
  backoffMs,
  byActivity,
  cutResult,
  decidedLabel,
  inputText,
  pickSession,
  relativeTime,
  replyState,
  resultLine,
  splitMarkdown,
  statusLabel,
  toolSummary,
  unknownNote,
} from "./chat-format.js";

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
};

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
let wantFocus = true;
/** True while the person is at the bottom of the stream: new events keep it there. */
let stick = true;
let followQueued = false;

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

/** Adds to the end of the stream, above the text that is still streaming. */
function add(el) {
  els.stream.insertBefore(el, streamedEl?.parentNode === els.stream ? streamedEl : null);
  follow();
  return el;
}

function renderMarkdown(el, text) {
  el.replaceChildren(
    ...splitMarkdown(text).map((block) => {
      if (block.type === "code") {
        const pre = h("pre", "code-block");
        pre.append(h("code", "", block.text));
        return pre;
      }
      const p = h("p");
      for (const span of block.spans) p.append(span.code ? h("code", "", span.text) : document.createTextNode(span.text));
      return p;
    }),
  );
}

/** Shows (or removes) the selected session's streaming text as the last thing in the stream. */
function renderStreamed() {
  const text = selected ? streamed.get(selected) : undefined;
  if (!text) {
    streamedEl?.remove();
    streamedEl = null;
    return;
  }
  if (!streamedEl) streamedEl = h("div", "msg assistant streaming");
  renderMarkdown(streamedEl, text);
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
  const result = h("pre", "tool-result muted", "Waiting for the result.");
  body.append(h("div", "tool-label muted small", "Input"), h("pre", "tool-input", inputText(input, 2)), h("div", "tool-label muted small", "Result"), result);
  details.append(summary, body);
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

/** A cut text with a "show all" button after it, as a tool result has. */
function showAll(pre, full, parent) {
  const all = h("button", "show-all small", "show all");
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
    const pre = h("pre", "approval-input", view.text);
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
      const el = add(h("div", "msg user"));
      el.append(h("div", "user-text", event.text));
      if (event.imagePath) el.append(h("div", "attachment mono muted", event.imagePath));
      break;
    }
    case "assistant_text":
      renderMarkdown(add(h("div", "msg assistant")), event.text);
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
      add(h("div", event.ok ? "note muted small" : "note error small", resultLine(event)));
      if (!event.ok && event.text) add(h("div", "error", event.text));
      break;
    case "error":
      endOpenTools();
      endOpenApprovals();
      add(h("div", "error", event.message));
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

function renderSidebar() {
  const ordered = byActivity(sessions.values());
  for (const id of [...rows.keys()]) {
    if (!sessions.has(id)) {
      rows.get(id).item.remove();
      rows.delete(id);
    }
  }
  const now = Date.now();
  ordered.forEach((session, i) => {
    let row = rows.get(session.id);
    if (!row) {
      const item = h("li");
      const link = h("a", "session");
      link.href = `/?session=${encodeURIComponent(session.id)}`;
      link.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(session.id, true);
      });
      row = { item, link, dot: h("span", "dot"), title: h("span", "session-title"), time: h("time", "session-time muted small"), workspace: h("span", "session-workspace muted small") };
      link.append(row.dot, row.title, row.time, row.workspace);
      item.append(link);
      rows.set(session.id, row);
    }
    row.dot.dataset.status = session.status;
    row.dot.title = statusLabel(session.status);
    row.title.textContent = session.title || "Untitled";
    row.workspace.textContent = session.workspace;
    row.time.dateTime = session.updatedAt;
    row.time.textContent = relativeTime(session.updatedAt, now);
    if (session.id === selected) row.link.setAttribute("aria-current", "true");
    else row.link.removeAttribute("aria-current");
    // Moved only when the order changed, so a focused row keeps its focus.
    if (els.sessions.children[i] !== row.item) els.sessions.insertBefore(row.item, els.sessions.children[i] ?? null);
  });
  els.sessionsEmpty.hidden = sessions.size > 0;
  els.empty.hidden = sessions.size > 0;
  els.stream.hidden = sessions.size === 0;
}

function renderHead() {
  const session = selected ? sessions.get(selected) : undefined;
  els.head.hidden = !session;
  document.title = session ? `${session.title || "Untitled"} · intuition` : "intuition";
  if (!session) return;
  els.title.textContent = session.title || "Untitled";
  els.dot.dataset.status = session.status;
  els.workspace.textContent = session.workspace;
  els.status.textContent = statusLabel(session.status);
}

// ---------- the reply box ----------

function grow() {
  els.text.style.height = "auto";
  els.text.style.height = `${els.text.scrollHeight + 2}px`;
}

function renderReply() {
  const session = selected ? sessions.get(selected) : undefined;
  els.reply.hidden = !session;
  const state = replyState(session);
  const enabled = state.enabled && !sending;
  if (!enabled && document.activeElement === els.text) wantFocus = true;
  els.text.disabled = !enabled;
  els.hint.textContent = replyError ? `Couldn't send: ${replyError}` : sending ? "Sending." : state.hint;
  // Back to the box once, at the start and after a turn, unless the person has moved on to something else.
  if (enabled) {
    const active = document.activeElement;
    if (wantFocus && (active === null || active === document.body || active === els.text)) els.text.focus();
    wantFocus = false;
  }
}

async function send() {
  const id = selected;
  const prompt = els.text.value;
  if (!id || sending || !prompt.trim() || !replyState(sessions.get(id)).enabled) return;
  sending = true;
  replyError = "";
  wantFocus = true;
  renderReply();
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(await errorText(res));
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
  els.text.value = (id && typed.get(id)) || "";
  renderSidebar();
  renderHead();
  renderReply();
  grow();
  renderStreamed();
  void catchUp();
}

window.addEventListener("popstate", () => select(pickSession([...sessions.values()], wanted() ?? selected)));

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
        select(pickSession([...sessions.values()], wanted()));
        renderSidebar();
      }
      break;
    }
    case "session": {
      const session = message.session;
      if (!session?.id) break;
      sessions.set(session.id, session);
      if (!selected) select(pickSession([...sessions.values()], wanted()));
      renderSidebar();
      if (session.id === selected) {
        renderHead();
        renderReply();
      }
      break;
    }
    case "event": {
      const event = message.event;
      if (!event) break;
      // The complete text (or the turn's end) replaces what was streamed.
      if (event.kind === "assistant_text" || event.kind === "result" || event.kind === "error") streamed.delete(message.sessionId);
      if (message.sessionId !== selected) break;
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
      if (message.sessionId === selected) renderStreamed();
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
