// The pop-up prompt (/prompt): pick a workspace, type a task, Enter starts the session.
// The shell opens it in a small window on the hotkey, so everything works from the keyboard:
// Enter starts, Shift+Enter is a new line, Alt+1..9 picks a workspace, Alt+A flips the agent
// (Claude Code or Codex, the workspace's own until flipped), Esc closes.
// The shell captures the clipboard as the window opens: the capture shows under the task box and
// goes with the task, unless it is removed (its × or Alt+Backspace).
// The API is docs/protocol.md; the types are src/shared/protocol.ts.
import { agentName, agentSvg, flipAgent, isAgentKey, pickAgent, taskPlaceholder } from "./agent.js";

export const UNREACHABLE = "the runner is not reachable";

/**
 * The workspace selected when the page opens: the last one used if its folder is there,
 * otherwise the first whose folder is. Null when none can be picked.
 */
export function initialWorkspace(workspaces, lastUsed) {
  const usable = workspaces.filter((w) => w.exists);
  return (usable.find((w) => w.name === lastUsed) ?? usable[0])?.name ?? null;
}

/**
 * The position (from 0) that Alt+1..9 asks for, or null for any other key. It reads the physical
 * key first: with Alt held, some keyboard layouts report another character in `key`.
 */
export function altDigit(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")?.[1] ?? (/^[1-9]$/.test(event.key ?? "") ? event.key : null);
  return digit ? Number(digit) - 1 : null;
}

/** The line shown for an answer that isn't a success: the runner's own error text if it sent one. */
export function errorText(status, body) {
  const text = body && typeof body === "object" && typeof body.error === "string" ? body.error.trim() : "";
  return text || `the runner answered ${status}`;
}

/** Why no workspace can be picked: there are none yet, or none of their folders exists. Settings (the tray menu) adds and fixes them. */
export function noWorkspaceText(workspaces) {
  return workspaces.length === 0 ? "no workspaces yet: add one in Settings, from the tray menu" : "no workspace folder exists: fix the paths in Settings, from the tray menu";
}

/** A capture older than this was not made for this pop-up, and is not attached. */
export const FRESH_MS = 30_000;
/** When the page asks for the capture, in ms after it loads: the shell posts it while the window opens. */
export const CLIPBOARD_POLLS = [0, 150, 400, 800, 1300, 2000];

/**
 * What a capture attaches: its image, else its text, or null when it has neither, is older than
 * FRESH_MS, or is not a capture at all.
 */
export function attachmentOf(capture, now = Date.now()) {
  if (!capture || typeof capture !== "object" || typeof capture.capturedAt !== "string") return null;
  const age = now - Date.parse(capture.capturedAt);
  // A little slack for a capture stamped just ahead of this clock.
  if (!(age <= FRESH_MS && age >= -5000)) return null;
  const base = { capturedAt: capture.capturedAt };
  if (typeof capture.imagePath === "string" && capture.imagePath) return { ...base, kind: "image", imagePath: capture.imagePath };
  if (typeof capture.text === "string" && capture.text.trim()) return { ...base, kind: "text", text: capture.text };
  return null;
}

/** The first two lines of clipboard text that have something on them, each cut to 200 characters. */
export function preview(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((line) => line.slice(0, 200))
    .join("\n");
}

/**
 * The body of POST /api/sessions: an attached image goes by its path, attached text after the task,
 * and the agent shown on the switch, when there is one.
 */
export function sessionBody(workspace, task, attachment, agent = null) {
  const on = agent === "claude" || agent === "codex" ? { agent } : {};
  if (attachment?.kind === "image") return { workspace, prompt: task, imagePath: attachment.imagePath, ...on };
  if (attachment?.kind === "text") return { workspace, prompt: `${task.trimEnd()}\n\nClipboard:\n${attachment.text}`, ...on };
  return { workspace, prompt: task, ...on };
}

/** Fetches JSON from the runner. Throws an Error whose message is the line to show. */
async function api(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error(UNREACHABLE);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(res.status, body));
  return body;
}

