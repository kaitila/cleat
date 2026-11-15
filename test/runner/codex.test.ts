// The Codex driver (agent-codex.ts): its permissions, its reduction of Codex's events and its turns,
// checked against a stand-in for the SDK's Codex class. Nothing here starts Codex.
import { describe, expect, test } from "bun:test";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { AgentOutput, TurnInput } from "../../src/runner/agent";
import { codexDriver, codexPermissions, codexThreadOptions, codexTurnState, reduceCodex, type CodexLike } from "../../src/runner/agent-codex";

const input: TurnInput = {
  agent: "codex",
  prompt: "hi",
  cwd: "/tmp/work",
  resume: null,
  permissionMode: "auto",
  signal: new AbortController().signal,
  approve: async () => "deny",
};

describe("codexPermissions", () => {
  test("auto: the workspace-write sandbox, Codex's default on-request approvals", () => {
    expect(codexPermissions("auto")).toEqual({ sandboxMode: "workspace-write", approvalPolicy: "on-request" });
  });

  test("default: read-only, so anything beyond reading needs an approval", () => {
    expect(codexPermissions("default")).toEqual({ sandboxMode: "read-only", approvalPolicy: "on-request" });
  });

  test("never turns Codex's checks off: no full access, no 'never' policy", () => {
    for (const mode of ["auto", "default"] as const) {
      const p = codexPermissions(mode);
      expect(p.sandboxMode).not.toBe("danger-full-access");
      expect(p.approvalPolicy).not.toBe("never");
    }
  });

  test("the thread runs in the workspace with the mode's permissions, and nothing else that widens them", () => {
    const options = codexThreadOptions({ cwd: "/tmp/work", permissionMode: "default" });
    expect(options).toEqual({ workingDirectory: "/tmp/work", skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "on-request" });
    expect("networkAccessEnabled" in options).toBe(false);
    expect("additionalDirectories" in options).toBe(false);
  });
});

describe("reduceCodex", () => {
  const run = (events: ThreadEvent[]) => {
    const state = codexTurnState();
    return events.flatMap((e) => reduceCodex(e, state, Date.now()));
  };

  test("the thread id is the session id", () => {
    expect(run([{ type: "thread.started", thread_id: "t-1" }])).toEqual([{ type: "session_id", id: "t-1" }]);
  });

  test("an agent message is stored when it completes, a growing one streams deltas, and the result carries the last", () => {
    const out = run([
      { type: "item.started", item: { id: "m", type: "agent_message", text: "po" } },
      { type: "item.updated", item: { id: "m", type: "agent_message", text: "pong" } },
      { type: "item.completed", item: { id: "m", type: "agent_message", text: "pong" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]);
    expect(out.slice(0, 3)).toEqual([
      { type: "delta", text: "po" },
      { type: "delta", text: "ng" },
      { type: "event", event: { kind: "assistant_text", text: "pong" } },
    ]);
    expect(out[3]).toMatchObject({ type: "event", event: { kind: "result", ok: true, text: "pong" } });
  });

  test("a message seen only when it completes is one delta and its text", () => {
    expect(run([{ type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } }])).toEqual([
      { type: "delta", text: "done" },
      { type: "event", event: { kind: "assistant_text", text: "done" } },
    ]);
  });

  test("a command is a Bash tool_use when it starts and its tool_result when it ends, failed on a non-zero exit", () => {
    const out = run([
      { type: "item.started", item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } },
      { type: "item.updated", item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "a", status: "in_progress" } },
      { type: "item.completed", item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "a\nb\n", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "d", type: "command_execution", command: "touch x", aggregated_output: "read-only file system", exit_code: 1, status: "failed" } },
    ]);
    expect(out).toEqual([
      { type: "event", event: { kind: "tool_use", toolUseId: "c", name: "Bash", input: { command: "ls" } } },
      { type: "event", event: { kind: "tool_result", toolUseId: "c", content: "a\nb\n", isError: false } },
      { type: "event", event: { kind: "tool_use", toolUseId: "d", name: "Bash", input: { command: "touch x" } } },
      { type: "event", event: { kind: "tool_result", toolUseId: "d", content: "read-only file system\n(exit code 1)", isError: true } },
    ]);
  });

  test("a file change is an Edit with its changes", () => {
    const changes = [{ path: "/tmp/work/proof.txt", kind: "add" as const }];
    expect(run([{ type: "item.completed", item: { id: "f", type: "file_change", changes, status: "completed" } }])).toEqual([
      { type: "event", event: { kind: "tool_use", toolUseId: "f", name: "Edit", input: { changes } } },
      { type: "event", event: { kind: "tool_result", toolUseId: "f", content: "add /tmp/work/proof.txt", isError: false } },
    ]);
  });

  test("an MCP call is named by its server and tool", () => {
    const out = run([
      { type: "item.completed", item: { id: "x", type: "mcp_tool_call", server: "s", tool: "t", arguments: { a: 1 }, result: { content: [{ type: "text", text: "ok" }], structured_content: null }, status: "completed" } },
    ]);
    expect(out).toEqual([
      { type: "event", event: { kind: "tool_use", toolUseId: "x", name: "mcp__s__t", input: { a: 1 } } },
      { type: "event", event: { kind: "tool_result", toolUseId: "x", content: "ok", isError: false } },
    ]);
  });

  test("reasoning and the to-do list are left out; a failed turn and a stream error are errors", () => {
    expect(run([{ type: "item.completed", item: { id: "r", type: "reasoning", text: "hmm" } }])).toEqual([]);
    expect(run([{ type: "item.updated", item: { id: "l", type: "todo_list", items: [] } }])).toEqual([]);
    expect(run([{ type: "turn.started" }])).toEqual([]);
    expect(run([{ type: "turn.failed", error: { message: "no" } }])).toEqual([{ type: "event", event: { kind: "error", message: "no" } }]);
    expect(run([{ type: "error", message: "broken" }])).toEqual([{ type: "event", event: { kind: "error", message: "broken" } }]);
  });
});

