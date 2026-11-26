// The guide to every hotkey (src/web/shortcuts.js, D0046): one list, in the platform's words, the
// global keys as recorded, and held to the code: every key a handler takes is in the guide, and every
// key the guide names is taken by its handler.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultHotkeys as shellDefaults } from "../../shell/src/os";
import { dockKey } from "../../src/web/dock-state.js";
import { commandK } from "../../src/web/keys.js";
import { isAgentKey } from "../../src/web/agent.js";
import { capsText, comboCaps, defaultHotkeys, GLOBAL, guide, HINTS, hintLine, hotkeysOf, isGuideKey, keyText, PAGE_KEYS, pageRow, tip, typingIn } from "../../src/web/shortcuts.js";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");
const { workspaceDigit } = (await import(join(WEB, "prompt.js"))) as {
  workspaceDigit(event: unknown, mac?: boolean): number | null;
};

type Ev = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };
const KEYS: Record<string, { key: string; code: string }[]> = {
  "1–9": [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({ key: String(d), code: `Digit${d}` })),
  "↓": [{ key: "ArrowDown", code: "ArrowDown" }],
  "↑": [{ key: "ArrowUp", code: "ArrowUp" }],
  Tab: [{ key: "Tab", code: "Tab" }],
  Enter: [{ key: "Enter", code: "Enter" }],
  Esc: [{ key: "Escape", code: "Escape" }],
  Backspace: [{ key: "Backspace", code: "Backspace" }],
  Delete: [{ key: "Delete", code: "Delete" }],
  F2: [{ key: "F2", code: "F2" }],
  "?": [{ key: "?", code: "Slash" }],
};
/** The key presses a combo stands for, on a Mac or not. */
function events(combo: string[], mac: boolean): Ev[] {
  const mods = combo.slice(0, -1);
  const last = combo.at(-1)!;
  const keys = KEYS[last] ?? [{ key: last.toLowerCase(), code: `Key${last}` }];
  return keys.map((k) => ({
    ...k,
    metaKey: mods.includes("cmd") && mac,
    ctrlKey: mods.includes("ctrl") || (mods.includes("cmd") && !mac),
    altKey: mods.includes("alt"),
    // ? is Shift+/ on most layouts.
    shiftKey: mods.includes("shift") || last === "?",
  }));
}
// ? is whatever the layout needs to type it, Shift or not.
const same = (a: Ev, b: Ev) => a.key === b.key && a.metaKey === b.metaKey && a.ctrlKey === b.ctrlKey && a.altKey === b.altKey && (a.shiftKey === b.shiftKey || a.key === "?");
/** Every press of letters, digits, arrows, Tab, Enter, Esc, Backspace and ?, with every set of modifiers. */
function allPresses(): Ev[] {
  const keys = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => ({ key: l.toLowerCase(), code: `Key${l}` }))
    .concat([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({ key: String(d), code: `Digit${d}` })))
    .concat(Object.values(KEYS).flat().filter((k) => !/^\d$/.test(k.key)));
  const out: Ev[] = [];
  for (const k of keys) for (let m = 0; m < 16; m++) out.push({ ...k, metaKey: Boolean(m & 1), ctrlKey: Boolean(m & 2), altKey: Boolean(m & 4), shiftKey: Boolean(m & 8) });
  return out;
}
/** The presses the guide's rows name, for one platform. */
const named = (ids: string[], mac: boolean) => ids.flatMap((id) => pageRow(id)!.keys.flatMap((c) => events(c, mac)));

