// Plugins (D0057): loading plugins/<id>/plugin.ts from the repo and beside the config file, what a
// plugin may define and give back, its view (kept, on disk too) and its search, the routes under
// /api/plugins, and the built-in Calendar and Gamma. The fake plugin agent only: no Claude Code runs.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInfo, PluginSearchResponse, PluginView, PluginViewResponse, ServerMessage } from "../../src/shared/protocol";
import { loadConfig, pluginSettingsOf, type PluginSettings } from "../../src/runner/config";
import { fakePluginAgent, type AskCall, type PluginAgent, type ToolCall } from "../../src/runner/plugin-agent";
import { BUILT_IN_DIR, cleanView, definitionOf, MAX_QUERY, MAX_ROWS, MAX_SECTIONS, MAX_TEXT, Plugins, RETRY_MS } from "../../src/runner/plugins";
import { newPlugin, PLUGIN_API as CLI_PLUGIN_API, template, titleOf } from "../../src/cli/plugin";
import { connect, testRunner, type TestRunner } from "./helpers";

const PLUGIN_API = join(import.meta.dir, "..", "..", "src", "plugin.ts");

const runners: TestRunner[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const d of new Set([...runners.map((r) => r.dir), ...dirs])) rmSync(d, { recursive: true, force: true });
});

async function runner(options: { dir?: string } = {}): Promise<TestRunner> {
  const r = testRunner(options);
  runners.push(r);
  await r.pluginsLoaded;
  return r;
}

async function stopRunner(r: TestRunner): Promise<void> {
  runners.splice(runners.indexOf(r), 1);
  dirs.push(r.dir);
  await r.stop();
}

/** Writes a plugin.ts into `root`/<id>/, its time moved on so a rewrite is imported anew. */
let tick = 0;
function writePlugin(root: string, id: string, source: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "plugin.ts");
  writeFileSync(file, source);
  const t = new Date(Date.now() + ++tick * 1000);
  utimesSync(file, t, t);
  return file;
}

async function reload(r: TestRunner): Promise<PluginInfo[]> {
  const res = await r.post("/api/plugins/reload", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { plugins: PluginInfo[] }).plugins;
}

async function withPlugin(r: TestRunner, id: string, source: string): Promise<PluginInfo> {
  writePlugin(join(r.dir, "plugins"), id, source);
  const found = (await reload(r)).find((p) => p.id === id);
  if (!found) throw new Error(`${id} was not loaded`);
  return found;
}

