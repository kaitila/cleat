// The agent driver: what runs one turn of a session. Two implementations: Claude Code through the
// Agent SDK (agent-claude.ts) and a scripted fake for tests and CI (agent-fake.ts).
import type { ApprovalDecision, PermissionMode, SessionEvent } from "../shared/protocol";
import type { Config } from "./config";
import { claudeDriver } from "./agent-claude";
import { fakeDriver } from "./agent-fake";

/** A SessionEvent before the store gives it its seq and time. */
export type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

/** A tool call the person has to allow or deny. */
export interface ApprovalAsk {
  toolUseId?: string;
  toolName: string;
  input: unknown;
  /** Why the call needs approval, when the agent says. */
  reason?: string;
}

export interface TurnInput {
  prompt: string;
  /** The workspace folder. */
  cwd: string;
  /** Claude Code's session id to continue, or null for a new conversation. */
  resume: string | null;
  /** The session's title, given to a new conversation so the transcript (and `claude --resume`'s picker) shows it. */
  title?: string;
  /** The permission mode to ask Claude Code for (config `permissionMode`). It may run in another: see the `permission_mode` output. */
  permissionMode: PermissionMode;
  /** Aborted when the runner stops: the driver ends the turn without more output. */
  signal: AbortSignal;
  /**
   * Aborted when the person stops the turn (POST .../stop): the driver interrupts it and returns
   * soon after. What it yields after this is not stored; the runner records a `stopped` event.
   */
  interrupt?: AbortSignal;
  /**
   * Asks the person to allow or deny a tool call, and waits for the answer: it is shown in the chat
   * view and resolves from POST /api/sessions/:id/approvals/:approvalId. Nothing else allows a call.
   * It resolves as "deny" when `signal` (the agent's own, for this call) aborts, when the turn ends
   * and when the runner stops.
   */
  approve(ask: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export type AgentOutput =
  /** Claude Code's session id, sent as soon as it is known. */
  | { type: "session_id"; id: string }
  /** A piece of assistant text as it streams. Not stored. */
  | { type: "delta"; text: string }
  /** The permission mode Claude Code runs the turn in, as it reports it (at the start, and whenever it changes). */
  | { type: "permission_mode"; mode: string }
  | { type: "event"; event: NewEvent };

export interface AgentDriver {
  /**
   * Runs one turn. The turn ends with a `result` event or an `error` event, after which the driver
   * returns. A driver that throws, or returns without either, is recorded as an error.
   */
  run(input: TurnInput): AsyncIterable<AgentOutput>;
}

export function driverFor(config: Config): AgentDriver {
  return config.fakeAgent ? fakeDriver() : claudeDriver();
}
