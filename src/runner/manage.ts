// The person's operations on sessions (D0020): rename, archive, pin, fork and delete. Stop is the
// Sessions' own (sessions.ts interrupt), as it reaches into a running turn.
// Rename, fork and delete also act on Claude Code's transcript, through the SDK's session functions
// (renameSession, forkSession, deleteSession: read sdk.d.ts before changing them). Archive and pin
// are the runner's alone. A session from the terminal is never deleted here, only archived.
import type { ServerMessage, SessionMeta } from "../shared/protocol";
import { TERMINAL_NOT_DELETED } from "../shared/protocol";
import { fakeFork } from "./agent-fake";
import { BUSY, busy, titleOf, type Sessions } from "./sessions";
import type { Store } from "./store";
import { hasTranscript, type Sync } from "./sync";

/** What the runner does to Claude Code's transcripts for the person. A test passes its own. */
export interface TranscriptOps {
  /** Sets the transcript's custom title, which Claude Code's resume picker shows. */
  rename(sessionId: string, title: string, dir: string): Promise<void>;
  /** Removes the transcript. Throws when it can't (or it isn't there). */
  remove(sessionId: string, dir: string): Promise<void>;
  /** Copies the conversation into a new transcript with this title, and returns its session id. */
  fork(sessionId: string, dir: string, title: string): Promise<string>;
  /** Whether the transcript is there. */
  exists(sessionId: string, dir: string): Promise<boolean>;
}

/** The real transcripts, through the SDK. */
export function sdkOps(): TranscriptOps {
  const sdk = () => import("@anthropic-ai/claude-agent-sdk");
  return {
    async rename(sessionId, title, dir) {
      await (await sdk()).renameSession(sessionId, title, { dir });
    },
    async remove(sessionId, dir) {
      await (await sdk()).deleteSession(sessionId, { dir });
    },
    async fork(sessionId, dir, title) {
      return (await (await sdk()).forkSession(sessionId, { dir, title })).sessionId;
    },
    async exists(sessionId, dir) {
      return (await (await sdk()).getSessionInfo(sessionId, { dir })) !== undefined;
    },
  };
}

/** With the fake agent there are no transcripts: a fork is a new fake conversation that remembers the old one's prompts. */
export function fakeOps(): TranscriptOps {
  return {
    rename: async () => {},
    remove: async () => {},
    fork: async (sessionId) => fakeFork(sessionId),
    exists: async () => false,
  };
}

export const NOTHING_TO_FORK = "the session has no Claude Code conversation yet: nothing to fork";
/** The 409 for forking a Codex session: only Claude Code transcripts can be forked. */
export const CODEX_NOT_FORKED = "a Codex session can not be forked yet";
export const DELETING = "the session is being deleted";

