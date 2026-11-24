// Which agent runs a session: config `agent` (top level and per workspace), StartSessionRequest.agent,
// SessionMeta.agent, replies on the session's own agent, and what the settings keep of it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta, SessionsResponse, Settings } from "../../src/shared/protocol";
import { byAgent, type AgentDriver, type TurnInput } from "../../src/runner/agent";
import { fakeDriver } from "../../src/runner/agent-fake";
import { agentFor, loadConfig } from "../../src/runner/config";
import { CODEX_NOT_FORKED } from "../../src/runner/manage";
import { connect, settled, testRunner, type TestRunner } from "./helpers";

const dirs: string[] = [];
const runners: TestRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const d of [...dirs, ...runners.map((r) => r.dir)]) rmSync(d, { recursive: true, force: true });
});

function configWith(file: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "holm-agent-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(file));
  return () => loadConfig({ HOLM_CONFIG: path, HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0" });
}

describe("config agent", () => {
  const ws = (extra: Record<string, unknown> = {}) => ({ name: "a", path: "/tmp/a", ...extra });

  test("is claude when left out; a workspace's own overrides the top-level one, both ways", () => {
    const plain = configWith({ workspaces: [ws(), { name: "b", path: "/tmp/b" }] })();
    expect(plain.agent).toBe("claude");
    expect(agentFor(plain, "a")).toBe("claude");
    const mixed = configWith({ agent: "codex", workspaces: [ws({ agent: "claude" }), { name: "b", path: "/tmp/b" }] })();
    expect(agentFor(mixed, "a")).toBe("claude");
    expect(agentFor(mixed, "b")).toBe("codex");
    expect(agentFor(mixed, "not listed")).toBe("codex");
    // The agent is not part of the workspace the pages get.
    expect(mixed.workspaces[0]).toEqual({ name: "a", path: "/tmp/a", exists: false });
  });

  test("any other value is refused when the config is read", () => {
    for (const bad of ["openai", "Claude", "", 1]) {
      expect(configWith({ agent: bad, workspaces: [ws()] })).toThrow(/agent/);
      expect(configWith({ workspaces: [ws({ agent: bad })] })).toThrow(/agent/);
    }
  });
});

/** Two fakes, one per agent, that record which one ran each turn. */
function recording(): { driver: AgentDriver; turns: { agent: string; input: TurnInput }[] } {
  const turns: { agent: string; input: TurnInput }[] = [];
  const fake = fakeDriver(1);
  const as = (agent: string): AgentDriver => ({ run: (input) => (turns.push({ agent, input }), fake.run(input)) });
  return { turns, driver: byAgent({ claude: as("claude"), codex: as("codex") }) };
}

async function stored(r: TestRunner, id: string): Promise<SessionMeta> {
  return ((await (await r.get("/api/sessions")).json()) as SessionsResponse).sessions.find((s) => s.id === id)!;
}

async function start(r: TestRunner, body: Record<string, unknown>): Promise<Response> {
  return r.post("/api/sessions", { workspace: "work", prompt: "hi", ...body });
}

describe("a session's agent", () => {
  test("is the workspace's, recorded on the session, and every reply goes to it, even after the config changes", async () => {
    const { driver, turns } = recording();
    const r = testRunner({ driver, workAgent: "codex" });
    runners.push(r);
    const socket = await connect(r);
    const session = ((await (await start(r, {})).json()) as { session: SessionMeta }).session;
    expect(session.agent).toBe("codex");
    await settled(socket, session.id);
    socket.close();

    const settings = (await (await r.get("/api/settings")).json()) as Settings;
    expect(settings.workspaces[0]).toMatchObject({ name: "work", agent: "codex" });
    const res = await fetch(r.url + "/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...settings, workspaces: settings.workspaces.map((w) => ({ ...w, agent: "claude" })) }),
    });
    expect(res.status).toBe(200);
    expect(agentFor(r.config, "work")).toBe("claude");

    const again = await connect(r);
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "again" })).status).toBe(202);
    await again.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq > 3);
    again.close();
    expect(turns.map((t) => t.agent)).toEqual(["codex", "codex"]);
    expect(turns[1]!.input.resume).toBe(turns[0]!.input.resume ?? (await stored(r, session.id)).claudeSessionId);
    expect((await stored(r, session.id)).agent).toBe("codex");
  });

  test("StartSessionRequest.agent overrides the config; an unknown one is refused", async () => {
    const { driver, turns } = recording();
    const r = testRunner({ driver, agent: "codex" });
    runners.push(r);
    const socket = await connect(r);
    const a = ((await (await start(r, {})).json()) as { session: SessionMeta }).session;
    const b = ((await (await start(r, { agent: "claude" })).json()) as { session: SessionMeta }).session;
    await settled(socket, a.id);
    await settled(socket, b.id);
    socket.close();
    expect([a.agent, b.agent]).toEqual(["codex", "claude"]);
    expect(turns.map((t) => t.agent).sort()).toEqual(["claude", "codex"]);
    for (const bad of ["openai", 1, null, ""]) {
      const res = await start(r, { agent: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("agent");
    }
  });

  test("a Codex session isn't forked: its thread is no Claude Code transcript", async () => {
    const r = testRunner({ workAgent: "codex" });
    runners.push(r);
    const socket = await connect(r);
    const session = ((await (await start(r, {})).json()) as { session: SessionMeta }).session;
    await settled(socket, session.id);
    socket.close();
    const res = await r.post(`/api/sessions/${session.id}/fork`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(CODEX_NOT_FORKED);
    // Rename and delete work, without touching any transcript.
    expect((await r.post(`/api/sessions/${session.id}/rename`, { title: "renamed" })).status).toBe(200);
    expect((await r.post(`/api/sessions/${session.id}/delete`, {})).status).toBe(200);
  });
});

describe("settings agent", () => {
  async function put(r: TestRunner, body: unknown): Promise<Response> {
    return fetch(r.url + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  test("GET has it; a PUT sets it at the top and per workspace, and the file keeps it", async () => {
    const r = testRunner();
    runners.push(r);
    const before = (await (await r.get("/api/settings")).json()) as Settings;
    expect(before.agent).toBe("claude");
    const res = await put(r, { ...before, agent: "codex", workspaces: [{ ...before.workspaces[0]!, agent: "claude" }, before.workspaces[1]] });
    expect(res.status).toBe(200);
    const after = (await res.json()) as Settings;
    expect(after.agent).toBe("codex");
    expect(after.workspaces.map((w) => w.agent)).toEqual(["claude", undefined]);
    const file = JSON.parse(readFileSync(r.env.HOLM_CONFIG!, "utf8"));
    expect(file.agent).toBe("codex");
    expect(file.workspaces[0].agent).toBe("claude");
    expect("agent" in file.workspaces[1]).toBe(false);
    expect(agentFor(r.config, "work")).toBe("claude");
    expect(agentFor(r.config, "gone")).toBe("codex");
  });

  test("a PUT without agent keys (a client from before them) keeps them; a workspace's agent: null clears its own", async () => {
    const r = testRunner({ agent: "codex", workAgent: "claude" });
    runners.push(r);
    const before = (await (await r.get("/api/settings")).json()) as Settings;
    const { agent: _a, ...old } = before;
    const res = await put(r, { ...old, theme: "dark", workspaces: before.workspaces.map(({ agent: _w, ...w }) => w) });
    expect(res.status).toBe(200);
    const kept = (await res.json()) as Settings;
    expect(kept.theme).toBe("dark");
    expect(kept.agent).toBe("codex");
    expect(kept.workspaces[0]!.agent).toBe("claude");

    const cleared = (await (await put(r, { ...kept, workspaces: [{ ...kept.workspaces[0]!, agent: null }, kept.workspaces[1]] })).json()) as Settings;
    expect(cleared.workspaces[0]!.agent).toBeUndefined();
    expect(agentFor(r.config, "work")).toBe("codex");
    expect((await put(r, { ...kept, agent: "gpt" })).status).toBe(400);
  });
});
