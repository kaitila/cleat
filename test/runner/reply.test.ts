// POST /api/sessions/:id/messages: a reply continues a session by resuming its conversation.
import { afterAll, describe, expect, test } from "bun:test";
import type { EventsResponse, ServerMessage, SessionEvent, SessionMeta, SessionsResponse } from "../../src/shared/protocol";
import type { AgentDriver, TurnInput } from "../../src/runner/agent";
import { FAKE_ERROR, fakeFirst, fakeReply } from "../../src/runner/agent-fake";
import { APPROVAL_OPEN, BUSY, busy } from "../../src/runner/sessions";
import { RESTARTED } from "../../src/runner/store";
import { connect, settled, testRunner, type Socket, type TestRunner } from "./helpers";

const ASK = "what did I say first?";
type SessionMessage = Extract<ServerMessage, { type: "session" }>;

/** Waits until a turn that stored events after `after` has ended (idle or error). */
async function settledAfter(socket: Socket, id: string, after: number): Promise<SessionMeta> {
  const m = await socket.waitFor(
    (m) => m.type === "session" && m.session.id === id && m.session.lastSeq > after && (m.session.status === "idle" || m.session.status === "error"),
  );
  return (m as SessionMessage).session;
}

async function eventsOf(runner: TestRunner, id: string, after = 0): Promise<SessionEvent[]> {
  return ((await (await runner.get(`/api/sessions/${id}/events?after=${after}`)).json()) as EventsResponse).events;
}

async function stored(runner: TestRunner, id: string): Promise<SessionMeta> {
  return ((await (await runner.get("/api/sessions")).json()) as SessionsResponse).sessions.find((s) => s.id === id)!;
}

/** A session whose first turn has finished. */
async function finished(runner: TestRunner, socket: Socket, prompt: string): Promise<SessionMeta> {
  const session = await runner.startSession(prompt);
  await settled(socket, session.id);
  return stored(runner, session.id);
}

/** A driver that keeps each turn's input and never ends a turn until the runner stops. */
function stuckDriver(inputs: TurnInput[] = []): AgentDriver {
  return {
    async *run(input) {
      inputs.push(input);
      yield { type: "session_id", id: "claude-1" };
      yield { type: "event", event: { kind: "assistant_text", text: "working" } };
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
    },
  };
}

