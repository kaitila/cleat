// Starts sessions, continues them with replies, and runs their turns in the background: every
// output of the agent driver is stored (events) or passed on (deltas), and sent to the WebSocket clients.
import type { ServerMessage, SessionMeta, SessionStatus, Workspace } from "../shared/protocol";
import type { AgentDriver, NewEvent } from "./agent";
import type { Store } from "./store";

export const NO_RESULT = "the turn ended without a result";
export const BUSY = "a turn is running: wait for it to finish";
export const APPROVAL_OPEN = "an approval is open: answer it first";

/** Why a session can't take a reply now, or null. Only an idle or failed session can. */
export function busy(session: SessionMeta): string | null {
  if (session.status === "running") return BUSY;
  if (session.status === "waiting_approval") return APPROVAL_OPEN;
  return null;
}

export function titleOf(prompt: string): string {
  return (prompt.trim().split("\n")[0] ?? "").trim().slice(0, 80);
}

/** The prompt Claude sees: the task, then the attached image's path for it to read. */
export function promptWithImage(prompt: string, imagePath?: string): string {
  return imagePath ? `${prompt}\n\nAttached image (read this file): ${imagePath}` : prompt;
}

export class Sessions {
  private readonly turns = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(
    private readonly store: Store,
    private readonly driver: AgentDriver,
    private readonly send: (message: ServerMessage) => void,
  ) {}

  /** Creates the session, stores the prompt as its first event and starts the turn in the background. */
  start(workspace: Workspace, prompt: string, imagePath?: string): SessionMeta {
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
    this.begin(session.id, prompt, imagePath);
    return session;
  }

  /**
   * Continues a session that is idle or in error (the caller checks with busy()): stores the reply
   * as a user event, sets the session running and starts a turn in the background. The turn resumes
   * Claude Code's conversation when the session has a claudeSessionId, also after a restart of the
   * runner, since that id is on disk. A session that failed before Claude Code reported an id has
   * no conversation to resume: its turn starts a new one in the same workspace.
   */
  reply(id: string, prompt: string, imagePath?: string): SessionMeta {
    this.begin(id, prompt, imagePath);
    return this.store.get(id)!;
  }

  /**
   * Stores the prompt as a user event, with the session running, and starts its turn. The event
   * keeps the text and the image's path apart; the agent gets them as one prompt.
   */
  private begin(id: string, text: string, imagePath?: string): void {
    this.record(id, { kind: "user", text, ...(imagePath ? { imagePath } : {}) }, "running");
    const prompt = promptWithImage(text, imagePath);
    const abort = new AbortController();
    const entry = {
      abort,
      // A turn's last event sets the status before this runs, so a quick reply may already have
      // put the next turn in the map: only the turn's own entry is removed.
      done: this.turn(id, prompt, abort.signal).finally(() => {
        if (this.turns.get(id) === entry) this.turns.delete(id);
      }),
    };
    this.turns.set(id, entry);
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
