// The transcript sync for Codex (src/runner/codex-sync.ts, D0031), against rollout files written to a
// temp CODEX_HOME in the shape real ones have (codex 0.167.1 and 0.169.0): a thread started in a
// workspace from a terminal becomes a terminal session with agent "codex", a thread that grows
// streams as events, the runner's own Codex turns are never taken for another process's, a reply to a
// thread written to just now needs force, and nothing under CODEX_HOME is ever written.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_IN_TERMINAL, type EventsResponse, type SessionEvent, type SessionMeta, type SessionsResponse } from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { codexThreads, entriesOf, itemEvents } from "../../src/runner/codex-sync";
import { OPEN_MS, UNTITLED, type Threads } from "../../src/runner/sync";
import { connect, settled, testRunner, type Socket, type TestRunner } from "./helpers";

/** A temp CODEX_HOME, and rollout files in it written line by line as Codex writes them. */
class CodexHome {
  readonly home = mkdtempSync(join(tmpdir(), "holm-codex-home-"));
  private readonly paths = new Map<string, string>();
  private ordinal = 0;

  /** A new thread's rollout: its session_meta line. `source` "exec" is `codex exec` and the SDK; an object is a subagent's. */
  start(id: string, cwd: string, options: { source?: unknown; threadSource?: string; at?: Date } = {}): string {
    const at = options.at ?? new Date();
    const day = join(this.home, "sessions", String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, "0"), String(at.getDate()).padStart(2, "0"));
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-${at.toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
    this.paths.set(id, path);
    const meta = {
      session_id: id,
      id,
      timestamp: at.toISOString(),
      cwd,
      originator: "codex-tui",
      cli_version: "0.169.0",
      source: options.source ?? "cli",
      thread_source: options.threadSource ?? "user",
      model_provider: "openai",
      // The real line carries the whole base instructions: tens of kilobytes on one line.
      base_instructions: { text: "You are Codex. ".repeat(3000) },
    };
    writeFileSync(path, JSON.stringify({ timestamp: at.toISOString(), type: "session_meta", payload: meta }) + "\n");
    return path;
  }

  private line(id: string, type: string, payload: unknown): void {
    this.ordinal += 1;
    appendFileSync(this.paths.get(id)!, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: this.ordinal, type, payload }) + "\n");
  }

  private item(id: string, item: unknown): void {
    this.line(id, "event_msg", { type: "item_completed", thread_id: id, turn_id: "turn", item });
  }

  /** One whole turn as `codex` writes it: the developer and environment messages the person never sees, the prompt, a command, the answer, the end. */
  turn(id: string, prompt: string, answer: string, options: { command?: string; end?: boolean } = {}): void {
    this.line(id, "event_msg", { type: "task_started", turn_id: "turn" });
    this.line(id, "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] });
    this.line(id, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] });
    this.line(id, "turn_context", { turn_id: "turn", cwd: "/x", approval_policy: "on-request" });
    this.line(id, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
    this.item(id, { type: "UserMessage", id: `u-${this.ordinal}`, content: [{ type: "text", text: prompt, text_elements: [] }] });
    if (options.command) {
      this.item(id, { type: "Reasoning", id: `rs-${this.ordinal}`, summary_text: [], raw_content: [] });
      this.item(id, {
        type: "CommandExecution",
        id: `exec-${this.ordinal}`,
        command: ["/usr/bin/zsh", "-lc", options.command],
        status: "completed",
        aggregated_output: "a.txt\n",
        exit_code: 0,
      });
      this.line(id, "event_msg", { type: "token_count", info: null });
    }
    this.answer(id, answer, options.end ?? true);
  }

  answer(id: string, text: string, end = true): void {
    this.item(id, { type: "AgentMessage", id: `msg-${this.ordinal}`, content: [{ type: "Text", text }], phase: end ? "final_answer" : "commentary" });
    this.line(id, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    if (end) this.complete(id, text);
  }

  complete(id: string, text: string): void {
    this.line(id, "event_msg", { type: "task_complete", turn_id: "turn", last_agent_message: text, duration_ms: 1200 });
  }

  /** The TUI's name for a thread, in session_index.jsonl. */
  name(id: string, name: string): void {
    appendFileSync(join(this.home, "session_index.jsonl"), JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() }) + "\n");
  }

  /** Moves the file's mtime back, as if it was last written `ms` ago. */
  age(id: string, ms: number): void {
    const at = new Date(Date.now() - ms);
    utimesSync(this.paths.get(id)!, at, at);
  }

  /** Every file under the home with its size and mtime: what a write would change. */
  snapshot(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(`${p} ${statSync(p).size} ${statSync(p).mtimeMs}`);
      }
    };
    walk(this.home);
    return out.sort();
  }
}

