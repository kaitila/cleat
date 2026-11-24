// The person's operations on sessions (src/runner/manage.ts, Sessions.interrupt, D0020): rename, stop,
// archive, pin, fork and delete, against the fake agent and transcripts kept in memory.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  NOT_RUNNING,
  TERMINAL_NOT_DELETED,
  type EventsResponse,
  type SessionEvent,
  type SessionMeta,
  type SessionResponse,
  type SessionsResponse,
} from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { COUNT_SLOWLY, fakeDriver, fakeFirst } from "../../src/runner/agent-fake";
import { NOTHING_TO_FORK, forkTitle } from "../../src/runner/manage";
import { BUSY } from "../../src/runner/sessions";
import { assistantEntry, MemoryTranscripts, userEntry } from "../web/chat-transcripts";
import { connect, settled, testRunner, type Socket, type TestRunner } from "./helpers";

/** A driver that writes its turn to the transcript, as Claude Code does, and answers "ok". */
function writingDriver(t: MemoryTranscripts): AgentDriver {
  return {
    async *run(input) {
      const id = input.resume ?? `claude-${crypto.randomUUID()}`;
      yield { type: "session_id", id };
      t.write(id, input.cwd, [userEntry(input.prompt), assistantEntry("ok")]);
      await Bun.sleep(20);
      yield { type: "event", event: { kind: "assistant_text", text: "ok" } };
      yield { type: "event", event: { kind: "result", ok: true, text: "ok" } };
    },
  };
}

const runners: TestRunner[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const r of runners.splice(0)) await r.stop();
});

function runner(options: { transcripts?: MemoryTranscripts; driver?: AgentDriver } = {}): TestRunner {
  const t = options.transcripts;
  const r = testRunner({ driver: options.driver, ...(t ? { sync: { transcripts: t, pollMs: 20, idleMs: 80 }, ops: t } : {}) });
  runners.push(r);
  return r;
}

async function socketOf(r: TestRunner): Promise<Socket> {
  const s = await connect(r);
  sockets.push(s);
  return s;
}

const workPath = (r: TestRunner) => r.config.workspaces.find((w) => w.name === "work")!.path;
const list = async (r: TestRunner, query = "") => ((await (await r.get(`/api/sessions${query}`)).json()) as SessionsResponse).sessions;
const eventsOf = async (r: TestRunner, id: string) => ((await (await r.get(`/api/sessions/${id}/events`)).json()) as EventsResponse).events;
const kinds = (events: SessionEvent[]) => events.map((e) => e.kind);
const sessionOf = async (res: Response) => ((await res.json()) as SessionResponse).session;

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await check();
    if (found !== undefined) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits until the session's turn that starts after now has ended: earlier idle messages don't count. */
async function turnEnds(s: Socket, id: string, from = s.messages.length): Promise<void> {
  // The WebSocket may still bring earlier messages after the request's answer: the end counts only after the start.
  await until("the turn to end", () => {
    const later = s.messages.slice(from);
    const start = later.findIndex((m) => m.type === "session" && m.session.id === id && m.session.status === "running");
    return (start >= 0 && later.slice(start).some((m) => m.type === "session" && m.session.id === id && (m.session.status === "idle" || m.session.status === "error"))) || undefined;
  });
}

/** A session started and finished, with its transcript written. */
async function finished(r: TestRunner, s: Socket, prompt = "hello there"): Promise<SessionMeta> {
  const started = await r.startSession(prompt);
  await settled(s, started.id);
  return (await list(r)).find((x) => x.id === started.id)!;
}

