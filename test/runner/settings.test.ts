// Settings: GET and PUT /api/settings, the config file they write, and the 'settings' message.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage, Settings, SettingsErrorResponse } from "../../src/shared/protocol";
import { loadConfig, permissionModeFor } from "../../src/runner/config";
import { connect, testRunner, type TestRunner } from "./helpers";

const runners: TestRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const r of runners) rmSync(r.dir, { recursive: true, force: true });
});

function runner(): TestRunner {
  const r = testRunner();
  runners.push(r);
  return r;
}

function put(r: TestRunner, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Promise<Response> {
  return fetch(r.url + "/api/settings", { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function settings(r: TestRunner): Promise<Settings> {
  const res = await r.get("/api/settings");
  expect(res.status).toBe(200);
  return (await res.json()) as Settings;
}

const file = (r: TestRunner) => r.env.INTUITION_CONFIG!;

const SHELL = { hotkey: "Alt+Space", snipHotkey: "Alt+Shift+S", dock: true, startOnLogin: false };

describe("GET /api/settings", () => {
  test("answers the file's settings, with defaults, the paths as written and the port served on", async () => {
    const r = runner();
    const s = await settings(r);
    expect(s).toEqual({
      theme: "system",
      permissionMode: "auto",
      workspaces: [
        { name: "work", path: join(r.dir, "work") },
        { name: "gone", path: join(r.dir, "gone") },
      ],
      shell: null,
      port: r.port,
    });
  });

  test("passes refusal()", async () => {
    const r = runner();
    const res = await fetch(r.url + "/api/settings", { headers: { origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/settings", () => {
  test("stores a whole Settings, keeps unknown keys and the port, and sends 'settings' to every client", async () => {
    const r = runner();
    const extra = join(r.dir, "extra");
    mkdirSync(extra);
    const raw = JSON.parse(readFileSync(file(r), "utf8"));
    raw.port = 4999;
    raw.mine = { keep: true };
    raw.workspaces[0].note = "kept";
    writeFileSync(file(r), JSON.stringify(raw));
    const socket = await connect(r);
    const before = await settings(r);
    const next = {
      ...before,
      port: 1,
      theme: "dark",
      permissionMode: "default",
      workspaces: [{ name: "extra", path: extra, permissionMode: "auto" }, before.workspaces[0]!],
      shell: SHELL,
    };
    const res = await put(r, next);
    expect(res.status).toBe(200);
    const stored = (await res.json()) as Settings;
    expect(stored).toEqual({ ...next, port: r.port } as Settings);
    const message = (await socket.waitFor((m) => m.type === "settings")) as Extract<ServerMessage, { type: "settings" }>;
    expect(message.settings).toEqual(stored);
    socket.close();
    expect(await settings(r)).toEqual(stored);

    const written = JSON.parse(readFileSync(file(r), "utf8"));
    expect(written.port).toBe(4999);
    expect(written.mine).toEqual({ keep: true });
    expect(written.theme).toBe("dark");
    expect(written.shell).toEqual(SHELL);
    expect(written.workspaces).toEqual([
      { name: "extra", path: extra, permissionMode: "auto" },
      { name: "work", path: join(r.dir, "work"), note: "kept" },
    ]);
    // No temp file is left beside it.
    expect(readdirSync(r.dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    // The file reads back as the same settings.
    const reread = loadConfig(r.env);
    const { port: _port, ...rest } = stored;
    expect(reread.settings).toEqual(rest);

    // In effect at once: the workspaces the pages get, and the mode the next turn asks for.
    const ws = (await (await r.get("/api/workspaces")).json()) as { workspaces: { name: string }[] };
    expect(ws.workspaces.map((w) => w.name)).toEqual(["extra", "work"]);
    expect(permissionModeFor(r.config, "work")).toBe("default");
    expect(permissionModeFor(r.config, "extra")).toBe("auto");
    expect((await r.post("/api/sessions", { workspace: "extra", prompt: "hi" })).status).toBe(201);
    expect((await r.post("/api/sessions", { workspace: "gone", prompt: "hi" })).status).toBe(400);
  });

  test("a missing folder already in the settings doesn't block another change", async () => {
    const r = runner();
    const res = await put(r, { ...(await settings(r)), theme: "light" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Settings).theme).toBe("light");
  });

  const bad: [string, (s: Settings, dir: string) => unknown, string][] = [
    ["a theme it doesn't know", (s) => ({ ...s, theme: "blue" }), "theme"],
    ["a permission mode other than auto or default", (s) => ({ ...s, permissionMode: "bypassPermissions" }), "permissionMode"],
    ["such a mode on a workspace", (s) => ({ ...s, workspaces: [{ ...s.workspaces[0]!, permissionMode: "acceptEdits" }] }), "workspaces.0.permissionMode"],
    ["no workspaces", (s) => ({ ...s, workspaces: [] }), "workspaces"],
    ["a workspace without a name", (s) => ({ ...s, workspaces: [{ ...s.workspaces[0]!, name: "" }] }), "workspaces.0.name"],
    ["a name listed twice", (s) => ({ ...s, workspaces: [s.workspaces[0]!, { ...s.workspaces[0]!, path: s.workspaces[1]!.path }] }), "workspaces.1.name"],
    ["a relative path", (s) => ({ ...s, workspaces: [...s.workspaces, { name: "rel", path: "work" }] }), "workspaces.2.path"],
    ["a path with no folder", (s, dir) => ({ ...s, workspaces: [...s.workspaces, { name: "no", path: join(dir, "nothing") }] }), "workspaces.2.path"],
    ["a path to a file", (s, dir) => ({ ...s, workspaces: [...s.workspaces, { name: "file", path: join(dir, "config.json") }] }), "workspaces.2.path"],
    ["a shell without a hotkey", (s) => ({ ...s, shell: { ...SHELL, hotkey: "" } }), "shell.hotkey"],
    ["a shell whose dock isn't a boolean", (s) => ({ ...s, shell: { ...SHELL, dock: "yes" } }), "shell.dock"],
    ["a body that isn't an object", () => [1], ""],
  ];
  for (const [what, make, field] of bad) {
    test(`refuses ${what} with 400 naming ${field || "the body"}, and leaves the file untouched`, async () => {
      const r = runner();
      const before = readFileSync(file(r), "utf8");
      const socket = await connect(r);
      const res = await put(r, make(await settings(r), r.dir));
      expect(res.status).toBe(400);
      const answer = (await res.json()) as SettingsErrorResponse;
      expect(answer.field).toBe(field);
      expect(answer.error).toBeTruthy();
      expect(readFileSync(file(r), "utf8")).toBe(before);
      expect(readdirSync(r.dir).filter((f) => f.includes(".tmp"))).toEqual([]);
      expect((await settings(r)).theme).toBe("system");
      await Bun.sleep(50);
      expect(socket.messages.some((m) => m.type === "settings")).toBe(false);
      socket.close();
    });
  }

  test("refuses a body that isn't JSON", async () => {
    const r = runner();
    const before = readFileSync(file(r), "utf8");
    const res = await put(r, "{not json");
    expect(res.status).toBe(400);
    expect(readFileSync(file(r), "utf8")).toBe(before);
  });

  test("passes refusal(): a foreign origin or a body that isn't application/json is a 403", async () => {
    const r = runner();
    const before = readFileSync(file(r), "utf8");
    const body = { ...(await settings(r)), theme: "dark" };
    expect((await put(r, body, { "content-type": "application/json", origin: "http://evil.example" })).status).toBe(403);
    expect((await put(r, body, { "content-type": "text/plain" })).status).toBe(403);
    expect(readFileSync(file(r), "utf8")).toBe(before);
  });
});

describe("config settings", () => {
  test("theme and shell are read from the file, and a bad one is refused", () => {
    const r = runner();
    const raw = JSON.parse(readFileSync(file(r), "utf8"));
    writeFileSync(file(r), JSON.stringify({ ...raw, theme: "dark", shell: SHELL }));
    const config = loadConfig(r.env);
    expect(config.settings.theme).toBe("dark");
    expect(config.settings.shell).toEqual(SHELL);
    writeFileSync(file(r), JSON.stringify({ ...raw, theme: "blue" }));
    expect(() => loadConfig(r.env)).toThrow(/theme/);
  });
});