const put = (r: TestRunner, id: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${r.url}/api/plugins/${id}`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function viewOf(r: TestRunner, id: string, query = ""): Promise<PluginViewResponse> {
  const res = await r.get(`/api/plugins/${id}/view${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as PluginViewResponse;
}

/** The view once it has been worked out: asks, waits for the refresh it started, asks again. */
async function settledView(r: TestRunner, id: string): Promise<PluginViewResponse> {
  await viewOf(r, id);
  await r.plugins.settled(id);
  return viewOf(r, id);
}

const HELLO = `export default {
  title: "Hello",
  icon: "star",
  hotkey: "Alt+Shift+H",
  async view() {
    return { sections: [{ title: "Greetings", rows: [{ title: "Hi there", detail: "from a plugin", url: "https://cleat.example/hi", task: "Say hi" }] }], note: "a note" };
  },
};
`;

describe("loading", () => {
  test("lists the built-in Calendar and Gamma, off until turned on, with their hotkeys and tools", async () => {
    const r = await runner();
    const res = await r.get("/api/plugins");
    expect(res.status).toBe(200);
    const { plugins } = (await res.json()) as { plugins: PluginInfo[] };
    const calendar = plugins.find((p) => p.id === "calendar");
    const gamma = plugins.find((p) => p.id === "gamma");
    expect(calendar).toEqual({
      id: "calendar",
      title: "Calendar",
      icon: "calendar",
      builtIn: true,
      enabled: false,
      hotkey: "CommandOrControl+Alt+C",
      view: true,
      search: false,
      placeholder: null,
      live: false,
      tools: ["mcp__claude_ai_Google_Calendar__list_events"],
      error: null,
    });
    expect(gamma).toMatchObject({
      id: "gamma",
      title: "Gamma",
      icon: "people",
      builtIn: true,
      enabled: false,
      hotkey: "CommandOrControl+Alt+G",
      view: false,
      search: true,
      placeholder: "Search people and companies in Gamma",
      tools: ["mcp__claude_ai_Gamma__search_people", "mcp__claude_ai_Gamma__search_organizations"],
      error: null,
    });
  });

  test("a new plugin is one plugin.ts beside the config file: on by default, listed after the built-in ones", async () => {
    const r = await runner();
    expect(r.config.pluginsDir).toBe(join(r.dir, "plugins"));
    const hello = await withPlugin(r, "hello", HELLO);
    expect(hello).toEqual({
      id: "hello",
      title: "Hello",
      icon: "star",
      builtIn: false,
      enabled: true,
      hotkey: "Alt+Shift+H",
      view: true,
      search: false,
      placeholder: null,
      live: false,
      tools: [],
      error: null,
    });
    const ids = (await reload(r)).map((p) => p.id);
    expect(ids.indexOf("hello")).toBeGreaterThan(ids.indexOf("gamma"));
  });

  test("a plugin written with definePlugin loads the same", async () => {
    const r = await runner();
    const p = await withPlugin(
      r,
      "typed",
      `import { definePlugin } from ${JSON.stringify(PLUGIN_API)};
export default definePlugin({ title: "Typed", search: { placeholder: "Find it", live: true, async run(q) { return { sections: [{ rows: [{ title: q }] }] }; } } });
`,
    );
    expect(p).toMatchObject({ title: "Typed", icon: "list", search: true, view: false, placeholder: "Find it", live: true, error: null, enabled: true });
  });

  test("the person's plugin of a built-in one's id takes its place", async () => {
    const r = await runner();
    const mine = await withPlugin(r, "calendar", `export default { title: "My calendar", async view() { return { sections: [] }; } };`);
    expect(mine).toMatchObject({ id: "calendar", title: "My calendar", builtIn: false, enabled: true, hotkey: null });
    expect((await reload(r)).filter((p) => p.id === "calendar")).toHaveLength(1);
  });

  test("a broken plugin is listed with its error, off, and never run; the others still load", async () => {
    const r = await runner();
    const root = join(r.dir, "plugins");
    writePlugin(root, "no-default", `export const x = 1;`);
    writePlugin(root, "nothing", `export default { title: "Nothing" };`);
    writePlugin(root, "bad-tool", `export default { title: "Bad", tools: ["Bash"], async view() { return { sections: [] }; } };`);
    writePlugin(root, "bad-icon", `export default { title: "Bad", icon: "skull", async view() { return { sections: [] }; } };`);
    writePlugin(root, "syntax", `export default { title: ;`);
    writePlugin(root, "throws", `throw new Error("boom at load"); export default {};`);
    writePlugin(root, "ok", HELLO);
    // Not plugins: a name that is not an id, and a folder without plugin.ts.
    writePlugin(root, "Not_An_Id", HELLO);
    mkdirSync(join(root, "empty"), { recursive: true });
    const list = await reload(r);
    const of = (id: string) => list.find((p) => p.id === id)!;
    expect(of("no-default").error).toContain("no default export");
    expect(of("nothing").error).toContain("a view(), a search, or both");
    expect(of("bad-tool").error).toContain("mcp__");
    expect(of("bad-icon").error).toBeTruthy();
    expect(of("syntax").error).toContain("could not be loaded");
    expect(of("throws").error).toContain("boom at load");
    for (const id of ["no-default", "nothing", "bad-tool", "bad-icon", "syntax", "throws"]) {
      expect(of(id).enabled).toBe(false);
      expect((await r.get(`/api/plugins/${id}/view`)).status).toBe(409);
    }
    expect(of("ok").error).toBeNull();
    expect(list.some((p) => p.id === "Not_An_Id" || p.id === "empty")).toBe(false);
    expect((await r.get("/api/plugins")).status).toBe(200);
  });

  // Bun keys its module cache by path and ignores a query: a changed file is imported through a copy (importFresh).
  test("reload imports a changed file afresh", async () => {
    const r = await runner();
    await withPlugin(r, "change", `export default { title: "Before", async view() { return { sections: [] }; } };`);
    expect((await withPlugin(r, "change", `export default { title: "After", async view() { return { sections: [] }; } };`)).title).toBe("After");
  });

  test("reload drops a removed plugin", async () => {
    const r = await runner();
    await withPlugin(r, "change", `export default { title: "Before", async view() { return { sections: [] }; } };`);
    rmSync(join(r.dir, "plugins", "change"), { recursive: true });
    expect((await reload(r)).some((p) => p.id === "change")).toBe(false);
    expect((await r.get("/api/plugins/change/view")).status).toBe(404);
  });

  test("reload sends the list as a 'plugins' message", async () => {
    const r = await runner();
    const socket = await connect(r);
    writePlugin(join(r.dir, "plugins"), "sent", HELLO);
    await reload(r);
    const m = (await socket.waitFor((m) => m.type === "plugins" && m.plugins.some((p) => p.id === "sent"))) as Extract<ServerMessage, { type: "plugins" }>;
    expect(m.plugins.find((p) => p.id === "sent")?.enabled).toBe(true);
    socket.close();
  });
});

describe("GET /api/plugins/:id/view", () => {
  test("answers at once while loading, then sends 'plugin_view', then answers the kept view", async () => {
    const r = await runner();
    await withPlugin(r, "hello", HELLO);
    const socket = await connect(r);
    const first = await viewOf(r, "hello");
    expect(first).toEqual({ view: null, at: null, loading: true, error: null });
    const m = (await socket.waitFor((m) => m.type === "plugin_view" && m.plugin === "hello")) as Extract<ServerMessage, { type: "plugin_view" }>;
    const view: PluginView = { sections: [{ title: "Greetings", rows: [{ title: "Hi there", detail: "from a plugin", url: "https://cleat.example/hi", task: "Say hi" }] }], note: "a note" };
    expect(m.view.view).toEqual(view);
    expect(m.view.loading).toBe(false);
    expect(m.view.error).toBeNull();
    const second = await viewOf(r, "hello");
    expect(second).toEqual({ view, at: m.view.at, loading: false, error: null });
    expect(Date.parse(second.at!)).not.toBeNaN();
    socket.close();
  });

  test("fresh=1 works it out again; fresh other than 0 or 1 is a 400; an unknown plugin a 404", async () => {
    const r = await runner();
    await withPlugin(r, "count", `let n = 0; export default { title: "Count", async view() { n++; return { sections: [{ rows: [{ title: "run " + n }] }] }; } };`);
    expect((await settledView(r, "count")).view?.sections[0]?.rows[0]?.title).toBe("run 1");
    // Not stale: no new run.
    expect((await viewOf(r, "count", "?fresh=0")).loading).toBe(false);
    const again = await viewOf(r, "count", "?fresh=1");
    expect(again.loading).toBe(true);
    expect(again.view?.sections[0]?.rows[0]?.title).toBe("run 1");
    await r.plugins.settled("count");
    expect((await viewOf(r, "count")).view?.sections[0]?.rows[0]?.title).toBe("run 2");
    expect((await r.get("/api/plugins/count/view?fresh=yes")).status).toBe(400);
    expect((await r.get("/api/plugins/nope/view")).status).toBe(404);
  });

  test("a plugin that throws gives its error in the answer, and the runner goes on", async () => {
    const r = await runner();
    await withPlugin(r, "fails", `export default { title: "Fails", async view() { throw new Error("the calendar is down"); } };`);
    const socket = await connect(r);
    await viewOf(r, "fails");
    const m = (await socket.waitFor((m) => m.type === "plugin_view" && m.plugin === "fails")) as Extract<ServerMessage, { type: "plugin_view" }>;
    expect(m.view).toMatchObject({ view: null, loading: false, error: "the calendar is down" });
    // Asked again at once, it is not tried again (RETRY_MS); fresh=1 tries again, the last error still said.
    expect(await viewOf(r, "fails")).toMatchObject({ view: null, loading: false, error: "the calendar is down" });
    expect(await viewOf(r, "fails", "?fresh=1")).toMatchObject({ view: null, loading: true, error: "the calendar is down" });
    await r.plugins.settled("fails");
    expect((await r.get("/api/plugins")).status).toBe(200);
    socket.close();
  });

  test("a view that is not a view is an error, not shown", async () => {
    const r = await runner();
    await withPlugin(r, "notview", `export default { title: "X", async view() { return { rows: "nope" }; } };`);
    const v = await settledView(r, "notview");
    expect(v.view).toBeNull();
    expect(v.error).toContain("not a view");
  });

  test("drops javascript: links and cuts long text before it reaches the pages", async () => {
    const r = await runner();
    await withPlugin(
      r,
      "evil",
      `export default { title: "Evil", async view() { return { sections: [{ rows: [
        { title: "x".repeat(2000), url: "javascript:alert(1)", detail: "<img src=x onerror=alert(1)>" },
        { title: "fine", url: "http://cleat.example/ok" },
      ] }] }; } };`,
    );
    const v = await settledView(r, "evil");
    const [bad, fine] = v.view!.sections[0]!.rows;
    expect(bad!.url).toBeUndefined();
    expect(bad!.title).toHaveLength(MAX_TEXT);
    expect(bad!.title.endsWith("…")).toBe(true);
    // Text stays text: kept as given, the page sets it with textContent.
    expect(bad!.detail).toBe("<img src=x onerror=alert(1)>");
    expect(fine!.url).toBe("http://cleat.example/ok");
  });

  test("ctx.tool runs the fake agent for a declared tool, and refuses one not in tools", async () => {
    const r = await runner();
    await withPlugin(
      r,
      "tooly",
      `export default { title: "Tooly", tools: ["mcp__claude_ai_Example__list_things"], async view(ctx) {
        const got = await ctx.tool("mcp__claude_ai_Example__list_things", { limit: 3 });
        return { sections: [{ rows: [{ title: JSON.stringify(got) }] }] };
      } };`,
    );
    const v = await settledView(r, "tooly");
    expect(JSON.parse(v.view!.sections[0]!.rows[0]!.title)).toEqual({ fake: true, tool: "mcp__claude_ai_Example__list_things", args: { limit: 3 } });

    await withPlugin(
      r,
      "sneaky",
      `export default { title: "Sneaky", tools: ["mcp__claude_ai_Example__list_things"], async view(ctx) {
        await ctx.tool("mcp__claude_ai_Example__delete_everything", {});
        return { sections: [] };
      } };`,
    );
    const refused = await settledView(r, "sneaky");
    expect(refused.view).toBeNull();
    expect(refused.error).toBe("mcp__claude_ai_Example__delete_everything is not in the plugin's tools");
  });

  test("a restart shows the last view at once, read back from view.json", async () => {
    const r1 = await runner();
    await withPlugin(r1, "kept", `export default { title: "Kept", async view() { return { sections: [{ rows: [{ title: "kept " + Math.random() }] }] }; } };`);
    const before = await settledView(r1, "kept");
    const file = join(r1.dir, "data", "plugins", "kept", "view.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ view: before.view, at: before.at });
    await stopRunner(r1);

    const r2 = await runner({ dir: r1.dir });
    const after = await viewOf(r2, "kept");
    expect(after).toEqual({ view: before.view, at: before.at, loading: false, error: null });
  });

  test("a broken view.json is ignored", async () => {
    const r1 = await runner();
    await withPlugin(r1, "broken", HELLO);
    await stopRunner(r1);
    mkdirSync(join(r1.dir, "data", "plugins", "broken"), { recursive: true });
    writeFileSync(join(r1.dir, "data", "plugins", "broken", "view.json"), "{ not json");
    const r2 = await runner({ dir: r1.dir });
    expect(await viewOf(r2, "broken")).toEqual({ view: null, at: null, loading: true, error: null });
    await r2.plugins.settled("broken");
  });

  test("a plugin with only a search has no view: 409", async () => {
    const r = await runner();
    await withPlugin(r, "onlysearch", `export default { title: "S", search: { async run() { return { sections: [] }; } } };`);
    expect((await r.get("/api/plugins/onlysearch/view")).status).toBe(409);
  });
});

describe("POST /api/plugins/:id/search", () => {
  const ECHO = `export default { title: "Echo", search: { async run(q) { if (q === "fail") throw new Error("the search broke"); return { sections: [{ title: "You said", rows: [{ title: "[" + q + "]" }] }] }; } } };`;

  test("answers the plugin's view for the trimmed query", async () => {
    const r = await runner();
    await withPlugin(r, "echo", ECHO);
    const res = await r.post("/api/plugins/echo/search", { query: "  ada  " });
    expect(res.status).toBe(200);
    expect((await res.json()) as PluginSearchResponse).toEqual({ query: "ada", view: { sections: [{ title: "You said", rows: [{ title: "[ada]" }] }] } });
  });

  test("refuses a bad query, an unknown plugin, one without a search, and a broken body", async () => {
    const r = await runner();
    await withPlugin(r, "echo", ECHO);
    await withPlugin(r, "hello", HELLO);
    expect((await r.post("/api/plugins/echo/search", { query: 7 })).status).toBe(400);
    expect((await r.post("/api/plugins/echo/search", {})).status).toBe(400);
    expect((await r.post("/api/plugins/echo/search", { query: "x".repeat(MAX_QUERY + 1) })).status).toBe(400);
    expect((await r.post("/api/plugins/echo/search", { query: "x".repeat(MAX_QUERY) })).status).toBe(200);
    expect((await r.post("/api/plugins/echo/search", [1])).status).toBe(400);
    expect((await r.post("/api/plugins/nope/search", { query: "a" })).status).toBe(404);
    expect((await r.post("/api/plugins/hello/search", { query: "a" })).status).toBe(409);
  });

  test("a search that throws is a 502 with its words", async () => {
    const r = await runner();
    await withPlugin(r, "echo", ECHO);
    const res = await r.post("/api/plugins/echo/search", { query: "fail" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("the search broke");
  });

  test("a newer search aborts the one under way, which answers 409", async () => {
    const r = await runner();
    await withPlugin(
      r,
      "slow",
      `export default { title: "Slow", search: { async run(q, ctx) {
        if (q === "first") await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        return { sections: [{ rows: [{ title: q }] }] };
      } } };`,
    );
    const first = r.post("/api/plugins/slow/search", { query: "first" });
    await Bun.sleep(50);
    const second = await r.post("/api/plugins/slow/search", { query: "second" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as PluginSearchResponse).view.sections[0]!.rows[0]!.title).toBe("second");
    const stopped = await first;
    expect(stopped.status).toBe(409);
    expect(((await stopped.json()) as { error: string }).error).toBe("stopped");
  });
});

describe("PUT /api/plugins/:id", () => {
  test("turns a built-in plugin on, keeps the rest of the config file and the plugin's options, and sends 'plugins'", async () => {
    const r = await runner();
    const path = r.env.CLEAT_CONFIG!;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...raw, mine: { keep: true }, plugins: { calendar: { options: { calendarId: "team@cleat.example" } }, other: { enabled: false } } }));
    const socket = await connect(r);
    const res = await put(r, "calendar", { enabled: true });
    expect(res.status).toBe(200);
    const { plugins } = (await res.json()) as { plugins: PluginInfo[] };
    expect(plugins.find((p) => p.id === "calendar")?.enabled).toBe(true);
    const m = (await socket.waitFor((m) => m.type === "plugins" && m.plugins.some((p) => p.id === "calendar" && p.enabled))) as Extract<ServerMessage, { type: "plugins" }>;
    expect(m.plugins.find((p) => p.id === "calendar")?.enabled).toBe(true);
    socket.close();

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mine).toEqual({ keep: true });
    expect(written.workspaces).toEqual(raw.workspaces);
    expect(written.plugins).toEqual({ calendar: { options: { calendarId: "team@cleat.example" }, enabled: true }, other: { enabled: false } });
    // The file reads back.
    expect(loadConfig(r.env).plugins.calendar).toEqual({ options: { calendarId: "team@cleat.example" }, enabled: true });
  });

  test("sets the hotkey (trimmed), or none with null; leaving it out keeps it", async () => {
    const r = await runner();
    const hotkeyOf = async (res: Response) => ((await res.json()) as { plugins: PluginInfo[] }).plugins.find((p) => p.id === "gamma")!.hotkey;
    expect(await hotkeyOf(await put(r, "gamma", { hotkey: "  Alt+Shift+K " }))).toBe("Alt+Shift+K");
    expect(await hotkeyOf(await put(r, "gamma", { enabled: true }))).toBe("Alt+Shift+K");
    expect(await hotkeyOf(await put(r, "gamma", { hotkey: null }))).toBeNull();
    expect(JSON.parse(readFileSync(r.env.CLEAT_CONFIG!, "utf8")).plugins.gamma).toEqual({ hotkey: null, enabled: true });
  });

  test("refuses bad types and an unknown plugin", async () => {
    const r = await runner();
    expect((await put(r, "calendar", { enabled: "yes" })).status).toBe(400);
    expect((await put(r, "calendar", { hotkey: 3 })).status).toBe(400);
    expect((await put(r, "calendar", { hotkey: "   " })).status).toBe(400);
    expect((await put(r, "calendar", { hotkey: "A".repeat(81) })).status).toBe(400);
    expect((await put(r, "calendar", "[]")).status).toBe(400);
    expect((await put(r, "nope", { enabled: true })).status).toBe(404);
    expect(JSON.parse(readFileSync(r.env.CLEAT_CONFIG!, "utf8")).plugins).toBeUndefined();
  });

  test("a plugin turned off has no view and no search", async () => {
    const r = await runner();
    await withPlugin(r, "both", `export default { title: "Both", async view() { return { sections: [] }; }, search: { async run() { return { sections: [] }; } } };`);
    expect((await put(r, "both", { enabled: false })).status).toBe(200);
    expect((await r.get("/api/plugins/both/view")).status).toBe(409);
    expect((await r.post("/api/plugins/both/search", { query: "a" })).status).toBe(409);
    expect((await put(r, "both", { enabled: true })).status).toBe(200);
    expect((await r.get("/api/plugins/both/view")).status).toBe(200);
  });
});

