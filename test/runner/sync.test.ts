// The transcript sync (src/runner/sync.ts, D0015), against transcripts kept in memory: terminal sessions
// imported, their history read on first request, growth streamed as events, the runner's own turns
// never taken for another process's, and the reply guard for a session open in a terminal.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { OPEN_IN_TERMINAL, type EventsResponse, type SessionEvent, type SessionMeta, type SessionsResponse } from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { claudeEnv, claudeOptions, ENTRYPOINT } from "../../src/runner/agent-claude";
import { BUSY } from "../../src/runner/sessions";
import { MAX_AGE_MS, MAX_PER_WORKSPACE, OPEN_MS, UNTITLED, eventsOf, titleFrom, type Transcripts } from "../../src/runner/sync";
import { connect, settled, testRunner, type Socket, type TestRunner } from "./helpers";

/** Transcripts in memory. Every write moves the transcript's lastModified to now, as a file's mtime. */
class FakeTranscripts implements Transcripts {
  readonly all = new Map<string, { info: SDKSessionInfo; messages: SessionMessage[] }>();
  reads = 0;

  write(sessionId: string, cwd: string, messages: SessionMessage[], at = Date.now(), info: Partial<SDKSessionInfo> = {}): void {
    const t = this.all.get(sessionId) ?? { info: { sessionId, summary: "", lastModified: at, cwd, createdAt: at }, messages: [] };
    t.messages.push(...messages);
    t.info = { ...t.info, ...info, lastModified: Math.max(at, t.info.lastModified + 1) };
    if (!t.info.firstPrompt) t.info.firstPrompt = textOf(messages.find((m) => m.type === "user"));
    this.all.set(sessionId, t);
  }

  async list(dir: string, limit: number): Promise<SDKSessionInfo[]> {
    return [...this.all.values()]
      .filter((t) => t.info.cwd === dir)
      .map((t) => ({ ...t.info }))
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit);
  }

  async info(sessionId: string): Promise<SDKSessionInfo | undefined> {
    const t = this.all.get(sessionId);
    return t && { ...t.info };
  }

  async messages(sessionId: string): Promise<SessionMessage[]> {
    this.reads++;
    return [...(this.all.get(sessionId)?.messages ?? [])];
  }
}

