// The Settings page's Plugins section (D0057): each plugin the runner found, with its switch and its
// hotkey, saved with PUT /api/plugins/:id; Reload reads the plugin files again (POST /api/plugins/reload).
// A plugin's title, tools and error are text from its file: set as text, never as markup.
import { keycaps, recordKey } from "./settings-model.js";

const TOOL_WORDS = /^mcp__claude_ai_(.+?)__(.+)$/;

/** A tool's full name in words: mcp__claude_ai_Google_Calendar__list_events is "Google Calendar list events". */
export function toolWords(tool) {
  const m = TOOL_WORDS.exec(tool) ?? /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? `${m[1].replace(/_/g, " ")} ${m[2].replace(/[_-]/g, " ")}` : tool;
}

/** The line under a plugin's name: built in or the person's own, and what it may call; or why it can't load. */
export function pluginLine(p) {
  if (p.error) return `Can't be loaded: ${p.error}`;
  const kind = p.builtIn ? "Built in" : "Yours";
  return p.tools.length ? `${kind} · uses ${p.tools.map(toolWords).join(", ")}` : kind;
}

/**
 * The section: `list` (the <div class="card"> rows go in), `mac` for the keycaps, `taken()` the
 * shell's own hotkeys (a plugin's may not be one of them), `say(text, tone)` the page's status line.
 */
export function pluginSettings(doc, list, { mac, taken, say }) {
  let plugins = [];
  let recording = null;
  const h = (tag, className, text) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  async function put(id, body) {
    say("Saving…");
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = await res.json();
      if (!res.ok) return say(answer?.error ?? `Not saved: the runner answered ${res.status}`, "error");
      set(answer.plugins);
      say("Saved", "saved");
    } catch {
      say("Not saved: the runner is not reachable", "error");
    }
  }

  function caps(into, accelerator) {
    const keys = keycaps(accelerator, mac);
    if (keys.length === 0) into.replaceChildren(h("span", "muted", "None"));
    else into.replaceChildren(...keys.map((k) => h("kbd", "", k)));
  }

  function row(p) {
    const item = h("div", "plugin-setting");
    const toggle = h("label", "setting");
    const text = h("span", "setting-text");
    text.append(h("span", "strong", p.title), h("span", p.error ? "field-error small" : "muted small", pluginLine(p)));
    const sw = h("input", "switch");
    sw.type = "checkbox";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", `${p.title} on`);
    sw.checked = p.enabled;
    sw.disabled = Boolean(p.error);
    sw.addEventListener("change", () => void put(p.id, { enabled: sw.checked }));
    toggle.append(text, sw);
    item.append(toggle);
    if (p.error) return item;
    const keys = h("div", "setting");
    const name = h("span", "setting-text");
    name.append(h("span", "", "Hotkey"), h("span", "muted small", "Opens the dock on its tab"));
    const button = h("button", "shortcut quiet");
    button.type = "button";
    button.setAttribute("aria-label", `${p.title} hotkey`);
    const shown = h("span", "keycaps");
    button.append(shown);
    caps(shown, p.hotkey);
    const clear = h("button", "quiet small", "Clear");
    clear.type = "button";
    clear.hidden = !p.hotkey;
    clear.addEventListener("click", () => void put(p.id, { hotkey: null }));
    const error = h("p", "field-error small");
    error.hidden = true;
    // Recording is drawn in place: the button keeps the keyboard.
    const stop = () => {
      recording = null;
      button.dataset.recording = "false";
      caps(shown, p.hotkey);
    };
    button.addEventListener("click", () => {
      recording = p.id;
      button.dataset.recording = "true";
      shown.replaceChildren(h("span", "muted", "Press the keys…"));
    });
    button.addEventListener("blur", () => {
      if (recording === p.id) stop();
    });
    button.addEventListener("keydown", (e) => {
      if (recording !== p.id) return;
      e.preventDefault();
      e.stopPropagation();
      const got = recordKey(e, mac);
      if (got.pending) return;
      if (got.cancel) return stop();
      if (got.invalid) {
        error.textContent = got.invalid;
        error.hidden = false;
        return;
      }
      const lower = got.accelerator.toLowerCase();
      const clash = taken().some((k) => k?.toLowerCase() === lower) ? "one of Cleat's own shortcuts" : plugins.find((o) => o.id !== p.id && o.hotkey?.toLowerCase() === lower)?.title;
      if (clash) {
        error.textContent = `This is already ${clash.startsWith("one of") ? clash : `the ${clash} plugin's`}.`;
        error.hidden = false;
        return;
      }
      stop();
      void put(p.id, { hotkey: got.accelerator });
    });
    const controls = h("span", "plugin-keys");
    controls.append(button, clear);
    keys.append(name, controls);
    item.append(keys, error);
    return item;
  }

  function render() {
    list.replaceChildren();
    if (plugins.length === 0) {
      list.append(h("p", "empty muted small", "No plugins found."));
      return;
    }
    for (const p of plugins) {
      const el = row(p);
      el.dataset.plugin = p.id;
      list.append(el);
    }
  }

  function set(next) {
    plugins = Array.isArray(next) ? next : [];
    render();
  }

  async function load() {
    try {
      const res = await fetch("/api/plugins");
      if (res.ok) set((await res.json()).plugins);
    } catch {
      // The socket's next 'plugins' message has them.
    }
  }

  async function reload() {
    say("Reloading the plugins…");
    try {
      const res = await fetch("/api/plugins/reload", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) return say(`Not reloaded: the runner answered ${res.status}`, "error");
      set((await res.json()).plugins);
      say("Reloaded", "saved");
    } catch {
      say("Not reloaded: the runner is not reachable", "error");
    }
  }

  return { load, reload, set };
}
