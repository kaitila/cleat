import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventsResponse, ServerMessage, SessionEvent, SessionMeta, SessionsResponse, WorkspacesResponse } from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { FAKE_ERROR, fakeReply } from "../../src/runner/agent-fake";
import { NO_RESULT } from "../../src/runner/sessions";
import { RESTARTED } from "../../src/runner/store";
import { connect, settled, testRunner } from "./helpers";

const kinds = (events: SessionEvent[]) => events.map((e) => e.kind);
const eventsOf = (messages: ServerMessage[], id: string) =>
  messages.flatMap((m) => (m.type === "event" && m.sessionId === id ? [m.event] : []));

describe("API", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("GET /api/workspaces lists the config's workspaces, and lastUsed follows the last session started", async () => {
    const before = (await (await runner.get("/api/workspaces")).json()) as WorkspacesResponse;
    expect(before.workspaces.map((w) => [w.name, w.exists])).toEqual([["work", true], ["gone", false]]);
    expect(before.lastUsed).toBeNull();
    await runner.startSession("hello");
    const after = (await (await runner.get("/api/workspaces")).json()) as WorkspacesResponse;
    expect(after.lastUsed).toBe("work");
    expect(JSON.parse(readFileSync(join(runner.config.dataDir, "state.json"), "utf8"))).toEqual({ lastWorkspace: "work" });
  });

  test("POST /api/sessions answers 400 for an unknown or missing workspace and an empty prompt", async () => {
    const bad: unknown[] = [
      { workspace: "nope", prompt: "hi" },
      { prompt: "hi" },
      { workspace: "gone", prompt: "hi" },
      { workspace: "work", prompt: "" },
      { workspace: "work", prompt: "  \n " },
      { workspace: "work" },
      { workspace: "work", prompt: 5 },
      ["work", "hi"],
    ];
    for (const body of bad) {
      const res = await runner.post("/api/sessions", body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    const notJson = await fetch(`${runner.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
  });

  test("POST /api/sessions answers 201 with a running session, and the turn finishes in the background", async () => {
    const socket = await connect(runner);
    const res = await runner.post("/api/sessions", { workspace: "work", prompt: "first line that is the title\nsecond line" });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: SessionMeta };
    expect(session).toMatchObject({ workspace: "work", cwd: join(runner.dir, "work"), title: "first line that is the title", status: "running", claudeSessionId: null });
    await settled(socket, session.id);
    socket.close();
    const { sessions } = (await (await runner.get("/api/sessions")).json()) as SessionsResponse;
    const stored = sessions.find((s) => s.id === session.id)!;
    expect(stored.status).toBe("idle");
    expect(stored.claudeSessionId).toStartWith("fake-");
  });

  test("a title is cut to 80 characters", async () => {
    const session = await runner.startSession("x".repeat(200));
    expect(session.title).toBe("x".repeat(80));
  });

  test("GET /api/sessions lists the newest first", async () => {
    const a = await runner.startSession("older");
    const b = await runner.startSession("newer");
    const { sessions } = (await (await runner.get("/api/sessions")).json()) as SessionsResponse;
    const ids = sessions.map((s) => s.id);
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(a.id);
  });

  test("GET /api/sessions/:id/events returns the stored events, seq 1, 2, 3, and only the later ones with after", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("please use tool");
    await settled(socket, session.id);
    socket.close();
    const { events } = (await (await runner.get(`/api/sessions/${session.id}/events`)).json()) as EventsResponse;
    expect(kinds(events)).toEqual(["user", "tool_use", "tool_result", "assistant_text", "result"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]).toMatchObject({ kind: "user", text: "please use tool" });
    const use = events[1] as Extract<SessionEvent, { kind: "tool_use" }>;
    expect(events[2]).toMatchObject({ kind: "tool_result", toolUseId: use.toolUseId, isError: false });
    expect(events[3]).toMatchObject({ kind: "assistant_text", text: fakeReply("please use tool") });
    expect(events[4]).toMatchObject({ kind: "result", ok: true });
    const later = (await (await runner.get(`/api/sessions/${session.id}/events?after=3`)).json()) as EventsResponse;
    expect(later.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(((await (await runner.get(`/api/sessions/${session.id}/events?after=5`)).json()) as EventsResponse).events).toEqual([]);
    // What is on disk is what the API returns.
    const lines = readFileSync(join(runner.config.dataDir, "events", `${session.id}.jsonl`), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual(events);
  });

  test("events answers 404 for an unknown session and 400 for a bad after", async () => {
    expect((await runner.get("/api/sessions/nope/events")).status).toBe(404);
    const session = await runner.startSession("hi");
    expect((await runner.get(`/api/sessions/${session.id}/events?after=abc`)).status).toBe(400);
    expect((await runner.get(`/api/sessions/${session.id}/events?after=-1`)).status).toBe(400);
  });

  test("the new routes refuse another site's origin", async () => {
    const headers = { origin: "https://example.com", "content-type": "application/json" };
    expect((await fetch(`${runner.url}/api/workspaces`, { headers })).status).toBe(403);
    expect((await fetch(`${runner.url}/api/sessions`, { headers })).status).toBe(403);
    expect((await fetch(`${runner.url}/api/sessions/x/events`, { headers })).status).toBe(403);
    const before = ((await (await runner.get("/api/sessions")).json()) as SessionsResponse).sessions.length;
    const post = await fetch(`${runner.url}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ workspace: "work", prompt: "hi" }) });
    expect(post.status).toBe(403);
    expect(((await (await runner.get("/api/sessions")).json()) as SessionsResponse).sessions.length).toBe(before);
  });
});

