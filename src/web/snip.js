// The snip overlay (/assets/snip.html): the shell opens one per display on the snip hotkey, each on
// its own frozen capture. Drag an area (a click takes the whole display), and a prompt box appears
// under it, centred, with the focus in it: type the task, Enter starts the session with the area attached.
// Tab or ⌘1..9 (Ctrl+1..9 off a Mac) switches the workspace, Alt+A flips the agent (the workspace's own until flipped),
// Shift+Enter is a new line, Esc closes every overlay.
// The shell's half is window.intuitionSnip (shell/src/snip-preload.ts): getCapture(), crop(rect)
// and close(). The runner's half is POST /api/sessions (docs/protocol.md).
import { agentName, agentSvg, flipAgent, isAgentKey, pickAgent, taskPlaceholder } from "./agent.js";
import { workspaceDigit, anchorBox, anchorLabel, devicePixels, errorText, initialWorkspace, isClick, selectionOf, sessionBody, sizeText, stepWorkspace, UNREACHABLE, wholeDisplay } from "./snip-geometry.js";
import { commandLabel } from "./keys.js";

/** A selection narrower or shorter than this, in CSS pixels, shows no corner marks: they would cover it. */
const SMALL = 32;

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
  const bridge = window.intuitionSnip;
  const $ = (id) => document.getElementById(id);
  const frozen = $("frozen");
  const shade = $("shade");
  const selection = $("selection");
  const size = $("size");
  const hint = $("hint");
  const box = $("box");
  const task = $("task");
  const chip = $("workspace");
  const chipName = $("workspace-name");
  const status = $("status");
  const agentButton = $("agent");

  /** The selection, in CSS pixels of this window, or null before the first. */
  let sel = null;
  /** Where the press started while a drag is on. */
  let press = null;
  let workspaces = [];
  let workspace = null;
  /** The agent the person flipped to, or null to follow the workspace's. */
  let agentOverride = null;
  const agent = () => pickAgent(workspaces, workspace, agentOverride);
  let loaded = false;
  let busy = false;
  /** The selection last cropped and the Windows path it was saved as, so sending again after an error doesn't save it twice. */
  let cropped = null;

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const say = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  const tell = (text, kind = "") => {
    hint.replaceChildren(text);
    hint.dataset.kind = kind;
    hint.hidden = false;
  };

  function drawWorkspace() {
    chipName.textContent = workspace ?? "no workspace";
    const i = workspaces.findIndex((w) => w.name === workspace);
    chip.title = `Workspace${i >= 0 ? ` ${i + 1} of ${workspaces.length}` : ""} (Tab, ${commandLabel()}1..9)`;
    drawAgent();
  }

  /** The switch shows the agent the task starts on: its glyph and name; the task box asks who does it. */
  function drawAgent() {
    const kind = agent();
    agentButton.dataset.agent = kind;
    const name = document.createElement("span");
    name.textContent = agentName(kind);
    agentButton.replaceChildren(agentSvg(document, kind), name);
    agentButton.title = `Starts on ${agentName(kind)}. Alt+A switches to ${agentName(flipAgent(kind))}`;
    agentButton.setAttribute("aria-label", `Agent: ${agentName(kind)}. Switch to ${agentName(flipAgent(kind))}`);
    task.placeholder = taskPlaceholder(kind, true);
  }

  function flip() {
    agentOverride = flipAgent(agent());
    drawAgent();
    agentButton.removeAttribute("data-in");
    void agentButton.offsetWidth;
    agentButton.setAttribute("data-in", "");
  }

  /** As noWorkspaceText in prompt.js. */
  const noWorkspaceText = (list) =>
    list.length === 0 ? "no workspaces yet: add one in Settings, from the tray menu" : "no workspace folder exists: fix the paths in Settings, from the tray menu";

  async function loadWorkspaces() {
    const { workspaces: list, lastUsed } = await api("/api/workspaces");
    workspaces = list;
    workspace = initialWorkspace(list, lastUsed);
    loaded = true;
    drawWorkspace();
    if (workspace === null) say(noWorkspaceText(list), "error");
  }

  /**
   * The shade with the selection cut out of it, the hairline round it, and its size. The edge is
   * drawn on the device pixels the crop takes (devicePixels), one device pixel wide, so it is crisp
   * at any display scale and what is inside it is what is saved. Drawn at once on every move: the
   * selection follows the pointer with no easing.
   */
  function drawSelection() {
    if (sel === null) {
      shade.style.clipPath = "";
      selection.hidden = true;
      delete selection.dataset.settle;
      size.hidden = true;
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty("--device-px", `${1 / ratio}px`);
    const { width: w, height: h } = viewport();
    const px = devicePixels(sel, ratio, viewport());
    const [x, y, width, height] = [px.x / ratio, px.y / ratio, px.width / ratio, px.height / ratio];
    shade.style.clipPath = `path(evenodd, "M0 0H${w}V${h}H0Z M${x} ${y}H${x + width}V${y + height}H${x}Z")`;
    Object.assign(selection.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    selection.hidden = sel.width < 1 && sel.height < 1;
    selection.toggleAttribute("data-small", width < SMALL || height < SMALL);
    size.textContent = sizeText(px);
    size.hidden = selection.hidden;
    placeLabel();
  }

  function placeLabel(placement = box.hidden ? "below" : box.dataset.placement) {
    if (size.hidden || sel === null) return;
    const at = anchorLabel(sel, { width: size.offsetWidth, height: size.offsetHeight }, viewport(), placement);
    Object.assign(size.style, { left: `${at.x}px`, top: `${at.y}px` });
  }

  /** The task box grows with its text, up to its max-height, and the box is placed again. */
  function fit() {
    task.style.height = "auto";
    task.style.height = `${task.scrollHeight}px`;
    placeBox();
  }

  function placeBox() {
    if (box.hidden || sel === null) return;
    const at = anchorBox(sel, { width: box.offsetWidth, height: box.offsetHeight }, viewport());
    Object.assign(box.style, { left: `${at.x}px`, top: `${at.y}px` });
    box.dataset.placement = at.placement;
    placeLabel(at.placement);
  }

  /** Starts a CSS animation over: the attribute off, a style read so the browser sees it gone, on again. */
  function replay(el, name) {
    el.removeAttribute(name);
    void el.offsetWidth;
    el.setAttribute(name, "");
  }

  function showBox() {
    box.hidden = false;
    fit();
    // The focus first, so typing never waits for the spring.
    task.focus();
    replay(box, "data-in");
    replay(selection, "data-settle");
  }

  function onDown(e) {
    if (e.button !== 0 || box.contains(e.target) || busy || closing) return;
    e.preventDefault();
    press = { x: e.clientX, y: e.clientY };
    sel = selectionOf(press, press, viewport());
    hint.hidden = true;
    box.hidden = true;
    delete box.dataset.in;
    delete selection.dataset.settle;
    drawSelection();
    document.documentElement.setPointerCapture?.(e.pointerId);
  }

  function onMove(e) {
    if (press === null) return;
    sel = selectionOf(press, { x: e.clientX, y: e.clientY }, viewport());
    drawSelection();
  }

  function onUp(e) {
    if (press === null) return;
    const end = { x: e.clientX, y: e.clientY };
    sel = selectionOf(press, end, viewport());
    // A click, or a drag along one line, takes the whole display.
    if (isClick(press, end) || sel.width < 1 || sel.height < 1) sel = wholeDisplay(viewport());
    press = null;
    drawSelection();
    showBox();
  }

  async function submit() {
    const prompt = task.value;
    if (busy || sel === null || !prompt.trim()) return;
    busy = true;
    try {
      if (!loaded) await loadWorkspaces();
      if (workspace === null) {
        if (!status.textContent) say("pick a workspace", "error");
        return;
      }
      say("Starting…");
      const rect = { x: sel.x, y: sel.y, width: sel.width, height: sel.height };
      const same = cropped && ["x", "y", "width", "height"].every((k) => cropped.rect[k] === rect[k]);
      let imagePath = same ? cropped.path : null;
      if (imagePath === null) {
        try {
          imagePath = await bridge.crop(rect);
        } catch (e) {
          throw new Error(`the snip was not saved: ${e instanceof Error ? e.message : String(e)}`);
        }
        cropped = { rect, path: imagePath };
      }
      await api("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionBody(workspace, prompt, imagePath, agent())),
      });
      say("Started");
      close();
    } catch (e) {
      // The task stays in the box, to send again.
      say(e.message, "error");
    } finally {
      busy = false;
    }
  }

  function onKey(e) {
    if (closing) return e.preventDefault();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (box.hidden) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      workspace = stepWorkspace(workspaces, workspace, e.shiftKey ? -1 : 1);
      drawWorkspace();
      task.focus();
      return;
    }
    if (isAgentKey(e)) {
      e.preventDefault();
      if (!busy) flip();
      return;
    }
    const position = workspaceDigit(e);
    if (position === null) return;
    e.preventDefault();
    const w = workspaces[position];
    if (w && w.exists) {
      workspace = w.name;
      drawWorkspace();
    }
  }

  /** Closes every overlay, after the marks have faded back to the frozen screen (--dur-out). */
  let closing = false;
  function close() {
    if (!bridge || closing) return;
    closing = true;
    document.body.dataset.closing = "";
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-out")) || 0;
    setTimeout(() => bridge.close(), ms);
  }

  if (!bridge) {
    tell("The snip opens from the shell's snip hotkey.", "error");
    return;
  }
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("keydown", onKey);
  task.addEventListener("input", fit);
  agentButton.addEventListener("click", () => {
    flip();
    task.focus();
  });
  chip.addEventListener("click", () => {
    workspace = stepWorkspace(workspaces, workspace, 1);
    drawWorkspace();
    task.focus();
  });
  // Another display's overlay took the focus (a press there): this one lets its selection go, so
  // only one box is up. What was typed stays in its task box.
  window.addEventListener("blur", () => {
    if (busy || sel === null) return;
    sel = null;
    press = null;
    box.hidden = true;
    drawSelection();
  });
  window.addEventListener("resize", () => {
    drawSelection();
    placeBox();
  });
  drawWorkspace();
  void loadWorkspaces().catch((e) => say(e.message, "error"));

  // The shell waits for this before it shows the window, so the screen never flashes unfrozen.
  window.snipReady = (async () => {
    let url = null;
    try {
      url = await bridge.getCapture();
    } catch {
      // Told below.
    }
    if (typeof url !== "string" || !url) {
      tell("Nothing was captured: Windows may be locked. Esc closes.", "error");
      return false;
    }
    frozen.src = url;
    await frozen.decode().catch(() => {});
    // The dim fades in over the frozen screen (snip.css).
    document.body.dataset.ready = "";
    return true;
  })();
}

if (typeof document !== "undefined") start();