describe("every plugin route passes refusal()", () => {
  test("a foreign Origin is a 403, and a POST or PUT without JSON's content type a 415-ish refusal", async () => {
    const r = await runner();
    const evil = { origin: "http://evil.example" };
    expect((await fetch(r.url + "/api/plugins", { headers: evil })).status).toBe(403);
    expect((await fetch(r.url + "/api/plugins/calendar/view", { headers: evil })).status).toBe(403);
    expect((await fetch(r.url + "/api/plugins/reload", { method: "POST", headers: { ...evil, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(r.url + "/api/plugins/gamma/search", { method: "POST", headers: { ...evil, "content-type": "application/json" }, body: '{"query":"a"}' })).status).toBe(403);
    expect((await put(r, "calendar", { enabled: true }, { ...evil, "content-type": "application/json" })).status).toBe(403);
    expect((await put(r, "calendar", { enabled: true }, { "content-type": "text/plain" })).status).toBe(403);
    expect((await fetch(r.url + "/api/plugins/reload", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
    // Nothing was turned on.
    expect(JSON.parse(readFileSync(r.env.CLEAT_CONFIG!, "utf8")).plugins).toBeUndefined();
  });
});

describe("the config file's plugins", () => {
  function configWith(plugins: unknown): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), "cleat-plugins-config-"));
    dirs.push(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ workspaces: [], plugins }));
    return { CLEAT_CONFIG: join(dir, "config.json"), CLEAT_DATA_DIR: join(dir, "data"), CLEAT_PORT: "0" };
  }

  test("reads each plugin's settings, and puts the person's plugins beside the file", () => {
    const env = configWith({ calendar: { enabled: true, hotkey: null, options: { a: 1 } } });
    const config = loadConfig(env);
    expect(config.plugins).toEqual({ calendar: { enabled: true, hotkey: null, options: { a: 1 } } });
    expect(config.pluginsDir).toBe(join(env.CLEAT_CONFIG!, "..", "plugins"));
  });

  test("no plugins key is {}", () => {
    const env = configWith(undefined);
    expect(loadConfig(env).plugins).toEqual({});
  });

  for (const [what, plugins] of [
    ["an id that is not one", { Calendar: { enabled: true } }],
    ["enabled that is not a boolean", { calendar: { enabled: "yes" } }],
    ["an empty hotkey", { calendar: { hotkey: "" } }],
    ["options that are not an object", { calendar: { options: [1] } }],
  ] as const) {
    test(`leaves out ${what}, says so, and keeps the valid entries`, () => {
      const said: string[] = [];
      expect(pluginSettingsOf({ ...plugins, gamma: { enabled: true } }, (why) => said.push(why))).toEqual({ gamma: { enabled: true } });
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(Object.keys(plugins)[0]!);
      // The runner still starts on such a file.
      expect(loadConfig(configWith({ ...plugins, gamma: { enabled: true } })).plugins).toEqual({ gamma: { enabled: true } });
    });
  }

  test("plugins that are not an object are left out whole", () => {
    const said: string[] = [];
    expect(pluginSettingsOf(["calendar"], (why) => said.push(why))).toEqual({});
    expect(pluginSettingsOf("x", (why) => said.push(why))).toEqual({});
    expect(said).toHaveLength(2);
    expect(pluginSettingsOf(null, () => said.push("no"))).toEqual({});
    expect(said).toHaveLength(2);
    expect(loadConfig(configWith(["calendar"])).plugins).toEqual({});
  });
});

