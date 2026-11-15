// The Codex side of the transcript sync (D0031): Codex keeps every thread, the runner's and the
// terminal's alike, as a rollout file under $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
// (CODEX_HOME is ~/.codex unless set). This reads them, and only reads: nothing here writes under
// CODEX_HOME. The format is Codex's own and changes between versions; it was read from real files of
// codex 0.167.1 (the TUI, VS Code) and 0.169.0 (`codex exec`, the SDK) and from the strings of the binary:
//   - the first line is `session_meta`: { id, cwd, timestamp, source, thread_source, ... };
//   - then, appended as the thread runs, `response_item` lines (what the model is sent and says,
//     developer instructions included), `event_msg` lines and others (turn_context, token counts);
//   - `event_msg` `item_completed` carries each finished item in the shape the person saw it:
//     UserMessage, AgentMessage, CommandExecution, FileChange, McpToolCall, WebSearch, Reasoning;
//   - `event_msg` `task_complete` ends a turn, `turn_aborted` ends one that was interrupted, and
//     `error` reports a failed one;
//   - a resumed thread appends to the same file.
// $CODEX_HOME/session_index.jsonl names a thread (`thread_name`, the TUI's title for it).
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NewEvent } from "./agent";
import { cut } from "./agent-claude";
import { CODEX_TOOLS } from "./agent-codex";
import { titleOf } from "./sessions";
import type { Entry, ThreadInfo, Threads } from "./sync";

/** The folder Codex keeps its state in: $CODEX_HOME, else ~/.codex, as Codex itself finds it. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** What the first line of a rollout says, and the first thing the person typed in it. */
interface Meta {
  id: string;
  cwd: string;
  createdAt: number;
  /** A thread Codex started for itself (a subagent's, a review's): not a conversation of the person's. */
  own: boolean;
}

interface FileState {
  mtime: number;
  size: number;
  meta: Meta | null;
  /** The first user message, once one is written. */
  firstPrompt: string;
}

/** Reads the first line of a file (the session_meta can be tens of kilobytes), or null before it is whole. */
function firstLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; ; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) return null;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl !== -1) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

function metaOf(line: string): Meta | null {
  try {
    const row = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
    const p = row.payload;
    if (row.type !== "session_meta" || !p || typeof p.id !== "string" || typeof p.cwd !== "string") return null;
    const created = typeof p.timestamp === "string" ? Date.parse(p.timestamp) : Number.NaN;
    // A subagent's thread records its source as an object ({ subagent: ... }) and its thread_source as not "user".
    const own = (p.source !== undefined && typeof p.source !== "string") || (typeof p.thread_source === "string" && p.thread_source !== "user");
    return { id: p.id, cwd: resolve(p.cwd), createdAt: Number.isNaN(created) ? 0 : created, own };
  } catch {
    return null;
  }
}

/** The complete lines of a rollout, parsed; a line still being written (no newline yet) and a broken one are skipped. */
function rows(text: string): { line: number; row: Row }[] {
  const out: { line: number; row: Row }[] = [];
  const lines = text.split("\n");
  lines.pop(); // after the last newline: empty, or a line not yet whole
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      out.push({ line: i, row: JSON.parse(l) as Row });
    } catch {
      // A broken line is left out; the rest of the thread still reads.
    }
  });
  return out;
}

interface Row {
  timestamp?: unknown;
  type?: unknown;
  payload?: { type?: unknown; item?: Item; last_agent_message?: unknown; duration_ms?: unknown; message?: unknown } & Record<string, unknown>;
}

type Item = { type?: unknown; id?: unknown } & Record<string, unknown>;

function texts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((c: { type?: unknown; text?: unknown }) => (typeof c?.text === "string" && (c.type === "text" || c.type === "Text") ? [c.text] : []))
    .join("\n");
}

/** A command as one line: the script of `<shell> -lc <script>`, else the words joined. */
function commandOf(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const words = command.filter((w): w is string => typeof w === "string");
  if (words.length === 3 && /^-l?c$/.test(words[1]!)) return words[2]!;
  return words.join(" ");
}