function textOf(m: SessionMessage | undefined): string | undefined {
  const content = (m?.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : undefined;
}

const base = (type: SessionMessage["type"], message: unknown, ts?: string): SessionMessage =>
  ({ type, uuid: crypto.randomUUID(), session_id: "s", message, parent_tool_use_id: null, parent_agent_id: null, ...(ts ? { timestamp: ts } : {}) }) as SessionMessage;
const user = (text: string, ts?: string) => base("user", { role: "user", content: text }, ts);
const assistant = (text: string, end = true) => base("assistant", { role: "assistant", content: [{ type: "text", text }], stop_reason: end ? "end_turn" : null });
const toolUse = (id: string) => base("assistant", { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" });
const toolResult = (id: string) => base("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "a.txt" }] }] });

/** A driver that writes its turn to the transcript, as Claude Code does, and answers "ok". */
function writingDriver(t: FakeTranscripts): AgentDriver {
  return {
    async *run(input) {
      const id = input.resume ?? `claude-${crypto.randomUUID()}`;
      yield { type: "session_id", id };
      t.write(id, input.cwd, [user(input.prompt), assistant("ok")]);
      await Bun.sleep(30);
      yield { type: "event", event: { kind: "assistant_text", text: "ok" } };
      yield { type: "event", event: { kind: "result", ok: true, text: "ok" } };
    },
  };
}

const SYNC = { pollMs: 20, idleMs: 80 };
const runners: TestRunner[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const r of runners.splice(0)) await r.stop();
});

function runner(t: FakeTranscripts, options: { dir?: string; driver?: AgentDriver } = {}): TestRunner {
  const r = testRunner({ ...options, sync: { transcripts: t, ...SYNC } });
  runners.push(r);
  return r;
}

async function socketOf(r: TestRunner): Promise<Socket> {
  const s = await connect(r);
  sockets.push(s);
  return s;
}

const workPath = (r: TestRunner) => r.config.workspaces.find((w) => w.name === "work")!.path;
const sessionsOf = async (r: TestRunner) => ((await (await r.get("/api/sessions")).json()) as SessionsResponse).sessions;
const eventsFrom = async (r: TestRunner, id: string) => ((await (await r.get(`/api/sessions/${id}/events`)).json()) as EventsResponse).events;
const kinds = (events: SessionEvent[]) => events.map((e) => e.kind);

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await check();
    if (found !== undefined) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const terminalSession = (r: TestRunner) => until("a terminal session", async () => (await sessionsOf(r)).find((s) => s.source === "terminal"));

describe("eventsOf", () => {
  test("maps user, assistant, tool calls and results to the turn's event kinds, and ends a turn with result", () => {
    expect(eventsOf(user("hi"))).toEqual([{ kind: "user", text: "hi" }]);
    expect(eventsOf(toolUse("t1"))).toEqual([{ kind: "tool_use", toolUseId: "t1", name: "Bash", input: { command: "ls" } }]);
    expect(eventsOf(toolResult("t1"))).toEqual([{ kind: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }]);
    expect(eventsOf(assistant("done"))).toEqual([{ kind: "assistant_text", text: "done" }, { kind: "result", ok: true, text: "done" }]);
    expect(eventsOf(assistant("thinking aloud", false))).toEqual([{ kind: "assistant_text", text: "thinking aloud" }]);
  });

  test("leaves out a subagent's messages and the text Claude Code keeps for itself", () => {
    expect(eventsOf({ ...assistant("inner"), parent_tool_use_id: "t1" })).toEqual([]);
    expect(eventsOf(user("<local-command-caveat>Caveat: ...</local-command-caveat>"))).toEqual([]);
    expect(eventsOf(user("<system-reminder>x</system-reminder>"))).toEqual([]);
    expect(eventsOf(base("system", { content: "compacted" }))).toEqual([]);
  });

  test("titleFrom: custom title, else summary, else first prompt, cut to 80 characters", () => {
    const info = { sessionId: "s", lastModified: 0, summary: "" };
    expect(titleFrom({ ...info, customTitle: "Named", summary: "Sum", firstPrompt: "First" })).toBe("Named");
    expect(titleFrom({ ...info, summary: "Sum", firstPrompt: "First" })).toBe("Sum");
    expect(titleFrom({ ...info, firstPrompt: "First line\nsecond" })).toBe("First line");
    expect(titleFrom({ ...info, firstPrompt: "x".repeat(100) })).toHaveLength(80);
    expect(titleFrom(info)).toBe(UNTITLED);
  });
});

describe("claudeOptions for the sync", () => {
  const input = { agent: "claude" as const, prompt: "hi", cwd: "/tmp/work", resume: null, title: "My task", permissionMode: "auto" as const, signal: new AbortController().signal, approve: async () => "deny" as const };

  test("names the runner as the entrypoint, so Claude Code's resume picker lists its sessions", () => {
    const env = claudeOptions(input, new AbortController(), () => {}).env!;
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(ENTRYPOINT);
    expect(ENTRYPOINT.startsWith("sdk")).toBe(false);
    expect(ENTRYPOINT).not.toBe("cli");
    // The rest of the runner's environment goes along, and a value already set is replaced.
    expect(claudeEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })).toEqual({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT });
  });

  test("a new conversation gets the session's title; a resumed one keeps its own", () => {
    expect(claudeOptions(input, new AbortController(), () => {}).title).toBe("My task");
    const resumed = claudeOptions({ ...input, resume: "abc" }, new AbortController(), () => {});
    expect(resumed.resume).toBe("abc");
    expect("title" in resumed).toBe(false);
  });
});

