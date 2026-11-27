// The plugins on the pages (D0057): the dock's tabs and the Settings section. Their pure logic, that
// the runner serves their modules, and the rule a reader can't see on the page: a plugin's text never
// becomes markup.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iconFor, LIVE_SEARCH_MS, safeUrl, SESSIONS, statusLine, tabsOf } from "../../src/web/dock-plugins.js";
import { pluginLine, toolWords } from "../../src/web/settings-plugins.js";
import { ICON_KEYS } from "../../src/web/tool-icons.js";
import { PLUGIN_ICONS } from "../../src/shared/protocol";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");
const noComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the dock's tabs", () => {
  test("every plugin icon is one the tool icons draw", () => {
    for (const icon of PLUGIN_ICONS) expect(ICON_KEYS).toContain(iconFor(icon));
    expect(iconFor("note")).toBe("page");
    expect(iconFor("calendar")).toBe("calendar");
  });

  test("a tab for each plugin that is on, loads, and has a view or a search", () => {
    const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, enabled: true, error: null, view: true, search: false, ...extra });
    const list = [p("a"), p("off", { enabled: false }), p("broken", { error: "x" }), p("neither", { view: false }), p("search", { view: false, search: true }), null];
    expect(tabsOf(list).map((t) => (t as { id: string }).id)).toEqual(["a", "search"]);
    expect(tabsOf(undefined)).toEqual([]);
    expect(tabsOf("x")).toEqual([]);
    expect(SESSIONS).toBe("sessions");
    expect(LIVE_SEARCH_MS).toBeGreaterThan(0);
  });

  test("the status line: when, and that it loads or failed", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const at = "2026-11-27T11:55:00Z";
    expect(statusLine(null)).toBe("");
    expect(statusLine({ view: null, at: null, loading: true, error: null }, now)).toBe("Loading…");
    expect(statusLine({ view: {}, at, loading: true, error: null }, now)).toBe("Updated 5m · updating…");
    expect(statusLine({ view: {}, at, loading: false, error: null }, now)).toBe("Updated 5m");
    expect(statusLine({ view: {}, at, loading: false, error: "down" }, now)).toBe("Updated 5m · the last update failed");
    expect(statusLine({ view: null, at: null, loading: false, error: "the calendar is down" }, now)).toBe("Failed: the calendar is down");
  });

  test("only http and https links are opened", () => {
    expect(safeUrl("https://cleat.example/a b")).toBe("https://cleat.example/a%20b");
    expect(safeUrl("http://cleat.example/")).toBe("http://cleat.example/");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/relative", "", null, undefined, 3]) expect(safeUrl(bad)).toBeNull();
  });

  test("a plugin's text is set as text, never as markup", () => {
    for (const file of ["dock-plugins.js", "settings-plugins.js"]) {
      const js = noComments(source(file));
      expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.html\s*=/);
    }
  });

  test("a search-only tab runs the empty search when shown, so its hint shows; once", () => {
    const js = noComments(source("dock-plugins.js"));
    expect(js).toContain('else if (p?.search && !find.value.trim() && searches.get(p.id)?.query !== "") void search("");');
  });

  test("a row's link goes through safeUrl before it becomes an href", () => {
    const js = noComments(source("dock-plugins.js"));
    expect(js).toContain("const url = row.url ? safeUrl(row.url) : null;");
    expect(js.match(/\.href = /g)).toEqual([".href = "]);
  });
});

describe("the Settings section", () => {
  test("a tool's name in words", () => {
    expect(toolWords("mcp__claude_ai_Google_Calendar__list_events")).toBe("Google Calendar list events");
    expect(toolWords("mcp__my-server__find-things")).toBe("my-server find things");
    expect(toolWords("Bash")).toBe("Bash");
  });

  test("the line under a plugin: built in or yours, what it uses, or why it can't load", () => {
    expect(pluginLine({ error: null, builtIn: true, tools: ["mcp__claude_ai_Gamma__search_people", "mcp__claude_ai_Gamma__search_organizations"] })).toBe(
      "Built in · uses Gamma search people, Gamma search organizations",
    );
    expect(pluginLine({ error: null, builtIn: false, tools: [] })).toBe("Yours");
    expect(pluginLine({ error: "no default export", builtIn: false, tools: [] })).toBe("Can't be loaded: no default export");
  });
});

describe("served by the runner", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("the plugin modules and the icons they import", async () => {
    for (const file of ["dock-plugins.js", "settings-plugins.js", "tool-icons.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect(res.status).toBe(200);
    }
    const imports = (file: string) => [...source(file).matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    for (const file of [...imports("dock-plugins.js"), ...imports("settings-plugins.js")]) expect((await runner.get(`/assets/${file}`)).status).toBe(200);
  });
});