function changesOf(changes: unknown): { path: string; kind: string }[] {
  if (Array.isArray(changes)) return changes.filter((c) => typeof c?.path === "string").map((c) => ({ path: c.path, kind: String(c.kind ?? "update") }));
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, { type?: unknown }>).map(([path, c]) => ({ path, kind: typeof c?.type === "string" ? c.type : "update" }));
}

/**
 * One finished item as the events the runner keeps, the same a turn of the runner's gives
 * (reduceCodex in agent-codex.ts): a user message, an agent message, and a tool_use with its
 * tool_result for a command, a file change, an MCP call or a web search. Reasoning is left out.
 */
export function itemEvents(item: Item): NewEvent[] {
  const id = typeof item.id === "string" ? item.id : "";
  switch (item.type) {
    case "UserMessage": {
      const text = texts(item.content);
      return text.trim() ? [{ kind: "user", text }] : [];
    }
    case "AgentMessage": {
      const text = texts(item.content);
      return text ? [{ kind: "assistant_text", text }] : [];
    }
    case "CommandExecution": {
      const code = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const failed = item.status === "failed" || (code !== undefined && code !== 0);
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      return [
        { kind: "tool_use", toolUseId: id, name: CODEX_TOOLS.command, input: { command: commandOf(item.command) } },
        { kind: "tool_result", toolUseId: id, content: cut(output + (code !== undefined && code !== 0 ? `\n(exit code ${code})` : "")), isError: failed },
      ];
    }
    case "FileChange": {
      const changes = changesOf(item.changes);
      const failed = item.status === "failed";
      return [
        { kind: "tool_use", toolUseId: id, name: CODEX_TOOLS.fileChange, input: { changes } },
        { kind: "tool_result", toolUseId: id, content: cut(changes.map((c) => `${c.kind} ${c.path}`).join("\n") + (failed ? "\n(the patch failed)" : "")), isError: failed },
      ];
    }
    case "McpToolCall": {
      const error = item.error as { message?: unknown } | string | null | undefined;
      const errorText = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
      const result = item.result as { content?: { type?: unknown; text?: unknown }[] } | null | undefined;
      const text = errorText || (result?.content ?? []).map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : `[${String(b.type)}]`)).join("\n");
      return [
        { kind: "tool_use", toolUseId: id, name: `${CODEX_TOOLS.mcp}__${String(item.server)}__${String(item.tool)}`, input: item.arguments ?? {} },
        { kind: "tool_result", toolUseId: id, content: cut(text), isError: item.status === "failed" || Boolean(errorText) },
      ];
    }
    case "WebSearch":
      return [
        { kind: "tool_use", toolUseId: id, name: CODEX_TOOLS.webSearch, input: { query: typeof item.query === "string" ? item.query : "" } },
        { kind: "tool_result", toolUseId: id, content: "", isError: false },
      ];
    default:
      return [];
  }
}

/**
 * A rollout's lines as the sync's entries: one per finished item, turn end, interruption or error,
 * keyed by its line number (a rollout only grows). `idle`: the turn is over after it.
 */