// ---------- The Plugins class on its own, with a scripted agent ----------

interface Harness {
  plugins: Plugins;
  sent: ServerMessage[];
  tools: ToolCall[];
  asks: AskCall[];
  builtIn: string;
  user: string;
  data: string;
  settings: PluginSettings;
}

function harness(options: { builtInDir?: string; settings?: PluginSettings; tool?: (call: ToolCall) => string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "cleat-plugins-"));
  dirs.push(root);
  const h: Harness = {
    sent: [],
    tools: [],
    asks: [],
    builtIn: options.builtInDir ?? join(root, "built-in"),
    user: join(root, "user"),
    data: join(root, "data"),
    settings: options.settings ?? {},
    plugins: undefined as unknown as Plugins,
  };
  const fake = fakePluginAgent();
  const agent: PluginAgent = {
    async tool(call) {
      h.tools.push(call);
      return options.tool ? options.tool(call) : fake.tool(call);
    },
    async ask(call) {
      h.asks.push(call);
      return fake.ask(call);
    },
  };
  h.plugins = new Plugins({ builtInDir: h.builtIn, userDir: h.user, settings: () => h.settings, dataDir: h.data, agent, send: (m) => h.sent.push(m), log: () => {} });
  return h;
}

async function settle(h: Harness, id: string, fresh = false) {
  h.plugins.view(id, fresh);
  await h.plugins.settled(id);
  return h.plugins.view(id);
}

