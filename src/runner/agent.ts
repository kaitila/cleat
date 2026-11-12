// The agent driver: what runs one turn of a session. Two implementations: Claude Code through the
// Agent SDK (agent-claude.ts) and a scripted fake for tests and CI (agent-fake.ts).
import type { SessionEvent } from "../shared/protocol";
import type { Config } from "./config";
import { claudeDriver } from "./agent-claude";
import { fakeDriver } from "./agent-fake";

/** A SessionEvent before the store gives it its seq and time. */
export type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

export interface TurnInput {
  prompt: string;
  /** The workspace folder. */
  cwd: string;
  /** Claude Code's session id to continue, or null for a new conversation. */
  resume: string | null;
  /** Aborted when the runner stops: the driver ends the turn without more output. */
  signal: AbortSignal;
}

export type AgentOutput =
  /** Claude Code's session id, sent as soon as it is known. */
  | { type: "session_id"; id: string }
  /** A piece of assistant text as it streams. Not stored. */
  | { type: "delta"; text: string }
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
