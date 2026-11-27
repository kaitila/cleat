// The plugins' tabs in the open dock (D0057, docs/plugins.md): Sessions first, then one tab per
// plugin that is on. Out of a notch the tabs sit in the notch's band, on its left wing; without one
// they are a row at the panel's top. A plugin's tab shows its view (worked out by the runner, kept,
// and shown at once while a new one loads) and, when it has a search, a find field over it.
// Everything a plugin gives is text: it reaches the page as text nodes only, never as markup.
import { iconByKey } from "./tool-icons.js";
import { relativeTime } from "./chat-format.js";

/** The tab that is not a plugin's. */
export const SESSIONS = "sessions";
/** A live search waits this long after the last key. */
export const LIVE_SEARCH_MS = 350;

/** A plugin's icon name (protocol.ts, PLUGIN_ICONS) as one of the tool icons' keys. */
export function iconFor(icon) {
  return { note: "page", people: "people" }[icon] ?? icon;
}

/** The plugins that get a tab: the ones that are on and loaded. */
export function tabsOf(plugins) {
  return (Array.isArray(plugins) ? plugins : []).filter((p) => p && p.enabled === true && !p.error && (p.view || p.search));
}

/** The line under a view: when it was worked out, and that a new one loads, or that the last try failed. */
export function statusLine(response, now = Date.now()) {
  if (!response) return "";
  const parts = [];
  if (response.at) parts.push(`Updated ${relativeTime(response.at, now)}`);
  if (response.loading) parts.push(response.view ? "updating…" : "Loading…");
  else if (response.error) parts.push(response.view ? "the last update failed" : `Failed: ${response.error}`);
  return parts.join(" · ");
}

/** Only http and https links are opened. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The tabs and the plugin view, inside the dock's panel. `onTab(id)` is told each change of tab,
 * `onTask(prompt)` starts a session (a row's Ask). Returns what dock.js drives it with.
 */
