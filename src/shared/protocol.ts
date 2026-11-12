// The contract between the runner, the web pages and the Windows shell.
// docs/protocol.md describes it in prose. Change both together.

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";

/** running: a turn is in progress. waiting_approval: a tool call waits for Allow / Deny.
 *  idle: the turn finished, a reply continues it. error: the turn failed, a reply may retry. */
export type SessionStatus = "running" | "waiting_approval" | "idle" | "error";

export interface Workspace {
  name: string;
  /** Absolute WSL path, with ~ expanded. */
  path: string;
  /** False when the folder is missing: the UI shows it disabled. */
  exists: boolean;
}

export interface SessionMeta {
  /** The runner's id for the session (a UUID). Stable across turns. */
  id: string;
  /** Claude Code's session id, known after the first turn starts. Used to resume. */
  claudeSessionId: string | null;
  workspace: string;
  cwd: string;
  /** First line of the first prompt, cut to 80 characters. */
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** seq of the session's newest stored event. */
  lastSeq: number;
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
  | { type: "delta"; sessionId: string; text: string };

export interface Notification {
  /** Global, starts at 1. The shell polls with ?after=<seq>. */
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
export interface WorkspacesResponse { workspaces: Workspace[]; lastUsed: string | null }
export interface SessionsResponse { sessions: SessionMeta[] }
export interface StartSessionRequest { workspace: string; prompt: string; imagePath?: string }
export interface ReplyRequest { prompt: string; imagePath?: string }
export interface SessionResponse { session: SessionMeta }
export interface EventsResponse { events: SessionEvent[] }
export interface ApprovalRequest { decision: ApprovalDecision }
/** imagePath may be a Windows path (C:\...) here; the runner stores the WSL path. */
export interface ClipboardPostRequest { text?: string; imagePath?: string }
export interface NotificationsResponse { notifications: Notification[]; latest: number }
export interface ErrorResponse { error: string }
