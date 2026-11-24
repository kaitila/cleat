// Starts sessions, continues them with replies, and runs their turns in the background: every
// output of the agent driver is stored (events) or passed on (deltas), and sent to the WebSocket clients.
import type { AgentKind, ApprovalDecision, Notification, QuestionAnswers, PermissionMode, ServerMessage, SessionMeta, SessionStatus, Workspace } from "../shared/protocol";
import type { AgentDriver, ApprovalAsk, NewEvent } from "./agent";
import { approvalBody, bodyOf, NO_TEXT, type Notifications } from "./notifications";
import { answersRefusal, cleanAnswers, questionTexts } from "./questions";
import { DEFAULT_AGENT, DEFAULT_PERMISSION_MODE } from "./config";
import type { Store } from "./store";

export const NO_RESULT = "the turn ended without a result";
/** The body of an `error` notification whose turn gave no message. */
export const FAILED = "The turn failed.";
export const BUSY = "a turn is running: wait for it to finish";
export const APPROVAL_OPEN = "an approval is open: answer it first";
export const NO_APPROVAL = "no such open approval";
/** How long POST .../stop waits for the interrupted turn to end before it answers. */
export const STOP_WAIT_MS = 10_000;

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

/** Told when a runner turn starts and ends, while the turn is still counted as running (the transcript sync, sync.ts). */
export interface TurnWatcher {
  turnStarted(id: string): void;
  turnEnded(id: string): void;
}

export class Sessions {
  /** Set by the server once the sync exists. */
  watcher: TurnWatcher | null = null;
  private readonly turns = new Map<string, { abort: AbortController; interrupt: AbortController; done: Promise<void> }>();
  /** The open approvals, by approvalId: the call asked about, and `settle`, which gives it its answer. */
  private readonly approvals = new Map<string, { sessionId: string; toolName: string; input: unknown; settle: (decision: ApprovalDecision, answers?: QuestionAnswers) => void }>();

