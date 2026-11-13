// The snip overlay (/assets/snip.html): the shell opens one per display on the snip hotkey, each on
// its own frozen capture. Drag an area (a click takes the whole display), and a prompt box appears
// beside it with the focus in it: type the task, Enter starts the session with the area attached.
// Tab or Alt+1..9 switches the workspace, Shift+Enter is a new line, Esc closes every overlay.
// The shell's half is window.intuitionSnip (shell/src/snip-preload.ts): getCapture(), crop(rect)
// and close(). The runner's half is POST /api/sessions (docs/protocol.md).
import { altDigit, anchorBox, anchorLabel, devicePixels, errorText, initialWorkspace, isClick, selectionOf, sessionBody, sizeText, stepWorkspace, UNREACHABLE, wholeDisplay } from "./snip-geometry.js";

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

  /** The selection, in CSS pixels of this window, or null before the first. */
  let sel = null;
  /** Where the press started while a drag is on. */
  let press = null;
  let workspaces = [];
  let workspace = null;
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
    chip.title = `Workspace${i >= 0 ? ` ${i + 1} of ${workspaces.length}` : ""} (Tab, Alt+1..9)`;
  }

  async function loadWorkspaces() {
    const { workspaces: list, lastUsed } = await api("/api/workspaces");
    workspaces = list;
    workspace = initialWorkspace(list, lastUsed);
    loaded = true;
    drawWorkspace();
    if (workspace === null) say("no workspace folder exists: check the config file", "error");
  }

  /** The shade with the selection cut out of it, the hairline round it, and its size. */
  function drawSelection() {
    if (sel === null) {
      shade.style.clipPath = "";
      selection.hidden = true;
      size.hidden = true;
      return;
    }
    const { width: w, height: h } = viewport();
    const { x, y, width, height } = sel;
    shade.style.clipPath = `path(evenodd, "M0 0H${w}V${h}H0Z M${x} ${y}H${x + width}V${y + height}H${x}Z")`;
    Object.assign(selection.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    selection.hidden = width < 1 && height < 1;
    size.textContent = sizeText(devicePixels(sel, window.devicePixelRatio || 1, viewport()));
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

  function showBox() {
    box.hidden = false;
    fit();
    task.focus();
  }

  function onDown(e) {
    if (e.button !== 0 || box.contains(e.target) || busy) return;
    e.preventDefault();
    press = { x: e.clientX, y: e.clientY };
    sel = selectionOf(press, press, viewport());
    hint.hidden = true;
    box.hidden = true;
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
        body: JSON.stringify(sessionBody(workspace, prompt, imagePath)),
      });
      say("Started");
      bridge.close();
    } catch (e) {
      // The task stays in the box, to send again.
      say(e.message, "error");
    } finally {
      busy = false;
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      bridge?.close();
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
    const position = altDigit(e);
    if (position === null) return;
    e.preventDefault();
    const w = workspaces[position];
    if (w && w.exists) {
      workspace = w.name;
      drawWorkspace();
    }
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
    return true;
  })();
}

if (typeof document !== "undefined") start();