/** A stand-in for the SDK: records how each thread was made and run, and plays `events`. */
function fakeCodex(events: (signal?: AbortSignal) => AsyncGenerator<ThreadEvent>) {
  const calls: { how: "start" | "resume"; id?: string; options: ThreadOptions; prompt?: string }[] = [];
  const codex: CodexLike = {
    startThread(options) {
      const call: (typeof calls)[number] = { how: "start", options };
      calls.push(call);
      return { runStreamed: async (prompt, o) => ((call.prompt = prompt), { events: events(o.signal) }) };
    },
    resumeThread(id, options) {
      const call: (typeof calls)[number] = { how: "resume", id, options };
      calls.push(call);
      return { runStreamed: async (prompt, o) => ((call.prompt = prompt), { events: events(o.signal) }) };
    },
  };
  return { codex, calls };
}

async function collect(outputs: AsyncIterable<AgentOutput>): Promise<AgentOutput[]> {
  const all: AgentOutput[] = [];
  for await (const o of outputs) all.push(o);
  return all;
}

const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

describe("codexDriver", () => {
  test("a new conversation starts a thread in the workspace, reports the mode asked for, and ends at the result", async () => {
    const { codex, calls } = fakeCodex(async function* () {
      yield { type: "thread.started", thread_id: "t-1" };
      yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "pong" } };
      yield { type: "turn.completed", usage };
      yield { type: "item.completed", item: { id: "late", type: "agent_message", text: "never read" } };
    });
    const out = await collect(codexDriver(async () => codex).run({ ...input, prompt: "Reply with exactly: pong" }));
    expect(calls).toEqual([{ how: "start", options: codexThreadOptions(input), prompt: "Reply with exactly: pong" }]);
    expect(out[0]).toEqual({ type: "permission_mode", mode: "auto" });
    expect(out[1]).toEqual({ type: "session_id", id: "t-1" });
    expect(out.at(-1)).toMatchObject({ type: "event", event: { kind: "result", ok: true, text: "pong" } });
    expect(JSON.stringify(out)).not.toContain("never read");
  });

  test("a reply resumes the stored thread id, with the mode's permissions", async () => {
    const { codex, calls } = fakeCodex(async function* () {
      yield { type: "turn.completed", usage };
    });
    const out = await collect(codexDriver(async () => codex).run({ ...input, resume: "t-1", permissionMode: "default" }));
    expect(calls).toEqual([{ how: "resume", id: "t-1", options: codexThreadOptions({ cwd: "/tmp/work", permissionMode: "default" }), prompt: "hi" }]);
    expect(out.slice(0, 2)).toEqual([{ type: "session_id", id: "t-1" }, { type: "permission_mode", mode: "default" }]);
  });

  test("Stop aborts the turn: it returns without a result or an error", async () => {
    const stop = new AbortController();
    const { codex } = fakeCodex(async function* (signal) {
      yield { type: "thread.started", thread_id: "t-1" };
      stop.abort();
      await Bun.sleep(5);
      if (signal?.aborted) throw new Error("aborted");
      yield { type: "turn.completed", usage };
    });
    const out = await collect(codexDriver(async () => codex).run({ ...input, interrupt: stop.signal }));
    expect(out.some((o) => o.type === "event" && (o.event.kind === "result" || o.event.kind === "error"))).toBe(false);
  });

  test("Codex failing to start is an error event with its message", async () => {
    const out = await collect(codexDriver(async () => { throw new Error("Unable to locate Codex CLI binaries"); }).run(input));
    expect(out).toEqual([{ type: "event", event: { kind: "error", message: "Unable to locate Codex CLI binaries" } }]);
  });
});