  constructor(
    private readonly store: Store,
    private readonly driver: AgentDriver,
    private readonly send: (message: ServerMessage) => void,
    /** Where the turns' notifications go (the dock's peeks). Without it none are recorded. */
    private readonly notifications?: Notifications,
    /** The permission mode a session in this workspace asks for (config.ts permissionModeFor). Read at the start of every turn. */
    private readonly modeFor: (workspace: string) => PermissionMode = () => DEFAULT_PERMISSION_MODE,
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  /** Records a notification, titled as the session is. */
  private notify(id: string, kind: Notification["kind"], body: string): void {
    this.notifications?.add({ kind, sessionId: id, title: this.store.get(id)?.title ?? "", body });
  }

  /**
   * Creates the session on `agent`, stores the prompt as its first event and starts the turn in the
   * background. The agent is the session's for good: every reply goes to it.
   */
  start(workspace: Workspace, prompt: string, imagePath?: string, agent: AgentKind = DEFAULT_AGENT): SessionMeta {
    const now = new Date().toISOString();
    const session = this.store.create({
      id: crypto.randomUUID(),
      claudeSessionId: null,
      workspace: workspace.name,
      cwd: workspace.path,
      title: titleOf(prompt),
      source: "cleat",
      agent,
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
    const interrupt = new AbortController();
    const entry = {
      abort,
      interrupt,
      // A turn's last event sets the status before this runs, so a quick reply may already have
      // put the next turn in the map: only the turn's own entry is removed.
      done: this.turn(id, prompt, abort.signal, interrupt.signal).finally(() => {
        if (this.turns.get(id) === entry) this.turns.delete(id);
      }),
    };
    this.turns.set(id, entry);
    this.watcher?.turnStarted(id);
  }

  /**
   * Waits (at most `ms`) for a turn that has already ended, idle or failed, to finish closing: the
   * SDK's query still shuts Claude Code down after the result. Then nothing writes to the transcript.
   */
  async closed(id: string, ms = 5000): Promise<void> {
    const entry = this.turns.get(id);
    if (!entry) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.done, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  /** True while the runner runs a turn of this session. */
  isRunning(id: string): boolean {
    return this.turns.has(id);
  }

  /**
   * The person stops the session's turn: its open approvals are denied, the driver is interrupted,
   * and once the turn has ended the session is idle with a `stopped` event. Resolves with the
   * session when the turn has ended (or after STOP_WAIT_MS), null when the runner runs no turn of it.
   */
  async interrupt(id: string, waitMs = STOP_WAIT_MS): Promise<SessionMeta | null> {
    const entry = this.turns.get(id);
    if (!entry) return null;
    if (!entry.interrupt.signal.aborted) {
      entry.interrupt.abort();
      for (const [approvalId, open] of [...this.approvals]) if (open.sessionId === id) this.close(approvalId, "deny");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.done, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
    return this.store.get(id) ?? null;
  }

  /** Stores an event and tells the clients: the event, then the session with its new lastSeq. `ts` is the event's time (now by default). */
  record(id: string, event: NewEvent, status?: SessionStatus, ts?: string): void {
    const stored = this.store.append(id, event, ts);
    this.send({ type: "event", sessionId: id, event: stored });
    this.send({ type: "session", session: status ? this.store.update(id, { status }) : this.store.get(id)! });
  }

  /**
   * The person's answer to an open approval: stores approval_resolved, lets the tool call go on, and
   * the session is running again once no approval of its is open. Null when the session has no open
   * approval with that id (unknown, or already answered); `{ refused }` when the answers don't fit
   * the call (questions.ts): an AskUserQuestion is allowed only with an answer to each question.
   */
  answer(id: string, approvalId: string, decision: ApprovalDecision, answers?: unknown): SessionMeta | null | { refused: string } {
    const open = this.approvals.get(approvalId);
    if (open?.sessionId !== id) return null;
    const refused = answersRefusal(open.toolName, open.input, decision, answers);
    if (refused) return { refused };
    const texts = questionTexts(open.toolName, open.input);
    this.close(approvalId, decision, false, texts && answers ? cleanAnswers(texts, answers as QuestionAnswers) : undefined);
    return this.store.get(id)!;
  }

  /** Ends an open approval: recorded (unless `quiet`: the runner is stopping), then the tool call gets its answer. */
  private close(approvalId: string, decision: ApprovalDecision, quiet = false, answers?: QuestionAnswers): void {
    const open = this.approvals.get(approvalId);
    if (!open) return;
    this.approvals.delete(approvalId);
    if (!quiet) {
      const more = [...this.approvals.values()].some((a) => a.sessionId === open.sessionId);
      this.record(open.sessionId, { kind: "approval_resolved", approvalId, decision, ...(answers ? { answers } : {}) }, more ? undefined : "running");
    }
    open.settle(decision, answers);
  }

  /**
   * The mode Claude Code reports for the turn: stored on the session, and logged when it changes.
   * A session that asked for auto and runs in another mode gets one `permission_mode` event, the
   * first time, so the person knows why calls come to them.
   */
  private modeInEffect(id: string, requested: PermissionMode, mode: string): void {
    const before = this.store.get(id)!.permissionMode;
    if (before !== mode) {
      this.log(`session ${id}: asked for permissionMode ${requested}, runs in ${mode}`);
      this.send({ type: "session", session: this.store.update(id, { permissionMode: mode }) });
    }
    if (requested === "auto" && mode !== "auto" && !this.store.events(id).some((e) => e.kind === "permission_mode")) {
      this.record(id, { kind: "permission_mode", requested, mode });
    }
  }

  private async turn(id: string, prompt: string, signal: AbortSignal, interrupt: AbortSignal): Promise<void> {
    const session = this.store.get(id)!;
    const permissionMode = this.modeFor(session.workspace);
    /** This turn's open approvals. */
    const mine = new Set<string>();
    let ended = false;
    /** The turn's newest assistant text: the body of its notification when the result carries none. */
    let lastText = "";
    const approve = (ask: ApprovalAsk, callSignal?: AbortSignal): Promise<ApprovalDecision> => {
      // Nobody can be asked any more: the call is denied, never allowed.
      if (ended || signal.aborted || interrupt.aborted || callSignal?.aborted) return Promise.resolve("deny");
      const approvalId = crypto.randomUUID();
      return new Promise((resolve) => {
        // The agent gave up on the call. While the runner stops, nothing more is recorded.
        const onAbort = () => this.close(approvalId, "deny", signal.aborted);
        this.approvals.set(approvalId, {
          sessionId: id,
          toolName: ask.toolName,
          input: ask.input,
          settle: (decision, answers) => {
            callSignal?.removeEventListener("abort", onAbort);
            mine.delete(approvalId);
            if (answers) ask.answered?.(answers);
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
    /** The end of a turn the person stopped: whatever the driver said last, the session is idle. No notification: they know. */
    const stopped = () => {
      ended = true;
      for (const approvalId of [...mine]) this.close(approvalId, "deny");
      this.record(id, { kind: "stopped" }, "idle");
    };
    try {
      for await (const out of this.driver.run({ agent: session.agent ?? DEFAULT_AGENT, prompt, cwd: session.cwd, resume: session.claudeSessionId, title: session.title, permissionMode, signal, interrupt, approve })) {
        // A turn cut off by the runner stopping stays "running" on disk, and the next start records it as failed.
        if (signal.aborted) return;
        // Stopped: only the conversation's id is still worth keeping; the rest (an aborted result) is not stored.
        if (interrupt.aborted && out.type !== "session_id") continue;
        if (out.type === "delta") {
          this.send({ type: "delta", sessionId: id, text: out.text });
        } else if (out.type === "permission_mode") {
          this.modeInEffect(id, permissionMode, out.mode);
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
      if (signal.aborted) return;
      if (interrupt.aborted) stopped();
      else end({ kind: "error", message: NO_RESULT }, "error");
    } catch (e) {
      if (signal.aborted) return;
      if (interrupt.aborted) stopped();
      else end({ kind: "error", message: (e as Error).message || String(e) }, "error");
    } finally {
      ended = true;
      // Still in `turns` here, so the sync can't take the turn's own transcript entries for another process's.
      if (!signal.aborted) this.watcher?.turnEnded(id);
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
