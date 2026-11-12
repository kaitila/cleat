// Starts sessions and runs their turns in the background: every output of the agent driver is
// stored (events) or passed on (deltas), and sent to the WebSocket clients.
import type { ServerMessage, SessionMeta, SessionStatus, Workspace } from "../shared/protocol";
import type { AgentDriver, NewEvent } from "./agent";
import type { Store } from "./store";

export const NO_RESULT = "the turn ended without a result";

export function titleOf(prompt: string): string {
  return (prompt.trim().split("\n")[0] ?? "").trim().slice(0, 80);
}

export class Sessions {
  private readonly turns = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(
    private readonly store: Store,
    private readonly driver: AgentDriver,
    private readonly send: (message: ServerMessage) => void,
  ) {}

  /** Creates the session, stores the prompt as its first event and starts the turn in the background. */
  start(workspace: Workspace, prompt: string): SessionMeta {
    const now = new Date().toISOString();
    const session = this.store.create({
      id: crypto.randomUUID(),
      claudeSessionId: null,
      workspace: workspace.name,
      cwd: workspace.path,
      title: titleOf(prompt),
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    });
    this.store.lastWorkspace = workspace.name;
    this.record(session.id, { kind: "user", text: prompt });
    const abort = new AbortController();
    const done = this.turn(session.id, prompt, abort.signal).finally(() => this.turns.delete(session.id));
    this.turns.set(session.id, { abort, done });
    return session;
  }

  /** Stores an event and tells the clients: the event, then the session with its new lastSeq. */
  private record(id: string, event: NewEvent, status?: SessionStatus): void {
    const stored = this.store.append(id, event);
    this.send({ type: "event", sessionId: id, event: stored });
    this.send({ type: "session", session: status ? this.store.update(id, { status }) : this.store.get(id)! });
  }

  private async turn(id: string, prompt: string, signal: AbortSignal): Promise<void> {
    const session = this.store.get(id)!;
    try {
      for await (const out of this.driver.run({ prompt, cwd: session.cwd, resume: session.claudeSessionId, signal })) {
        // A turn cut off by the runner stopping stays "running" on disk, and the next start records it as failed.
        if (signal.aborted) return;
        if (out.type === "delta") {
          this.send({ type: "delta", sessionId: id, text: out.text });
        } else if (out.type === "session_id") {
          if (session.claudeSessionId !== out.id) this.send({ type: "session", session: this.store.update(id, { claudeSessionId: out.id }) });
        } else if (out.event.kind === "result") {
          this.record(id, out.event, out.event.ok ? "idle" : "error");
          return;
        } else if (out.event.kind === "error") {
          this.record(id, out.event, "error");
          return;
        } else {
          this.record(id, out.event);
        }
      }
      if (!signal.aborted) this.record(id, { kind: "error", message: NO_RESULT }, "error");
    } catch (e) {
      if (!signal.aborted) this.record(id, { kind: "error", message: (e as Error).message || String(e) }, "error");
    }
  }

  /** Ends every running turn without recording anything more. */
  async stop(): Promise<void> {
    const running = [...this.turns.values()];
    for (const t of running) t.abort.abort();
    await Promise.all(running.map((t) => t.done));
  }
}
