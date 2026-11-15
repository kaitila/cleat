// The settings page: its files are served, its pure logic (shortcuts from key presses, keycaps,
// the PUT body, where a 400's field points) does what the page relies on, and its markup has every
// section and field the contract has. The page in a browser: settings-ui.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldKeys, isDraft, keycaps, keyOf, move, putBody, recordKey } from "../../src/web/settings-model.js";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const html = readFileSync(join(WEB, "settings.html"), "utf8");

describe("recording a shortcut", () => {
  test("letters, digits, function keys, arrows and punctuation are Electron's names", () => {
    expect(["KeyA", "Digit7", "F5", "F24", "Space", "ArrowUp", "Minus", "Numpad3", "Slash"].map(keyOf)).toEqual(["A", "7", "F5", "F24", "Space", "Up", "-", "num3", "/"]);
    expect(["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft", "F25", "IntlBackslash", ""].map(keyOf)).toEqual([null, null, null, null, null, null, null]);
  });

  test("a key with modifiers is an accelerator, the modifiers in Electron's order", () => {
    expect(recordKey({ code: "Space", ctrlKey: true, altKey: true })).toEqual({ accelerator: "Control+Alt+Space" });
    expect(recordKey({ code: "KeyS", metaKey: true, shiftKey: true, ctrlKey: true })).toEqual({ accelerator: "Control+Shift+Super+S" });
    expect(recordKey({ code: "F9", altKey: true })).toEqual({ accelerator: "Alt+F9" });
  });

  test("modifiers alone wait, Esc alone cancels, and a key without Ctrl, Alt or Win is refused", () => {
    expect(recordKey({ code: "ControlLeft", ctrlKey: true })).toEqual({ pending: true });
    expect(recordKey({ code: "Escape" })).toEqual({ cancel: true });
    expect(recordKey({ code: "Escape", ctrlKey: true })).toEqual({ accelerator: "Control+Escape" });
    expect("invalid" in recordKey({ code: "KeyK" })).toBe(true);
    expect("invalid" in recordKey({ code: "KeyK", shiftKey: true })).toBe(true);
  });

  test("keycaps: one per key, in the words on a Windows keyboard", () => {
    expect(keycaps("Control+Alt+Space")).toEqual(["Ctrl", "Alt", "Space"]);
    expect(keycaps("CommandOrControl+Shift+s")).toEqual(["Ctrl", "Shift", "S"]);
    expect(keycaps("Super+Up")).toEqual(["Win", "↑"]);
    expect(keycaps("Control+Plus")).toEqual(["Ctrl", "+"]);
    expect(keycaps("Alt+num4")).toEqual(["Alt", "Num 4"]);
    expect(keycaps("")).toEqual([]);
  });
});

describe("saving", () => {
  const state = {
    theme: "dark",
    permissionMode: "auto",
    port: 4777,
    shell: { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true, startOnLogin: false },
    workspaces: [
      { name: " one ", path: "/a ", permissionMode: "default" },
      { name: "", path: "", fresh: true },
      { name: "two", path: "", fresh: true },
      { name: "three", path: "/c", fresh: true, permissionMode: "" },
      { name: "", path: "/d" },
    ],
  };

  test("a new row is held back until it has a name and a folder; a stored one is always sent", () => {
    expect(state.workspaces.map(isDraft)).toEqual([false, true, true, false, false]);
  });

  test("the body is the whole Settings, trimmed, and maps each sent workspace back to its row", () => {
    const { body, rows } = putBody(state);
    expect(body).toEqual({
      theme: "dark",
      permissionMode: "auto",
      port: 4777,
      shell: state.shell,
      workspaces: [{ name: "one", path: "/a", permissionMode: "default" }, { name: "three", path: "/c" }, { name: "", path: "/d" }],
    });
    expect(rows).toEqual([0, 3, 4]);
  });

  test("a 400's field is the page's keys, most precise first, in any of the usual spellings", () => {
    expect(fieldKeys("workspaces[1].path", [0, 3])).toEqual(["workspaces.3.path", "workspaces.3", "workspaces"]);
    expect(fieldKeys("workspaces.1.name", [0, 3])).toEqual(["workspaces.3.name", "workspaces.3", "workspaces"]);
    expect(fieldKeys("/shell/hotkey")).toEqual(["shell.hotkey", "shell"]);
    expect(fieldKeys("theme")).toEqual(["theme"]);
    expect(fieldKeys(undefined)).toEqual([]);
  });

  test("move keeps everything and refuses out of range", () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(move([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], -1, 0)).toEqual([1, 2, 3]);
  });
});

describe("the page", () => {
  test("has every section the task names, in order", () => {
    const sections = [...html.matchAll(/<h2 id="h-[a-z]+" class="label">([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(sections).toEqual(["Workspaces", "Sessions", "Appearance", "Shortcuts", "Dock", "Startup", "About"]);
  });

  test("has a control for every setting of the contract, each named for the 400's field", () => {
    for (const field of ["workspaces", "permissionMode", "theme", "shell.hotkey", "shell.snipHotkey", "shell.dock", "shell.startOnLogin"]) {
      expect({ field, control: html.includes(`data-field="${field}"`) }).toEqual({ field, control: true });
    }
    for (const value of ["system", "light", "dark"]) expect(html).toContain(`name="theme" value="${value}"`);
    for (const value of ["auto", "default"]) expect(html).toContain(`name="permissionMode" value="${value}"`);
  });

  test("never turns the runner's text into markup", () => {
    const js = readFileSync(join(WEB, "settings.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  const runner = testRunner();
  afterAll(() => runner.stop());
  test("the runner serves it and its files", async () => {
    for (const file of ["settings.html", "settings.css", "settings.js", "settings-model.js", "theme.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect({ file, status: res.status }).toEqual({ file, status: 200 });
    }
  });
});