describe("POST /api/sessions/:id/messages", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("answers 202 with the session running, and the turn reaches the same conversation", async () => {
    const socket = await connect(runner);
    const first = await finished(runner, socket, "alpha");
    expect(first).toMatchObject({ status: "idle", lastSeq: 3 });
    const res = await runner.post(`/api/sessions/${first.id}/messages`, { prompt: ASK });
    expect(res.status).toBe(202);
    const { session } = (await res.json()) as { session: SessionMeta };
    expect(session).toMatchObject({ id: first.id, status: "running", claudeSessionId: first.claudeSessionId, title: "alpha", lastSeq: 4 });
    const last = await settledAfter(socket, first.id, 4);
    expect(last).toMatchObject({ id: first.id, status: "idle", claudeSessionId: first.claudeSessionId, lastSeq: 6 });
    // The fake answers with the conversation's first prompt, which only the first turn had.
    const events = await eventsOf(runner, first.id);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([[1, "user"], [2, "assistant_text"], [3, "result"], [4, "user"], [5, "assistant_text"], [6, "result"]]);
    expect(events[3]).toMatchObject({ kind: "user", text: ASK });
    expect(events[4]).toMatchObject({ kind: "assistant_text", text: fakeFirst("alpha") });
    expect(events[5]).toMatchObject({ kind: "result", ok: true });
    // The socket carried the same events, and the session running in between.
    const sent = socket.messages.flatMap((m) => (m.type === "event" && m.sessionId === first.id ? [m.event] : []));
    expect(sent).toEqual(events);
    const statuses = socket.messages.flatMap((m) => (m.type === "session" && m.session.id === first.id ? [`${m.session.lastSeq}:${m.session.status}`] : []));
    expect(statuses).toContain("4:running");
    expect(statuses.at(-1)).toBe("6:idle");
    socket.close();
    expect(await stored(runner, first.id)).toMatchObject({ status: "idle", lastSeq: 6 });
  });

  test("a second reply continues the same conversation again", async () => {
    const socket = await connect(runner);
    const first = await finished(runner, socket, "beta");
    expect((await runner.post(`/api/sessions/${first.id}/messages`, { prompt: "more" })).status).toBe(202);
    await settledAfter(socket, first.id, 4);
    expect((await runner.post(`/api/sessions/${first.id}/messages`, { prompt: ASK })).status).toBe(202);
    const last = await settledAfter(socket, first.id, 7);
    expect(last).toMatchObject({ status: "idle", claudeSessionId: first.claudeSessionId, lastSeq: 9 });
    const events = await eventsOf(runner, first.id, 3);
    expect(events[1]).toMatchObject({ kind: "assistant_text", text: fakeReply("more") });
    expect(events[4]).toMatchObject({ kind: "assistant_text", text: fakeFirst("beta") });
    socket.close();
  });

  test("a new session is its own conversation", async () => {
    const socket = await connect(runner);
    await finished(runner, socket, "gamma");
    const other = await finished(runner, socket, ASK);
    expect((await eventsOf(runner, other.id))[1]).toMatchObject({ kind: "assistant_text", text: fakeFirst(ASK) });
    socket.close();
  });

  test("answers 404 for an unknown session", async () => {
    const res = await runner.post("/api/sessions/nope/messages", { prompt: "hi" });
    expect(res.status).toBe(404);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  test("answers 400 for an empty or missing prompt, and stores nothing", async () => {
    const socket = await connect(runner);
    const session = await finished(runner, socket, "delta");
    socket.close();
    const bad: unknown[] = [{ prompt: "" }, { prompt: "  \n " }, {}, { prompt: 5 }, ["hi"]];
    for (const body of bad) {
      const res = await runner.post(`/api/sessions/${session.id}/messages`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    const notJson = await fetch(`${runner.url}/api/sessions/${session.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect(await stored(runner, session.id)).toMatchObject({ status: "idle", lastSeq: 3 });
  });

  test("refuses another site's origin and a body that isn't JSON by content type", async () => {
    const socket = await connect(runner);
    const session = await finished(runner, socket, "epsilon");
    socket.close();
    const url = `${runner.url}/api/sessions/${session.id}/messages`;
    const body = JSON.stringify({ prompt: "hi" });
    expect((await fetch(url, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body })).status).toBe(403);
    expect(await stored(runner, session.id)).toMatchObject({ status: "idle", lastSeq: 3 });
  });

  test("of two replies sent at once, one starts a turn and the other answers 409", async () => {
    const socket = await connect(runner);
    const session = await finished(runner, socket, "zeta");
    const answers = await Promise.all(["one", "two"].map((prompt) => runner.post(`/api/sessions/${session.id}/messages`, { prompt })));
    expect(answers.map((r) => r.status).sort()).toEqual([202, 409]);
    const last = await settledAfter(socket, session.id, 4);
    expect(last.lastSeq).toBe(6);
    socket.close();
  });

  test("a session in error with a conversation retries in that conversation", async () => {
    const socket = await connect(runner);
    const failed = await finished(runner, socket, "eta, please fail");
    expect(failed.status).toBe("error");
    expect(failed.claudeSessionId).toStartWith("fake-");
    expect((await eventsOf(runner, failed.id)).at(-1)).toMatchObject({ kind: "error", message: FAKE_ERROR });
    const res = await runner.post(`/api/sessions/${failed.id}/messages`, { prompt: ASK });
    expect(res.status).toBe(202);
    const last = await settledAfter(socket, failed.id, 4);
    expect(last).toMatchObject({ status: "idle", claudeSessionId: failed.claudeSessionId, lastSeq: 6 });
    expect((await eventsOf(runner, failed.id))[4]).toMatchObject({ kind: "assistant_text", text: fakeFirst("eta, please fail") });
    socket.close();
  });
});

describe("busy", () => {
  const meta = (status: SessionMeta["status"]) => ({ status }) as SessionMeta;

  test("only an idle or failed session takes a reply", () => {
    expect(busy(meta("idle"))).toBeNull();
    expect(busy(meta("error"))).toBeNull();
    expect(busy(meta("running"))).toBe(BUSY);
    expect(busy(meta("waiting_approval"))).toBe(APPROVAL_OPEN);
  });

  test("a reply answers 409 while a turn is running, and stores nothing", async () => {
    const inputs: TurnInput[] = [];
    const runner = testRunner({ driver: stuckDriver(inputs) });
    const socket = await connect(runner);
    const session = await runner.startSession("never ends");
    await socket.waitFor((m) => m.type === "event" && m.event.kind === "assistant_text");
    const res = await runner.post(`/api/sessions/${session.id}/messages`, { prompt: "hello?" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY);
    expect(await stored(runner, session.id)).toMatchObject({ status: "running", lastSeq: 2 });
    expect(inputs).toHaveLength(1);
    socket.close();
    await runner.stop();
  });
});

describe("a session in error without a conversation", () => {
  test("a reply starts a new conversation in the same workspace", async () => {
    const inputs: TurnInput[] = [];
    // The first turn fails before Claude Code reports a session id; later turns work.
    const driver: AgentDriver = {
      async *run(input) {
        inputs.push(input);
        if (inputs.length === 1) throw new Error("could not start");
        yield { type: "session_id", id: "claude-2" };
        yield { type: "event", event: { kind: "result", ok: true, text: "done" } };
      },
    };
    const runner = testRunner({ driver });
    const socket = await connect(runner);
    const failed = await finished(runner, socket, "hi");
    expect(failed).toMatchObject({ status: "error", claudeSessionId: null, lastSeq: 2 });
    expect((await runner.post(`/api/sessions/${failed.id}/messages`, { prompt: "again" })).status).toBe(202);
    const last = await settledAfter(socket, failed.id, 3);
    expect(last).toMatchObject({ id: failed.id, status: "idle", claudeSessionId: "claude-2", lastSeq: 4 });
    expect(inputs.map((i) => [i.prompt, i.cwd, i.resume])).toEqual([["hi", failed.cwd, null], ["again", failed.cwd, null]]);
    // The next reply resumes the conversation the retry started.
    expect((await runner.post(`/api/sessions/${failed.id}/messages`, { prompt: "third" })).status).toBe(202);
    await settledAfter(socket, failed.id, 5);
    expect(inputs[2]!.resume).toBe("claude-2");
    socket.close();
    await runner.stop();
  });

  test("the session id a resumed turn reports replaces the stored one", async () => {
    let turn = 0;
    const driver: AgentDriver = {
      async *run() {
        yield { type: "session_id", id: `claude-${++turn}` };
        yield { type: "event", event: { kind: "result", ok: true } };
      },
    };
    const runner = testRunner({ driver });
    const socket = await connect(runner);
    const first = await finished(runner, socket, "hi");
    expect(first.claudeSessionId).toBe("claude-1");
    await runner.post(`/api/sessions/${first.id}/messages`, { prompt: "again" });
    const last = await settledAfter(socket, first.id, 3);
    expect(last).toMatchObject({ id: first.id, claudeSessionId: "claude-2" });
    socket.close();
    await runner.stop();
  });
});

describe("after a restart", () => {
  test("a reply reaches the same conversation, and events keep counting from lastSeq", async () => {
    const first = testRunner();
    const socket = await connect(first);
    const session = await finished(first, socket, "theta");
    socket.close();
    await first.stop();

    const second = testRunner({ dir: first.dir });
    const socket2 = await connect(second);
    const res = await second.post(`/api/sessions/${session.id}/messages`, { prompt: ASK });
    expect(res.status).toBe(202);
    const last = await settledAfter(socket2, session.id, 4);
    expect(last).toMatchObject({ id: session.id, status: "idle", claudeSessionId: session.claudeSessionId, lastSeq: 6 });
    const events = await eventsOf(second, session.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[4]).toMatchObject({ kind: "assistant_text", text: fakeFirst("theta") });
    socket2.close();
    await second.stop();
  });

  test("a session cut off by the restart can be replied to, and resumes its conversation", async () => {
    const first = testRunner({ driver: stuckDriver() });
    const socket = await connect(first);
    const session = await first.startSession("never ends");
    await socket.waitFor((m) => m.type === "event" && m.event.kind === "assistant_text");
    socket.close();
    await first.stop();

    const inputs: TurnInput[] = [];
    const driver: AgentDriver = {
      async *run(input) {
        inputs.push(input);
        yield { type: "session_id", id: input.resume ?? "new" };
        yield { type: "event", event: { kind: "result", ok: true } };
      },
    };
    const second = testRunner({ dir: first.dir, driver });
    const socket2 = await connect(second);
    expect((await eventsOf(second, session.id)).at(-1)).toMatchObject({ seq: 3, kind: "error", message: RESTARTED });
    expect((await second.post(`/api/sessions/${session.id}/messages`, { prompt: "carry on" })).status).toBe(202);
    const last = await settledAfter(socket2, session.id, 4);
    expect(last).toMatchObject({ status: "idle", claudeSessionId: "claude-1", lastSeq: 5 });
    expect(inputs.map((i) => [i.prompt, i.resume])).toEqual([["carry on", "claude-1"]]);
    socket2.close();
    await second.stop();
  });
});
