// How a plugin reaches the person's MCP tools (their claude.ai connectors): through Claude Code, in a
// one-off process that may run nothing but the plugin's declared tools (D0057). The SDK changes often:
// read node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts before changing this.
import type { McpServerStatus, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv, resultText } from "./agent-claude";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** The plugin's own folder: Claude Code runs there, never in a workspace. */
  cwd: string;
  signal: AbortSignal;
}

export interface AskCall {
  prompt: string;
  schema: Record<string, unknown>;
  tools: string[];
  model?: string;
  cwd: string;
  signal: AbortSignal;
}

/** What the plugins' ctx.tool() and ctx.ask() run on: Claude Code, or the fake in tests (CLEAT_FAKE_AGENT). */
export interface PluginAgent {
  /** The tool's result as text. Throws with the tool's own words when it answered an error. */
  tool(call: ToolCall): Promise<string>;
  /** The answer, of the schema's shape. */
  ask(call: AskCall): Promise<unknown>;
}

/** How long a call waits for the MCP servers it needs to connect. */
export const SERVER_WAIT_MS = 15_000;
const SERVER_POLL_MS = 200;
/** The model that only makes the one call: the cheapest and quickest. */
export const TOOL_MODEL = "haiku";
export const ASK_MODEL = "sonnet";

/** An MCP tool's full name: mcp__<server>__<tool>, the server's name normalised as Claude Code does. */
export const MCP_TOOL = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/;

/** The server of an MCP tool's full name, as Claude Code writes it in the name; null for a name that is not one. */
export function serverOf(tool: string): string | null {
  return MCP_TOOL.exec(tool)?.[1] ?? null;
}

/** A server's name as it appears in its tools' names: every character but [a-zA-Z0-9_-] becomes "_". */
export function normalServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Whether the servers a call needs are settled, from one status answer: "wait" while one is still
 * connecting or the list is still empty (Claude Code lists them only once it has started), "ready"
 * when every one is connected, else why not (missing, failed, needs a sign-in).
 */
export function serversReady(status: McpServerStatus[], wanted: string[]): "wait" | "ready" | string {
  if (status.length === 0) return "wait";
  const problems: string[] = [];
  for (const server of wanted) {
    const s = status.find((x) => normalServer(x.name) === server);
    if (!s) {
      if (status.some((x) => x.status === "pending")) return "wait";
      problems.push(`no MCP server ${server} is set up for Claude Code`);
    } else if (s.status === "pending") return "wait";
    else if (s.status !== "connected") problems.push(`${s.name} is ${s.status}${s.status === "needs-auth" ? ": sign in to it in Claude" : ""}`);
  }
  return problems.length ? problems.join("; ") : "ready";
}

/**
 * The options of every plugin call: no built-in tool at all, only `tools` allowed, and `dontAsk`, so
 * any other call is refused without asking anyone (there is no one to ask). No settings are loaded
 * (settingSources []), so no allow rule of the person's lets anything else through; the claude.ai
 * connectors come with the login. Nothing is written to a transcript.
 */
export function pluginOptions(cwd: string, tools: string[], abortController: AbortController, model: string): Options {
  return {
    cwd,
    model,
    tools: [],
    allowedTools: tools,
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    abortController,
    env: claudeEnv(),
  };
}

