// The real agent: Claude Code through the Claude Agent SDK's query().
// The SDK changes often: read node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts before changing this.
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDriver, AgentOutput, NewEvent, TurnInput } from "./agent";

/** tool_result content is cut to this many characters before it is stored. */
export const MAX_TOOL_RESULT = 20_000;

export const NO_APPROVALS = "Approvals are not available yet in intuition, so this tool call was denied. Carry on without it.";

/**
 * The options every session runs with. permissionMode is always "default", and settingSources is
 * left out so the workspace's own settings (user, project and local) load, as in the CLI.
 * A call that would prompt reaches canUseTool, which denies it: nothing is ever auto-approved.
 */
export function claudeOptions(input: TurnInput, abortController: AbortController, stderr: (data: string) => void): Options {
  return {
    cwd: input.cwd,
    permissionMode: "default",
    includePartialMessages: true,
    canUseTool: async () => ({ behavior: "deny", message: NO_APPROVALS }),
    abortController,
    stderr,
    ...(input.resume ? { resume: input.resume } : {}),
  };
}

export function cut(text: string, max = MAX_TOOL_RESULT): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A tool_result block's content (a string, or text and other blocks) as one string. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type ?? "content"}]`;
    })
    .join("\n");
}

/**
 * Reduces one SDK message to what the runner keeps. Only the main conversation is reduced: a
 * subagent's own messages (parent_tool_use_id set) are left out, its result arrives as the
 * Agent tool's tool_result.
 */
export function reduce(message: SDKMessage): AgentOutput[] {
  const event = (e: NewEvent): AgentOutput => ({ type: "event", event: e });
  switch (message.type) {
    case "stream_event": {
      if (message.parent_tool_use_id !== null) return [];
      const e = message.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta" && e.delta.text) {
        return [{ type: "delta", text: e.delta.text }];
      }
      return [];
    }
    case "assistant": {
      if (message.parent_tool_use_id !== null) return [];
      const out: AgentOutput[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) out.push(event({ kind: "assistant_text", text: block.text }));
        else if (block.type === "tool_use") out.push(event({ kind: "tool_use", toolUseId: block.id, name: block.name, input: block.input }));
      }
      return out;
    }
    case "user": {
      if (message.parent_tool_use_id !== null) return [];
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      const out: AgentOutput[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        out.push(event({ kind: "tool_result", toolUseId: block.tool_use_id, content: cut(resultText(block.content)), isError: block.is_error === true }));
      }
      return out;
    }
    case "result": {
      const ok = message.subtype === "success" && !message.is_error;
      const text = message.subtype === "success" ? message.result : [message.subtype, ...message.errors].join(": ");
      return [event({ kind: "result", ok, text, costUsd: message.total_cost_usd, durationMs: message.duration_ms })];
    }
    default:
      return [];
  }
}

export function claudeDriver(): AgentDriver {
  return {
    async *run(input: TurnInput): AsyncIterable<AgentOutput> {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      if (input.signal.aborted) return;
      input.signal.addEventListener("abort", abort, { once: true });
      let stderr = "";
      let sessionId: string | null = null;
      try {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const options = claudeOptions(input, abortController, (data) => {
          stderr = (stderr + data).slice(-2000);
        });
        for await (const message of query({ prompt: input.prompt, options })) {
          if (input.signal.aborted) return;
          const id = (message as { session_id?: unknown }).session_id;
          if (typeof id === "string" && id && id !== sessionId) {
            sessionId = id;
            yield { type: "session_id", id };
          }
          const outputs = reduce(message);
          yield* outputs;
          if (message.type === "result") return;
        }
      } catch (e) {
        if (input.signal.aborted) return;
        const detail = stderr.trim();
        yield { type: "event", event: { kind: "error", message: (e as Error).message + (detail ? `\n${detail}` : "") } };
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    },
  };
}