describe("Plugins", () => {
  test("hands view() its options, its own data folder under the data folder, and a log", async () => {
    const h = harness({ settings: { opts: { options: { greeting: "hej" } } } });
    writePlugin(h.user, "opts", `export default { title: "Opts", async view(ctx) { ctx.log("ran"); return { sections: [{ rows: [{ title: ctx.id + ":" + ctx.options.greeting, detail: ctx.dataDir }] }] }; } };`);
    await h.plugins.load();
    const v = await settle(h, "opts");
    expect(v?.view?.sections[0]?.rows[0]).toEqual({ title: "opts:hej", detail: join(h.data, "plugins", "opts") });
    expect(existsSync(join(h.data, "plugins", "opts"))).toBe(true);
  });

  test("enabled: the config's, else the plugin's own, else on for the person's own and off for the built-in ones", async () => {
    const h = harness();
    const view = `async view() { return { sections: [] }; }`;
    writePlugin(h.builtIn, "b-default", `export default { title: "B", ${view} };`);
    writePlugin(h.builtIn, "b-own", `export default { title: "B", enabled: true, ${view} };`);
    writePlugin(h.user, "u-default", `export default { title: "U", ${view} };`);
    writePlugin(h.user, "u-own", `export default { title: "U", enabled: false, ${view} };`);
    await h.plugins.load();
    const on = () => Object.fromEntries(h.plugins.list().map((p) => [p.id, p.enabled]));
    expect(on()).toEqual({ "b-default": false, "b-own": true, "u-default": true, "u-own": false });
    h.settings = { "b-default": { enabled: true }, "b-own": { enabled: false }, "u-default": { enabled: false }, "u-own": { enabled: true } };
    expect(on()).toEqual({ "b-default": true, "b-own": false, "u-default": false, "u-own": true });
    // Built-in ones first.
    expect(h.plugins.list().map((p) => p.builtIn)).toEqual([true, true, false, false]);
  });

  test("hotkey: the config's (null for none), else the plugin's own", async () => {
    const h = harness();
    writePlugin(h.user, "keyed", `export default { title: "K", hotkey: "Alt+K", async view() { return { sections: [] }; } };`);
    await h.plugins.load();
    expect(h.plugins.list()[0]!.hotkey).toBe("Alt+K");
    h.settings = { keyed: { hotkey: "Alt+J" } };
    expect(h.plugins.list()[0]!.hotkey).toBe("Alt+J");
    h.settings = { keyed: { hotkey: null } };
    expect(h.plugins.list()[0]!.hotkey).toBeNull();
  });

  test("a view older than refreshMs is worked out again when asked; a newer one is not", async () => {
    const h = harness();
    writePlugin(h.user, "timed", `let n = 0; export default { title: "T", refreshMs: 60000, async view() { n++; return { sections: [{ rows: [{ title: String(n) }] }] }; } };`);
    await h.plugins.load();
    const v = await settle(h, "timed");
    const at = Date.parse(v!.at!);
    expect(h.plugins.view("timed", false, at + 59_000)?.loading).toBe(false);
    expect(h.plugins.view("timed", false, at + 60_000)?.loading).toBe(true);
    await h.plugins.settled("timed");
    expect(h.plugins.view("timed", false, Date.parse(h.plugins.view("timed")!.at!))?.view?.sections[0]?.rows[0]?.title).toBe("2");
  });

  test("after a failed view, the next try waits RETRY_MS, unless fresh asks", async () => {
    const h = harness();
    writePlugin(h.user, "flaky", `let n = 0; export default { title: "F", async view() { n++; if (n < 3) throw new Error("down " + n); return { sections: [{ rows: [{ title: "up" }] }] }; } };`);
    await h.plugins.load();
    const failed = await settle(h, "flaky");
    expect(failed).toMatchObject({ view: null, error: "down 1", loading: false });
    const t = Date.now();
    expect(h.plugins.view("flaky", false, t + RETRY_MS - 1000)?.loading).toBe(false);
    expect(h.plugins.view("flaky", false, t + RETRY_MS + 1000)?.loading).toBe(true);
    await h.plugins.settled("flaky");
    expect(h.plugins.view("flaky", false, Date.now())).toMatchObject({ error: "down 2", loading: false });
    expect(h.plugins.view("flaky", true)?.loading).toBe(true);
    await h.plugins.settled("flaky");
    expect(h.plugins.view("flaky")).toMatchObject({ error: null, view: { sections: [{ rows: [{ title: "up" }] }] } });
  });

  test("one refresh at a time: asking again while it runs starts no second one", async () => {
    const h = harness();
    writePlugin(h.user, "once", `let n = 0; export default { title: "O", async view() { n++; await new Promise((r) => setTimeout(r, 30)); return { sections: [{ rows: [{ title: String(n) }] }] }; } };`);
    await h.plugins.load();
    h.plugins.view("once");
    h.plugins.view("once", true);
    h.plugins.view("once", true);
    await h.plugins.settled("once");
    expect(h.plugins.view("once")?.view?.sections[0]?.rows[0]?.title).toBe("1");
    expect(h.sent.filter((m) => m.type === "plugin_view")).toHaveLength(1);
  });

  test("ctx.ask passes the plugin's tools, and refuses a tool it did not declare", async () => {
    const h = harness();
    const tool = "mcp__claude_ai_Example__find";
    writePlugin(
      h.user,
      "asker",
      `export default { title: "A", tools: [${JSON.stringify(tool)}], search: { async run(q, ctx) {
        if (q === "stray") await ctx.ask("x", {}, { tools: ["mcp__claude_ai_Example__other"] });
        const got = await ctx.ask("Who is " + q, { type: "object" }, { model: "haiku" });
        return { sections: [{ rows: [{ title: JSON.stringify(got) }] }] };
      } } };`,
    );
    await h.plugins.load();
    const view = await h.plugins.search("asker", "Ada");
    expect(JSON.parse(view!.sections[0]!.rows[0]!.title)).toEqual({ fake: true, prompt: "Who is Ada" });
    expect(h.asks[0]).toMatchObject({ prompt: "Who is Ada", tools: [tool], model: "haiku", cwd: join(h.data, "plugins", "asker") });
    await expect(h.plugins.search("asker", "stray")).rejects.toThrow("mcp__claude_ai_Example__other is not in the plugin's tools");
    expect(h.asks).toHaveLength(1);
  });

  test("ctx.tool gives back text that is not JSON as text, and runs in the plugin's folder", async () => {
    const h = harness({ tool: () => "plain words" });
    const tool = "mcp__claude_ai_Example__find";
    writePlugin(h.user, "texty", `export default { title: "T", tools: [${JSON.stringify(tool)}], async view(ctx) { return { sections: [{ rows: [{ title: await ctx.tool(${JSON.stringify(tool)}) }] }] }; } };`);
    await h.plugins.load();
    expect((await settle(h, "texty"))?.view?.sections[0]?.rows[0]?.title).toBe("plain words");
    expect(h.tools[0]).toMatchObject({ tool, args: {}, cwd: join(h.data, "plugins", "texty") });
  });

  test("stop() aborts the signal a running search was given", async () => {
    const h = harness();
    writePlugin(h.user, "waits", `export default { title: "W", search: { async run(q, ctx) { await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true })); return { sections: [] }; } } };`);
    await h.plugins.load();
    const running = h.plugins.search("waits", "a");
    await Bun.sleep(20);
    h.plugins.stop();
    await expect(running).rejects.toThrow("stopped");
  });
});

