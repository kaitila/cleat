// The settings page (/assets/settings.html): every setting of GET /api/settings, saved on change
// with PUT /api/settings (the whole Settings each time), a quiet "Saved", and a 400's error shown
// at the field it names (docs/protocol.md, "Settings"). Other windows' changes arrive as
// { type: "settings" } on /ws. The theme is applied by theme.js, at once on a choice here.
import { fieldKeys, isDraft, keycaps, move, putBody, recordKey } from "./settings-model.js";

const $ = (id) => document.getElementById(id);
const main = document.querySelector(".settings");
const status = $("status");
const list = $("workspaces");
const rowTemplate = $("workspace-row");

/** The page's settings: what the runner stored, plus the person's edits and unsent new rows. */
let state = null;
/** A workspace's name to whether its folder exists, from GET /api/workspaces. */
let exists = new Map();
/** For each workspace in the last PUT, its row on the page. */
let sentRows = [];
let saving = false;
let again = false;
/** The shortcut being recorded ("hotkey" or "snipHotkey"), or null. */
let recording = null;

const UNREACHABLE = "the runner is not reachable";

async function api(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, body: { error: UNREACHABLE } };
  }
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// ---------- status and errors ----------

let quietTimer = 0;
function showStatus(text, tone) {
  clearTimeout(quietTimer);
  status.textContent = text;
  status.dataset.tone = tone;
  status.classList.remove("gone");
  if (tone === "saved") quietTimer = setTimeout(() => status.classList.add("gone"), 1600);
}

