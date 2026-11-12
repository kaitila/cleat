// Approvals: a tool call that needs approval waits for POST /api/sessions/:id/approvals/:approvalId.
import { afterAll, describe, expect, test } from "bun:test";
import type { ApprovalDecision, EventsResponse, ServerMessage, SessionEvent, SessionMeta, SessionsResponse } from "../../src/shared/protocol";
import type { AgentDriver, TurnInput } from "../../src/runner/agent";
import { DENIED } from "../../src/runner/agent-claude";
import { FAKE_REASON, fakeDecided } from "../../src/runner/agent-fake";
import { APPROVAL_OPEN, NO_APPROVAL } from "../../src/runner/sessions";
import { RESTARTED } from "../../src/runner/store";
import { connect, settled, testRunner, type Socket, type TestRunner } from "./helpers";

type Ask = Extract<SessionEvent, { kind: "approval_request" }>;

async function eventsOf(runner: TestRunner, id: string): Promise<SessionEvent[]> {
  return ((await (await runner.get(`/api/sessions/${id}/events`)).json()) as EventsResponse).events;
}

async function stored(runner: TestRunner, id: string): Promise<SessionMeta> {
  return ((await (await runner.get("/api/sessions")).json()) as SessionsResponse).sessions.find((s) => s.id === id)!;
}

/** The session's nth approval_request (0 first), once it has been sent. */
async function asked(socket: Socket, id: string, n = 0): Promise<Ask> {
  const nth = () => socket.messages.flatMap((m) => (m.type === "event" && m.sessionId === id && m.event.kind === "approval_request" ? [m.event] : []))[n];
  await socket.waitFor(() => nth() !== undefined);
  return nth()!;
}

const statuses = (socket: Socket, id: string) => socket.messages.flatMap((m: ServerMessage) => (m.type === "session" && m.session.id === id ? [m.session.status] : []));
const answer = (runner: TestRunner, id: string, approvalId: string, decision: unknown) => runner.post(`/api/sessions/${id}/approvals/${approvalId}`, { decision });

/** A driver whose turn asks for `count` approvals at once and reports the decisions as its text. */
function askingDriver(count: number, inputs: TurnInput[] = [], callSignals: AbortSignal[] = []): AgentDriver {
  return {
    async *run(input) {
      inputs.push(input);
      yield { type: "session_id", id: "claude-1" };
      const decisions = await Promise.all(
        Array.from({ length: count }, (_, i) => input.approve({ toolUseId: `t${i}`, toolName: "Bash", input: { command: `echo ${i}` } }, callSignals[i])),
      );
      if (input.signal.aborted) return;
      yield { type: "event", event: { kind: "assistant_text", text: decisions.join(",") } };
      yield { type: "event", event: { kind: "result", ok: true } };
    },
  };
}

