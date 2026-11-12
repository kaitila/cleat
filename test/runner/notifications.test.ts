// Notifications: what the runner records for the shell's toasts, and GET /api/notifications.
import { afterAll, describe, expect, test } from "bun:test";
import type { NotificationsResponse, SessionEvent } from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { FAKE_ERROR, fakeDecided, fakeReply } from "../../src/runner/agent-fake";
import { approvalBody, bodyOf, KEEP_NOTIFICATIONS, NO_TEXT, Notifications, toolSummary } from "../../src/runner/notifications";
import { FAILED, NO_RESULT } from "../../src/runner/sessions";
import { connect, settled, testRunner, type TestRunner } from "./helpers";

async function notes(runner: TestRunner, query = ""): Promise<NotificationsResponse> {
  const res = await runner.get(`/api/notifications${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as NotificationsResponse;
}

describe("the notification log", () => {
  test("seq starts at 1 and `after` returns the higher ones, oldest first", () => {
    const log = new Notifications();
    expect(log.after(0)).toEqual({ notifications: [], latest: 0 });
    const first = log.add({ kind: "finished", sessionId: "s1", title: "one", body: "done" });
    log.add({ kind: "error", sessionId: "s2", title: "two", body: "bad" });
    expect(first).toMatchObject({ seq: 1, kind: "finished", sessionId: "s1", title: "one", body: "done" });
    expect(new Date(first.ts).toISOString()).toBe(first.ts);
    expect(log.after(0).notifications.map((n) => n.seq)).toEqual([1, 2]);
    expect(log.after(1)).toMatchObject({ notifications: [{ seq: 2, title: "two" }], latest: 2 });
    expect(log.after(2)).toEqual({ notifications: [], latest: 2 });
    expect(log.after(99)).toEqual({ notifications: [], latest: 2 });
  });

  test("only the newest 200 are kept, and seq goes on", () => {
    const log = new Notifications();
    for (let i = 1; i <= KEEP_NOTIFICATIONS + 5; i++) log.add({ kind: "finished", sessionId: "s", title: "t", body: String(i) });
    const { notifications, latest } = log.after(0);
    expect(latest).toBe(205);
    expect(notifications).toHaveLength(200);
    expect(notifications[0]!.seq).toBe(6);
    expect(notifications.at(-1)).toMatchObject({ seq: 205, body: "205" });
  });

  test("a body is one line of at most 140 characters", () => {
    expect(bodyOf("  two\n\nlines\there ")).toBe("two lines here");
    expect(bodyOf("x".repeat(300))).toHaveLength(140);
    expect(bodyOf("")).toBe("");
  });

  test("an approval's body names the tool and its one-line summary", () => {
    expect(approvalBody("Bash", { command: "git  push\n origin" })).toBe("Bash: git push origin");
    expect(approvalBody("Write", { file_path: "/w/a.txt", content: "long" })).toBe("Write: /w/a.txt");
    expect(approvalBody("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toBe("NotebookEdit: /w/n.ipynb");
    expect(approvalBody("WebFetch", { url: "https://example.com" })).toBe('WebFetch: {"url":"https://example.com"}');
    expect(approvalBody("Odd", undefined)).toBe("Odd");
    expect(approvalBody("Bash", { command: "y".repeat(400) })).toHaveLength(140);
    expect(toolSummary("Other", "plain  text")).toBe("plain text");
  });
});

describe("what the runner records", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("nothing before the first turn ends", async () => {
    expect(await notes(runner)).toEqual({ notifications: [], latest: 0 });
  });

  test("a finished turn: `finished`, titled as the session, with the start of the final text", async () => {
    const socket = await connect(runner);
    const prompt = `summarise this\n${"long ".repeat(60)}`;
    const session = await runner.startSession(prompt);
    await settled(socket, session.id);
    const { notifications, latest } = await notes(runner);
    expect(latest).toBe(1);
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n).toMatchObject({ seq: 1, kind: "finished", sessionId: session.id, title: "summarise this" });
    expect(n.body).toBe(fakeReply(prompt).replace(/\s+/g, " ").trim().slice(0, 140));
    expect(n.body).toHaveLength(140);
    expect(new Date(n.ts).toISOString()).toBe(n.ts);
    socket.close();
  });

  test("an approval that opens: `needs_approval` at once, then `finished` when its turn ends", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("this needs approval");
    const ask = (await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "approval_request")) as { event: Extract<SessionEvent, { kind: "approval_request" }> };
    const open = await notes(runner, "?after=1");
    expect(open.latest).toBe(2);
    expect(open.notifications).toEqual([
      { seq: 2, ts: expect.any(String), kind: "needs_approval", sessionId: session.id, title: "this needs approval", body: `Write: ${runner.dir}/work/fake.txt`.slice(0, 140) },
    ]);
    await runner.post(`/api/sessions/${session.id}/approvals/${ask.event.approvalId}`, { decision: "allow" });
    await settled(socket, session.id);
    const done = await notes(runner, "?after=2");
    expect(done).toMatchObject({ latest: 3, notifications: [{ seq: 3, kind: "finished", sessionId: session.id, body: fakeDecided("allow") }] });
    socket.close();
  });

  test("a failed turn: `error` with the message", async () => {
    const socket = await connect(runner);
    const session = await runner.startSession("please fail");
    await settled(socket, session.id);
    const { notifications, latest } = await notes(runner, "?after=3");
    expect(latest).toBe(4);
    expect(notifications).toMatchObject([{ seq: 4, kind: "error", sessionId: session.id, title: "please fail", body: FAKE_ERROR }]);
    socket.close();
  });

  test("`after` filters, and anything but a whole number is refused", async () => {
    expect((await notes(runner)).notifications.map((n) => n.seq)).toEqual([1, 2, 3, 4]);
    expect((await notes(runner, "?after=0")).notifications).toHaveLength(4);
    expect(await notes(runner, "?after=4")).toEqual({ notifications: [], latest: 4 });
    expect(await notes(runner, "?after=4000")).toEqual({ notifications: [], latest: 4 });
    for (const bad of ["-1", "1.5", "abc", ""]) {
      const res = await runner.get(`/api/notifications?after=${bad}`);
      expect(`${bad}: ${res.status}`).toBe(`${bad}: 400`);
    }
  });

  test("the route passes the same guard as the others", async () => {
    const res = await fetch(`${runner.url}/api/notifications`, { headers: { origin: "http://evil.test" } });
    expect(res.status).toBe(403);
  });
});

describe("turns that end in other ways", () => {
  /** One driver, scripted by the prompt. */
  const driver: AgentDriver = {
    async *run(input) {
      if (input.prompt === "throw") throw new Error("the driver broke");
      if (input.prompt === "silent") return;
      if (input.prompt === "not ok") {
        yield { type: "event", event: { kind: "result", ok: false, text: "ran out of turns" } };
      } else if (input.prompt === "bare") {
        yield { type: "event", event: { kind: "result", ok: true } };
      } else if (input.prompt === "unanswered") {
        void input.approve({ toolName: "Bash", input: { command: "rm -rf build" } });
        yield { type: "event", event: { kind: "result", ok: true, text: "gave up waiting" } };
      } else {
        yield { type: "event", event: { kind: "assistant_text", text: "first" } };
        yield { type: "event", event: { kind: "assistant_text", text: "the last text" } };
        yield { type: "event", event: { kind: "result", ok: true } };
      }
    },
  };
  const runner = testRunner({ driver });
  afterAll(() => runner.stop());

  async function run(prompt: string) {
    const socket = await connect(runner);
    const before = (await notes(runner)).latest;
    const session = await runner.startSession(prompt);
    await settled(socket, session.id);
    socket.close();
    return { session, added: (await notes(runner, `?after=${before}`)).notifications };
  }

  test("a result without text uses the turn's last assistant text", async () => {
    const { session, added } = await run("texts");
    expect(added).toMatchObject([{ kind: "finished", sessionId: session.id, title: "texts", body: "the last text" }]);
  });

  test("a result with nothing said still notifies", async () => {
    expect((await run("bare")).added).toMatchObject([{ kind: "finished", body: NO_TEXT }]);
  });

  test("a result that is not ok is an error", async () => {
    expect((await run("not ok")).added).toMatchObject([{ kind: "error", body: "ran out of turns" }]);
  });

  test("a driver that throws, or ends without a result, is an error", async () => {
    expect((await run("throw")).added).toMatchObject([{ kind: "error", body: "the driver broke" }]);
    expect((await run("silent")).added).toMatchObject([{ kind: "error", body: NO_RESULT }]);
    expect(FAILED).toBeTruthy();
  });

  test("an approval the turn ended on: one needs_approval, then finished", async () => {
    const { added } = await run("unanswered");
    expect(added.map((n) => [n.kind, n.body])).toEqual([
      ["needs_approval", "Bash: rm -rf build"],
      ["finished", "gave up waiting"],
    ]);
  });

  test("stopping the runner records nothing", async () => {
    const waiting: AgentDriver = {
      async *run(input) {
        await input.approve({ toolName: "Bash", input: { command: "sleep" } });
        yield { type: "event", event: { kind: "result", ok: true } };
      },
    };
    const other = testRunner({ driver: waiting });
    const socket = await connect(other);
    const session = await other.startSession("wait");
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "approval_request");
    socket.close();
    await other.stop();
    // A restart begins a new log: seq starts at 1 again and nothing is replayed.
    const again = testRunner({ dir: other.dir });
    try {
      expect(await notes(again)).toEqual({ notifications: [], latest: 0 });
    } finally {
      await again.stop();
    }
  });
});