describe("WebSocket", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("sends hello with every session on connect", async () => {
    const first = await connect(runner);
    expect(first.messages[0]).toEqual({ type: "hello", sessions: [] });
    const session = await runner.startSession("hi");
    await settled(first, session.id);
    first.close();
    const second = await connect(runner);
    const hello = second.messages[0] as Extract<ServerMessage, { type: "hello" }>;
    expect(hello.sessions.map((s) => [s.id, s.status])).toEqual([[session.id, "idle"]]);
    second.close();
  });

  test("streams deltas, every stored event, and the session as it changes", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("echo this");
    await settled(socket, session.id);
    const mine = socket.messages.filter((m) => (m.type === "session" ? m.session.id === session.id : (m.type === "event" || m.type === "delta") && m.sessionId === session.id));
    const deltas = mine.flatMap((m) => (m.type === "delta" ? [m.text] : []));
    expect(deltas.length).toBe(3);
    expect(deltas.join("")).toBe(fakeReply("echo this"));
    const events = eventsOf(mine, session.id);
    expect(kinds(events)).toEqual(["user", "assistant_text", "result"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The deltas come before the complete text that replaces them.
    const order = mine.map((m) => (m.type === "event" ? m.event.kind : m.type));
    expect(order.lastIndexOf("delta")).toBeLessThan(order.indexOf("assistant_text"));
    // The same events are stored.
    expect(((await (await runner.get(`/api/sessions/${session.id}/events`)).json()) as EventsResponse).events).toEqual(events);
    const metas = mine.flatMap((m) => (m.type === "session" ? [m.session] : []));
    expect(metas.some((s) => s.status === "running" && s.claudeSessionId?.startsWith("fake-"))).toBe(true);
    expect(metas.at(-1)).toMatchObject({ status: "idle", lastSeq: 3 });
    socket.close();
  });

  test("a prompt containing 'fail' ends in an error event and the error status", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("please fail");
    const last = (await settled(socket, session.id)) as Extract<ServerMessage, { type: "session" }>;
    expect(last.session.status).toBe("error");
    const events = eventsOf(socket.messages, session.id);
    expect(kinds(events)).toEqual(["user", "assistant_text", "error"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", message: FAKE_ERROR });
    socket.close();
  });

  test("the upgrade is refused for another site's origin and another host", async () => {
    const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await fetch(`${runner.url}/ws`, { headers: { ...upgrade, origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${runner.url}/ws`, { headers: { ...upgrade, host: "evil.test" } })).status).toBe(403);
    // Without the upgrade headers it is not a WebSocket request.
    expect((await runner.get("/ws")).status).toBe(400);
  });
});

describe("a driver that misbehaves", () => {
  test("one that throws is recorded as an error event", async () => {
    const driver: AgentDriver = {
      async *run() {
        yield { type: "delta", text: "a" };
        throw new Error("boom");
      },
    };
    const runner = testRunner({ driver });
    const socket = await connect(runner);
    const session = await runner.startSession("hi");
    await settled(socket, session.id);
    const events = eventsOf(socket.messages, session.id);
    expect(events.at(-1)).toMatchObject({ kind: "error", message: "boom", seq: 2 });
    socket.close();
    await runner.stop();
  });

  test("one that returns without a result is recorded as an error, and a failed result gives the error status", async () => {
    let ok: boolean | null = null;
    const driver: AgentDriver = {
      async *run() {
        if (ok !== null) yield { type: "event", event: { kind: "result", ok, text: "error_max_turns" } };
      },
    };
    const runner = testRunner({ driver });
    const socket = await connect(runner);
    const silent = await runner.startSession("hi");
    await settled(socket, silent.id);
    expect(eventsOf(socket.messages, silent.id).at(-1)).toMatchObject({ kind: "error", message: NO_RESULT });
    ok = false;
    const failed = await runner.startSession("hi");
    const last = (await settled(socket, failed.id)) as Extract<ServerMessage, { type: "session" }>;
    expect(last.session.status).toBe("error");
    expect(eventsOf(socket.messages, failed.id).at(-1)).toMatchObject({ kind: "result", ok: false });
    socket.close();
    await runner.stop();
  });
});

describe("restart", () => {
  test("sessions survive, and one that was running becomes error with 'the runner restarted'", async () => {
    // A driver that never finishes, so the session is still running when the runner stops.
    const stuck: AgentDriver = {
      async *run(input) {
        yield { type: "session_id", id: "claude-1" };
        yield { type: "event", event: { kind: "assistant_text", text: "working" } };
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
      },
    };
    const first = testRunner({ driver: stuck });
    const socket = await connect(first);
    const session = await first.startSession("never ends");
    await socket.waitFor((m) => m.type === "event" && m.event.kind === "assistant_text");
    socket.close();
    await first.stop();
    const sessionsFile = join(first.config.dataDir, "sessions.json");
    expect(existsSync(sessionsFile)).toBe(true);
    expect((JSON.parse(readFileSync(sessionsFile, "utf8")) as SessionMeta[])[0]!.status).toBe("running");

    const second = testRunner({ dir: first.dir });
    const { sessions } = (await (await second.get("/api/sessions")).json()) as SessionsResponse;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: session.id, status: "error", claudeSessionId: "claude-1", lastSeq: 3 });
    const { events } = (await (await second.get(`/api/sessions/${session.id}/events`)).json()) as EventsResponse;
    expect(kinds(events)).toEqual(["user", "assistant_text", "error"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[2]).toMatchObject({ kind: "error", message: RESTARTED });
    expect(((await (await second.get("/api/workspaces")).json()) as WorkspacesResponse).lastUsed).toBe("work");
    await second.stop();

    // A third start changes nothing more.
    const third = testRunner({ dir: first.dir });
    expect(((await (await third.get(`/api/sessions/${session.id}/events`)).json()) as EventsResponse).events).toHaveLength(3);
    await third.stop();
  });
});
