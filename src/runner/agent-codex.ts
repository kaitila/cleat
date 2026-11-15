// The second real agent: OpenAI Codex through the Codex SDK (@openai/codex-sdk), which runs the
// `codex exec --experimental-json` it bundles and reads its JSONL events (docs/agents.md, D0028).
// The SDK changes often: read node_modules/@openai/codex-sdk/dist/index.d.ts and its README before changing this.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ApprovalMode, SandboxMode, ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk";
import type { PermissionMode } from "../shared/protocol";
import type { AgentDriver, AgentOutput, NewEvent, TurnInput } from "./agent";
import { cut } from "./agent-claude";

/** What Codex runs a turn with, from the runner's permission mode. */
export interface CodexPermissions {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
}

/**
 * The runner's permission mode as Codex's sandbox and approval policy. auto: Codex's workspace-write
 * sandbox (it writes in the workspace, the network is off) with Codex's own default approval policy,
 * on-request. default: the read-only sandbox, so anything beyond reading needs approval.
 *
 * `codex exec`, which the SDK runs, has no way to ask the host: the SDK gives no callback, and Codex
 * tells the model that escalation requests are not available. So a call that would need approval is
 * never run, in either mode, and never reaches the person (docs/agents.md, "Approvals").
 * Never danger-full-access, never the "never" policy: the runner doesn't turn Codex's checks off.
 */
export function codexPermissions(mode: PermissionMode): CodexPermissions {
  return mode === "auto" ? { sandboxMode: "workspace-write", approvalPolicy: "on-request" } : { sandboxMode: "read-only", approvalPolicy: "on-request" };
}

/** The ThreadOptions of every turn: the workspace, the mode's permissions. */
export function codexThreadOptions(input: Pick<TurnInput, "cwd" | "permissionMode">): ThreadOptions {
  return {
    workingDirectory: input.cwd,
    // A workspace is a folder the person added on purpose; Codex would otherwise refuse one that isn't a git repository.
    skipGitRepoCheck: true,
    ...codexPermissions(input.permissionMode),
  };
}

const PLATFORM_PACKAGE: Record<string, string> = {
  "linux-x64": "@openai/codex-linux-x64",
  "linux-arm64": "@openai/codex-linux-arm64",
  "darwin-x64": "@openai/codex-darwin-x64",
  "darwin-arm64": "@openai/codex-darwin-arm64",
  "win32-x64": "@openai/codex-win32-x64",
  "win32-arm64": "@openai/codex-win32-arm64",
};

/**
 * The codex binary the SDK runs: the one its @openai/codex package brings for this platform, as the
 * SDK finds it. Null when it isn't installed. doctor asks this binary for its version and login.
 */
export function codexBinary(): string | null {
  try {
    const pkg = PLATFORM_PACKAGE[`${process.platform}-${process.arch}`];
    if (!pkg) return null;
    const codexRequire = createRequire(createRequire(import.meta.url).resolve("@openai/codex/package.json"));
    const vendor = join(dirname(codexRequire.resolve(`${pkg}/package.json`)), "vendor");
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    for (const triple of ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]) {
      for (const path of [join(vendor, triple, "bin", name), join(vendor, triple, "codex", name)]) if (existsSync(path)) return path;
    }
    return null;
  } catch {
    return null;
  }
}

/** The tool name a Codex item is stored under, as Claude Code's are (Bash, Edit...). */
export const CODEX_TOOLS = { command: "Bash", fileChange: "Edit", mcp: "mcp", webSearch: "WebSearch" } as const;

function toolUse(item: ThreadItem): NewEvent | null {
  switch (item.type) {
    case "command_execution":
      return { kind: "tool_use", toolUseId: item.id, name: CODEX_TOOLS.command, input: { command: item.command } };
    case "file_change":
      return { kind: "tool_use", toolUseId: item.id, name: CODEX_TOOLS.fileChange, input: { changes: item.changes } };
    case "mcp_tool_call":
      return { kind: "tool_use", toolUseId: item.id, name: `${CODEX_TOOLS.mcp}__${item.server}__${item.tool}`, input: item.arguments ?? {} };
    case "web_search":
      return { kind: "tool_use", toolUseId: item.id, name: CODEX_TOOLS.webSearch, input: { query: item.query } };
    default:
      return null;
  }
}