describe("cleanView", () => {
  test("keeps http(s) links and drops every other kind", () => {
    const urls = ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "/relative", "not a url", "vbscript:x"];
    const v = cleanView({ sections: [{ rows: [...urls.map((url) => ({ title: "t", url })), { title: "ok", url: "https://cleat.example/a" }] }] });
    expect("error" in v).toBe(false);
    const rows = (v as PluginView).sections[0]!.rows;
    expect(rows.slice(0, urls.length).every((r) => r.url === undefined)).toBe(true);
    expect(rows.at(-1)!.url).toBe("https://cleat.example/a");
  });

  test("cuts text, rows and sections to size", () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => ({ title: `r${i}`, meta: "m".repeat(100), task: "t".repeat(9000) }));
    const sections = Array.from({ length: MAX_SECTIONS + 5 }, () => ({ title: "s".repeat(200), rows }));
    const v = cleanView({ sections, note: "n".repeat(1000) }) as PluginView;
    expect(v.sections).toHaveLength(MAX_SECTIONS);
    expect(v.sections[0]!.rows).toHaveLength(MAX_ROWS);
    expect(v.sections[0]!.title).toHaveLength(80);
    expect(v.sections[0]!.rows[0]!.meta).toHaveLength(60);
    expect(v.sections[0]!.rows[0]!.task).toHaveLength(8000);
    expect(v.note).toHaveLength(MAX_TEXT);
  });

  test("drops empty fields and unknown keys, and refuses what is not a view", () => {
    expect(cleanView({ sections: [{ title: "", rows: [{ title: "a", detail: "", onclick: "x" }], empty: "" }], note: "", html: "<b>" })).toEqual({ sections: [{ rows: [{ title: "a" }] }] });
    for (const bad of [null, "x", {}, { sections: "x" }, { sections: [{ rows: [{ detail: "no title" }] }] }, { sections: [{ rows: [{ title: "a", tone: "red" }] }] }]) {
      expect("error" in (cleanView(bad) as object)).toBe(true);
    }
  });
});