export function pluginDeck(doc, panel, { onTab, onTask }) {
  const h = (tag, className, text) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const tabs = h("nav", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Tabs");
  tabs.hidden = true;
  const view = h("section", "plugin");
  view.hidden = true;
  view.setAttribute("role", "tabpanel");
  const top = h("form", "plugin-top");
  const find = h("input", "input find small");
  find.type = "search";
  find.autocomplete = "off";
  find.spellcheck = false;
  const title = h("span", "plugin-title strong");
  const refresh = h("button", "quiet small plugin-refresh", "Refresh");
  refresh.type = "button";
  top.append(title, find, refresh);
  const scroller = h("div", "plugin-scroll scroller");
  const body = h("div", "plugin-body");
  scroller.append(body);
  const status = h("p", "plugin-status muted small");
  status.setAttribute("role", "status");
  view.append(top, scroller, status);
  panel.prepend(tabs);
  panel.append(view);

  let plugins = [];
  let current = SESSIONS;
  /** Each plugin's last GET /api/plugins/:id/view answer. */
  const views = new Map();
  /** Each plugin's last search: its query and answer (or error), and the query under way. */
  const searches = new Map();
  let liveTimer = 0;

  const plugin = () => plugins.find((p) => p.id === current) ?? null;

  function tabButton(id, label, icon) {
    const b = h("button", "tab quiet small");
    b.type = "button";
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.append(iconByKey(doc, icon));
    b.addEventListener("click", () => show(id, true));
    return b;
  }

  function renderTabs() {
    tabs.replaceChildren();
    tabs.hidden = plugins.length === 0;
    if (tabs.hidden) return;
    tabs.append(tabButton(SESSIONS, "Sessions", "bubble"));
    for (const p of plugins) {
      const b = tabButton(p.id, p.hotkey ? `${p.title} (${p.hotkey})` : p.title, iconFor(p.icon));
      tabs.append(b);
    }
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === current));
  }

  function rowEl(row) {
    const item = h("li", "plugin-item");
    const url = row.url ? safeUrl(row.url) : null;
    const main = h(url ? "a" : "div", "row plugin-row");
    if (url) {
      main.href = url;
      main.target = "_blank";
      main.rel = "noopener noreferrer";
    }
    const dot = h("span", "dot plugin-dot");
    if (row.tone) dot.dataset.tone = row.tone;
    const text = h("span", "plugin-text");
    text.append(h("span", "plugin-row-title", row.title));
    if (row.detail) text.append(h("span", "plugin-row-detail muted small", row.detail));
    main.append(dot, text);
    if (row.meta) main.append(h("span", "plugin-meta muted small", row.meta));
    item.append(main);
    if (row.task) {
      const ask = h("button", "quiet small plugin-ask", "Ask");
      ask.type = "button";
      ask.title = "Start a session on this";
      ask.addEventListener("click", () => onTask(row.task));
      item.append(ask);
    }
    return item;
  }

  function renderView(v) {
    body.replaceChildren();
    if (!v) return;
    for (const section of v.sections ?? []) {
      const block = h("div", "plugin-section");
      if (section.title) block.append(h("h3", "plugin-section-title muted small", section.title));
      if (section.rows?.length) {
        const list = h("ul", "plugin-rows");
        for (const row of section.rows) list.append(rowEl(row));
        block.append(list);
      } else if (section.empty) block.append(h("p", "plugin-empty muted small", section.empty));
      body.append(block);
    }
    if (v.note) body.append(h("p", "plugin-note muted small", v.note));
  }

  function render() {
    const p = plugin();
    panel.dataset.tab = p ? "plugin" : SESSIONS;
    view.hidden = !p;
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === current));
    if (!p) return;
    title.textContent = p.title;
    find.hidden = !p.search;
    find.placeholder = p.placeholder ?? `Search ${p.title}`;
    find.setAttribute("aria-label", find.placeholder);
    refresh.hidden = !p.view;
    const s = searches.get(p.id);
    const query = find.value.trim();
    if (p.search && query) {
      if (s?.running === query) {
        status.textContent = "Searching…";
        if (s.query !== query) renderView(null);
      } else if (s?.query === query) {
        renderView(s.view);
        status.textContent = s.error ? `Failed: ${s.error}` : "";
      } else {
        renderView(null);
        status.textContent = p.live ? "" : "Enter to search";
      }
      return;
    }
    const v = views.get(p.id);
    renderView(v?.view ?? null);
    status.textContent = p.view ? statusLine(v) : "";
  }

  async function loadView(id, fresh = false) {
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/view${fresh ? "?fresh=1" : ""}`);
      const answer = await res.json();
      if (res.ok) views.set(id, answer);
      else views.set(id, { ...(views.get(id) ?? { view: null, at: null }), loading: false, error: answer?.error ?? `the runner answered ${res.status}` });
    } catch {
      views.set(id, { ...(views.get(id) ?? { view: null, at: null }), loading: false, error: "the runner is not reachable" });
    }
    if (current === id) render();
  }

  async function search(query) {
    const p = plugin();
    if (!p?.search) return;
    const id = p.id;
    const s = searches.get(id) ?? {};
    s.running = query;
    searches.set(id, s);
    render();
    let answer;
    let error = null;
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      answer = await res.json();
      // A newer search took its place: that one's answer is the one shown.
      if (res.status === 409 && searches.get(id)?.running !== query) return;
      if (!res.ok) error = answer?.error ?? `the runner answered ${res.status}`;
    } catch {
      error = "the runner is not reachable";
    }
    const now = searches.get(id);
    if (now?.running !== query) return;
    searches.set(id, { query, view: error ? null : answer.view, error, running: null });
    if (current === id) render();
  }

  top.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = find.value.trim();
    if (query) void search(query);
  });
  find.addEventListener("input", () => {
    clearTimeout(liveTimer);
    const p = plugin();
    const query = find.value.trim();
    if (p?.live && query) liveTimer = setTimeout(() => void search(query), LIVE_SEARCH_MS);
    render();
  });
  refresh.addEventListener("click", () => {
    const p = plugin();
    if (p?.view) void loadView(p.id, true);
  });

  /** Shows a tab: a plugin's, loading its view, or the sessions'. `focus`: the keyboard goes to its find field. */
  function show(id, focus = false) {
    const next = id === SESSIONS || plugins.some((p) => p.id === id) ? id : SESSIONS;
    const changed = next !== current;
    current = next;
    if (changed) {
      find.value = searches.get(next)?.query ?? "";
      scroller.scrollTop = 0;
    }
    render();
    const p = plugin();
    if (p?.view) void loadView(p.id);
    if (focus && p?.search) find.focus({ preventScroll: true });
    if (changed) onTab(current);
  }

  return {
    get current() {
      return current;
    },
    /** The plugin list from GET /api/plugins or a 'plugins' message. */
    setPlugins(list) {
      plugins = tabsOf(list);
      renderTabs();
      if (current !== SESSIONS && !plugin()) show(SESSIONS);
      else render();
    },
    has: (id) => plugins.some((p) => p.id === id),
    show,
    /** A 'plugin_view' message: the plugin's new view. */
    onView(id, response) {
      if (!response) return;
      views.set(id, response);
      if (current === id) render();
    },
    /** The dock opened: a plugin's tab shown gets its view again (the runner works out a new one only when it is old). */
    opened() {
      const p = plugin();
      if (p?.view) void loadView(p.id);
    },
    /** The find field, when the plugin shown has one. */
    focus() {
      const p = plugin();
      if (p?.search) find.focus({ preventScroll: true });
      return Boolean(p?.search);
    },
    /** Whether it holds the dock open as a focused reply would: text typed in the find field while the dock has the keyboard. */
    holds() {
      return current !== SESSIONS && doc.hasFocus() && doc.activeElement === find && find.value !== "";
    },
    /** Ticks the "Updated … ago" line. */
    tick() {
      if (current !== SESSIONS) render();
    },
  };
}
