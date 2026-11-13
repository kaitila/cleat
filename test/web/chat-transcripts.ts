// Claude Code transcripts kept in memory, for the browser scripts (chat-ui.ts, dock-ui.ts): a runner
// given these imports a "terminal" session from them and streams what is written to them later, as
// it does with ~/.claude/projects. Every write moves the transcript's lastModified to now.
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Transcripts } from "../../src/runner/sync";

export class MemoryTranscripts implements Transcripts {
  private readonly all = new Map<string, { info: SDKSessionInfo; messages: SessionMessage[] }>();

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
}

const entry = (type: SessionMessage["type"], message: unknown): SessionMessage =>
  ({ type, uuid: crypto.randomUUID(), session_id: "s", message, parent_tool_use_id: null, parent_agent_id: null }) as SessionMessage;
export const userEntry = (text: string) => entry("user", { role: "user", content: text });
export const assistantEntry = (text: string) => entry("assistant", { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" });
