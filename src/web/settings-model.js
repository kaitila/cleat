// The settings page's pure logic: shortcuts from key presses, keycaps, the PUT body and where a
// 400's field points. No DOM here, so test/web/settings.test.ts runs it in bun.

const MODIFIERS = ["Control", "Alt", "Shift", "Super"];

/** KeyboardEvent.code names that are Electron accelerator keys under another name. */
const CODES = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PrintScreen: "PrintScreen",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
};

/** The accelerator key of a KeyboardEvent.code, or null for a modifier or a key Electron can't take. */
export function keyOf(code) {
  if (typeof code !== "string") return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `num${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return code;
  return CODES[code] ?? null;
}

/**
 * What a key press means while a shortcut is being recorded:
 * { accelerator } when it is a whole shortcut (Electron's form, as the shell registers it),
 * { cancel: true } for Esc alone, { pending: true } while only modifiers are down, and
 * { invalid: why } for a key without Ctrl, Alt or Win (⌃, ⌥ or ⌘ on a Mac: a global shortcut would
 * take that key everywhere).
 */
export function recordKey(event, mac = false) {
  const mods = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");
  if (event.code === "Escape" && mods.length === 0) return { cancel: true };
  const key = keyOf(event.code);
  if (key === null) return { pending: true };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { invalid: mac ? "Use ⌘, ⌥ or ⌃ with the key" : "Use Ctrl, Alt or Win with the key" };
  return { accelerator: [...mods, key].join("+") };
}

const CAPS = { Control: "Ctrl", CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Ctrl: "Ctrl", Super: "Win", Meta: "Win", Command: "Win", Cmd: "Win", Alt: "Alt", Option: "Alt", AltGr: "AltGr", Shift: "Shift", Plus: "+", Return: "Enter", Esc: "Esc", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→" };

/** A Mac's keycaps: its modifiers by their symbols, in the words on its keys (Super is ⌘ there). */
const MAC_CAPS = { ...CAPS, Control: "⌃", Ctrl: "⌃", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Super: "⌘", Meta: "⌘", Command: "⌘", Cmd: "⌘", Alt: "⌥", Option: "⌥", Shift: "⇧", Return: "Return" };

/**
 * An accelerator as the keycaps to draw, one per key: "Control+Alt+Space" is Ctrl, Alt, Space, and
 * on a Mac (`mac`) ⌃, ⌥, Space.
 */
export function keycaps(accelerator, mac = false) {
  if (typeof accelerator !== "string" || accelerator === "") return [];
  // "+" itself is the key "Plus"; a trailing "++" is a plus key, too.
  const parts = accelerator.endsWith("++") ? [...accelerator.slice(0, -2).split("+"), "+"] : accelerator.split("+");
  return parts.filter((p) => p !== "").map((p) => (mac ? MAC_CAPS : CAPS)[p] ?? (/^num(\d)$/.test(p) ? `Num ${p.slice(3)}` : p.length === 1 ? p.toUpperCase() : p));
}

/**
 * True for a workspace row the person added (`fresh`) that has no name or no folder yet: it isn't
 * sent until it has both, so adding one doesn't show an error before it is written. A stored
 * workspace whose name is cleared is sent, and the runner's 400 says what is wrong.
 */
export const isDraft = (w) => w.fresh === true && (w.name.trim() === "" || w.path.trim() === "");

/**
 * The body of PUT /api/settings from the page's state, and for each workspace sent the index of
 * its row on the page, so a 400 naming workspaces.N points at the right row.
 */
export function putBody(state) {
  const rows = [];
  const workspaces = [];
  state.workspaces.forEach((w, i) => {
    if (isDraft(w)) return;
    rows.push(i);
    const out = { name: w.name.trim(), path: w.path.trim() };
    if (w.permissionMode === "auto" || w.permissionMode === "default") out.permissionMode = w.permissionMode;
    // null clears a workspace's own agent; left out, the runner would keep it.
    out.agent = w.agent === "claude" || w.agent === "codex" ? w.agent : null;
    workspaces.push(out);
  });
  const body = { theme: state.theme, permissionMode: state.permissionMode, workspaces, shell: state.shell, port: state.port };
  // Left out (an older runner sent none), the runner keeps its own.
  if (state.agent === "claude" || state.agent === "codex") body.agent = state.agent;
  return { body, rows };
}

/**
 * A 400's field as the page's data-field keys to try, the most precise first: "workspaces[2].path"
 * (or workspaces.2.path, or /workspaces/2/path) is "workspaces.<row>.path", then "workspaces.<row>",
 * then "workspaces". `rows` maps the sent index back to the row on the page.
 */
export function fieldKeys(field, rows = []) {
  if (typeof field !== "string" || field === "") return [];
  const parts = field.replace(/\[(\d+)\]/g, ".$1").split(/[./]/).filter((p) => p !== "");
  if (parts[0] === "workspaces" && parts[1] !== undefined && /^\d+$/.test(parts[1])) parts[1] = String(rows[Number(parts[1])] ?? parts[1]);
  const keys = [];
  for (let n = parts.length; n > 0; n--) keys.push(parts.slice(0, n).join("."));
  return keys;
}

/** The list with the item at `from` moved to `to`; the same list when either is out of range. */
export function move(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// ---------- the Setup section ----------

const LAYOUT_NAMES = {
  "windows-wsl": ["Windows with WSL", "The runner in WSL, the shell on Windows."],
  macos: ["macOS", "The runner and the shell on this Mac."],
  linux: ["Linux", "The runner and the shell on this machine."],
};
const OS_NAMES = { windows: "Windows", macos: "macOS", linux: "Linux" };

/**
 * The Setup section's lines from GET /api/platform (null when it can't be had) and whether the runner
 * answers now. Each line: { key, name, tone: "ok" | "off" | "bad" | "unknown", value, detail, action? }.
 * `detail` says what it means, and what to do when the line isn't ok. `shell` is Settings.shell, for
 * the hotkeys' keys. Screen Recording is a line only on macOS; the dock only when it is opaque.
 */
export function setupLines(platform, reachable, shell = null) {
  const layout = platform?.layout ?? null;
  const where = layout === "windows-wsl" ? "In WSL" : "In a terminal";
  const lines = [];

  if (!platform) lines.push({ key: "layout", name: "Layout", tone: "unknown", value: "Unknown", detail: "Shown once the runner answers." });
  else if (layout && LAYOUT_NAMES[layout]) lines.push({ key: "layout", name: "Layout", tone: "ok", value: LAYOUT_NAMES[layout][0], detail: LAYOUT_NAMES[layout][1] });
  else lines.push({ key: "layout", name: "Layout", tone: "bad", value: "Unknown", detail: "INTUITION_PLATFORM names no layout. Unset it, or set it to windows-wsl, macos or linux, then restart the runner: intuition stop, then intuition start." });

  if (reachable && platform) lines.push({ key: "runner", name: "Runner", tone: "ok", value: "Running", detail: `Version ${platform.runner?.version ?? "unknown"}, on this machine's port.` });
  else lines.push({ key: "runner", name: "Runner", tone: "bad", value: "Not reachable", detail: `Nothing answers on the runner's port. ${where}: intuition up` });

  const known = reachable && platform !== null;
  const connected = known && platform.shell?.connected === true;
  const report = connected ? (platform.shell.report ?? null) : null;
  if (!known) lines.push({ key: "shell", name: "Shell", tone: "unknown", value: "Unknown", detail: "Shown once the runner answers." });
  else if (connected) lines.push({ key: "shell", name: "Shell", tone: "ok", value: "Running", detail: report ? `On ${OS_NAMES[report.os] ?? report.os}: the tray, the shortcuts and the dock.` : "It hasn't said how it is yet." });
  else lines.push({ key: "shell", name: "Shell", tone: "bad", value: "Not running", detail: `The tray, the shortcuts and the dock need it. ${where}: intuition up (or intuition shell start)` });

  const notYet = connected ? "It hasn't said yet." : "Shown while the shell runs.";
  if (!report) lines.push({ key: "startOnLogin", name: "Start at login", tone: "unknown", value: "Unknown", detail: notYet });
  else if (report.startOnLogin === true) lines.push({ key: "startOnLogin", name: "Start at login", tone: "ok", value: "On", detail: "The shell starts when you log in, and starts the runner." });
  else if (report.startOnLogin === false) lines.push({ key: "startOnLogin", name: "Start at login", tone: "off", value: "Off", detail: "After a login nothing runs until you start it. Turn on Start at login below, or: intuition shell login on" });
  else lines.push({ key: "startOnLogin", name: "Start at login", tone: "bad", value: "Can't be read", detail: `The shell could not read it. ${where}: intuition shell login status says why.` });

  if (report) {
    const missing = [["hotkey", "New task"], ["snipHotkey", "Snip"]].filter(([k]) => report.hotkeys?.[k] !== true);
    if (missing.length === 0) lines.push({ key: "hotkeys", name: "Shortcuts", tone: "ok", value: "Registered", detail: "Both work from any program." });
    else {
      const names = missing.map(([k, name]) => (shell?.[k] ? `${name} (${keycaps(shell[k]).join("+")})` : name)).join(" and ");
      const wayland = report.os === "linux" ? ", or the desktop refuses global shortcuts (Wayland: start the shell with DISPLAY set, or use the tray)" : "";
      lines.push({ key: "hotkeys", name: "Shortcuts", tone: "bad", value: "Not registered", detail: `${names}: another program holds the keys${wayland}. Pick other keys under Shortcuts.` });
    }
    if (report.dockTransparent === false) {
      lines.push({ key: "dock", name: "Dock", tone: "off", value: "Opaque", detail: "No compositor here, so the dock is a small solid window. A desktop that composites (GNOME, KDE, Xfce and others) shows it as an island; INTUITION_DOCK_OPAQUE=0 forces that." });
    }
  }

  if (layout === "macos" || report?.os === "macos") {
    const status = report?.screenRecording;
    const action = connected && report?.os === "macos" ? "open_screen_recording" : undefined;
    if (!report || status === undefined) lines.push({ key: "screenRecording", name: "Screen Recording", tone: "unknown", value: "Unknown", detail: `The snip needs it. ${notYet}` });
    else if (status === "granted") lines.push({ key: "screenRecording", name: "Screen Recording", tone: "ok", value: "Allowed", detail: "The snip can see the screens." });
    else lines.push({ key: "screenRecording", name: "Screen Recording", tone: "bad", value: "Not allowed", detail: "Until it is, a snip shows only the wallpaper. Open System Settings, allow Electron under Screen Recording, then quit the shell and start it again.", action });
  }
  return lines;
}