/** A fork's title: the session's, cut so " (fork)" fits in a title's 80 characters. */
export function forkTitle(title: string): string {
  const suffix = " (fork)";
  return `${(title || "Untitled").slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
}

/** A refusal: the status and the error the route answers with. */
export interface Refused { status: number; error: string }

export class Manage {
  /** Sessions being deleted: a reply or a fork of one is refused meanwhile. */
  readonly deleting = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sessions: Sessions,
    private readonly sync: Sync,
    private readonly ops: TranscriptOps,
    private readonly send: (message: ServerMessage) => void,
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

  /**
   * Why a session can't be forked or deleted now: a turn runs, here or in a terminal (a session
   * shown running only because its transcript grows is "running" too). A turn whose result is in
   * but whose query still closes counts as over, as for a reply: `closed` waits for it.
   */
  private busy(id: string): string | null {
    if (this.deleting.has(id)) return DELETING;
    if (this.sync.isLive(id)) return BUSY;
    return busy(this.store.get(id)!);
  }

  /**
   * A new title, cut as any title. The transcript gets it too (its custom title), so Claude Code's
   * resume picker shows the same name; a transcript that can't be renamed is logged, and the
   * runner's title stands.
   */
  async rename(id: string, title: string): Promise<SessionMeta | Refused> {
    const cut = titleOf(title);
    if (!cut) return { status: 400, error: "title is empty" };
    const session = this.store.mark(id, { title: cut });
    this.send({ type: "session", session });
    const claudeId = hasTranscript(session) ? session.claudeSessionId : null;
    if (claudeId) {
      try {
        await this.sync.own(id, () => this.ops.rename(claudeId, cut, session.cwd));
      } catch (e) {
        this.log(`manage: renaming the transcript ${claudeId} failed: ${(e as Error).message}`);
      }
    }
    return this.store.get(id) ?? session;
  }

  /** Archived sessions leave the default lists and stay on disk, any session, from the terminal too. */
  archive(id: string, archived: boolean): SessionMeta {
    const session = this.store.mark(id, { archived });
    this.send({ type: "session", session });
    return session;
  }

  pin(id: string, pinned: boolean): SessionMeta {
    const session = this.store.mark(id, { pinned });
    this.send({ type: "session", session });
    return session;
  }

  /**
   * A new session of the runner's, from the conversation so far: the transcript is forked (a new
   * Claude Code session id), the events so far are copied, and it is idle until replied to.
   */
  async fork(id: string): Promise<SessionMeta | Refused> {
    const why = this.busy(id);
    if (why) return { status: 409, error: why };
    // A terminal session's history is read first, so the fork's copy has it, and the last turn has closed.
    await this.sessions.closed(id);
    await this.sync.load(id);
    const source = this.store.get(id);
    if (!source) return { status: 404, error: "no such session" };
    // A reply may have come in meanwhile.
    const now = this.busy(id);
    if (now) return { status: 409, error: now };
    if (!hasTranscript(source)) return { status: 409, error: CODEX_NOT_FORKED };
    if (!source.claudeSessionId) return { status: 409, error: NOTHING_TO_FORK };
    const title = forkTitle(source.title);
    // The new transcript isn't the runner's until its session exists: the sync waits for it.
    const release = this.sync.hold(source.workspace);
    let session: SessionMeta;
    try {
      const claudeSessionId = await this.ops.fork(source.claudeSessionId, source.cwd, title);
      const now = new Date().toISOString();
      session = this.store.create({
        id: crypto.randomUUID(),
        claudeSessionId,
        workspace: source.workspace,
        cwd: source.cwd,
        title,
        source: "holm",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
      });
      for (const { seq: _seq, ts, ...event } of this.store.events(id)) this.store.append(session.id, event, ts);
      this.store.update(session.id, { updatedAt: now });
    } finally {
      release();
    }
    await this.sync.adopt(session.id);
    const stored = this.store.get(session.id)!;
    this.send({ type: "session", session: stored });
    return stored;
  }

  /**
   * Deletes a session the runner started: its transcript first (deleteSession), then the runner's
   * record and events. Refused for a session from the terminal (it is only archived) and while a
   * turn runs. A transcript that won't go and is still there keeps the session as it was.
   */
  async remove(id: string): Promise<{ deleted: string } | Refused> {
    const session = this.store.get(id);
    if (!session) return { status: 404, error: "no such session" };
    if (session.source === "terminal") return { status: 409, error: TERMINAL_NOT_DELETED };
    const why = this.busy(id);
    if (why) return { status: 409, error: why };
    this.deleting.add(id);
    try {
      await this.sessions.closed(id);
      // A Codex thread stays in ~/.codex/sessions: only Claude Code transcripts are deleted here.
      const claudeId = hasTranscript(session) ? session.claudeSessionId : null;
      if (claudeId) {
        try {
          await this.ops.remove(claudeId, session.cwd);
        } catch (e) {
          // Gone already (never written, or removed by hand) is as good as removed.
          if (await this.ops.exists(claudeId, session.cwd).catch(() => true)) {
            return { status: 500, error: `the transcript could not be deleted: ${(e as Error).message}` };
          }
        }
      }
      this.sync.forget(id);
      this.store.remove(id);
      this.send({ type: "removed", sessionId: id });
      return { deleted: id };
    } finally {
      this.deleting.delete(id);
    }
  }
}
