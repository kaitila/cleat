// The contract between the runner, the web pages and the Windows shell.
// docs/protocol.md describes it in prose. Change both together.

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";

/** running: a turn is in progress. waiting_approval: a tool call waits for Allow / Deny.
 *  idle: the turn finished, a reply continues it. error: the turn failed, a reply may retry. */
export type SessionStatus = "running" | "waiting_approval" | "idle" | "error";

/** The permission mode a session asks for (config `permissionMode`). Nothing else is ever passed to the SDK. */
export type PermissionMode = "auto" | "default";

export interface Workspace {
  name: string;
  /** Absolute WSL path, with ~ expanded. */
  path: string;
  /** False when the folder is missing: the UI shows it disabled. */
  exists: boolean;
}

/**
 * intuition: started by the runner. terminal: a Claude Code session the runner found in a workspace's
 * transcripts (started in a terminal, or anywhere else) and imported. See docs/protocol.md, "Terminal sessions".
 */
export type SessionSource = "intuition" | "terminal";

export interface SessionMeta {
  /** The runner's id for the session (a UUID). Stable across turns, and across restarts for imported ones. */
  id: string;
  /** Claude Code's session id, known after the first turn starts. Used to resume. */
  claudeSessionId: string | null;
  workspace: string;
  cwd: string;
  /** First line of the first prompt, cut to 80 characters. An imported session's: its custom title, else summary, else first prompt. */
  title: string;
  /** Where the session came from. The runner always sends it; a session stored before it existed reads as "intuition". */
  source?: SessionSource;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** seq of the session's newest stored event. */
  lastSeq: number;
  /**
   * The permission mode in effect, as Claude Code reports it at the start of each turn (and when it
   * changes): "auto", "default", or another of the SDK's modes. Absent until the first turn reports it.
   */
  permissionMode?: string;
}

interface EventBase {
  /** Per session, starts at 1, no gaps. */
  seq: number;
  /** ISO time. */
  ts: string;
}

export type SessionEvent = EventBase &
  (
    | { kind: "user"; text: string; imagePath?: string }
    | { kind: "assistant_text"; text: string }
    | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
    | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
    | { kind: "approval_request"; approvalId: string; toolUseId?: string; toolName: string; input: unknown; reason?: string }
    | { kind: "approval_resolved"; approvalId: string; decision: ApprovalDecision }
    | { kind: "result"; ok: boolean; text?: string; costUsd?: number; durationMs?: number }
    /** A call the auto-mode classifier (or a deny rule, or the mode) denied without asking the person. `input` is a one-line summary. */
    | { kind: "auto_denied"; toolUseId: string; toolName: string; input?: string; reason?: string }
    /** Once per session: it asked for `requested` but Claude Code runs it in `mode`, so calls come to the person. */
    | { kind: "permission_mode"; requested: PermissionMode; mode: string }
    | { kind: "error"; message: string }
  );

export type SessionEventKind = SessionEvent["kind"];
export type ApprovalDecision = "allow" | "deny";

/** What the runner sends on the WebSocket at /ws. Clients send nothing. */
export type ServerMessage =
  | { type: "hello"; sessions: SessionMeta[] }
  | { type: "session"; session: SessionMeta }
  | { type: "event"; sessionId: string; event: SessionEvent }
  /** A piece of assistant text as it streams. Not stored: the full text follows as an assistant_text event. */
  | { type: "delta"; sessionId: string; text: string }
  /** A notification as it is recorded. Not replayed on connect: GET /api/notifications has the kept ones. */
  | { type: "notification"; notification: Notification };

export interface Notification {
  /** Global, starts at 1 each time the runner starts. GET /api/notifications?after=<seq> returns the later ones. */
  seq: number;
  ts: string;
  kind: "finished" | "needs_approval" | "error";
  sessionId: string;
  title: string;
  body: string;
}

export interface ClipboardCapture {
  capturedAt: string;
  text?: string;
  /** WSL path (/mnt/c/...) of the saved image. */
  imagePath?: string;
}

// Request and response bodies.
/** build: a hash of the code the runner process loaded. `start` and `up` restart a runner whose build differs from the repo's. */
export interface HealthResponse { ok: true; version: string; build: string }
export interface WorkspacesResponse { workspaces: Workspace[]; lastUsed: string | null }
export interface SessionsResponse { sessions: SessionMeta[] }
export interface StartSessionRequest { workspace: string; prompt: string; imagePath?: string }
/** force: reply even when another process wrote to the transcript in the last two minutes (else 409, OPEN_IN_TERMINAL). */
export interface ReplyRequest { prompt: string; imagePath?: string; force?: boolean }
/** The 409 error for a reply to a session another process is writing to, without force. */
export const OPEN_IN_TERMINAL = "it looks open in a terminal: reply with force to continue it here anyway";
export interface SessionResponse { session: SessionMeta }
export interface EventsResponse { events: SessionEvent[] }
export interface ApprovalRequest { decision: ApprovalDecision }
/** imagePath may be a Windows path (C:\...) here; the runner stores the WSL path. */
export interface ClipboardPostRequest { text?: string; imagePath?: string }
export interface NotificationsResponse { notifications: Notification[]; latest: number }
export interface ErrorResponse { error: string }