describe("the guide's list", () => {
  test("the global hotkeys' defaults are the shell's", () => {
    expect(defaultHotkeys(true)).toEqual(shellDefaults("macos"));
    for (const os of ["windows", "linux"] as const) expect(defaultHotkeys(false)).toEqual(shellDefaults(os));
    expect(GLOBAL.map((g) => g.key)).toEqual(["hotkey", "snipHotkey", "chatHotkey"]);
  });

  test("the global ones are the person's own, else the default; settings from before the chat's hotkey get its default", () => {
    const shell = { hotkey: "Alt+F9", snipHotkey: "Alt+S", chatHotkey: "Control+Shift+K" };
    expect(hotkeysOf(shell, false)).toEqual(shell);
    expect(hotkeysOf({ hotkey: "Alt+F9", snipHotkey: "Alt+S" }, true)).toEqual({ hotkey: "Alt+F9", snipHotkey: "Alt+S", chatHotkey: "Command+Shift+J" });
    expect(hotkeysOf(null, false)).toEqual(defaultHotkeys(false));
    const global = guide({ mac: true, shell })[0]!;
    expect(global.title).toBe("Anywhere");
    expect(global.rows.map((r) => r.keys)).toEqual([[["⌥", "F9"]], [["⌥", "S"]], [["⌃", "⇧", "K"]]]);
    expect(guide({ mac: false, shell: null })[0]!.rows.map((r) => r.keys[0]!.join("+"))).toEqual(["Ctrl+Alt+Space", "Ctrl+Alt+S", "Ctrl+Alt+J"]);
    expect(guide({ global: false }).map((s) => s.id)).toEqual(PAGE_KEYS.map((s) => s.id));
  });

  test("the pages' keys in the platform's words: ⌘ ⌥ ⇧ ⌃ on a Mac, Ctrl Alt Shift elsewhere", () => {
    expect(comboCaps(["cmd", "K"], true)).toEqual(["⌘", "K"]);
    expect(comboCaps(["cmd", "K"], false)).toEqual(["Ctrl", "K"]);
    expect(comboCaps(["ctrl", "shift", "Tab"], true)).toEqual(["⌃", "⇧", "Tab"]);
    expect(comboCaps(["alt", "A"], false)).toEqual(["Alt", "A"]);
    expect(capsText(["⌘", "⇧", "J"], true)).toBe("⌘⇧J");
    expect(capsText(["Ctrl", "Alt", "J"], false)).toBe("Ctrl+Alt+J");
  });

  test("a tooltip says what, then the key: the global ones as recorded", () => {
    expect(tip("Switch session", "dock.switch", { mac: true })).toBe("Switch session (⌘K)");
    expect(tip("Switch session", "dock.switch", { mac: false })).toBe("Switch session (Ctrl+K)");
    expect(tip("Open in the chat", "chatHotkey", { mac: true })).toBe("Open in the chat (⌘⇧J)");
    expect(tip("Open in the chat", "chatHotkey", { mac: false, shell: { chatHotkey: "Alt+Shift+C" } })).toBe("Open in the chat (Alt+Shift+C)");
    expect(tip("Back to the dock", "chat.down", { mac: true })).toBe("Back to the dock (Esc)");
    expect(tip("Settings")).toBe("Settings");
    expect(keyText("nope")).toBe("");
  });

  test("ids are unique, and every id a page names in a tooltip or a hint is in the list", () => {
    const ids = PAGE_KEYS.flatMap((s) => s.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set([...ids, ...GLOBAL.map((g) => g.key)]);
    const used = ["dock.js", "chat.js", "prompt.js", "snip.js", "settings.js"].flatMap((f) => [...source(f).matchAll(/\b(?:tip\([^;]*?|keyText\()"([\w.]+)"/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(8);
    expect(used.filter((id) => !known.has(id))).toEqual([]);
    for (const hints of Object.values(HINTS)) for (const [id] of hints) expect(known.has(id)).toBe(true);
  });

  test("the pop-up's and the snip's hint lines are the list's", () => {
    expect(hintLine("prompt", true)).toEqual([
      { caps: ["Enter"], word: "start" }, { caps: ["⇧", "Enter"], word: "new line" }, { caps: ["⌥", "A"], word: "agent" }, { caps: ["Esc"], word: "close" },
    ]);
    expect(hintLine("snip", false).map((p) => p.caps.join("+"))).toEqual(["Alt+A", "Enter", "Esc"]);
  });
});

describe("the guide and the handlers agree", () => {
  for (const mac of [true, false]) {
    const os = mac ? "on a Mac" : "elsewhere";
    test(`the dock's switch keys: dockKey takes each the guide names, and names each it takes (${os})`, () => {
      const ids = ["dock.switch", "dock.nth", "dock.next", "dock.previous"];
      for (const e of named(ids, mac)) expect({ e, taken: dockKey(e, mac) !== null }).toEqual({ e, taken: true });
      const listed = named(ids, mac);
      for (const e of allPresses().filter((p) => dockKey(p, mac) !== null)) expect({ e, listed: listed.some((l) => same(l, e)) }).toEqual({ e, listed: true });
      // The steps go the way the guide says.
      expect(named(["dock.next"], mac).map((e) => dockKey(e, mac))).toEqual([{ step: 1 }, { step: 1 }]);
      expect(named(["dock.previous"], mac).map((e) => dockKey(e, mac))).toEqual([{ step: -1 }, { step: -1 }]);
    });

    test(`the chat's find, the workspace digits and the agent's key (${os})`, () => {
      const checks: [string, (e: Ev) => boolean][] = [
        ["chat.find", (e) => commandK(e, mac)],
        ["task.workspace", (e) => workspaceDigit(e, mac) !== null],
        ["task.agent", (e) => isAgentKey(e)],
        ["dock.guide", (e) => isGuideKey(e)],
      ];
      for (const [id, takes] of checks) {
        const listed = named([id], mac);
        for (const e of listed) expect({ id, e, taken: takes(e) }).toEqual({ id, e, taken: true });
        for (const e of allPresses().filter(takes)) expect({ id, e, listed: listed.some((l) => same(l, e)) }).toEqual({ id, e, listed: true });
      }
    });
  }

  test("nothing is attached by itself any more: no Backspace key of its own, and pasting goes in at the cursor (D0056)", () => {
    expect(pageRow("task.remove")).toBeUndefined();
    expect(pageRow("task.paste")!.keys).toEqual([["cmd", "V"]]);
    expect(source("prompt.js")).not.toMatch(/Backspace/);
    expect(source("composer.js")).toContain('box.addEventListener("paste"');
    expect(GLOBAL.find((g) => g.key === "hotkey")!.what).not.toMatch(/clipboard attached/);
  });

  test("the keys handled in the pages' sources are in the guide", () => {
    const chat = source("chat.js");
    for (const [key, id] of [["F2", "chat.rename"], ["Delete", "chat.archive"], ["Escape", "chat.down"]] as const) {
      expect(chat).toContain(`e.key === "${key}"`);
      expect(pageRow(id)).toBeDefined();
    }
    for (const file of ["dock.js", "chat.js", "prompt.js", "snip.js"]) expect(source(file)).toMatch(/e\.key (?:!==|===) "Enter" \|\| e\.shiftKey|e\.key === "Enter" && !e\.shiftKey/);
    expect(source("snip.js")).toContain('e.key === "Tab"');
    expect(pageRow("task.step")!.keys).toEqual([["Tab"], ["shift", "Tab"]]);
    expect(source("dock.js")).toContain('e.key === "ArrowDown" || e.key === "ArrowUp"');
  });

  test("? opens the guide only away from text boxes", () => {
    expect(isGuideKey({ key: "?", shiftKey: true })).toBe(true);
    expect(isGuideKey({ key: "?", metaKey: true })).toBe(false);
    expect(isGuideKey({ key: "/", shiftKey: false })).toBe(false);
    const el = (tag: string, type = "") => ({ type, matches: (sel: string) => sel.split(",").some((s) => s.trim().split(/[:\[]/)[0] === tag) });
    expect(typingIn(el("textarea"))).toBe(true);
    expect(typingIn(el("input", "search"))).toBe(true);
    expect(typingIn(el("input", "checkbox"))).toBe(false);
    expect(typingIn(el("button"))).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