describe("rename", () => {
  test("sets the title, cut as any title, and the transcript's custom title, without counting as activity", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t, driver: writingDriver(t) });
    const s = await socketOf(r);
    const session = await finished(r, s);
    const res = await r.post(`/api/sessions/${session.id}/rename`, { title: "  A better name\nsecond line" });
    expect(res.status).toBe(200);
    const renamed = await sessionOf(res);
    expect(renamed.title).toBe("A better name");
    expect(renamed.updatedAt).toBe(session.updatedAt);
    expect(t.calls).toContain(`rename ${session.claudeSessionId} A better name`);
    expect((await t.info(session.claudeSessionId!))?.customTitle).toBe("A better name");
    await s.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.title === "A better name");
    // The rename is the runner's own write: a reply right after isn't taken for a terminal's.
    const reply = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "and more" });
    expect(reply.status).toBe(202);
  });

  test("an empty title is a 400, an unknown session a 404", async () => {
    const r = runner();
    const session = await r.startSession("hi");
    expect((await r.post(`/api/sessions/${session.id}/rename`, { title: "  \n" })).status).toBe(400);
    expect((await r.post(`/api/sessions/${session.id}/rename`, { title: 5 })).status).toBe(400);
    expect((await r.post(`/api/sessions/nope/rename`, { title: "x" })).status).toBe(404);
  });

  test("a terminal session's rename reaches its transcript, so the sync keeps the new title", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t });
    t.write("term-1", workPath(r), [userEntry("from the terminal"), assistantEntry("hi")], Date.now() - 5 * 60_000);
    const term = await until("the terminal session", async () => (await list(r)).find((x) => x.source === "terminal"));
    expect((await r.post(`/api/sessions/${term.id}/rename`, { title: "Renamed" })).status).toBe(200);
    await Bun.sleep(100);
    expect((await list(r)).find((x) => x.id === term.id)?.title).toBe("Renamed");
  });
});

describe("stop", () => {
  test("interrupts the running turn: the session is idle with a stopped event, and takes a reply", async () => {
    const r = runner({ driver: fakeDriver(5) });
    const s = await socketOf(r);
    const session = await r.startSession(`Please ${COUNT_SLOWLY} to 200`);
    await s.waitFor((m) => m.type === "delta" && m.sessionId === session.id);
    const res = await r.post(`/api/sessions/${session.id}/stop`, {});
    expect(res.status).toBe(200);
    expect((await sessionOf(res)).status).toBe("idle");
    const events = await eventsOf(r, session.id);
    expect(kinds(events)).toEqual(["user", "stopped"]);
    await s.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "stopped");
    const from = s.messages.length;
    const reply = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "what did I say first" });
    expect(reply.status).toBe(202);
    await turnEnds(s, session.id, from);
    const after = await eventsOf(r, session.id);
    expect(after.at(-1)?.kind).toBe("result");
    expect(after.some((e) => e.kind === "assistant_text" && e.text === fakeFirst(`Please ${COUNT_SLOWLY} to 200`))).toBe(true);
  });

  test("an open approval is denied, then the session stops", async () => {
    const r = runner({ driver: fakeDriver(5) });
    const s = await socketOf(r);
    const session = await r.startSession("this needs approval");
    await s.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "waiting_approval");
    const res = await r.post(`/api/sessions/${session.id}/stop`, {});
    expect((await sessionOf(res)).status).toBe("idle");
    const events = await eventsOf(r, session.id);
    expect(kinds(events).slice(-2)).toEqual(["approval_resolved", "stopped"]);
    expect(events.find((e) => e.kind === "approval_resolved")).toMatchObject({ decision: "deny" });
  });

  test("a session with no turn running is a 409", async () => {
    const r = runner();
    const s = await socketOf(r);
    const session = await finished(r, s);
    const res = await r.post(`/api/sessions/${session.id}/stop`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NOT_RUNNING);
  });
});

