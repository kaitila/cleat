// What the runner keeps on disk, under the data folder:
//   sessions.json      every session's metadata, oldest first
//   events/<id>.jsonl  one session's events, one JSON object per line, seq 1, 2, 3 with no gaps
//   state.json         the last workspace used
// Writes are synchronous, so two events can never get the same seq.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, SessionMeta } from "../shared/protocol";
import type { NewEvent } from "./agent";

export const RESTARTED = "the runner restarted";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Writes through a temporary file, so a crash never leaves half a file. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export class Store {
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly sessionsPath: string;
  private readonly statePath: string;
  private readonly eventsDir: string;
  private state: { lastWorkspace: string | null };

  constructor(dataDir: string) {
    this.sessionsPath = join(dataDir, "sessions.json");
    this.statePath = join(dataDir, "state.json");
    this.eventsDir = join(dataDir, "events");
    mkdirSync(this.eventsDir, { recursive: true });
    for (const s of readJson<SessionMeta[]>(this.sessionsPath, [])) this.sessions.set(s.id, s);
    this.state = { lastWorkspace: readJson<{ lastWorkspace?: string | null }>(this.statePath, {}).lastWorkspace ?? null };
    this.recover();
  }

  /**
   * A turn that was running when the runner stopped can't continue: it is recorded as failed.
   * An approval it left open can't be answered any more: it is recorded as denied.
   */
  private recover(): void {
    for (const s of this.sessions.values()) {
      if (s.status !== "running" && s.status !== "waiting_approval") continue;
      // The runner may have stopped between storing an event and storing the metadata.
      const events = this.events(s.id);
      s.lastSeq = events.at(-1)?.seq ?? 0;
      const open = new Set<string>();
      for (const e of events) {
        if (e.kind === "approval_request") open.add(e.approvalId);
        else if (e.kind === "approval_resolved") open.delete(e.approvalId);
      }
      for (const approvalId of open) this.append(s.id, { kind: "approval_resolved", approvalId, decision: "deny" });
      this.append(s.id, { kind: "error", message: RESTARTED });
      this.update(s.id, { status: "error" });
    }
  }

  private save(): void {
    writeJson(this.sessionsPath, [...this.sessions.values()]);
  }

  /** Newest first. */
  list(): SessionMeta[] {
    return [...this.sessions.values()].reverse();
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  create(session: SessionMeta): SessionMeta {
    this.sessions.set(session.id, session);
    this.save();
    return session;
  }

  update(id: string, patch: Partial<Pick<SessionMeta, "status" | "claudeSessionId" | "title">>): SessionMeta {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`no session ${id}`);
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return session;
  }

  /** Stores an event with the session's next seq. */
  append(id: string, event: NewEvent): SessionEvent {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`no session ${id}`);
    const ts = new Date().toISOString();
    const stored = { seq: session.lastSeq + 1, ts, ...event } as SessionEvent;
    appendFileSync(join(this.eventsDir, `${id}.jsonl`), JSON.stringify(stored) + "\n");
    session.lastSeq = stored.seq;
    session.updatedAt = ts;
    this.save();
    return stored;
  }

  /** Stored events with a seq higher than `after`. */
  events(id: string, after = 0): SessionEvent[] {
    const path = join(this.eventsDir, `${id}.jsonl`);
    if (!existsSync(path)) return [];
    const events: SessionEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as SessionEvent;
      if (event.seq > after) events.push(event);
    }
    return events;
  }

  get lastWorkspace(): string | null {
    return this.state.lastWorkspace;
  }

  set lastWorkspace(name: string | null) {
    this.state = { lastWorkspace: name };
    writeJson(this.statePath, this.state);
  }
}
