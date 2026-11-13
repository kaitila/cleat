// The notifications the dock shows as peeks: the newest 200, in memory only, with a global seq that
// starts at 1 each time the runner starts (docs/protocol.md, "Notifications"). Each one is handed to
// `onAdd` as it is recorded (the server pushes it to the WebSocket clients) and kept for the polling route.
import type { Notification, NotificationsResponse } from "../shared/protocol";

export const KEEP_NOTIFICATIONS = 200;
export const BODY_MAX = 140;
/** The body of a `finished` notification whose turn said nothing. */
export const NO_TEXT = "Finished.";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A notification's body: one line, at most 140 characters. */
export function bodyOf(text: string): string {
  return oneLine(text).slice(0, BODY_MAX);
}

/**
 * A tool call in one line, as the chat view shows it: the command for Bash, the path for file
 * tools, otherwise the start of the input as JSON.
 */
export function toolSummary(toolName: string, input: unknown): string {
  const fields = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof fields.command === "string") return oneLine(fields.command);
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return value;
  }
  if (typeof input === "string") return oneLine(input);
  try {
    return oneLine(JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
}

/** The body of a `needs_approval` notification: the tool and its one-line summary. */
export function approvalBody(toolName: string, input: unknown): string {
  const summary = toolSummary(toolName, input);
  return bodyOf(summary ? `${toolName}: ${summary}` : toolName);
}

export class Notifications {
  private readonly kept: Notification[] = [];
  private seq = 0;

  constructor(private readonly onAdd?: (notification: Notification) => void) {}

  add(n: Omit<Notification, "seq" | "ts">): Notification {
    const stored: Notification = { seq: ++this.seq, ts: new Date().toISOString(), ...n };
    this.kept.push(stored);
    if (this.kept.length > KEEP_NOTIFICATIONS) this.kept.splice(0, this.kept.length - KEEP_NOTIFICATIONS);
    this.onAdd?.(stored);
    return stored;
  }

  /** The kept notifications with a higher seq, oldest first, and the newest seq given out (0 before the first). */
  after(seq: number): NotificationsResponse {
    return { notifications: this.kept.filter((n) => n.seq > seq), latest: this.seq };
  }
}