describe("the fake agent's approval", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("the call waits: an approval_request is stored and the session is waiting_approval", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("this needs approval");
    const ask = await asked(socket, session.id);
    expect(ask).toMatchObject({ kind: "approval_request", toolName: "Write", input: { file_path: `${runner.dir}/work/fake.txt`, content: "fake" }, reason: FAKE_REASON });
    expect(ask.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    await Bun.sleep(60);
    expect(await stored(runner, session.id)).toMatchObject({ status: "waiting_approval", lastSeq: ask.seq });
    const events = await eventsOf(runner, session.id);
    expect(events.map((e) => e.kind)).toEqual(["user", "tool_use", "approval_request"]);
    expect(events[1]).toMatchObject({ kind: "tool_use", toolUseId: ask.toolUseId! });
    // No reply while it is open.
    const reply = await runner.post(`/api/sessions/${session.id}/messages`, { prompt: "hello?" });
    expect(reply.status).toBe(409);
    expect(await reply.json()).toEqual({ error: APPROVAL_OPEN });

    const res = await answer(runner, session.id, ask.approvalId, "allow");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: SessionMeta }).session).toMatchObject({ id: session.id, status: "running", lastSeq: ask.seq + 1 });
    await settled(socket, session.id);
    const all = await eventsOf(runner, session.id);
    expect(all.map((e) => e.kind)).toEqual(["user", "tool_use", "approval_request", "approval_resolved", "tool_result", "assistant_text", "result"]);
    expect(all[3]).toMatchObject({ kind: "approval_resolved", approvalId: ask.approvalId, decision: "allow" });
    expect(all[4]).toMatchObject({ kind: "tool_result", isError: false });
    expect(all[5]).toMatchObject({ kind: "assistant_text", text: fakeDecided("allow") });
    expect(statuses(socket, session.id).filter((s, i, a) => s !== a[i - 1])).toEqual(["running", "waiting_approval", "running", "idle"]);
    expect(await stored(runner, session.id)).toMatchObject({ status: "idle" });
    // The fake never writes.
    expect(await Bun.file(`${runner.dir}/work/fake.txt`).exists()).toBe(false);
    socket.close();
  });

  test("deny: the call gets the denial and the next text says so", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("this needs approval too");
    const ask = await asked(socket, session.id);
    expect((await answer(runner, session.id, ask.approvalId, "deny")).status).toBe(200);
    await settled(socket, session.id);
    const all = await eventsOf(runner, session.id);
    expect(all[3]).toMatchObject({ kind: "approval_resolved", approvalId: ask.approvalId, decision: "deny" });
    expect(all[4]).toMatchObject({ kind: "tool_result", content: DENIED, isError: true });
    expect(all[5]).toMatchObject({ kind: "assistant_text", text: fakeDecided("deny") });
    socket.close();
  });

  test("404 for an unknown approval, an answered one, another session's; 400 for a bad decision", async () => {
    const socket = await connect(runner);
    const one = await runner.startSession("one needs approval");
    const two = await runner.startSession("two needs approval");
    const askOne = await asked(socket, one.id);
    const askTwo = await asked(socket, two.id);
    for (const bad of ["yes", "always", undefined, true]) {
      const res = await answer(runner, one.id, askOne.approvalId, bad);
      expect(res.status).toBe(400);
    }
    expect((await runner.post(`/api/sessions/${one.id}/approvals/${askOne.approvalId}`, ["allow"])).status).toBe(400);
    const unknown = await answer(runner, one.id, crypto.randomUUID(), "allow");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: NO_APPROVAL });
    expect((await answer(runner, crypto.randomUUID(), askOne.approvalId, "allow")).status).toBe(404);
    // One session can't answer another's.
    expect((await answer(runner, two.id, askOne.approvalId, "allow")).status).toBe(404);
    expect(await stored(runner, one.id)).toMatchObject({ status: "waiting_approval" });
    expect((await eventsOf(runner, one.id)).some((e) => e.kind === "approval_resolved")).toBe(false);

    expect((await answer(runner, one.id, askOne.approvalId, "deny")).status).toBe(200);
    expect((await answer(runner, one.id, askOne.approvalId, "allow")).status).toBe(404);
    expect((await answer(runner, two.id, askTwo.approvalId, "allow")).status).toBe(200);
    await settled(socket, one.id);
    await settled(socket, two.id);
    // The second answer changed nothing: it stays denied, once.
    const resolved = (await eventsOf(runner, one.id)).filter((e) => e.kind === "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decision: "deny" });
    // Answered and over, it is still a 404.
    expect((await answer(runner, one.id, askOne.approvalId, "allow")).status).toBe(404);
    socket.close();
  });

  test("the route is guarded like every other", async () => {
    const res = await fetch(`${runner.url}/api/sessions/x/approvals/y`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: '{"decision":"allow"}' });
    expect(res.status).toBe(403);
    const plain = await fetch(`${runner.url}/api/sessions/x/approvals/y`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"decision":"allow"}' });
    expect(plain.status).toBe(403);
  });
});