describe("archive and pin", () => {
  test("an archived session leaves the default list and is in ?archived=1, until unarchived", async () => {
    const r = runner();
    const s = await socketOf(r);
    const a = await finished(r, s, "first");
    const b = await finished(r, s, "second");
    const res = await r.post(`/api/sessions/${a.id}/archive`, { archived: true });
    expect((await sessionOf(res)).archived).toBe(true);
    expect((await list(r)).map((x) => x.id)).toEqual([b.id]);
    expect((await list(r, "?archived=1")).map((x) => x.id)).toEqual([a.id]);
    await s.waitFor((m) => m.type === "session" && m.session.id === a.id && m.session.archived === true);
    const back = await sessionOf(await r.post(`/api/sessions/${a.id}/archive`, { archived: false }));
    expect(back.archived).toBeUndefined();
    expect((await list(r)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await r.get("/api/sessions?archived=yes")).status).toBe(400);
    expect((await r.post(`/api/sessions/${a.id}/archive`, {})).status).toBe(400);
  });

  test("a terminal session can be archived too", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t });
    t.write("term-1", workPath(r), [userEntry("from the terminal")], Date.now() - 5 * 60_000);
    const term = await until("the terminal session", async () => (await list(r)).find((x) => x.source === "terminal"));
    expect((await r.post(`/api/sessions/${term.id}/archive`, { archived: true })).status).toBe(200);
    await Bun.sleep(80);
    expect(await list(r)).toEqual([]);
    expect((await list(r, "?archived=1")).map((x) => x.id)).toEqual([term.id]);
    expect(t.all.has("term-1")).toBe(true);
  });

  test("pinned sessions are listed first, and unpinning puts one back in its place", async () => {
    const r = runner();
    const s = await socketOf(r);
    const a = await finished(r, s, "older");
    const b = await finished(r, s, "newer");
    const pinned = await sessionOf(await r.post(`/api/sessions/${a.id}/pin`, { pinned: true }));
    expect(pinned.pinned).toBe(true);
    expect(pinned.updatedAt).toBe(a.updatedAt);
    expect((await list(r)).map((x) => x.id)).toEqual([a.id, b.id]);
    await r.post(`/api/sessions/${a.id}/pin`, { pinned: false });
    expect((await list(r)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await r.post(`/api/sessions/${a.id}/pin`, { pinned: "yes" })).status).toBe(400);
  });
});

describe("fork", () => {
  test("a new idle session of the runner's from the conversation so far, never imported as a terminal one", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t, driver: writingDriver(t) });
    const s = await socketOf(r);
    const source = await finished(r, s, "the original task");
    const res = await r.post(`/api/sessions/${source.id}/fork`, {});
    expect(res.status).toBe(201);
    const fork = await sessionOf(res);
    expect(fork).toMatchObject({ title: "the original task (fork)", status: "idle", source: "cleat", workspace: "work" });
    expect(fork.claudeSessionId).not.toBe(source.claudeSessionId);
    expect(t.calls).toContain(`fork ${source.claudeSessionId} -> ${fork.claudeSessionId}`);
    expect(kinds(await eventsOf(r, fork.id))).toEqual(kinds(await eventsOf(r, source.id)));
    await Bun.sleep(120);
    const all = await list(r);
    expect(all.filter((x) => x.source === "terminal")).toEqual([]);
    expect(all.map((x) => x.id).sort()).toEqual([source.id, fork.id].sort());
    // Replying continues the fork's own transcript, and isn't taken for one open in a terminal.
    const from = s.messages.length;
    const reply = await r.post(`/api/sessions/${fork.id}/messages`, { prompt: "go on" });
    expect(reply.status).toBe(202);
    await turnEnds(s, fork.id, from);
    expect((await list(r)).find((x) => x.id === fork.id)?.claudeSessionId).toBe(fork.claudeSessionId);
    expect(t.all.get(fork.claudeSessionId!)?.messages.length).toBe(4);
    expect(t.all.get(source.claudeSessionId!)?.messages.length).toBe(2);
  });

  test("with the fake agent, the fork remembers the conversation", async () => {
    const r = runner();
    const s = await socketOf(r);
    const source = await finished(r, s, "remember this");
    const fork = await sessionOf(await r.post(`/api/sessions/${source.id}/fork`, {}));
    const from = s.messages.length;
    await r.post(`/api/sessions/${fork.id}/messages`, { prompt: "what did I say first" });
    await turnEnds(s, fork.id, from);
    expect((await eventsOf(r, fork.id)).some((e) => e.kind === "assistant_text" && e.text === fakeFirst("remember this"))).toBe(true);
  });

  test("refused while a turn runs, and for a session with no conversation yet", async () => {
    const r = runner({ driver: fakeDriver(20) });
    const s = await socketOf(r);
    const running = await r.startSession("still going");
    const busy = await r.post(`/api/sessions/${running.id}/fork`, {});
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe(BUSY);
    await settled(s, running.id);
    const failing = testRunner({ driver: { async *run() { yield { type: "event", event: { kind: "error", message: "no" } }; } } });
    runners.push(failing);
    const fs = await socketOf(failing);
    const none = await failing.startSession("x");
    await settled(fs, none.id);
    const res = await failing.post(`/api/sessions/${none.id}/fork`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NOTHING_TO_FORK);
  });

  test("forkTitle keeps a title within 80 characters", () => {
    expect(forkTitle("x".repeat(80))).toBe(`${"x".repeat(73)} (fork)`);
    expect(forkTitle("")).toBe("Untitled (fork)");
  });
});

