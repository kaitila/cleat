// The real driver's options and its reduction of SDK messages, checked without starting Claude Code.
import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalAsk } from "../../src/runner/agent";
import { DENIED, MAX_DENIED_INPUT, MAX_TOOL_RESULT, claudeOptions, reduce } from "../../src/runner/agent-claude";

const input = { agent: "claude" as const, prompt: "hi", cwd: "/tmp/work", resume: null, permissionMode: "auto" as const, signal: new AbortController().signal, approve: async () => "deny" as const };
/** Only the fields reduce() reads: the SDK's message types carry many more. */
const msg = (m: Record<string, unknown>) => ({ parent_tool_use_id: null, session_id: "s1", ...m }) as unknown as SDKMessage;

describe("claudeOptions", () => {
  test("passes the session's permission mode, auto or default, and nothing that skips the person", () => {
    for (const permissionMode of ["auto", "default"] as const) {
      const options = claudeOptions({ ...input, permissionMode }, new AbortController(), () => {});
      expect(options.permissionMode).toBe(permissionMode);
      expect("allowDangerouslySkipPermissions" in options).toBe(false);
      expect("permissionPromptToolName" in options).toBe(false);
      expect(typeof options.canUseTool).toBe("function");
    }
  });

  test("runs in the workspace with the workspace's own settings and partial messages", () => {
    const options = claudeOptions(input, new AbortController(), () => {});
    expect(options.cwd).toBe("/tmp/work");
    expect(options.permissionMode).toBe("auto");
    expect(options.includePartialMessages).toBe(true);
    // Not narrowed: left out, the SDK loads user, project and local settings.
    expect("settingSources" in options).toBe(false);
    expect("allowedTools" in options).toBe(false);
    expect("allowDangerouslySkipPermissions" in options).toBe(false);
    expect("resume" in options).toBe(false);
    expect(claudeOptions({ ...input, resume: "abc" }, new AbortController(), () => {}).resume).toBe("abc");
  });

  test("canUseTool asks the person and answers only what they decided", async () => {
    const asked: { ask: ApprovalAsk; signal?: AbortSignal }[] = [];
    let decision: "allow" | "deny" = "allow";
    const { canUseTool } = claudeOptions({ ...input, approve: async (ask, signal) => (asked.push({ ask, signal }), decision) }, new AbortController(), () => {});
    type CallOptions = Parameters<NonNullable<typeof canUseTool>>[2];
    const signal = new AbortController().signal;
    const toolInput = { command: "rm -rf /" };
    const allowed = await canUseTool!("Bash", toolInput, { signal, toolUseID: "t1", requestId: "r1", decisionReason: "not in the allow list", suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } as CallOptions);
    // The input goes back unchanged, and nothing is ever allowed for later calls.
    expect(allowed).toEqual({ behavior: "allow", updatedInput: toolInput });
    expect("updatedPermissions" in allowed!).toBe(false);
    expect(asked).toEqual([{ ask: { toolUseId: "t1", toolName: "Bash", input: toolInput, reason: "not in the allow list" }, signal }]);
    decision = "deny";
    const denied = await canUseTool!("Write", { file_path: "/x" }, { signal, toolUseID: "t2", requestId: "r2" } as CallOptions);
    expect(denied).toEqual({ behavior: "deny", message: DENIED });
    expect(DENIED).toBe("The user denied this tool call.");
    expect(asked[1]!.ask).toEqual({ toolUseId: "t2", toolName: "Write", input: { file_path: "/x" } });
  });
});