describe("several approvals, aborts and stops", () => {
  test("several can be open at once: the session runs again only when none is", async () => {
    const runner = testRunner({ driver: askingDriver(3) });
    try {
      const socket = await connect(runner);
      const session = await runner.startSession("go");
      const asks = [await asked(socket, session.id, 0), await asked(socket, session.id, 1), await asked(socket, session.id, 2)];
      expect(new Set(asks.map((a) => a.approvalId)).size).toBe(3);
      expect(asks.map((a) => a.toolUseId)).toEqual(["t0", "t1", "t2"]);
      // Answered out of order.
      const first = (await (await answer(runner, session.id, asks[1]!.approvalId, "deny")).json()) as { session: SessionMeta };
      expect(first.session.status).toBe("waiting_approval");
      const second = (await (await answer(runner, session.id, asks[2]!.approvalId, "allow")).json()) as { session: SessionMeta };
      expect(second.session.status).toBe("waiting_approval");
      const third = (await (await answer(runner, session.id, asks[0]!.approvalId, "allow")).json()) as { session: SessionMeta };
      expect(third.session.status).toBe("running");
      await settled(socket, session.id);
      const events = await eventsOf(runner, session.id);
      expect(events.find((e) => e.kind === "assistant_text")).toMatchObject({ text: "allow,deny,allow" });
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      socket.close();
    } finally {
      await runner.stop();
    }
  });

  test("the agent's abort signal for a call resolves it as a deny", async () => {
    const call = new AbortController();
    const runner = testRunner({ driver: askingDriver(1, [], [call.signal]) });
    try {
      const socket = await connect(runner);
      const session = await runner.startSession("go");
      const ask = await asked(socket, session.id);
      call.abort();
      await settled(socket, session.id);
      const events = await eventsOf(runner, session.id);
      expect(events.map((e) => e.kind)).toEqual(["user", "approval_request", "approval_resolved", "assistant_text", "result"]);
      expect(events[2]).toMatchObject({ approvalId: ask.approvalId, decision: "deny" });
      expect(events[3]).toMatchObject({ text: "deny" });
      expect((await answer(runner, session.id, ask.approvalId, "allow")).status).toBe(404);
      socket.close();
    } finally {
      await runner.stop();
    }
  });

  test("a call whose signal is already aborted is denied without asking", async () => {
    const call = new AbortController();
    call.abort();
    const runner = testRunner({ driver: askingDriver(1, [], [call.signal]) });
    try {
      const socket = await connect(runner);
      const session = await runner.startSession("go");
      await settled(socket, session.id);
      expect((await eventsOf(runner, session.id)).map((e) => e.kind)).toEqual(["user", "assistant_text", "result"]);
      socket.close();
    } finally {
      await runner.stop();
    }
  });

  test("a turn that ends with an approval open denies it first, and a late ask is denied", async () => {
    let late: Promise<ApprovalDecision> | undefined;
    let pending: Promise<ApprovalDecision> | undefined;
    let turnInput: TurnInput | undefined;
    const driver: AgentDriver = {
      async *run(input) {
        turnInput = input;
        pending = input.approve({ toolName: "Bash", input: { command: "sleep 1" } });
        await Bun.sleep(20);
        yield { type: "event", event: { kind: "error", message: "the agent died" } };
      },
    };
    const runner = testRunner({ driver });
    try {
      const socket = await connect(runner);
      const session = await runner.startSession("go");
      await settled(socket, session.id);
      expect(await pending).toBe("deny");
      late = turnInput!.approve({ toolName: "Bash", input: { command: "late" } });
      expect(await late).toBe("deny");
      const events = await eventsOf(runner, session.id);
      expect(events.map((e) => e.kind)).toEqual(["user", "approval_request", "approval_resolved", "error"]);
      expect(events[1]).not.toHaveProperty("toolUseId");
      expect(events[1]).not.toHaveProperty("reason");
      expect(await stored(runner, session.id)).toMatchObject({ status: "error", lastSeq: 4 });
      socket.close();
    } finally {
      await runner.stop();
    }
  });

  test("stopping the runner denies an open approval, and the next start records it", async () => {
    const inputs: TurnInput[] = [];
    let decided: ApprovalDecision[] | undefined;
    const driver: AgentDriver = {
      async *run(input) {
        inputs.push(input);
        decided = await Promise.all([input.approve({ toolName: "Write", input: {} }), input.approve({ toolName: "Edit", input: {} })]);
      },
    };
    const first = testRunner({ driver });
    const socket = await connect(first);
    const session = await first.startSession("go");
    const asks = [await asked(socket, session.id, 0), await asked(socket, session.id, 1)];
    expect((await answer(first, session.id, asks[0]!.approvalId, "allow")).status).toBe(200);
    socket.close();
    await first.stop();
    // The waiting call was denied, never allowed, and nothing more was stored.
    expect(decided).toEqual(["allow", "deny"]);

    const second = testRunner({ dir: first.dir });
    try {
      const events = await eventsOf(second, session.id);
      expect(events.map((e) => e.kind)).toEqual(["user", "approval_request", "approval_request", "approval_resolved", "approval_resolved", "error"]);
      expect(events[4]).toMatchObject({ approvalId: asks[1]!.approvalId, decision: "deny" });
      expect(events[5]).toMatchObject({ message: RESTARTED });
      expect(await stored(second, session.id)).toMatchObject({ status: "error", lastSeq: 6 });
      expect((await answer(second, session.id, asks[1]!.approvalId, "allow")).status).toBe(404);
    } finally {
      await second.stop();
    }
  });
});