function toolResult(item: ThreadItem): NewEvent | null {
  switch (item.type) {
    case "command_execution": {
      const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
      const code = item.exit_code !== undefined && item.exit_code !== 0 ? `\n(exit code ${item.exit_code})` : "";
      return { kind: "tool_result", toolUseId: item.id, content: cut(item.aggregated_output + code), isError: failed };
    }
    case "file_change":
      return {
        kind: "tool_result",
        toolUseId: item.id,
        content: cut(item.changes.map((c) => `${c.kind} ${c.path}`).join("\n") + (item.status === "failed" ? "\n(the patch failed)" : "")),
        isError: item.status === "failed",
      };
    case "mcp_tool_call": {
      const text = item.error
        ? item.error.message
        : (item.result?.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
      return { kind: "tool_result", toolUseId: item.id, content: cut(text), isError: item.status === "failed" || Boolean(item.error) };
    }
    case "web_search":
      return { kind: "tool_result", toolUseId: item.id, content: "", isError: false };
    default:
      return null;
  }
}

/** What one turn's reduction remembers: the tool calls already started, and the text of each message so far. */
export interface CodexTurnState {
  started: Set<string>;
  texts: Map<string, string>;
  /** The newest agent message: the result's text. */
  last: string;
}

export function codexTurnState(): CodexTurnState {
  return { started: new Set(), texts: new Map(), last: "" };
}

/**
 * Reduces one Codex event to what the runner keeps, as reduce() in agent-claude.ts does for Claude
 * Code. A command, file change, MCP call or web search becomes a tool_use (when it starts, or when it
 * completes if no start was seen) and a tool_result when it completes. An agent message is stored as
 * assistant_text when it completes; a message that grows (item.updated) streams its new part as a
 * delta. Reasoning and the to-do list are left out. The turn ends with a result or an error.
 */
export function reduceCodex(event: ThreadEvent, state: CodexTurnState, started: number): AgentOutput[] {
  const out = (e: NewEvent): AgentOutput => ({ type: "event", event: e });
  switch (event.type) {
    case "thread.started":
      return [{ type: "session_id", id: event.thread_id }];
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item.type === "agent_message") {
        const before = state.texts.get(item.id) ?? "";
        state.texts.set(item.id, item.text);
        const outputs: AgentOutput[] = [];
        if (item.text.startsWith(before) && item.text.length > before.length) outputs.push({ type: "delta", text: item.text.slice(before.length) });
        if (event.type === "item.completed" && item.text) {
          state.last = item.text;
          outputs.push(out({ kind: "assistant_text", text: item.text }));
        }
        return outputs;
      }
      if (item.type === "error") return event.type === "item.completed" ? [out({ kind: "assistant_text", text: `Codex: ${item.message}` })] : [];
      const outputs: AgentOutput[] = [];
      if (!state.started.has(item.id)) {
        const use = toolUse(item);
        if (use) {
          state.started.add(item.id);
          outputs.push(out(use));
        }
      }
      if (event.type === "item.completed") {
        const result = toolResult(item);
        if (result) outputs.push(out(result));
      }
      return outputs;
    }
    case "turn.completed":
      return [out({ kind: "result", ok: true, text: state.last, durationMs: Date.now() - started })];
    case "turn.failed":
      return [out({ kind: "error", message: event.error.message })];
    case "error":
      return [out({ kind: "error", message: event.message })];
    default:
      return [];
  }
}

/** The SDK's Codex class, as much of it as the driver uses: replaced in tests. */
export interface CodexLike {
  startThread(options: ThreadOptions): ThreadLike;
  resumeThread(id: string, options: ThreadOptions): ThreadLike;
}
export interface ThreadLike {
  runStreamed(input: string, options: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

async function realCodex(): Promise<CodexLike> {
  const { Codex } = await import("@openai/codex-sdk");
  const binary = codexBinary();
  return new Codex(binary ? { codexPathOverride: binary } : {});
}

/**
 * The Codex driver. Each turn starts a thread in the workspace, or resumes the stored thread id; the
 * thread id is reported as the session id. Stop (and the runner stopping) aborts the turn, which ends
 * the codex process: the turn returns without a result, as an interrupted Claude Code turn does.
 * Codex reports no permission mode of its own, so the mode asked for is reported as the one in effect.
 */
export function codexDriver(make: () => Promise<CodexLike> = realCodex): AgentDriver {
  return {
    async *run(input: TurnInput): AsyncIterable<AgentOutput> {
      if (input.signal.aborted) return;
      const abort = new AbortController();
      const stop = () => abort.abort();
      input.signal.addEventListener("abort", stop, { once: true });
      input.interrupt?.addEventListener("abort", stop, { once: true });
      if (input.interrupt?.aborted) stop();
      const started = Date.now();
      try {
        const codex = await make();
        const options = codexThreadOptions(input);
        const thread = input.resume ? codex.resumeThread(input.resume, options) : codex.startThread(options);
        if (input.resume) yield { type: "session_id", id: input.resume };
        yield { type: "permission_mode", mode: input.permissionMode };
        const { events } = await thread.runStreamed(input.prompt, { signal: abort.signal });
        const state = codexTurnState();
        for await (const event of events) {
          if (abort.signal.aborted) return;
          for (const output of reduceCodex(event, state, started)) {
            yield output;
            if (output.type === "event" && (output.event.kind === "result" || output.event.kind === "error")) return;
          }
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        yield { type: "event", event: { kind: "error", message: (e as Error).message || String(e) } };
      } finally {
        input.signal.removeEventListener("abort", stop);
        input.interrupt?.removeEventListener("abort", stop);
      }
    },
  };
}