/** A driver that writes its turn to the thread's rollout, as `codex exec` does, and answers "ok". */
function writingDriver(c: CodexHome): AgentDriver {
  return {
    async *run(input) {
      const id = input.resume ?? crypto.randomUUID();
      if (!input.resume) c.start(id, input.cwd, { source: "exec" });
      yield { type: "session_id", id };
      c.turn(id, input.prompt, "ok");
      await Bun.sleep(30);
      yield { type: "event", event: { kind: "assistant_text", text: "ok" } };
      yield { type: "event", event: { kind: "result", ok: true, text: "ok" } };
    },
  };
}

/** As writingDriver, but the turn's task_complete reaches the rollout only after the SDK reported the end, as Codex may write it. */
function lateTailDriver(c: CodexHome): AgentDriver {
  return {
    async *run(input) {
      const id = input.resume ?? crypto.randomUUID();
      if (!input.resume) c.start(id, input.cwd, { source: "exec" });
      yield { type: "session_id", id };
      c.turn(id, input.prompt, "ok", { end: false });
      yield { type: "event", event: { kind: "assistant_text", text: "ok" } };
      // The runner stops reading at the result: the late write is set up before it.
      setTimeout(() => c.complete(id, "ok"), 60);
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

function runner(c: CodexHome, options: { dir?: string; driver?: AgentDriver; codex?: Threads } = {}): TestRunner {
  const r = testRunner({ dir: options.dir, driver: options.driver, agent: "codex", sync: { codex: options.codex ?? codexThreads(c.home), ...SYNC } });
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

/** Waits for the session to be idle again (settled() would match the idle of its import). */
const idle = (r: TestRunner, id: string) => until(`${id} idle`, async () => ((await sessionsOf(r)).find((s) => s.id === id)?.status === "idle" ? true : undefined));

const terminalSession = (r: TestRunner) => until("a terminal session", async () => (await sessionsOf(r)).find((s) => s.source === "terminal"));

describe("reading rollouts", () => {
  test("each finished item becomes the events a runner turn of Codex gives", () => {
    expect(itemEvents({ type: "UserMessage", id: "u", content: [{ type: "text", text: "hi" }] })).toEqual([{ kind: "user", text: "hi" }]);
    expect(itemEvents({ type: "AgentMessage", id: "m", content: [{ type: "Text", text: "hello" }] })).toEqual([{ kind: "assistant_text", text: "hello" }]);
    expect(itemEvents({ type: "CommandExecution", id: "c", command: ["/bin/bash", "-lc", "false"], status: "failed", aggregated_output: "", exit_code: 1 })).toEqual([
      { kind: "tool_use", toolUseId: "c", name: "Bash", input: { command: "false" } },
      { kind: "tool_result", toolUseId: "c", content: "\n(exit code 1)", isError: true },
    ]);
    expect(itemEvents({ type: "FileChange", id: "f", changes: { "/w/a.md": { type: "add", content: "x" }, "/w/b.md": { type: "update", unified_diff: "" } }, status: "completed" })).toEqual([
      { kind: "tool_use", toolUseId: "f", name: "Edit", input: { changes: [{ path: "/w/a.md", kind: "add" }, { path: "/w/b.md", kind: "update" }] } },
      { kind: "tool_result", toolUseId: "f", content: "add /w/a.md\nupdate /w/b.md", isError: false },
    ]);
    expect(itemEvents({ type: "McpToolCall", id: "p", server: "docs", tool: "search", arguments: { q: "x" }, status: "completed", result: { content: [{ type: "text", text: "found" }] } })).toEqual([
      { kind: "tool_use", toolUseId: "p", name: "mcp__docs__search", input: { q: "x" } },
      { kind: "tool_result", toolUseId: "p", content: "found", isError: false },
    ]);
    expect(itemEvents({ type: "WebSearch", id: "w", query: "bun" })[0]).toEqual({ kind: "tool_use", toolUseId: "w", name: "WebSearch", input: { query: "bun" } });
    expect(itemEvents({ type: "Reasoning", id: "r", summary_text: [] })).toEqual([]);
    expect(itemEvents({ type: "UserMessage", id: "u", content: [{ type: "image", url: "x" }] })).toEqual([]);
  });

  test("a rollout's entries: only finished items and turn ends, keyed by line, a line still being written left out", () => {
    const c = new CodexHome();
    const path = c.start("t-1", "/w");
    c.turn("t-1", "list the files", "a.txt", { command: "ls" });
    appendFileSync(path, '{"timestamp":"2026-11-15T00:00:00Z","type":"event_msg","payload":{"type":"item_comp');
    const entries = entriesOf(readFileSync(path, "utf8"));
    expect(entries.flatMap((e) => e.events.map((ev) => ev.kind))).toEqual(["user", "tool_use", "tool_result", "assistant_text", "result"]);
    expect(entries.at(-1)).toMatchObject({ idle: true, events: [{ kind: "result", ok: true, text: "a.txt", durationMs: 1200 }] });
    expect(entries.slice(0, -1).every((e) => !e.idle)).toBe(true);
    // Keys are line numbers, so the same entry keeps its key as the file grows.
    const keys = entries.map((e) => e.key);
    c.answer("t-1", "more");
    expect(entriesOf(readFileSync(path, "utf8").replace(/\n[^\n]*item_comp[^\n]*$/, "")).slice(0, keys.length).map((e) => e.key)).toEqual(keys);
    // The developer instructions and the environment context are never events.
    expect(JSON.stringify(entries)).not.toContain("environment_context");
    // An interrupted turn ends it too, with no event.
    expect(entriesOf(JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }) + "\n")).toEqual([{ key: "0", events: [], idle: true }]);
  });

  test("codexThreads lists a folder's threads newest first, titled by the TUI's name or the first prompt, without subagents' threads", async () => {
    const c = new CodexHome();
    c.start("a", "/w");
    c.turn("a", "first prompt of a\nsecond line", "ok");
    c.age("a", 60_000);
    c.start("b", "/w/");
    c.turn("b", "prompt of b", "ok");
    c.age("b", 30_000);
    c.name("b", "Named in the TUI");
    c.start("other", "/elsewhere");
    c.turn("other", "x", "ok");
    c.start("sub", "/w", { source: { subagent: { thread_spawn: {} } }, threadSource: "subagent" });
    c.turn("sub", "inner", "ok");
    c.start("empty", "/w");
    const threads = codexThreads(c.home);
    const list = await threads.list("/w", 50);
    expect(list.map((t) => [t.id, t.title, t.cwd])).toEqual([
      ["empty", "", "/w"],
      ["b", "Named in the TUI", "/w"],
      ["a", "first prompt of a", "/w"],
    ]);
    expect(await threads.list("/w", 1)).toHaveLength(1);
    expect((await threads.info("a", "/w"))?.lastModified).toBeLessThan(Date.now() - 50_000);
    expect(await threads.info("missing", "/w")).toBeUndefined();
    expect((await threads.entries("a", "/w")).flatMap((e) => e.events.map((ev) => ev.kind))).toEqual(["user", "assistant_text", "result"]);
    // A fresh reader (a restart) finds a thread by id without listing first.
    expect((await codexThreads(c.home).info("b", "/"))?.title).toBe("Named in the TUI");
  });

  test("no sessions folder at all is no threads", async () => {
    const threads = codexThreads(join(tmpdir(), "holm-no-codex-home-" + crypto.randomUUID()));
    expect(await threads.list("/w", 50)).toEqual([]);
    expect(await threads.info("x", "/w")).toBeUndefined();
  });
});

describe("Codex threads from the terminal", () => {
  test("a thread started in a workspace becomes a terminal session with agent codex, its events read on request", async () => {
    const c = new CodexHome();
    const r = runner(c);
    c.start("thread-1", workPath(r));
    c.turn("thread-1", "list the files", "a.txt", { command: "ls" });
    c.age("thread-1", 5 * 60_000);
    const session = await terminalSession(r);
    expect(session).toMatchObject({ claudeSessionId: "thread-1", agent: "codex", workspace: "work", cwd: workPath(r), title: "list the files", source: "terminal", status: "idle", lastSeq: 0 });
    const events = await eventsFrom(r, session.id);
    expect(kinds(events)).toEqual(["user", "tool_use", "tool_result", "assistant_text", "result"]);
    expect(events[1]).toMatchObject({ name: "Bash", input: { command: "ls" } });
    // Asked again, and after more rounds: nothing stored or imported twice.
    await Bun.sleep(100);
    expect(await eventsFrom(r, session.id)).toEqual(events);
    expect(await sessionsOf(r)).toHaveLength(1);
  });

  test("a thread continued in a terminal while shown streams its new entries, running, then idle after the turn's end", async () => {
    const c = new CodexHome();
    const r = runner(c);
    const socket = await socketOf(r);
    c.start("thread-1", workPath(r));
    c.turn("thread-1", "hello", "hi");
    c.age("thread-1", 5 * 60_000);
    const session = await terminalSession(r);
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result"]);
    // The person types in the terminal: the prompt, a command, a message in between.
    c.turn("thread-1", "now list the files", "listing", { command: "ls", end: false });
    await socket.waitFor((m) => m.type === "session" && m.session.id === session.id && m.session.status === "running" && m.session.terminalTurn === true);
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "tool_result");
    // Still mid-turn: running for longer than idleMs.
    await Bun.sleep(200);
    expect((await sessionsOf(r))[0]).toMatchObject({ status: "running", terminalTurn: true });
    c.answer("thread-1", "a.txt");
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "result" && m.event.text === "a.txt");
    await idle(r, session.id);
    expect((await sessionsOf(r))[0]!.terminalTurn).toBeUndefined();
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "tool_use", "tool_result", "assistant_text", "assistant_text", "result"]);
  });

  test("the runner's own Codex sessions are never imported, and their turns are not stored twice", async () => {
    const c = new CodexHome();
    const r = runner(c, { driver: writingDriver(c) });
    const socket = await socketOf(r);
    const session = await r.startSession("mine");
    expect(session.agent).toBe("codex");
    await settled(socket, session.id);
    await Bun.sleep(150);
    const sessions = await sessionsOf(r);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: session.id, source: "holm", status: "idle", lastSeq: 3 });
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result"]);
  });

  test("a runner session continued in a terminal streams what the terminal added, and only that", async () => {
    const c = new CodexHome();
    const r = runner(c, { driver: writingDriver(c) });
    const socket = await socketOf(r);
    const session = await r.startSession("start here");
    const done = await settled(socket, session.id);
    const threadId = (done as { session: SessionMeta }).session.claudeSessionId!;
    await Bun.sleep(100);
    c.turn(threadId, "from the terminal", "terminal answer");
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "result" && m.event.text === "terminal answer");
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result"]);
  });

  test("the last lines of a runner turn written after its end are the runner's, not a terminal turn", async () => {
    const c = new CodexHome();
    const r = runner(c, { driver: lateTailDriver(c) });
    const socket = await socketOf(r);
    const session = await r.startSession("mine");
    await idle(r, session.id);
    const threadId = (await sessionsOf(r))[0]!.claudeSessionId!;
    await Bun.sleep(250);
    const idleAt = socket.messages.length;
    await Bun.sleep(150);
    expect(socket.messages.slice(idleAt).filter((m) => m.type === "session" && m.session.status === "running")).toEqual([]);
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result"]);
    // A turn from the terminal afterwards is read whole.
    c.turn(threadId, "from the terminal", "terminal answer");
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "result" && m.event.text === "terminal answer");
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result"]);
  });

  test("a Codex session from before the sync is followed from its thread's end, nothing stored twice", async () => {
    const c = new CodexHome();
    const first = runner(c, { driver: writingDriver(c) });
    const session = await first.startSession("before the sync");
    await idle(first, session.id);
    const threadId = (await sessionsOf(first))[0]!.claudeSessionId!;
    await first.stop();
    runners.splice(runners.indexOf(first), 1);
    // sync.json as the runner left it before D0031: the Codex session's cursor never moved.
    const file = join(first.config.dataDir, "sync.json");
    const sync = JSON.parse(readFileSync(file, "utf8")) as { codex?: true; sessions: Record<string, unknown> };
    delete sync.codex;
    sync.sessions[session.id] = { cursor: null, loaded: true, mtime: 0, ownWrite: 0 };
    writeFileSync(file, JSON.stringify(sync));
    const second = runner(c, { dir: first.dir });
    const socket = await socketOf(second);
    await Bun.sleep(100);
    c.turn(threadId, "from the terminal", "terminal answer");
    await socket.waitFor((m) => m.type === "event" && m.sessionId === session.id && m.event.kind === "result" && m.event.text === "terminal answer");
    expect(kinds(await eventsFrom(second, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result"]);
  });

  test("a reply to a thread written to in the last two minutes is refused without force; one idle longer takes it", async () => {
    const c = new CodexHome();
    const r = runner(c, { driver: writingDriver(c) });
    const socket = await socketOf(r);
    c.start("thread-1", workPath(r));
    c.turn("thread-1", "hello", "hi");
    const session = await terminalSession(r);
    const refused = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "from holm" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(OPEN_IN_TERMINAL);
    const forced = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "from holm", force: true });
    expect(forced.status).toBe(202);
    await idle(r, session.id);
    // The runner's own turn is no other process: the next reply needs no force, and nothing was stored twice.
    const again = await r.post(`/api/sessions/${session.id}/messages`, { prompt: "and again" });
    expect(again.status).toBe(202);
    await idle(r, session.id);
    expect(kinds(await eventsFrom(r, session.id))).toEqual(["user", "assistant_text", "result", "user", "assistant_text", "result", "user", "assistant_text", "result"]);

    c.start("thread-2", workPath(r));
    c.turn("thread-2", "older", "ok");
    c.age("thread-2", OPEN_MS + 60_000);
    const older = await until("the second thread", async () => (await sessionsOf(r)).find((s) => s.claudeSessionId === "thread-2"));
    expect((await r.post(`/api/sessions/${older.id}/messages`, { prompt: "continue" })).status).toBe(202);
  });

  test("a rename in the runner stands; a new name given in the TUI replaces it", async () => {
    const c = new CodexHome();
    const r = runner(c);
    c.start("thread-1", workPath(r));
    c.turn("thread-1", "hello", "hi");
    c.age("thread-1", 5 * 60_000);
    const session = await terminalSession(r);
    expect((await r.post(`/api/sessions/${session.id}/rename`, { title: "Mine" })).status).toBe(200);
    await Bun.sleep(150);
    expect((await sessionsOf(r))[0]!.title).toBe("Mine");
    c.name("thread-1", "Named in the TUI");
    await until("the TUI's name", async () => ((await sessionsOf(r))[0]!.title === "Named in the TUI" ? true : undefined));
  });

  test("an empty thread is imported untitled, and keeps its id across a restart", async () => {
    const c = new CodexHome();
    const first = runner(c);
    c.start("thread-1", workPath(first));
    const session = await terminalSession(first);
    expect(session.title).toBe(UNTITLED);
    await first.stop();
    runners.splice(runners.indexOf(first), 1);
    const second = runner(c, { dir: first.dir });
    await Bun.sleep(100);
    expect((await sessionsOf(second)).map((s) => [s.id, s.claudeSessionId, s.agent])).toEqual([[session.id, "thread-1", "codex"]]);
  });

  test("nothing under CODEX_HOME is written: not by importing, reading, following or replying", async () => {
    const c = new CodexHome();
    const r = runner(c, { driver: { async *run() { yield { type: "event", event: { kind: "result", ok: true } }; } } });
    const socket = await socketOf(r);
    c.start("thread-1", workPath(r));
    c.turn("thread-1", "hello", "hi");
    c.age("thread-1", OPEN_MS + 60_000);
    c.name("thread-1", "Named");
    const before = c.snapshot();
    const session = await terminalSession(r);
    await eventsFrom(r, session.id);
    await r.post(`/api/sessions/${session.id}/rename`, { title: "Mine" });
    expect((await r.post(`/api/sessions/${session.id}/messages`, { prompt: "more" })).status).toBe(202);
    await idle(r, session.id);
    await Bun.sleep(100);
    expect(c.snapshot()).toEqual(before);
  });
});