/** Polls `status` until the servers of `tools` are settled: resolves on "ready", throws why not, gives up waiting after `capMs`. */
export async function waitForServers(status: () => Promise<McpServerStatus[]>, tools: string[], signal: AbortSignal, capMs = SERVER_WAIT_MS): Promise<void> {
  const wanted = [...new Set(tools.map(serverOf).filter((s): s is string => s !== null))];
  if (wanted.length === 0) return;
  const until = Date.now() + capMs;
  let last = "wait";
  while (!signal.aborted && Date.now() < until) {
    let answer: McpServerStatus[] = [];
    try {
      answer = await status();
    } catch {
      // Not answering yet: asked again.
    }
    last = serversReady(answer, wanted);
    if (last === "ready") return;
    if (last !== "wait") throw new Error(last);
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
  }
  // Still connecting at the cap: the call goes ahead, and says so if its tool is missing.
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** The prompt as streaming input, sent once `ready` resolves, the input open until `done`. */
async function* promptAfter(text: string, ready: Promise<void>, done: Promise<void>): AsyncGenerator<SDKUserMessage> {
  await ready;
  yield userMessage(text);
  await done;
}

/**
 * Runs one query: the servers waited for first, then the prompt; `take` sees each message and says
 * when it has what it wants (the query is then aborted). Errors while waiting for the servers are thrown.
 */
async function run(prompt: string, options: Options, tools: string[], signal: AbortSignal, take: (m: SDKMessage) => boolean): Promise<void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = options.abortController!;
  const abort = () => abortController.abort();
  signal.addEventListener("abort", abort, { once: true });
  let go = (): void => {};
  let fail = (_e: Error): void => {};
  const ready = new Promise<void>((resolve, reject) => {
    go = resolve;
    fail = reject;
  });
  let end = (): void => {};
  const done = new Promise<void>((r) => (end = r));
  let waitError: Error | null = null;
  // The generator is read as soon as query() starts: `ready` is made before it.
  const q = query({ prompt: promptAfter(prompt, ready.catch(() => {}), done), options });
  waitForServers(() => q.mcpServerStatus(), tools, abortController.signal).then(go, (e: Error) => {
    waitError = e;
    fail(e);
    abortController.abort();
  });
  try {
    for await (const message of q) {
      if (take(message)) {
        abortController.abort();
        return;
      }
      if (message.type === "result") return;
    }
  } catch (e) {
    if (waitError) throw waitError;
    if (signal.aborted) throw new Error("stopped");
    if (abortController.signal.aborted) return;
    throw e;
  } finally {
    end();
    signal.removeEventListener("abort", abort);
  }
  if (waitError) throw waitError;
}

export function claudePluginAgent(): PluginAgent {
  return {
    async tool({ tool, args, cwd, signal }) {
      const abortController = new AbortController();
      const options: Options = {
        ...pluginOptions(cwd, [tool], abortController, TOOL_MODEL),
        maxTurns: 2,
        // The model only has to make the call: the arguments are the plugin's, whatever it wrote.
        hooks: { PreToolUse: [{ matcher: `^${tool}$`, hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, updatedInput: args } })] }] },
      };
      const ids = new Set<string>();
      let answer: { text: string; isError: boolean } | null = null;
      let denied = "";
      await run(`Call the tool ${tool} once, with exactly these arguments, then stop.\n${JSON.stringify(args)}`, options, [tool], signal, (m) => {
        if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use" && b.name === tool) ids.add(b.id);
        if (m.type === "user" && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === "tool_result" && ids.has(b.tool_use_id)) {
              answer = { text: resultText(b.content), isError: b.is_error === true };
              return true;
            }
          }
        }
        if (m.type === "result" && m.subtype === "success") denied = m.permission_denials.map((d) => d.tool_name).join(", ");
        return false;
      });
      const got = answer as { text: string; isError: boolean } | null;
      if (!got) throw new Error(denied ? `refused: ${denied}` : `${tool} did not run: is its connector connected in Claude?`);
      if (got.isError) throw new Error(got.text || `${tool} failed`);
      return got.text;
    },

    async ask({ prompt, schema, tools, model, cwd, signal }) {
      const abortController = new AbortController();
      const options: Options = { ...pluginOptions(cwd, tools, abortController, model ?? ASK_MODEL), maxTurns: 16, outputFormat: { type: "json_schema", schema } };
      let answer: unknown;
      let failed = "";
      await run(prompt, options, tools, signal, (m) => {
        if (m.type !== "result") return false;
        if (m.subtype === "success" && !m.is_error) answer = m.structured_output;
        else failed = m.subtype === "success" ? m.result : [m.subtype, ...m.errors].join(": ");
        return true;
      });
      if (answer === undefined) throw new Error(failed || "no answer");
      return answer;
    },
  };
}

/**
 * The fake, with CLEAT_FAKE_AGENT=1 (tests and CI, which have no Claude Code login): a tool call
 * answers `{ fake: true, tool, args }` as JSON, and an ask answers `{ fake: true, prompt }`.
 */
export function fakePluginAgent(): PluginAgent {
  return {
    async tool({ tool, args }) {
      return JSON.stringify({ fake: true, tool, args });
    },
    async ask({ prompt }) {
      return { fake: true, prompt };
    },
  };
}