function clearErrors() {
  for (const el of document.querySelectorAll(".field-error")) {
    el.hidden = true;
    el.textContent = "";
  }
  for (const el of document.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
}

/** Shows a 400's error at the most precise element its field names; at the top when none matches. */
function showFieldError(field, error) {
  clearErrors();
  const text = typeof error === "string" && error ? error : "This value can't be saved.";
  for (const key of fieldKeys(field, sentRows)) {
    const target = document.querySelector(`[data-field="${CSS.escape(key)}"]`);
    const slot = document.querySelector(`[data-error-for="${CSS.escape(key)}"]`) ?? target?.closest(".workspace")?.querySelector(".field-error");
    if (!target && !slot) continue;
    if (target) target.setAttribute("aria-invalid", "true");
    if (slot) {
      slot.textContent = text;
      slot.hidden = false;
      if (!slot.id) slot.id = `error-${key.replace(/\./g, "-")}`;
      target?.setAttribute("aria-errormessage", slot.id);
    }
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
    showStatus("Not saved", "error");
    return;
  }
  showStatus(`Not saved: ${text}`, "error");
}

// ---------- saving ----------

/** Puts the whole state; one PUT at a time, and the newest state again when edits came meanwhile. */
async function save() {
  if (!state) return;
  if (saving) {
    again = true;
    return;
  }
  saving = true;
  const { body, rows } = putBody(state);
  sentRows = rows;
  const res = await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  saving = false;
  if (again) {
    again = false;
    void save();
    return;
  }
  if (res.ok && res.body) {
    adopt(res.body);
    clearErrors();
    showStatus("Saved", "saved");
    void loadExists();
  } else if (res.status === 400 && res.body) {
    showFieldError(res.body.field, res.body.error);
  } else {
    clearErrors();
    showStatus(`Not saved: ${res.body?.error ?? `the runner answered ${res.status}`}`, "error");
  }
}

/** Takes the runner's stored settings into the page. */
function adopt(stored) {
  // Rows still being written were never sent: they stay where they are.
  const drafts = state ? state.workspaces.map((w, i) => (isDraft(w) ? [i, w] : null)).filter(Boolean) : [];
  const workspaces = Array.isArray(stored.workspaces) ? stored.workspaces.map((w) => ({ ...w })) : [];
  for (const [i, w] of drafts) workspaces.splice(Math.min(i, workspaces.length), 0, w);
  state = { theme: stored.theme, permissionMode: stored.permissionMode, workspaces, shell: stored.shell ? { ...stored.shell } : null, port: stored.port };
  window.intuitionTheme?.apply(state.theme);
  render();
}

async function loadExists() {
  const res = await api("/api/workspaces");
  if (!res.ok || !Array.isArray(res.body?.workspaces)) return;
  exists = new Map(res.body.workspaces.map((w) => [w.name, { path: w.path, exists: w.exists }]));
  renderWorkspaces();
}

// ---------- drawing ----------

function render() {
  if (!state) return;
  main.removeAttribute("aria-busy");
  for (const input of document.querySelectorAll('input[name="theme"]')) input.checked = input.value === state.theme;
  for (const input of document.querySelectorAll('input[name="permissionMode"]')) input.checked = input.value === state.permissionMode;
  renderWorkspaces();
  renderShell();
  $("port").textContent = String(state.port ?? "");
}

function renderWorkspaces() {
  if (!state) return;
  const rows = state.workspaces;
  while (list.children.length > rows.length) list.lastElementChild.remove();
  while (list.children.length < rows.length) list.append(rowTemplate.content.firstElementChild.cloneNode(true));
  rows.forEach((w, i) => {
    const li = list.children[i];
    li.dataset.field = `workspaces.${i}`;
    const name = li.querySelector(".name");
    const path = li.querySelector(".path");
    const mode = li.querySelector(".mode");
    const error = li.querySelector(".field-error");
    name.dataset.field = `workspaces.${i}.name`;
    path.dataset.field = `workspaces.${i}.path`;
    mode.dataset.field = `workspaces.${i}.permissionMode`;
    error.id = `workspace-error-${i}`;
    // Never overwrite what the person is typing in.
    if (document.activeElement !== name) name.value = w.name;
    if (document.activeElement !== path) path.value = w.path;
    mode.value = w.permissionMode ?? "";
    li.querySelector(".up").disabled = i === 0;
    li.querySelector(".down").disabled = i === rows.length - 1;
    const mark = li.querySelector(".exists");
    const known = exists.get(w.name.trim());
    if (known && known.path === w.path.trim()) {
      mark.textContent = known.exists ? "Found" : "Not found";
      mark.dataset.exists = String(known.exists);
      mark.title = known.exists ? "The folder exists" : "There is no folder at this path";
    } else {
      mark.textContent = "";
      delete mark.dataset.exists;
      mark.removeAttribute("title");
    }
  });
  $("workspaces-empty").hidden = rows.length > 0;
}

function renderShell() {
  const shell = state.shell;
  for (const button of document.querySelectorAll("[data-shortcut]")) {
    const key = button.dataset.shortcut;
    button.disabled = !shell;
    button.dataset.recording = String(recording === key);
    const caps = button.querySelector(".keycaps");
    if (recording === key) caps.replaceChildren(Object.assign(document.createElement("span"), { className: "muted", textContent: "Press the keys…" }));
    else drawCaps(caps, shell ? keycaps(shell[key]) : []);
  }
  for (const input of document.querySelectorAll("[data-switch]")) {
    input.disabled = !shell;
    input.checked = Boolean(shell?.[input.dataset.switch]);
  }
  const missing = $("shell-missing");
  missing.hidden = Boolean(shell);
  missing.textContent = "The Windows shell hasn't connected yet. Start it once, and its shortcuts, dock and startup settings appear here.";
}

function drawCaps(into, caps) {
  if (caps.length === 0) {
    into.replaceChildren(Object.assign(document.createElement("span"), { className: "muted", textContent: "None" }));
    return;
  }
  into.replaceChildren(...caps.map((cap) => Object.assign(document.createElement("kbd"), { textContent: cap })));
}

// ---------- the controls ----------

for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener("change", () => {
    if (!state) return;
    state.theme = input.value;
    // The live preview is the page itself: it takes the theme before the runner answers.
    window.intuitionTheme?.apply(state.theme);
    void save();
  });
}
for (const input of document.querySelectorAll('input[name="permissionMode"]')) {
  input.addEventListener("change", () => {
    if (!state) return;
    state.permissionMode = input.value;
    void save();
  });
}