// ---------- the Agents section ----------

const AGENT_NEEDS = {
  claude: { name: "Claude Code", needs: "Needs Claude Code installed and logged in." },
  codex: { name: "Codex", needs: "Needs Codex installed and logged in." },
};

/**
 * The Agents section's status lines from GET /api/agents (null when it can't be had: not yet, or a
 * runner without the route), as setupLines draws them: one per agent, Claude Code first. `detail`
 * says what the agent needs, then what doctor found, or what to do. An agent that isn't ready is
 * "bad" when sessions would run on it (`used`: the default agent or a workspace's), else "off".
 */
export function agentLines(response, reachable, used = ["claude"]) {
  return ["claude", "codex"].map((agent) => {
    const { name, needs } = AGENT_NEEDS[agent];
    const status = reachable && Array.isArray(response?.agents) ? response.agents.find((a) => a?.agent === agent) : undefined;
    if (!status) return { key: agent, name, tone: "unknown", value: "Unknown", detail: `${needs} ${reachable ? "Checking." : "Shown once the runner answers."}` };
    const ready = status.installed === true && status.loggedIn === true;
    if (ready) return { key: agent, name, tone: "ok", value: "Ready", detail: `${needs} Found ${status.detail}.` };
    const tone = used.includes(agent) ? "bad" : "off";
    const value = status.installed ? "Not logged in" : "Not installed";
    const fix = typeof status.fix === "string" && status.fix ? ` ${status.fix}` : "";
    return { key: agent, name, tone, value, detail: `${needs}${fix}` };
  });
}

/** The agents sessions would run on: the default one, and each workspace's own. */
export function usedAgents(state) {
  const used = new Set([state?.agent === "codex" ? "codex" : "claude"]);
  for (const w of state?.workspaces ?? []) if (w.agent === "claude" || w.agent === "codex") used.add(w.agent);
  return [...used];
}
