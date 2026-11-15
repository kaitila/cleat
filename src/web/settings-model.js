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
 * { invalid: why } for a key without Ctrl, Alt or Win (a global shortcut would take that key everywhere).
 */
export function recordKey(event) {
  const mods = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");
  if (event.code === "Escape" && mods.length === 0) return { cancel: true };
  const key = keyOf(event.code);
  if (key === null) return { pending: true };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { invalid: "Use Ctrl, Alt or Win with the key" };
  return { accelerator: [...mods, key].join("+") };
}

const CAPS = { Control: "Ctrl", CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Ctrl: "Ctrl", Super: "Win", Meta: "Win", Command: "Win", Cmd: "Win", Alt: "Alt", Option: "Alt", AltGr: "AltGr", Shift: "Shift", Plus: "+", Return: "Enter", Esc: "Esc", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→" };

/** An accelerator as the keycaps to draw, one per key: "Control+Alt+Space" is Ctrl, Alt, Space. */
export function keycaps(accelerator) {
  if (typeof accelerator !== "string" || accelerator === "") return [];
  // "+" itself is the key "Plus"; a trailing "++" is a plus key, too.
  const parts = accelerator.endsWith("++") ? [...accelerator.slice(0, -2).split("+"), "+"] : accelerator.split("+");
  return parts.filter((p) => p !== "").map((p) => CAPS[p] ?? (/^num(\d)$/.test(p) ? `Num ${p.slice(3)}` : p.length === 1 ? p.toUpperCase() : p));
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
    workspaces.push(out);
  });
  const body = { theme: state.theme, permissionMode: state.permissionMode, workspaces, shell: state.shell, port: state.port };
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