describe("definitionOf", () => {
  const view = async () => ({ sections: [] });
  test("takes a module's default export with a view or a search", () => {
    expect("error" in definitionOf({ default: { title: "A", view } })).toBe(false);
    expect("error" in definitionOf({ default: { title: "A", search: { run: view } } })).toBe(false);
  });

  for (const [what, module] of [
    ["no default export", {}],
    ["a null module", null],
    ["no title", { default: { view } }],
    ["a blank title", { default: { title: "  ", view } }],
    ["a title over 40", { default: { title: "x".repeat(41), view } }],
    ["neither view nor search", { default: { title: "A" } }],
    ["a view that is not a function", { default: { title: "A", view: "x" } }],
    ["a search without run", { default: { title: "A", search: {} } }],
    ["a built-in tool", { default: { title: "A", view, tools: ["Bash"] } }],
    ["a tool name with spaces", { default: { title: "A", view, tools: ["mcp__a b__c"] } }],
    ["a refreshMs under a second", { default: { title: "A", view, refreshMs: 10 } }],
    ["an unknown icon", { default: { title: "A", view, icon: "skull" } }],
  ] as const) {
    test(`refuses ${what}`, () => {
      expect("error" in definitionOf(module)).toBe(true);
    });
  }
});

// ---------- The built-in plugins through Plugins, with a scripted connector ----------

describe("Calendar (built in)", () => {
  test("lists today's and tomorrow's events, without cancelled ones and working locations", async () => {
    const now = new Date();
    const at = (dayOffset: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour).toISOString();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    const events = [
      { summary: "Standup", start: { dateTime: at(0, 0) }, end: { dateTime: at(0, 0) } },
      { summary: "Cancelled thing", status: "cancelled", start: { dateTime: at(0, 1) }, end: { dateTime: at(0, 2) } },
      { summary: "Home", eventType: "WORKING_LOCATION", start: { dateTime: at(0, 1) }, end: { dateTime: at(0, 2) } },
      { summary: "Offsite", start: { date: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}` }, end: {} },
    ];
    const h = harness({ builtInDir: BUILT_IN_DIR, settings: { calendar: { enabled: true } }, tool: () => JSON.stringify({ events }) });
    await h.plugins.load();
    const v = await settle(h, "calendar");
    expect(v?.error).toBeNull();
    const [today, next] = v!.view!.sections;
    expect(today!.title).toBe("Today");
    expect(today!.rows.map((r) => r.title)).toEqual(["Standup"]);
    expect(next!.title).toBe("Tomorrow");
    expect(next!.rows).toMatchObject([{ title: "Offsite", meta: "All day" }]);
    expect(h.tools).toHaveLength(1);
    expect(h.tools[0]!.tool).toBe("mcp__claude_ai_Google_Calendar__list_events");
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    expect(h.tools[0]!.args).toMatchObject({ startTime: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T00:00:00`, orderBy: "startTime" });
  });

  test("an empty calendar says so", async () => {
    const h = harness({ builtInDir: BUILT_IN_DIR, settings: { calendar: { enabled: true } }, tool: () => JSON.stringify({}) });
    await h.plugins.load();
    const v = await settle(h, "calendar");
    expect(v!.view!.sections.map((s) => [s.rows.length, s.empty])).toEqual([
      [0, "Nothing else today."],
      [0, "Nothing tomorrow."],
    ]);
  });

  test("off until turned on: no view, no call", async () => {
    const h = harness({ builtInDir: BUILT_IN_DIR });
    await h.plugins.load();
    expect(h.plugins.view("calendar")).toBeNull();
    expect(h.tools).toHaveLength(0);
  });
});