describe("importing terminal sessions", () => {
  test("a transcript in a workspace becomes a terminal session, idle, its events read on first request", async () => {
    const t = new FakeTranscripts();
    const r = runner(t);
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    t.write("term-1", workPath(r), [user("list the files", old), toolUse("t1"), toolResult("t1"), assistant("a.txt")], Date.now() - 5 * 60_000, { customTitle: "Files" });
    const session = await terminalSession(r);
    expect(session).toMatchObject({ claudeSessionId: "term-1", workspace: "work", cwd: workPath(r), title: "Files", source: "terminal", status: "idle", lastSeq: 0 });
    const readsBefore = t.reads;
    // Not read until asked for.
    await Bun.sleep(100);
    expect(t.reads).toBe(readsBefore);
    const events = await eventsFrom(r, session.id);
    expect(kinds(events)).toEqual(["user", "tool_use", "tool_result", "assistant_text", "result"]);
    expect(events[0]).toMatchObject({ seq: 1, text: "list the files", ts: old });
    // Asked again: the same events, nothing stored twice.
    expect(await eventsFrom(r, session.id)).toEqual(events);
    await Bun.sleep(100);
    expect((await sessionsOf(r)).filter((s) => s.claudeSessionId === "term-1")).toHaveLength(1);
    expect(await eventsFrom(r, session.id)).toEqual(events);
  });

  test("only the last 30 days, at most 50 per workspace", async () => {
    const t = new FakeTranscripts();
    const r = runner(t);
    const now = Date.now();
    t.write("too-old", workPath(r), [user("old")], now - MAX_AGE_MS - 60_000);
    for (let i = 0; i < MAX_PER_WORKSPACE + 5; i++) t.write(`recent-${i}`, workPath(r), [user(`task ${i}`)], now - 60_000 - i * 1000);
    await until("50 sessions", async () => ((await sessionsOf(r)).length === MAX_PER_WORKSPACE ? true : undefined));
    await Bun.sleep(100);
    const ids = (await sessionsOf(r)).map((s) => s.claudeSessionId);
    expect(ids).toHaveLength(MAX_PER_WORKSPACE);
    expect(ids).not.toContain("too-old");
    expect(ids).toContain("recent-0");
    expect(ids).not.toContain(`recent-${MAX_PER_WORKSPACE + 4}`);
  });

  test("keeps its id across a restart, and is never imported twice", async () => {
    const t = new FakeTranscripts();
    const first = runner(t);
    t.write("term-1", workPath(first), [user("hello")], Date.now() - 5 * 60_000);
    const session = await terminalSession(first);
    await first.stop();
    runners.splice(runners.indexOf(first), 1);
    const second = runner(t, { dir: first.dir });
    await Bun.sleep(100);
    const sessions = await sessionsOf(second);
    expect(sessions.map((s) => [s.id, s.claudeSessionId, s.source])).toEqual([[session.id, "term-1", "terminal"]]);
  });

  test("the runner's own sessions are never imported, and their turns are not stored twice", async () => {
    const t = new FakeTranscripts();
    const r = runner(t, { driver: writingDriver(t) });
    const socket = await socketOf(r);
    const session = await r.startSession("mine");
    await settled(socket, session.id);
    await Bun.sleep(150);
    const sessions = await sessionsOf(r);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: session.id, source: "intuition", status: "idle", lastSeq: 3 });
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result"]);
  });

  test("sessions stored before `source` existed read as the runner's own", async () => {
    const t = new FakeTranscripts();
    const first = runner(t);
    const session = await first.startSession("older");
    await first.stop();
    runners.splice(runners.indexOf(first), 1);
    const file = join(first.config.dataDir, "sessions.json");
    const stored = (JSON.parse(readFileSync(file, "utf8")) as SessionMeta[]).map(({ source: _, ...s }) => s);
    writeFileSync(file, JSON.stringify(stored));
    const second = runner(t, { dir: first.dir });
    expect((await sessionsOf(second)).find((s) => s.id === session.id)?.source).toBe("intuition");
  });
});

describe("live transcripts", () => {
  test("a runner session continued elsewhere streams the new entries, running, then idle after the last assistant entry", async () => {
    const t = new FakeTranscripts();
    const r = runner(t, { driver: writingDriver(t) });
    const socket = await socketOf(r);
    const session = await r.startSession("start here");
    const done = await settled(socket, session.id);
    const claudeId = (done as { session: SessionMeta }).session.claudeSessionId!;
    await Bun.sleep(100);
    const before = socket.messages.length;
    // The terminal's turn: the prompt first, the answer a little later.
    t.write(claudeId, workPath(r), [user("from terminal")]);
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "running" && m.session.lastSeq === 4);
    await Bun.sleep(SYNC.idleMs * 2);
    // Its last entry is the person's: still running, a turn from the terminal.
    expect((await sessionsOf(r))[0]).toMatchObject({ status: "running", terminalTurn: true });
    t.write(claudeId, workPath(r), [assistant("from terminal too")]);
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq === 6);
    expect((await sessionsOf(r))[0]!.terminalTurn).toBeUndefined();
    const events = (await eventsFrom(r, session.id)).slice(3);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([[4, "user"], [5, "assistant_text"], [6, "result"]]);
    expect(events[0]).toMatchObject({ text: "from terminal" });
    // The socket said running before the first new event's session update said anything else.
    const later = socket.messages.slice(before).flatMap((m) => (m.type === "session" && m.session.id === session.id ? [m.session.status] : []));
    expect(later[0]).toBe("running");
  });

  test("a terminal session that was read shows its new turns", async () => {
    const t = new FakeTranscripts();
    const r = runner(t);
    const socket = await socketOf(r);
    t.write("term-1", workPath(r), [user("one"), assistant("1")], Date.now() - 5 * 60_000);
    const session = await terminalSession(r);
    expect(await eventsFrom(r, session.id)).toHaveLength(3);
    t.write("term-1", workPath(r), [user("two"), assistant("2")]);
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq === 6);
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result"]);
  });
});

