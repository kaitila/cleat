// The plugins' hotkeys in the shell (plugin-keys.ts, D0057): which ones it registers from the runner's
// plugin list, and the 'plugins' message it reads them from. And the preload's onPlugin bridge.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCK_PLUGIN_CHANNEL } from "../../shell/src/dock";
import { pluginKeys, pluginsMessage, PLUGINS_PATH } from "../../shell/src/plugin-keys";

const on = (id: string, hotkey: string | null, extra: Record<string, unknown> = {}) => ({ id, hotkey, enabled: true, error: null, ...extra });

describe("pluginKeys", () => {
  test("the plugins that are on, load and have a hotkey, trimmed", () => {
    expect(pluginKeys([on("calendar", " CommandOrControl+Alt+C "), on("gamma", "CommandOrControl+Alt+G")])).toEqual([
      { id: "calendar", hotkey: "CommandOrControl+Alt+C" },
      { id: "gamma", hotkey: "CommandOrControl+Alt+G" },
    ]);
  });

  test("leaves out one that is off, broken, without a hotkey, or not a plugin", () => {
    expect(
      pluginKeys([
        on("off", "Alt+1", { enabled: false }),
        on("broken", "Alt+2", { error: "no default export" }),
        on("none", null),
        on("blank", "   "),
        on("BadId", "Alt+3"),
        on("../up", "Alt+4"),
        { id: 5, hotkey: "Alt+5", enabled: true },
        on("number", 7 as unknown as string),
        on("truthy", "Alt+6", { enabled: "yes" }),
        null,
        "calendar",
        [],
      ]),
    ).toEqual([]);
  });

  test("an accelerator once, to the first that asks, ignoring case; never one of the shell's own", () => {
    expect(pluginKeys([on("a", "Alt+K"), on("b", "alt+k"), on("c", "Alt+Space"), on("d", "Alt+J")], ["Alt+space"])).toEqual([
      { id: "a", hotkey: "Alt+K" },
      { id: "d", hotkey: "Alt+J" },
    ]);
  });

  test("anything but a list is none", () => {
    for (const not of [undefined, null, {}, "x", 3]) expect(pluginKeys(not)).toEqual([]);
  });
});

describe("pluginsMessage", () => {
  test("the list of a 'plugins' message", () => {
    const plugins = [on("calendar", "Alt+C")];
    expect(pluginsMessage(JSON.stringify({ type: "plugins", plugins }))).toEqual(plugins);
  });

  test("null for every other message, broken JSON, or not text", () => {
    expect(pluginsMessage(JSON.stringify({ type: "plugin_view", plugin: "plugins", view: {} }))).toBeNull();
    expect(pluginsMessage(JSON.stringify({ type: "settings", settings: { plugins: [] } }))).toBeNull();
    expect(pluginsMessage(JSON.stringify({ type: "plugins", plugins: "nope" }))).toBeNull();
    expect(pluginsMessage('{"type":"plugins", broken')).toBeNull();
    expect(pluginsMessage(JSON.stringify({ type: "hello" }))).toBeNull();
    expect(pluginsMessage(new Uint8Array([1, 2]))).toBeNull();
    expect(pluginsMessage(null)).toBeNull();
  });

  test("reads the runner's route", () => {
    expect(PLUGINS_PATH).toBe("/api/plugins");
  });
});

describe("the dock's preload", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "shell", "src", "dock-preload.ts"), "utf8");
  test("onPlugin hands the page a plugin id and nothing else, on the dock's plugin channel", () => {
    expect(DOCK_PLUGIN_CHANNEL).toBe("cleat-dock:plugin");
    expect(src).toContain("ipcRenderer.on(DOCK_PLUGIN_CHANNEL, (_event, id: unknown) => {");
    expect(src).toContain('if (typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id)) callback(id);');
  });

  test("the shell sends only a pressed plugin's id on it", () => {
    const main = readFileSync(join(import.meta.dir, "..", "..", "shell", "src", "main.ts"), "utf8");
    expect(main.match(/DOCK_PLUGIN_CHANNEL/g)?.length).toBeGreaterThanOrEqual(1);
    expect(main).toContain("dock.webContents.send(DOCK_PLUGIN_CHANNEL, id);");
  });
});
