// Starts sessions, continues them with replies, and runs their turns in the background: every
// output of the agent driver is stored (events) or passed on (deltas), and sent to the WebSocket clients.
import type { ApprovalDecision, Notification, ServerMessage, SessionMeta, SessionStatus, Workspace } from "../shared/protocol";
import type { AgentDriver, ApprovalAsk, NewEvent } from "./agent";
import { approvalBody, bodyOf, NO_TEXT, type Notifications } from "./notifications";
import type { Store } from "./store";

export const NO_RESULT = "the turn ended without a result";
/** The body of an `error` notification whose turn gave no message. */
export const FAILED = "The turn failed.";
export const BUSY = "a turn is running: wait for it to finish";
export const APPROVAL_OPEN = "an approval is open: answer it first";
export const NO_APPROVAL = "no such open approval";

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
  /** The open approvals, by approvalId. `settle` gives the waiting tool call its answer. */
  private readonly approvals = new Map<string, { sessionId: string; settle: (decision: ApprovalDecision) => void }>();

  constructor(
    private readonly store: Store,
    private readonly driver: AgentDriver,
    private readonly send: (message: ServerMessage) => void,
    /** Where the turns' notifications go (the shell's toasts). Without it none are recorded. */
    private readonly notifications?: Notifications,
  ) {}

  /** Records a notification for the shell, titled as the session is. */
  private notify(id: string, kind: Notification["kind"], body: string): void {
    this.notifications?.add({ kind, sessionId: id, title: this.store.get(id)?.title ?? "", body });
  }

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

  /**
   * The person's answer to an open approval: stores approval_resolved, lets the tool call go on, and
   * the session is running again once no approval of its is open. Null when the session has no open
   * approval with that id (unknown, or already answered).
   */
  answer(id: string, approvalId: string, decision: ApprovalDecision): SessionMeta | null {
    if (this.approvals.get(approvalId)?.sessionId !== id) return null;
    this.close(approvalId, decision);
    return this.store.get(id)!;
  }

  /** Ends an open approval: recorded (unless `quiet`: the runner is stopping), then the tool call gets its answer. */
  private close(approvalId: string, decision: ApprovalDecision, quiet = false): void {
    const open = this.approvals.get(approvalId);
    if (!open) return;
    this.approvals.delete(approvalId);
    if (!quiet) {
      const more = [...this.approvals.values()].some((a) => a.sessionId === open.sessionId);
      this.record(open.sessionId, { kind: "approval_resolved", approvalId, decision }, more ? undefined : "running");
    }
    open.settle(decision);
  }

  private async turn(id: string, prompt: string, signal: AbortSignal): Promise<void> {
    const session = this.store.get(id)!;
    /** This turn's open approvals. */
    const mine = new Set<string>();
    let ended = false;
    /** The turn's newest assistant text: the body of its notification when the result carries none. */
    let lastText = "";
    const approve = (ask: ApprovalAsk, callSignal?: AbortSignal): Promise<ApprovalDecision> => {
      // Nobody can be asked any more: the call is denied, never allowed.
      if (ended || signal.aborted || callSignal?.aborted) return Promise.resolve("deny");
      const approvalId = crypto.randomUUID();
      return new Promise((resolve) => {
        // The agent gave up on the call. While the runner stops, nothing more is recorded.
        const onAbort = () => this.close(approvalId, "deny", signal.aborted);
        this.approvals.set(approvalId, {
          sessionId: id,
          settle: (decision) => {
            callSignal?.removeEventListener("abort", onAbort);
            mine.delete(approvalId);
            resolve(decision);
          },
        });
        mine.add(approvalId);
        callSignal?.addEventListener("abort", onAbort, { once: true });
        const { toolUseId, toolName, input, reason } = ask;
        this.record(id, { kind: "approval_request", approvalId, ...(toolUseId ? { toolUseId } : {}), toolName, input, ...(reason ? { reason } : {}) }, "waiting_approval");
        this.notify(id, "needs_approval", approvalBody(toolName, input));
      });
    };
    /** The turn's last event. An approval still open then is denied first: its call will never run. */
    const end = (event: NewEvent, status: SessionStatus) => {
      ended = true;
      for (const approvalId of [...mine]) this.close(approvalId, "deny");
      this.record(id, event, status);
      if (event.kind === "result" && event.ok) this.notify(id, "finished", bodyOf(event.text || lastText) || NO_TEXT);
      else this.notify(id, "error", bodyOf(event.kind === "error" ? event.message : (event.kind === "result" && event.text) || lastText) || FAILED);
    };
    try {
      for await (const out of this.driver.run({ prompt, cwd: session.cwd, resume: session.claudeSessionId, signal, approve })) {
        // A turn cut off by the runner stopping stays "running" on disk, and the next start records it as failed.
        if (signal.aborted) return;
        if (out.type === "delta") {
          this.send({ type: "delta", sessionId: id, text: out.text });
        } else if (out.type === "session_id") {
          if (session.claudeSessionId !== out.id) this.send({ type: "session", session: this.store.update(id, { claudeSessionId: out.id }) });
        } else if (out.event.kind === "result") {
          end(out.event, out.event.ok ? "idle" : "error");
          return;
        } else if (out.event.kind === "error") {
          end(out.event, "error");
          return;
        } else {
          if (out.event.kind === "assistant_text") lastText = out.event.text;
          this.record(id, out.event);
        }
      }
      if (!signal.aborted) end({ kind: "error", message: NO_RESULT }, "error");
    } catch (e) {
      if (!signal.aborted) end({ kind: "error", message: (e as Error).message || String(e) }, "error");
    } finally {
      ended = true;
    }
  }

  /**
   * Ends every running turn without recording anything more. A tool call that waits for approval
   * is denied, so its agent isn't left waiting; the next start records the approval as denied.
   */
  async stop(): Promise<void> {
    const running = [...this.turns.values()];
    for (const t of running) t.abort.abort();
    for (const approvalId of [...this.approvals.keys()]) this.close(approvalId, "deny", true);
    await Promise.all(running.map((t) => t.done));
  }
}