describe("replying to a session open in a terminal", () => {
  test("409 while another process wrote to it in the last two minutes, unless force: true", async () => {
    const t = new FakeTranscripts();
    const r = runner(t, { driver: writingDriver(t) });
    const socket = await socketOf(r);
    t.write("term-1", workPath(r), [user("in the terminal"), assistant("yes")]);
    const session = await terminalSession(r);
    const refused = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "from intuition" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(OPEN_IN_TERMINAL);
    expect(OPEN_IN_TERMINAL).toContain("it looks open in a terminal");
    // Nothing was stored for the refused reply, but the history was read so a reply follows it.
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result"]);
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "from intuition", force: "yes" })).status).toBe(400);
    const forced = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "from intuition", force: true });
    expect(forced.status).toBe(202);
    // The runner's own turn is no terminal turn.
    expect(((await forced.json()) as { session: SessionMeta }).session.terminalTurn).toBeUndefined();
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq === 6);
    // The runner's own turn is no other process: the next reply needs no force, and nothing was stored twice.
    await Bun.sleep(100);
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "again" })).status).toBe(202);
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "idle" && m.session.lastSeq === 9);
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result", "user", "assistant_text", "result"]);
  });

  test("a transcript last written more than two minutes ago takes a reply without force", async () => {
    const t = new FakeTranscripts();
    const r = runner(t, { driver: writingDriver(t) });
    t.write("term-1", workPath(r), [user("earlier"), assistant("yes")], Date.now() - OPEN_MS - 10_000);
    const session = await terminalSession(r);
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "now" })).status).toBe(202);
  });

  test("a runner turn still running is busy, force or not", async () => {
    const t = new FakeTranscripts();
    const stuck: AgentDriver = {
      async *run(input) {
        yield { type: "session_id", id: "claude-stuck" };
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
      },
    };
    const r = runner(t, { driver: stuck });
    const session = await r.startSession("long");
    const res = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "more", force: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(BUSY);
  });

  test("a reply while the runner's own turn is still closing (its result in) is not taken for a terminal's", async () => {
    const t = new FakeTranscripts();
    // The turn started "long ago" on the sync's clock, so its own writes are newer than its start by more than the slack.
    let clock = Date.now() - 60_000;
    let closing: () => void = () => {};
    const lingering: AgentDriver = {
      async *run(input) {
        const id = input.resume ?? "claude-linger";
        yield { type: "session_id", id };
        t.write(id, input.cwd, [user(input.prompt), assistant("ok")]);
        try {
          yield { type: "event", event: { kind: "result", ok: true, text: "ok" } };
        } finally {
          // As the SDK's query, it shuts Claude Code down after the result.
          await new Promise<void>((resolve) => (closing = resolve));
        }
      },
    };
    const r = testRunner({ driver: lingering, sync: { transcripts: t, ...SYNC, now: () => clock } });
    runners.push(r);
    const s = await socketOf(r);
    const session = await r.startSession("first");
    await settled(s, session.id);
    clock = Date.now();
    const res = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "right away" });
    closing();
    expect(res.status).toBe(202);
  });
});

describe("a transcript that can't be read", () => {
  test("its events stay unread and a reply still resumes it, instead of failing the request", async () => {
    const t = new FakeTranscripts();
    const r = runner(t, { driver: writingDriver(t) });
    t.write("term-1", workPath(r), [user("hello"), assistant("hi")], Date.now() - OPEN_MS - 10_000);
    const session = await terminalSession(r);
    t.messages = async () => {
      throw new Error("unreadable");
    };
    t.info = async () => {
      throw new Error("unreadable");
    };
    const events = await r.get(`/api/sessions/${session.id}/events`);
    expect(events.status).toBe(200);
    expect(((await events.json()) as EventsResponse).events).toEqual([]);
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "still there?" })).status).toBe(202);
  });
});
