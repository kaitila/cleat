// Permission modes: the config's permissionMode (top level and per workspace), the mode each turn asks
// for, the mode in effect stored on the session, and calls denied without asking (auto_denied).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsResponse, PermissionMode, SessionEvent, SessionMeta, SessionsResponse } from "../../src/shared/protocol";
import type { AgentDriver, TurnInput } from "../../src/runner/agent";
import { AUTO_DENY, FAKE_CLASSIFIER, NO_AUTO_MODE, fakeDriver } from "../../src/runner/agent-fake";
import { loadConfig, permissionModeFor } from "../../src/runner/config";
import { connect, settled, testRunner, type TestRunner } from "./helpers";

const dirs: string[] = [];
const runners: TestRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const d of [...dirs, ...runners.map((r) => r.dir)]) rmSync(d, { recursive: true, force: true });
});

function configWith(file: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "cleat-mode-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(file));
  return () => loadConfig({ CLEAT_CONFIG: path, CLEAT_DATA_DIR: join(dir, "data"), CLEAT_PORT: "0" });
}

describe("config permissionMode", () => {
  const ws = (extra: Record<string, unknown> = {}) => ({ name: "a", path: "/tmp/a", ...extra });

  test("is auto when left out, and a workspace without its own takes the top-level one", () => {
    const config = configWith({ workspaces: [ws(), { name: "b", path: "/tmp/b" }] })();
    expect(config.permissionMode).toBe("auto");
    expect(permissionModeFor(config, "a")).toBe("auto");
    expect(permissionModeFor(config, "b")).toBe("auto");
    expect(permissionModeFor(config, "not listed")).toBe("auto");
    const manual = configWith({ permissionMode: "default", workspaces: [ws()] })();
    expect(permissionModeFor(manual, "a")).toBe("default");
  });

  test("a workspace's own permissionMode overrides the top-level one, both ways", () => {
    const config = configWith({ permissionMode: "default", workspaces: [ws({ permissionMode: "auto" }), { name: "b", path: "/tmp/b" }] })();
    expect(permissionModeFor(config, "a")).toBe("auto");
    expect(permissionModeFor(config, "b")).toBe("default");
    const other = configWith({ workspaces: [ws({ permissionMode: "default" })] })();
    expect(permissionModeFor(other, "a")).toBe("default");
    // The per-workspace mode is not part of the workspace the pages get.
    expect(other.workspaces[0]).toEqual({ name: "a", path: "/tmp/a", exists: false });
  });

  test("any other value is refused when the config is read, at the top or on a workspace", () => {
    for (const bad of ["bypassPermissions", "acceptEdits", "dontAsk", "plan", "Auto", "", 1, null]) {
      expect(configWith({ permissionMode: bad, workspaces: [ws()] })).toThrow(/permissionMode/);
      expect(configWith({ workspaces: [ws({ permissionMode: bad })] })).toThrow(/permissionMode/);
    }
  });
});

/** Records each turn's TurnInput, then runs the fake. */
function recording(): { driver: AgentDriver; inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  const fake = fakeDriver(1);
  return { inputs, driver: { run: (input) => (inputs.push(input), fake.run(input)) } };
}

async function eventsOf(runner: TestRunner, id: string): Promise<SessionEvent[]> {
  return ((await (await runner.get(`/api/sessions/${id}/events`)).json()) as EventsResponse).events;
}
async function stored(runner: TestRunner, id: string): Promise<SessionMeta> {
  return ((await (await runner.get("/api/sessions")).json()) as SessionsResponse).sessions.find((s) => s.id === id)!;
}

async function turnWith(options: { permissionMode?: string; workMode?: string }, prompt: string) {
  const { driver, inputs } = recording();
  const runner = testRunner({ ...options, driver });
  runners.push(runner);
  const socket = await connect(runner);
  const session = await runner.startSession(prompt);
  await settled(socket, session.id);
  socket.close();
  return { runner, socket, session, inputs };
}

describe("sessions and the permission mode", () => {
  const cases: [{ permissionMode?: string; workMode?: string }, PermissionMode][] = [
    [{}, "auto"],
    [{ permissionMode: "auto" }, "auto"],
    [{ permissionMode: "default" }, "default"],
    [{ permissionMode: "default", workMode: "auto" }, "auto"],
    [{ permissionMode: "auto", workMode: "default" }, "default"],
  ];
  for (const [options, expected] of cases) {
    test(`config ${JSON.stringify(options)}: the turn asks for ${expected}, and the session stores it`, async () => {
      const { runner, session, inputs } = await turnWith(options, "hello");
      expect(inputs.map((i) => i.permissionMode)).toEqual([expected]);
      expect((await stored(runner, session.id)).permissionMode).toBe(expected);
      // The mode it got is the mode it asked for: no permission_mode event.
      expect((await eventsOf(runner, session.id)).some((e) => e.kind === "permission_mode")).toBe(false);
    });
  }

  test("asked for auto and runs in default: stored, and said once as a permission_mode event", async () => {
    const { runner, session } = await turnWith({}, `hello ${NO_AUTO_MODE}`);
    expect((await stored(runner, session.id)).permissionMode).toBe("default");
    const socket = await connect(runner);
    await runner.post(`/api/sessions/${session.id}/messages`, { prompt: `again ${NO_AUTO_MODE}` });
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq > 5);
    socket.close();
    const events = await eventsOf(runner, session.id);
    expect(events.filter((e) => e.kind === "permission_mode").map((e) => ({ ...e, seq: 0, ts: "" }))).toEqual([
      { kind: "permission_mode", requested: "auto", mode: "default", seq: 0, ts: "" },
    ]);
    // It comes right after the prompt, before anything the turn did.
    expect(events.map((e) => e.kind).slice(0, 2)).toEqual(["user", "permission_mode"]);
    expect(events.filter((e) => e.kind === "user")).toHaveLength(2);
  });

  test("asked for default and runs in default: nothing to say", async () => {
    const { runner, session } = await turnWith({ permissionMode: "default" }, `hello ${NO_AUTO_MODE}`);
    expect((await eventsOf(runner, session.id)).some((e) => e.kind === "permission_mode")).toBe(false);
  });

  test("a call the classifier denies is stored as auto_denied and nobody is asked", async () => {
    const { runner, session } = await turnWith({}, `please ${AUTO_DENY}`);
    const events = await eventsOf(runner, session.id);
    const denied = events.find((e) => e.kind === "auto_denied");
    expect(denied).toMatchObject({ kind: "auto_denied", toolName: "Bash", input: "rm -rf fake", reason: FAKE_CLASSIFIER });
    expect(events.some((e) => e.kind === "approval_request")).toBe(false);
    expect((await stored(runner, session.id)).status).toBe("idle");
  });
});
