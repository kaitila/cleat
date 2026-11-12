// The pop-up prompt (/prompt): pick a workspace, type a task, Enter starts the session.
// The shell opens it in a small window on the hotkey, so everything works from the keyboard:
// Enter starts, Shift+Enter is a new line, Alt+1..9 picks a workspace, Esc closes.
// The API is docs/protocol.md; the types are src/shared/protocol.ts.

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
    );
    loaded = true;
    if (selected === null) say("no workspace folder exists: check the config file", "error");
  }

  async function load() {
    try {
      draw(await api("/api/workspaces"));
    } catch (e) {
      say(e.message, "error");
    }
  }

  function started(session) {
    task.value = "";
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
        body: JSON.stringify({ workspace, prompt }),
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
    const position = altDigit(e);
    if (position === null) return;
    e.preventDefault();
    const radio = radios()[position];
    if (radio && !radio.disabled) radio.checked = true;
  });

  task.focus();
  void load();
}

if (typeof document !== "undefined") start();