const rowIndex = (el) => [...list.children].indexOf(el.closest(".workspace"));
list.addEventListener("input", (e) => {
  if (!state) return;
  const i = rowIndex(e.target);
  if (i < 0) return;
  if (e.target.classList.contains("name")) state.workspaces[i].name = e.target.value;
  if (e.target.classList.contains("path")) state.workspaces[i].path = e.target.value;
});
list.addEventListener("change", (e) => {
  const i = rowIndex(e.target);
  if (i < 0) return;
  // What the field shows is what is saved, even if a message from elsewhere came in while typing.
  const li = list.children[i];
  state.workspaces[i].name = li.querySelector(".name").value;
  state.workspaces[i].path = li.querySelector(".path").value;
  if (e.target.classList.contains("mode")) {
    if (e.target.value) state.workspaces[i].permissionMode = e.target.value;
    else delete state.workspaces[i].permissionMode;
  }
  void save();
});
list.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  const i = rowIndex(button);
  if (button.classList.contains("remove")) {
    const draft = isDraft(state.workspaces[i]);
    state.workspaces.splice(i, 1);
    renderWorkspaces();
    (list.children[Math.min(i, list.children.length - 1)]?.querySelector(".remove") ?? $("add-workspace")).focus();
    if (!draft) void save();
    return;
  }
  const to = button.classList.contains("up") ? i - 1 : button.classList.contains("down") ? i + 1 : -1;
  if (to < 0 || to >= state.workspaces.length) return;
  state.workspaces = move(state.workspaces, i, to);
  renderWorkspaces();
  // The focus goes with the row; at the end of the list it moves to the other arrow.
  const moved = list.children[to];
  const same = moved.querySelector(button.classList.contains("up") ? ".up" : ".down");
  (same.disabled ? moved.querySelector(button.classList.contains("up") ? ".down" : ".up") : same).focus();
  void save();
});
$("add-workspace").addEventListener("click", () => {
  if (!state) return;
  state.workspaces.push({ name: "", path: "", fresh: true });
  renderWorkspaces();
  list.lastElementChild.querySelector(".name").focus();
});

for (const input of document.querySelectorAll("[data-switch]")) {
  input.addEventListener("change", () => {
    if (!state?.shell) return;
    state.shell[input.dataset.switch] = input.checked;
    void save();
  });
}

function stopRecording() {
  recording = null;
  if (state) renderShell();
}
for (const button of document.querySelectorAll("[data-shortcut]")) {
  const key = button.dataset.shortcut;
  const error = document.querySelector(`[data-error-for="shell.${key}"]`);
  button.addEventListener("click", () => {
    if (!state?.shell || recording === key) return;
    recording = key;
    renderShell();
  });
  button.addEventListener("blur", () => {
    if (recording === key) stopRecording();
  });
  button.addEventListener("keydown", (e) => {
    if (recording !== key) return;
    // Every key goes to the recording, Tab and Enter too; Esc alone keeps the old shortcut.
    e.preventDefault();
    e.stopPropagation();
    const got = recordKey(e);
    if (got.cancel) return stopRecording();
    if (got.pending) return;
    if (got.invalid) {
      error.textContent = got.invalid;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    state.shell[key] = got.accelerator;
    stopRecording();
    void save();
  });
}

// ---------- loading and following ----------

async function load() {
  const res = await api("/api/settings");
  const failed = $("load-error");
  if (!res.ok || !res.body) {
    failed.textContent = `Settings can't be loaded: ${res.body?.error ?? `the runner answered ${res.status}`}.`;
    failed.hidden = false;
    return;
  }
  failed.hidden = true;
  adopt(res.body);
  void loadExists();
}

async function loadVersion() {
  const res = await api("/health");
  $("version").textContent = res.ok && res.body?.version ? res.body.version : "unknown";
}

let attempt = 0;
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("open", () => {
    // What changed while the page was away (and the first load, when the GET came too early).
    if (attempt > 0) void load();
    attempt = 0;
  });
  ws.addEventListener("message", (e) => {
    let message;
    try {
      message = JSON.parse(e.data);
    } catch {
      return;
    }
    // An echo of a PUT still under way is taken from its answer instead.
    if (message?.type !== "settings" || !message.settings || saving) return;
    adopt(message.settings);
    void loadExists();
  });
  ws.addEventListener("close", () => {
    setTimeout(connect, Math.min(5000, 500 * 2 ** attempt));
    attempt += 1;
  });
}

void load();
void loadVersion();
connect();