describe("reduce", () => {
  test("init and status report the permission mode in effect", () => {
    expect(reduce(msg({ type: "system", subtype: "init", permissionMode: "default", tools: [] }))).toEqual([{ type: "permission_mode", mode: "default" }]);
    expect(reduce(msg({ type: "system", subtype: "init", permissionMode: "auto", tools: [] }))).toEqual([{ type: "permission_mode", mode: "auto" }]);
    expect(reduce(msg({ type: "system", subtype: "status", status: null, permissionMode: "auto" }))).toEqual([{ type: "permission_mode", mode: "auto" }]);
    expect(reduce(msg({ type: "system", subtype: "status", status: "requesting" }))).toEqual([]);
  });

  test("a call denied without asking becomes auto_denied, with the input's summary from its tool_use", () => {
    const inputs = new Map<string, unknown>();
    reduce(msg({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "rm -rf\n/tmp/x" } }] } }), inputs);
    const denied = (m: Record<string, unknown>) => reduce(msg({ type: "system", subtype: "permission_denied", uuid: "u", ...m }), inputs);
    expect(denied({ tool_name: "Bash", tool_use_id: "t9", decision_reason_type: "classifier", decision_reason: "deletes outside the workspace", message: "Denied by auto mode" })).toEqual([
      { type: "event", event: { kind: "auto_denied", toolUseId: "t9", toolName: "Bash", input: "rm -rf /tmp/x", reason: "deletes outside the workspace" } },
    ]);
    // An unknown call has no summary; without a decision_reason the model's message is the reason.
    expect(denied({ tool_name: "Write", tool_use_id: "t10", message: "Denied by auto mode" })).toEqual([
      { type: "event", event: { kind: "auto_denied", toolUseId: "t10", toolName: "Write", reason: "Denied by auto mode" } },
    ]);
    inputs.set("t11", { command: "x".repeat(MAX_DENIED_INPUT * 2) });
    const long = denied({ tool_name: "Bash", tool_use_id: "t11", message: "no" })[0] as { event: { input: string } };
    expect(long.event.input.length).toBe(MAX_DENIED_INPUT);
  });

  test("other system messages are dropped", () => {
    expect(reduce(msg({ type: "system", subtype: "compact_boundary" }))).toEqual([]);
  });

  test("a text delta becomes a delta; other stream events are dropped", () => {
    expect(reduce(msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } } }))).toEqual([{ type: "delta", text: "po" }]);
    expect(reduce(msg({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } } }))).toEqual([]);
    expect(reduce(msg({ type: "stream_event", event: { type: "message_stop" } }))).toEqual([]);
  });

  test("an assistant message becomes assistant_text and tool_use events, without its thinking", () => {
    const out = reduce(
      msg({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      }),
    );
    expect(out).toEqual([
      { type: "event", event: { kind: "assistant_text", text: "Looking." } },
      { type: "event", event: { kind: "tool_use", toolUseId: "t1", name: "Bash", input: { command: "ls" } } },
    ]);
  });

  test("a tool_result is joined to one string and cut to 20,000 characters", () => {
    expect(MAX_TOOL_RESULT).toBe(20_000);
    const out = reduce(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "x".repeat(30_000) },
            { type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }] },
            { type: "tool_result", tool_use_id: "t3" },
          ],
        },
      }),
    );
    expect(out).toEqual([
      { type: "event", event: { kind: "tool_result", toolUseId: "t1", content: "x".repeat(20_000), isError: false } },
      { type: "event", event: { kind: "tool_result", toolUseId: "t2", content: "a\n[image]\nb", isError: true } },
      { type: "event", event: { kind: "tool_result", toolUseId: "t3", content: "", isError: false } },
    ]);
    expect(reduce(msg({ type: "user", message: { role: "user", content: "plain text" } }))).toEqual([]);
  });

  test("a result becomes a result event: ok for success, not ok for an error", () => {
    expect(reduce(msg({ type: "result", subtype: "success", is_error: false, result: "pong", total_cost_usd: 0.01, duration_ms: 1200 }))).toEqual([
      { type: "event", event: { kind: "result", ok: true, text: "pong", costUsd: 0.01, durationMs: 1200 } },
    ]);
    expect(reduce(msg({ type: "result", subtype: "success", is_error: true, result: "Invalid API key", total_cost_usd: 0, duration_ms: 5 }))).toEqual([
      { type: "event", event: { kind: "result", ok: false, text: "Invalid API key", costUsd: 0, durationMs: 5 } },
    ]);
    expect(reduce(msg({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many"], total_cost_usd: 0.5, duration_ms: 9 }))).toEqual([
      { type: "event", event: { kind: "result", ok: false, text: "error_max_turns: too many", costUsd: 0.5, durationMs: 9 } },
    ]);
  });

  test("a subagent's messages and system messages are left out", () => {
    expect(reduce(msg({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "sub" }] } }))).toEqual([]);
    expect(reduce(msg({ type: "stream_event", parent_tool_use_id: "t9", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } } }))).toEqual([]);
    expect(reduce(msg({ type: "system", subtype: "init" }))).toEqual([]);
  });
});