function start() {
  const form = document.getElementById("prompt");
  const row = document.getElementById("workspaces");
  const task = document.getElementById("task");
  const status = document.getElementById("status");
  let loaded = false;
  let busy = false;
  const clip = document.getElementById("clipboard");
  /** The capture that goes with the task, or null. */
  let attachment = null;
  /** capturedAt of the capture that was removed: a later poll doesn't bring it back. */
  let removed = null;
  const agentButton = document.getElementById("agent");
  /** The workspaces as the runner sent them, for each one's agent. */
  let listed = [];
  /** The agent the person flipped to, or null to follow the workspace's. */
  let agentOverride = null;
  const agent = () => pickAgent(listed, chosen(), agentOverride);

  /** The chosen workspace's background, behind the chips (prompt.css). */
  const mark = document.createElement("span");
  mark.className = "workspace-mark";
  mark.setAttribute("aria-hidden", "true");
  /** Where the mark was last put, for the slide from there. */
  let markAt = null;

  const say = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const radios = () => [...row.querySelectorAll("input")];
  const chosen = () => radios().find((r) => r.checked)?.value ?? null;

  function draw({ workspaces, lastUsed }) {
    const selected = initialWorkspace(workspaces, lastUsed);
    row.replaceChildren(
      ...workspaces.map((w, i) => {
        const label = document.createElement("label");
        label.className = "workspace";
        label.title = w.exists ? w.path : `${w.path} is missing`;
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "workspace";
        radio.value = w.name;
        radio.disabled = !w.exists;
        radio.checked = w.name === selected;
        const chip = document.createElement("span");
        if (i < 9) {
          const key = document.createElement("kbd");
          key.textContent = String(i + 1);
          radio.setAttribute("aria-keyshortcuts", `Alt+${i + 1}`);
          chip.append(key);
        }
        chip.append(w.name);
        label.append(radio, chip);
        return label;
      }),
      mark,
    );
    listed = workspaces;
    markAt = null;
    placeMark();
    drawAgent();
    loaded = true;
    if (selected === null) say(noWorkspaceText(workspaces), "error");
  }

  async function load() {
    try {
      draw(await api("/api/workspaces"));
    } catch (e) {
      say(e.message, "error");
    }
  }

  /**
   * Puts the mark behind the chosen chip. From where it was, it slides: it is set at once to the new
   * chip's width and place, drawn where it was with a transform, then let go to the new place on
   * the transition (FLIP), so only the transform animates.
   */
  function placeMark() {
    const span = row.querySelector("input:checked + span");
    mark.hidden = span === null;
    if (span === null) return row.removeAttribute("data-mark");
    const to = { x: span.offsetLeft + span.parentElement.offsetLeft, y: span.offsetTop + span.parentElement.offsetTop, width: span.offsetWidth };
    const from = markAt;
    markAt = to;
    mark.style.width = `${to.width}px`;
    row.setAttribute("data-mark", "");
    const at = (p, scale) => `translate(${p.x}px, ${p.y}px) scaleX(${scale})`;
    if (from === null || (from.x === to.x && from.y === to.y && from.width === to.width)) {
      delete mark.dataset.moving;
      mark.style.transform = at(to, 1);
      return;
    }
    delete mark.dataset.moving;
    mark.style.transform = at(from, from.width / to.width);
    void mark.offsetWidth;
    mark.dataset.moving = "";
    mark.style.transform = at(to, 1);
  }

  /** The switch shows the agent the task starts on: its glyph and name; the task box asks who does it. */
  function drawAgent() {
    const kind = agent();
    agentButton.hidden = false;
    agentButton.dataset.agent = kind;
    const name = document.createElement("span");
    name.textContent = agentName(kind);
    agentButton.replaceChildren(agentSvg(document, kind), name);
    agentButton.title = `Starts on ${agentName(kind)}. Alt+A switches to ${agentName(flipAgent(kind))}`;
    agentButton.setAttribute("aria-label", `Agent: ${agentName(kind)}. Switch to ${agentName(flipAgent(kind))}`);
    task.placeholder = taskPlaceholder(kind);
  }

  function flip() {
    agentOverride = flipAgent(agent());
    drawAgent();
    // It springs a little each time it turns (prompt.css).
    agentButton.removeAttribute("data-in");
    void agentButton.offsetWidth;
    agentButton.setAttribute("data-in", "");
  }

  function drawAttachment() {
    clip.hidden = attachment === null;
    if (attachment === null) return clip.replaceChildren();
    let what;
    if (attachment.kind === "image") {
      what = document.createElement("img");
      what.className = "clip-image";
      what.alt = "Image from the clipboard";
      what.src = `/api/clipboard/image?at=${encodeURIComponent(attachment.capturedAt)}`;
    } else {
      what = document.createElement("span");
      what.className = "clip-text mono";
      what.textContent = preview(attachment.text);
    }
    const label = document.createElement("span");
    label.className = "clip-label label";
    label.textContent = attachment.kind === "image" ? "Clipboard image" : "Clipboard";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "clip-remove quiet small";
    remove.textContent = "×";
    remove.title = "Remove (Alt+Backspace)";
    remove.setAttribute("aria-label", "Remove the clipboard attachment");
    remove.setAttribute("aria-keyshortcuts", "Alt+Backspace");
    remove.addEventListener("click", removeAttachment);
    clip.replaceChildren(label, what, remove);
    // It springs in each time a capture arrives (prompt.css).
    clip.removeAttribute("data-in");
    void clip.offsetWidth;
    clip.setAttribute("data-in", "");
  }

  function removeAttachment() {
    if (attachment === null) return;
    removed = attachment.capturedAt;
    attachment = null;
    drawAttachment();
    task.focus();
  }

  /** Takes the runner's latest capture when it is fresh, new to the page and not the one removed. */
  async function pollClipboard() {
    let found;
    try {
      found = attachmentOf(await api("/api/clipboard"));
    } catch {
      return; // The workspace load already says when the runner can't be reached.
    }
    if (busy || found === null || found.capturedAt === removed || found.capturedAt === attachment?.capturedAt) return;
    // An older answer that arrives late doesn't replace a newer capture.
    if (attachment !== null && Date.parse(found.capturedAt) < Date.parse(attachment.capturedAt)) return;
    attachment = found;
    drawAttachment();
  }

  function started(session) {
    task.value = "";
    attachment = null;
    drawAttachment();
    window.close();
    // Still here a moment later: the browser refused to close a window it didn't open.
    setTimeout(() => {
      const link = document.createElement("a");
      link.href = `/?session=${encodeURIComponent(session.id)}`;
      link.textContent = "open the session";
      status.dataset.kind = "";
      status.replaceChildren("Started: ", link);
    }, 150);
  }

  async function submit() {
    const prompt = task.value;
    if (busy || !prompt.trim()) return;
    busy = true;
    try {
      if (!loaded) draw(await api("/api/workspaces"));
      const workspace = chosen();
      if (workspace === null) {
        if (!status.textContent) say("pick a workspace", "error");
        return;
      }
      say("Starting…");
      const { session } = await api("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionBody(workspace, prompt, attachment, agent())),
      });
      started(session);
    } catch (e) {
      // The task stays in the box, to send again.
      say(e.message, "error");
    } finally {
      busy = false;
    }
  }

  form.addEventListener("submit", (e) => e.preventDefault());
  // A click on a workspace goes back to typing. Keyboard changes (arrows) keep their focus.
  row.addEventListener("change", () => {
    placeMark();
    drawAgent();
  });
  agentButton.addEventListener("click", (e) => {
    flip();
    if (e.detail > 0) task.focus();
  });
  row.addEventListener("click", (e) => {
    if (e.detail > 0) task.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      window.close();
      return;
    }
    // Enter on the "open the session" link follows the link.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(e.target instanceof HTMLAnchorElement)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Backspace" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Always swallowed: in a text box Alt+Backspace is undo, which would surprise here.
      e.preventDefault();
      removeAttachment();
      return;
    }
    if (isAgentKey(e)) {
      // Swallowed: on a Mac Option+A would type a character.
      e.preventDefault();
      if (!busy) flip();
      return;
    }
    const position = altDigit(e);
    if (position === null) return;
    e.preventDefault();
    const radio = radios()[position];
    if (radio && !radio.disabled) {
      radio.checked = true;
      placeMark();
      drawAgent();
    }
  });

  // Chip widths change when Geist has loaded, or the window does: the mark goes there at once.
  const replaceMark = () => {
    markAt = null;
    placeMark();
  };
  void document.fonts?.ready.then(replaceMark);
  window.addEventListener("resize", replaceMark);
  task.focus();
  void load();
  for (const ms of CLIPBOARD_POLLS) setTimeout(() => void pollClipboard(), ms);
}

if (typeof document !== "undefined") start();