describe("delete", () => {
  test("a session the runner started: its transcript, record and events go, and it is never imported back", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t, driver: writingDriver(t) });
    const s = await socketOf(r);
    const session = await finished(r, s);
    const res = await r.post(`/api/sessions/${session.id}/delete`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: session.id });
    expect(t.all.has(session.claudeSessionId!)).toBe(false);
    expect(t.calls).toContain(`remove ${session.claudeSessionId}`);
    expect((await r.get(`/api/sessions/${session.id}/events`)).status).toBe(404);
    await s.waitFor((m) => m.type === "removed" && m.sessionId === session.id);
    await Bun.sleep(100);
    expect(await list(r)).toEqual([]);
    expect(await list(r, "?archived=1")).toEqual([]);
  });

  test("a terminal session is refused with a 409 and its transcript is untouched", async () => {
    const t = new MemoryTranscripts();
    const r = runner({ transcripts: t });
    const messages: SessionMessage[] = [userEntry("from the terminal"), assistantEntry("hi")];
    t.write("term-1", workPath(r), messages, Date.now() - 5 * 60_000);
    const term = await until("the terminal session", async () => (await list(r)).find((x) => x.source === "terminal"));
    const before = JSON.stringify(t.all.get("term-1"));
    const res = await r.post(`/api/sessions/${term.id}/delete`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(TERMINAL_NOT_DELETED);
    expect(JSON.stringify(t.all.get("term-1"))).toBe(before);
    expect(t.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
    expect((await list(r)).map((x) => x.id)).toEqual([term.id]);
  });

  test("refused while a turn runs; a transcript that is already gone doesn't stop the delete", async () => {
    const r = runner({ driver: fakeDriver(20) });
    const s = await socketOf(r);
    const running = await r.startSession("still going");
    expect((await r.post(`/api/sessions/${running.id}/delete`, {})).status).toBe(409);
    await settled(s, running.id);
    // The fake ops have no transcripts at all: the fake id's is "gone".
    expect((await r.post(`/api/sessions/${running.id}/delete`, {})).status).toBe(200);
    expect((await r.post(`/api/sessions/${running.id}/delete`, {})).status).toBe(404);
  });

  test("a transcript that won't go and is still there keeps the session", async () => {
    const t = new MemoryTranscripts();
    t.remove = async () => {
      throw new Error("disk says no");
    };
    const r = runner({ transcripts: t, driver: writingDriver(t) });
    const s = await socketOf(r);
    const session = await finished(r, s);
    const res = await r.post(`/api/sessions/${session.id}/delete`, {});
    expect(res.status).toBe(500);
    expect((await list(r)).map((x) => x.id)).toEqual([session.id]);
  });
});

describe("guarding the new routes", () => {
  test("every one refuses another origin, another host and a body that isn't JSON", async () => {
    const r = runner();
    const session = await r.startSession("hi");
    for (const action of ["rename", "archive", "pin", "stop", "fork", "delete"]) {
      const url = `${r.url}/api/sessions/${session.id}/${action}`;
      expect((await fetch(url, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { host: "evil.test", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
    }
    expect((await fetch(`${r.url}/api/sessions?archived=1`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await list(r)).map((x) => x.id)).toEqual([session.id]);
  });
});
