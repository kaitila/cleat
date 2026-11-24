// Every hotkey, written once (D0046): the guide in the dock, the chat and Settings, the pop-up's and
// the snip's hint lines, and the tooltips all read this list, so none of them can say a key the code
// doesn't take. The global three are the person's own, recorded in Settings; the rest are the
// pages' keys, in the platform's words (keys.js: ⌘ ⌥ ⇧ ⌃ on a Mac, Ctrl, Alt, Shift elsewhere).
// No DOM here: test/web/shortcuts.test.ts runs it in bun, and checks it against the key handlers.

import { MAC } from "./keys.js";
import { keycaps } from "./settings-model.js";

/**
 * The global hotkeys' defaults, as the shell has them (shell/src/os.ts defaultHotkeys, which a test
 * holds this to): Command+Shift on a Mac, Control+Alt elsewhere. The pages use them for a setting a
 * file from before the chat's hotkey doesn't have yet.
 */
export function defaultHotkeys(mac = MAC) {
  return mac
    ? { hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S", chatHotkey: "Command+Shift+J" }
    : { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", chatHotkey: "Control+Alt+J" };
}

/** The three global hotkeys: the settings key, the name Settings shows, what each does, and the guide's line for it. */
export const GLOBAL = [
  { key: "hotkey", name: "New task", what: "Opens the pop-up with the clipboard attached.", short: "New task, with the clipboard" },
  { key: "snipHotkey", name: "Snip", what: "Freezes the screen to pick an area for a task.", short: "Snip a part of the screen" },
  { key: "chatHotkey", name: "Chat", what: "Opens the chat in the notch, and closes it again.", short: "Open or close the chat" },
];

/**
 * The pages' keys, by section. A key is a list of combos (any of them does it); a combo is a list of
 * words: "cmd" (⌘, Ctrl off a Mac), "ctrl", "alt", "shift", then the key as written on it.
 * `id` names the row for the tooltips and the hint lines, and for the test that holds the handlers to it.
 */
export const PAGE_KEYS = [
  {
    id: "dock",
    title: "Dock",
    rows: [
      { id: "dock.switch", keys: [["cmd", "K"]], what: "Switch session, or find one" },
      { id: "dock.nth", keys: [["cmd", "1–9"]], what: "Show the session in that row" },
      { id: "dock.next", keys: [["ctrl", "Tab"], ["alt", "↓"]], what: "Next session" },
      { id: "dock.previous", keys: [["ctrl", "shift", "Tab"], ["alt", "↑"]], what: "Session before" },
      { id: "dock.move", keys: [["↑"], ["↓"]], what: "In the switch: move the highlight" },
      { id: "dock.pick", keys: [["Enter"]], what: "In the switch: show that session" },
      { id: "dock.send", keys: [["Enter"]], what: "Send the reply" },
      { id: "dock.newline", keys: [["shift", "Enter"]], what: "New line in the reply" },
      { id: "dock.close", keys: [["Esc"]], what: "Close the switch, then the dock" },
      { id: "dock.guide", keys: [["?"]], what: "Show these shortcuts" },
    ],
  },
  {
    id: "chat",
    title: "Chat",
    rows: [
      { id: "chat.find", keys: [["cmd", "K"]], what: "Find a session" },
      { id: "chat.send", keys: [["Enter"]], what: "Send the reply" },
      { id: "chat.newline", keys: [["shift", "Enter"]], what: "New line in the reply" },
      { id: "chat.rename", keys: [["F2"]], what: "Rename the session" },
      { id: "chat.archive", keys: [["Delete"]], what: "Archive the session" },
      { id: "chat.down", keys: [["Esc"]], what: "Clear the search, or back to the dock" },
      { id: "chat.guide", keys: [["?"]], what: "Show these shortcuts" },
    ],
  },
  {
    id: "task",
    title: "New task and snip",
    rows: [
      { id: "task.send", keys: [["Enter"]], what: "Start the task" },
      { id: "task.newline", keys: [["shift", "Enter"]], what: "New line" },
      { id: "task.workspace", keys: [["cmd", "1–9"]], what: "Pick a workspace" },
      { id: "task.step", keys: [["Tab"], ["shift", "Tab"]], what: "Next or previous workspace (snip)" },
      { id: "task.agent", keys: [["alt", "A"]], what: "Switch between Claude and Codex" },
      { id: "task.remove", keys: [["Backspace"]], what: "Remove the clipboard, in an empty task" },
      { id: "task.close", keys: [["Esc"]], what: "Close without starting" },
    ],
  },
];

/** The compact hint lines under the pop-up's and the snip's task box: a row's first combo and a word. */
export const HINTS = {
  prompt: [["task.send", "start"], ["task.newline", "new line"], ["task.agent", "agent"], ["task.close", "close"]],
  snip: [["task.agent", "agent"], ["task.send", "start"], ["task.close", "close"]],
};

const WORDS = {
  mac: { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" },
  other: { cmd: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" },
};

/** A combo's keycaps, in the platform's words: ["cmd", "K"] is ⌘ K on a Mac, Ctrl K elsewhere. */
export function comboCaps(combo, mac = MAC) {
  const words = mac ? WORDS.mac : WORDS.other;
  return combo.map((word) => words[word] ?? word);
}

/** Keycaps as a tooltip writes them: ⌘⇧J on a Mac, Ctrl+Alt+J elsewhere. */
export function capsText(caps, mac = MAC) {
  return caps.join(mac ? "" : "+");
}

/** The row of the pages' keys with this id, or undefined. */
export function pageRow(id) {
  for (const section of PAGE_KEYS) for (const row of section.rows) if (row.id === id) return row;
  return undefined;
}

/**
 * The shell's three hotkeys from the settings' `shell` (null before the shell has connected): each
 * recorded one, else its default (a file from before the chat's hotkey has none).
 */
export function hotkeysOf(shell, mac = MAC) {
  const fallback = defaultHotkeys(mac);
  const pick = (key) => (typeof shell?.[key] === "string" && shell[key] ? shell[key] : fallback[key]);
  return { hotkey: pick("hotkey"), snipHotkey: pick("snipHotkey"), chatHotkey: pick("chatHotkey") };
}

/**
 * The key of a row, or of a global hotkey ("hotkey", "snipHotkey", "chatHotkey"), as a tooltip says
 * it: the first combo only. `shell` is the settings' shell part, for the global ones.
 */
export function keyText(id, { mac = MAC, shell = null } = {}) {
  if (GLOBAL.some((g) => g.key === id)) return capsText(keycaps(hotkeysOf(shell, mac)[id], mac), mac);
  const row = pageRow(id);
  return row ? capsText(comboCaps(row.keys[0], mac), mac) : "";
}

/** A tooltip: what a control does, then its key, "Switch session (⌘K)". */
export function tip(what, id, options = {}) {
  const key = id ? keyText(id, options) : "";
  return key ? `${what} (${key})` : what;
}

/**
 * The whole guide: the global hotkeys first, as the person recorded them, then the pages' keys.
 * Each section is { id, title, rows: [{ id, what, keys: [caps, …] }] }, keys already in caps.
 * `global: false` leaves the global ones out (Settings shows those as its recordable rows).
 */
export function guide({ mac = MAC, shell = null, global = true } = {}) {
  const keys = hotkeysOf(shell, mac);
  const sections = [];
  if (global) {
    sections.push({
      id: "global",
      title: "Anywhere",
      rows: GLOBAL.map((g) => ({ id: g.key, what: g.short, keys: [keycaps(keys[g.key], mac)] })),
    });
  }
  for (const section of PAGE_KEYS) {
    sections.push({ id: section.id, title: section.title, rows: section.rows.map((row) => ({ id: row.id, what: row.what, keys: row.keys.map((c) => comboCaps(c, mac)) })) });
  }
  return sections;
}

/** A hint line's parts: [{ caps, word }], from HINTS. */
export function hintLine(page, mac = MAC) {
  return (HINTS[page] ?? []).map(([id, word]) => ({ caps: comboCaps(pageRow(id).keys[0], mac), word }));
}

/** True for the key that opens the guide: "?" (Shift+/ on most layouts), with no ⌘, Ctrl or Alt. */
export function isGuideKey(event) {
  return Boolean(event && !event.isComposing && event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey);
}

/** True when the focus is in a place that types: a text box, a select, an editable element. */
export function typingIn(element) {
  if (!element || typeof element.matches !== "function") return false;
  if (element.matches("textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  return element.matches("input") && !/^(?:checkbox|radio|button|submit|reset|range|color|file)$/.test(element.type ?? "");
}