export function entriesOf(text: string): Entry[] {
  const out: Entry[] = [];
  for (const { line, row } of rows(text)) {
    if (row.type !== "event_msg" || !row.payload) continue;
    const p = row.payload;
    const ts = typeof row.timestamp === "string" && !Number.isNaN(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : undefined;
    const key = String(line);
    let events: NewEvent[];
    let idle = false;
    switch (p.type) {
      case "item_completed":
        if (!p.item) continue;
        events = itemEvents(p.item);
        if (!events.length) continue;
        break;
      case "task_complete": {
        const text = typeof p.last_agent_message === "string" ? p.last_agent_message : "";
        events = [{ kind: "result", ok: true, ...(text ? { text } : {}), ...(typeof p.duration_ms === "number" ? { durationMs: p.duration_ms } : {}) }];
        idle = true;
        break;
      }
      case "turn_aborted":
        events = [];
        idle = true;
        break;
      case "error":
        events = [{ kind: "error", message: typeof p.message === "string" ? p.message : "Codex failed" }];
        idle = true;
        break;
      default:
        continue;
    }
    out.push({ key, events, idle, ...(ts ? { time: ts } : {}) });
  }
  return out;
}

/** The first thing the person typed in a thread, or "". */
function firstPromptOf(text: string): string {
  for (const entry of entriesOf(text)) {
    const user = entry.events.find((e) => e.kind === "user");
    if (user && user.kind === "user") return user.text;
  }
  return "";
}

/**
 * The Codex threads under `home` (CODEX_HOME), read from their rollout files. Each call lists the
 * sessions folder again; a file is read again only when its size or mtime moved.
 */
export function codexThreads(home: string = codexHome()): Threads {
  const sessionsDir = join(home, "sessions");
  const indexPath = join(home, "session_index.jsonl");
  const files = new Map<string, FileState>();
  const paths = new Map<string, string>();
  let index = { mtime: -1, names: new Map<string, string>() };

  function walk(dir: string, out: string[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, out);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(path);
    }
  }

  function names(): Map<string, string> {
    try {
      const mtime = statSync(indexPath).mtimeMs;
      if (mtime === index.mtime) return index.names;
      const map = new Map<string, string>();
      for (const { row } of rows(readFileSync(indexPath, "utf8"))) {
        const r = row as { id?: unknown; thread_name?: unknown };
        if (typeof r.id === "string" && typeof r.thread_name === "string" && r.thread_name.trim()) map.set(r.id, r.thread_name);
      }
      index = { mtime, names: map };
    } catch {
      index = { mtime: -1, names: new Map() };
    }
    return index.names;
  }

  /** The file's state, read again when it changed. Null when it is gone or not a thread yet. */
  function stateOf(path: string): FileState | null {
    let st;
    try {
      st = statSync(path);
    } catch {
      files.delete(path);
      return null;
    }
    let state = files.get(path);
    if (!state || state.mtime !== st.mtimeMs || state.size !== st.size) {
      state = { mtime: st.mtimeMs, size: st.size, meta: state?.meta ?? null, firstPrompt: state?.firstPrompt ?? "" };
      try {
        if (!state.meta) {
          const line = firstLine(path);
          state.meta = line === null ? null : metaOf(line);
        }
        if (state.meta && !state.firstPrompt) state.firstPrompt = firstPromptOf(readFileSync(path, "utf8"));
      } catch {
        // Unreadable now: tried again when it changes.
      }
      files.set(path, state);
      if (state.meta) paths.set(state.meta.id, path);
    }
    return state.meta ? state : null;
  }

  function infoOf(state: FileState): ThreadInfo {
    const meta = state.meta!;
    return {
      id: meta.id,
      cwd: meta.cwd,
      title: titleOf(names().get(meta.id) || state.firstPrompt),
      createdAt: meta.createdAt || state.mtime,
      lastModified: Math.floor(state.mtime),
    };
  }

  function pathOf(id: string): string | undefined {
    const known = paths.get(id);
    if (known && stateOf(known)) return known;
    const all: string[] = [];
    walk(sessionsDir, all);
    // The file name ends in the thread id: only that one is read.
    for (const path of all.filter((p) => p.endsWith(`-${id}.jsonl`))) if (stateOf(path)?.meta?.id === id) return path;
    return undefined;
  }

  return {
    async list(dir, limit) {
      // Codex records the folder as it found it, links resolved (on macOS /var is /private/var).
      const want = new Set([resolve(dir)]);
      try {
        want.add(realpathSync(dir));
      } catch {
        // A workspace folder that is gone: only its path as written.
      }
      const all: string[] = [];
      walk(sessionsDir, all);
      const out: ThreadInfo[] = [];
      for (const path of all) {
        const state = stateOf(path);
        if (state?.meta && !state.meta.own && want.has(state.meta.cwd)) out.push(infoOf(state));
      }
      return out.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
    },
    async info(id) {
      const path = pathOf(id);
      const state = path ? stateOf(path) : null;
      return state ? infoOf(state) : undefined;
    },
    async entries(id) {
      const path = pathOf(id);
      if (!path) return [];
      return entriesOf(readFileSync(path, "utf8"));
    },
  };
}