describe("Gamma (built in)", () => {
  const people = { items: [{ id: "p1", name: "Ada Example", headline: "Founder at Example Oy", myWarmth: "strong" }] };
  const organizations = { items: [{ id: "o1", name: "Example Oy", type: "startup", industry: "fintech", knownBy: ["a", "b"], linkedinUrl: "https://linkedin.example/company/example" }] };
  const scripted = (call: ToolCall) => JSON.stringify(call.tool.endsWith("search_people") ? people : organizations);

  test("a name searches people and companies", async () => {
    const h = harness({ builtInDir: BUILT_IN_DIR, settings: { gamma: { enabled: true } }, tool: scripted });
    await h.plugins.load();
    const v = await h.plugins.search("gamma", "Ada Example");
    expect(v!.sections.map((s) => s.title)).toEqual(["People", "Companies"]);
    expect(v!.sections[0]!.rows[0]).toMatchObject({ title: "Ada Example", detail: "Founder at Example Oy", meta: "strong", tone: "accent" });
    expect(v!.sections[1]!.rows[0]).toMatchObject({ title: "Example Oy", detail: "startup · fintech", meta: "2 at Wave know", url: "https://linkedin.example/company/example" });
    const byTool = Object.fromEntries(h.tools.map((t) => [t.tool, t.args]));
    expect(byTool["mcp__claude_ai_Gamma__search_people"]).toEqual({ name: "Ada Example", scope: "all", sort: "warmth", limit: 10 });
    expect(byTool["mcp__claude_ai_Gamma__search_organizations"]).toEqual({ name: "Ada Example", limit: 5 });
  });

  test("three words or more search people by description only", async () => {
    const h = harness({ builtInDir: BUILT_IN_DIR, settings: { gamma: { enabled: true } }, tool: scripted });
    await h.plugins.load();
    const v = await h.plugins.search("gamma", "fintech founders in Helsinki");
    expect(v!.sections.map((s) => s.title)).toEqual(["People"]);
    expect(h.tools.map((t) => [t.tool, t.args])).toEqual([["mcp__claude_ai_Gamma__search_people", { description: "fintech founders in Helsinki", scope: "all", limit: 10 }]]);
  });

  test("an empty query asks for one and calls nothing", async () => {
    const h = harness({ builtInDir: BUILT_IN_DIR, settings: { gamma: { enabled: true } }, tool: scripted });
    await h.plugins.load();
    const v = await h.plugins.search("gamma", "");
    expect(v!.sections).toEqual([]);
    expect(v!.note).toContain("Type a name");
    expect(h.tools).toHaveLength(0);
  });
});

// ---------- cleat plugin new ----------

describe("cleat plugin new", () => {
  function envIn(): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), "cleat-plugin-new-"));
    dirs.push(dir);
    return { CLEAT_CONFIG: join(dir, "config.json"), CLEAT_DATA_DIR: join(dir, "data"), CLEAT_PORT: "0" };
  }

  test("titleOf turns a name into a title", () => {
    expect(titleOf("hacker-news")).toBe("Hacker news");
    expect(titleOf("crm")).toBe("Crm");
  });

  test("writes plugins/<name>/plugin.ts beside the config file, the template importing this install's API", () => {
    const env = envIn();
    const made = newPlugin("hacker-news", env);
    const file = join(env.CLEAT_CONFIG!, "..", "plugins", "hacker-news", "plugin.ts");
    expect(made).toEqual({ file });
    const source = readFileSync(file, "utf8");
    expect(source).toBe(template("hacker-news"));
    expect(source).toContain(JSON.stringify(CLI_PLUGIN_API.replace(/\.ts$/, "")));
    expect(source).toContain('title: "Hacker news"');
  });

  test("refuses a name that is not an id, and one already there, leaving the file as it was", () => {
    const env = envIn();
    for (const bad of ["Hacker", "-x", "a_b", "../up", "", "x".repeat(41)]) expect(newPlugin(bad, env)).toMatchObject({ error: expect.any(String) });
    expect(existsSync(join(env.CLEAT_CONFIG!, "..", "plugins"))).toBe(false);
    const made = newPlugin("mine", env) as { file: string };
    writeFileSync(made.file, "// edited");
    expect(newPlugin("mine", env)).toMatchObject({ error: expect.stringContaining("is there already") });
    expect(readFileSync(made.file, "utf8")).toBe("// edited");
  });

  test("the template loads through Plugins: a live search, on, no error; its search runs on a stubbed fetch", async () => {
    const env = envIn();
    const { file } = newPlugin("hn-test", env) as { file: string };
    const h = harness();
    writePlugin(h.user, "hn-test", readFileSync(file, "utf8"));
    await h.plugins.load();
    expect(h.plugins.list()).toEqual([
      expect.objectContaining({ id: "hn-test", title: "Hn test", icon: "search", enabled: true, search: true, view: false, live: true, placeholder: "Search Hacker News", error: null, tools: [] }),
    ]);
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ hits: [{ objectID: "1", title: "A story", url: "https://story.example/a", author: "ada", points: 3, num_comments: 1 }, { objectID: "2", title: null }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      // Empty: a note, and no fetch.
      expect((await h.plugins.search("hn-test", ""))?.note).toContain("Type to search");
      expect(asked).toEqual([]);
      const v = await h.plugins.search("hn-test", "bun");
      expect(asked).toHaveLength(1);
      expect(new URL(asked[0]!).searchParams.get("query")).toBe("bun");
      expect(v!.sections[0]!.rows).toEqual([{ title: "A story", detail: "3 points · 1 comments · ada", url: "https://story.example/a", task: "Read https://story.example/a and tell me what matters in it." }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("definitionOf takes the template's module", async () => {
    const env = envIn();
    const { file } = newPlugin("probe", env) as { file: string };
    expect("error" in definitionOf(await import(file))).toBe(false);
  });
});
