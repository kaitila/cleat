// Claude Code transcripts kept in memory, for the browser scripts (chat-ui.ts, dock-ui.ts): a runner
// given these imports a "terminal" session from them and streams what is written to them later, as
// it does with ~/.claude/projects. Every write moves the transcript's lastModified to now.
// They also take the runner's rename, fork and delete (TranscriptOps), as the SDK's session functions
// do on the files, and remember each one in `calls`. Used by the runner tests too (test/runner/manage.test.ts).
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptOps } from "../../src/runner/manage";
import type { Transcripts } from "../../src/runner/sync";

export class MemoryTranscripts implements Transcripts, TranscriptOps {
  readonly all = new Map<string, { info: SDKSessionInfo; messages: SessionMessage[] }>();
  /** Every rename, fork and delete, in order: "rename <id> <title>", "fork <id> -> <new id>", "remove <id>". */
  readonly calls: string[] = [];

  write(sessionId: string, cwd: string, messages: SessionMessage[], at = Date.now()): void {
    const t = this.all.get(sessionId) ?? { info: { sessionId, summary: "", lastModified: at, cwd, createdAt: at }, messages: [] };
    t.messages.push(...messages);
    t.info = { ...t.info, lastModified: Math.max(at, t.info.lastModified + 1) };
    if (!t.info.firstPrompt) {
      const first = messages.find((m) => m.type === "user")?.message as { content?: unknown } | undefined;
      if (typeof first?.content === "string") t.info.firstPrompt = first.content;
    }
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
    return [...(this.all.get(sessionId)?.messages ?? [])];
  }

  /** The SDK appends a custom-title entry: the file's lastModified moves on. */
  async rename(sessionId: string, title: string): Promise<void> {
    const t = this.all.get(sessionId);
    if (!t) throw new Error(`Session ${sessionId} not found`);
    this.calls.push(`rename ${sessionId} ${title}`);
    t.info = { ...t.info, customTitle: title, lastModified: Math.max(Date.now(), t.info.lastModified + 1) };
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.all.has(sessionId)) throw new Error(`Session ${sessionId} not found`);
    this.calls.push(`remove ${sessionId}`);
    this.all.delete(sessionId);
  }

  async fork(sessionId: string, _dir: string, title: string): Promise<string> {
    const t = this.all.get(sessionId);
    if (!t) throw new Error(`Session ${sessionId} not found`);
    const id = `fork-${crypto.randomUUID()}`;
    const now = Date.now();
    this.all.set(id, {
      info: { ...t.info, sessionId: id, customTitle: title, lastModified: now, createdAt: now },
      messages: t.messages.map((m) => ({ ...m, uuid: crypto.randomUUID() })),
    });
    this.calls.push(`fork ${sessionId} -> ${id}`);
    return id;
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.all.has(sessionId);
  }
}

const entry = (type: SessionMessage["type"], message: unknown): SessionMessage =>
  ({ type, uuid: crypto.randomUUID(), session_id: "s", message, parent_tool_use_id: null, parent_agent_id: null }) as SessionMessage;
export const userEntry = (text: string) => entry("user", { role: "user", content: text });
export const assistantEntry = (text: string) => entry("assistant", { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
