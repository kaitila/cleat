// The transcript sync (D0015, and D0031 for Codex). Claude Code keeps every session as a transcript
// under ~/.claude/projects, and Codex every thread as a rollout file under ~/.codex/sessions
// (codex-sync.ts), the runner's and the terminal's alike. Every few seconds the runner lists each
// workspace's transcripts of both agents and:
//   - imports the ones it doesn't own as sessions with source "terminal" (their events are read on
//     first request: load());
//   - reads the new entries of any session's transcript that grew while the runner wasn't running its
//     turn (continued in a terminal, say), stores them as events and shows the session running until
//     a few seconds after its last assistant entry.
// It only reads transcripts. Nothing here writes under ~/.claude or ~/.codex: the runner's own turns go through
// the SDK's query, and the person's rename, fork and delete through manage.ts, which tells the sync
// (own, hold, adopt, forget) so none of them is taken for another process's write. The SDK changes often: read its sdk.d.ts before changing this.
import { join } from "node:path";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentKind, ServerMessage, SessionMeta, Workspace } from "../shared/protocol";
import type { NewEvent } from "./agent";
import { cut, resultText } from "./agent-claude";
import { codexThreads } from "./codex-sync";
import { titleOf, type Sessions, type TurnWatcher } from "./sessions";
import { readJson, writeJson, type Store } from "./store";

/** How often the workspaces' transcripts are listed. */
export const POLL_MS = 3000;
/** A session that grew goes back to idle this long after its last entry, when that entry is the assistant's. */
export const IDLE_MS = 5000;
/** ...and this long after its last entry whatever it is (a terminal closed in the middle of a turn). */
export const STALE_MS = 10 * 60_000;
/** A reply to a session another process wrote to more recently than this is refused without force. */
export const OPEN_MS = 2 * 60_000;
/** Writes this soon after the runner's own turn ended still count as the runner's. */
export const OWN_SLACK_MS = 5000;
/** Only transcripts written in the last 30 days are imported, at most 50 per workspace. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const MAX_PER_WORKSPACE = 50;
/** The title of an imported session whose transcript gives none. */
export const UNTITLED = "Terminal session";

/** Claude Code's transcripts, as the SDK gives them. A test passes its own. */
export interface Transcripts {
  /** The newest `limit` sessions of the project folder `dir`, newest first. */
  list(dir: string, limit: number): Promise<SDKSessionInfo[]>;
  info(sessionId: string, dir: string): Promise<SDKSessionInfo | undefined>;
  /** The conversation's user and assistant messages, oldest first. */
  messages(sessionId: string, dir: string): Promise<SessionMessage[]>;
}

/** The real transcripts, through the SDK's read-only session functions. */
export function sdkTranscripts(): Transcripts {
  const sdk = () => import("@anthropic-ai/claude-agent-sdk");
  return {
    async list(dir, limit) {
      // Not the git worktrees' sessions: they belong to other folders.
      return (await sdk()).listSessions({ dir, limit, includeWorktrees: false });
    },
    async info(sessionId, dir) {
      return (await sdk()).getSessionInfo(sessionId, { dir });
    },
    async messages(sessionId, dir) {
      return (await sdk()).getSessionMessages(sessionId, { dir });
    },
  };
}

/** No transcripts at all: the fake agent's runs (tests and CI) have none to read. */
export function noTranscripts(): Transcripts {
  return { list: async () => [], info: async () => undefined, messages: async () => [] };
}

/** One conversation as the sync sees it, whichever agent keeps it. */
export interface ThreadInfo {
  /** The agent's id for it: Claude Code's session id, Codex's thread id. */
  id: string;
  /** The folder it runs in; "" when the transcript doesn't say. */
  cwd: string;
  /** Its title, "" when it has none yet. */
  title: string;
  createdAt: number;
  /** When its file was last written, ms since the epoch. */
  lastModified: number;
}

/** One entry of a conversation: what it adds to the session's events. */
export interface Entry {
  /** Names the entry within its conversation, so the sync knows where it stopped reading. */
  key: string;
  events: NewEvent[];
  /** When it was written. */
  time?: string;
  /** The turn may be over after it (an assistant message, the end of a Codex turn): the session goes idle IDLE_MS after it. */
  idle: boolean;
}

/** An agent's conversations, read-only: what the sync reads, one per agent. */
export interface Threads {
  /** The newest `limit` conversations started in the folder `dir`, newest first. */
  list(dir: string, limit: number): Promise<ThreadInfo[]>;
  info(id: string, dir: string): Promise<ThreadInfo | undefined>;
  /** Its entries, oldest first. */
  entries(id: string, dir: string): Promise<Entry[]>;
}

/** No conversations: the fake agent's runs (tests and CI) have no Codex threads to read. */
export function noThreads(): Threads {
  return { list: async () => [], info: async () => undefined, entries: async () => [] };
}

function claudeInfo(info: SDKSessionInfo): ThreadInfo {
  return { id: info.sessionId, cwd: info.cwd ?? "", title: titleFrom(info), createdAt: info.createdAt ?? info.lastModified, lastModified: info.lastModified };
}

/** Claude Code's transcripts as the sync's Threads. */
export function claudeThreads(t: Transcripts): Threads {
  return {
    list: async (dir, limit) => (await t.list(dir, limit)).map(claudeInfo),
    info: async (id, dir) => {
      const info = await t.info(id, dir);
      return info && claudeInfo(info);
    },
    entries: async (id, dir) =>
      (await t.messages(id, dir)).map((m) => {
        const time = timeOf(m);
        return { key: m.uuid, events: eventsOf(m), idle: m.type === "assistant", ...(time ? { time } : {}) };
      }),
  };
}

/** The agents the sync reads, in the order it lists them. */
const AGENTS: AgentKind[] = ["claude", "codex"];

export function titleFrom(info: SDKSessionInfo): string {
  return titleOf(info.customTitle || info.summary || info.firstPrompt || "") || UNTITLED;
}

/** Text a transcript keeps for Claude Code itself, not something the person said. */
function hidden(text: string): boolean {
  return /^\s*<(local-command-caveat|system-reminder)>/.test(text);
}

/**
 * One transcript message as the events the runner keeps: the same kinds a turn of the runner's gives
 * (user, assistant_text, tool_use, tool_result), and a `result` after an assistant message that
 * ended its turn (stop_reason end_turn). A subagent's own messages are left out, as in a turn.
 */
export function eventsOf(message: SessionMessage): NewEvent[] {
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return [];
  const m = message.message as { content?: unknown; stop_reason?: unknown } | null;
  if (!m) return [];
  const blocks: { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }[] =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const out: NewEvent[] = [];
  if (message.type === "user") {
    const text = blocks
      .flatMap((b) => (b.type === "text" && typeof b.text === "string" && b.text.trim() && !hidden(b.text) ? [b.text] : []))
      .join("\n");
    if (text) out.push({ kind: "user", text });
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        out.push({ kind: "tool_result", toolUseId: b.tool_use_id, content: cut(resultText(b.content)), isError: b.is_error === true });
      }
    }
  } else if (message.type === "assistant") {
    let last = "";
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        last = b.text;
        out.push({ kind: "assistant_text", text: b.text });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        out.push({ kind: "tool_use", toolUseId: b.id, name: b.name, input: b.input });
      }
    }
    if (m.stop_reason === "end_turn") out.push({ kind: "result", ok: true, ...(last ? { text: last } : {}) });
  }
  return out;
}

/** The time a transcript message was written, when it says. */
function timeOf(message: SessionMessage): string | undefined {
  const ts = (message as { timestamp?: unknown }).timestamp;
  return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : undefined;
}

/** What the sync remembers of a session, kept in sync.json under the data folder. */
interface Tracked {
  /** Key of the newest transcript entry already stored as events (or seen), null before any. */
  cursor: string | null;
  /** False for an imported session whose transcript hasn't been read yet. */
  loaded: boolean;
  /** The transcript's lastModified when it was last read. */
  mtime: number;
  /** When the runner's own last turn of it ended (or started, while it runs). */
  ownWrite: number;
  /** A terminal session's title as its transcript last gave it: a new one there replaces the session's. */
  title?: string;
}

interface SyncFile {
  /** Every Claude Code session id and Codex thread id the runner knows, to the runner's session id: one id per session, kept across restarts. */
  ids: Record<string, string>;
  sessions: Record<string, Tracked>;
}

export interface SyncOptions {
  /** Claude Code's transcripts. */
  transcripts: Transcripts;
  /** Codex's threads (codexThreads(), $CODEX_HOME or ~/.codex). */
  codex: Threads;
  pollMs: number;
  idleMs: number;
  now: () => number;
}

/**
 * Whether the session's conversation is a Claude Code transcript, which rename, fork and delete act
 * on (manage.ts). A Codex thread in ~/.codex/sessions is synced too, but only read (docs/agents.md).
 */
export function hasTranscript(session: Pick<SessionMeta, "agent">): boolean {
  return agentOf(session) === "claude";
}

function agentOf(session: Pick<SessionMeta, "agent">): AgentKind {
  return session.agent ?? "claude";
}

export class Sync implements TurnWatcher {
  private readonly path: string;
  private readonly file: SyncFile;
  /** Per session, so a poll, a load and the end of a runner turn never read the same transcript at once. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Sessions shown running because their transcript grew: when it last did, and whether its last entry was the assistant's. */
  private readonly live = new Map<string, { at: number; assistant: boolean }>();
  /** Runner turns that ended and whose transcript the sync hasn't caught up with yet (turnEnded): nothing else reads them meanwhile. */
  private readonly ending = new Set<string>();
  /** Bumped when a runner turn starts: a read that began before it is dropped. */
  private readonly generation = new Map<string, number>();
  /** Workspaces (by name) where a fork is being written: a new transcript there is not imported meanwhile. */
  private readonly held = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private stopped = false;
  private readonly options: SyncOptions;
  private readonly threads: Record<AgentKind, Threads>;

  constructor(
    private readonly store: Store,
    private readonly sessions: Sessions,
    private readonly send: (message: ServerMessage) => void,
    private readonly workspaces: Workspace[],
    dataDir: string,
    options: Partial<SyncOptions> = {},
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {
    this.options = { pollMs: POLL_MS, idleMs: IDLE_MS, now: Date.now, ...options, transcripts: options.transcripts ?? sdkTranscripts(), codex: options.codex ?? codexThreads() };
    this.threads = { claude: claudeThreads(this.options.transcripts), codex: this.options.codex };
    this.path = join(dataDir, "sync.json");
    const file = readJson<Partial<SyncFile>>(this.path, {});
    this.file = { ids: file.ids ?? {}, sessions: file.sessions ?? {} };
  }

  private save(): void {
    writeJson(this.path, this.file);
  }

  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Lists the transcripts now and then every pollMs. */
  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs);
  }

  /** Stops polling. A session shown running only because its transcript grew is idle again, not failed at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling;
    await Promise.all([...this.locks.values()]);
    for (const id of [...this.live.keys()]) this.settle(id);
  }

  /** One round: every workspace's transcripts, then the sessions that stopped growing. Rounds never overlap. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        for (const workspace of this.workspaces) {
          for (const agent of AGENTS) {
            if (this.stopped) return;
            let infos: ThreadInfo[];
            try {
              infos = await this.threads[agent].list(workspace.path, MAX_PER_WORKSPACE);
            } catch (e) {
              this.log(`sync: listing ${workspace.path} (${agent}) failed: ${(e as Error).message}`);
              continue;
            }
            const since = this.options.now() - MAX_AGE_MS;
            for (const info of infos.filter((i) => i.lastModified >= since).slice(0, MAX_PER_WORKSPACE)) {
              if (this.stopped) return;
              try {
                await this.see(workspace, agent, info);
              } catch (e) {
                this.log(`sync: reading ${info.id} failed: ${(e as Error).message}`);
              }
            }
          }
        }
        const now = this.options.now();
        for (const [id, l] of [...this.live]) {
          if (this.sessions.isRunning(id)) this.live.delete(id);
          else if (now - l.at >= STALE_MS || (l.assistant && now - l.at >= this.options.idleMs)) this.settle(id);
        }
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  /** Records every agent id (Claude Code's, Codex's) the runner's sessions have, so none is ever imported as a terminal session. */
  private link(): void {
    let changed = false;
    for (const s of this.store.list()) {
      if (s.claudeSessionId && this.file.ids[s.claudeSessionId] === undefined) {
        this.file.ids[s.claudeSessionId] = s.id;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** One transcript of a workspace: imported when it is new, read when it grew. */
  private async see(workspace: Workspace, agent: AgentKind, info: ThreadInfo): Promise<void> {
    this.link();
    const id = this.file.ids[info.id];
    if (id === undefined) {
      // A session the runner just started may not have reported its Claude Code id yet, or a fork is
      // being written: wait a round.
      if (this.held.has(workspace.name)) return;
      if (this.store.list().some((s) => s.workspace === workspace.name && s.claudeSessionId === null && this.sessions.isRunning(s.id))) return;
      this.import(workspace, agent, info);
      return;
    }
    const session = this.store.get(id);
    if (!session) return;
    const tracked = this.file.sessions[id];
    if (session.source === "terminal" && tracked) {
      // Only a title the transcript changed replaces the session's: a Codex session renamed in the
      // runner keeps its name (its thread isn't renamed), and so does a Claude Code one whose
      // transcript couldn't be.
      const title = info.title || UNTITLED;
      if (title !== tracked.title) {
        tracked.title = title;
        this.save();
        if (title !== session.title) this.send({ type: "session", session: this.store.update(id, { title, updatedAt: session.updatedAt }) });
      }
    }
    await this.lock(id, () => this.grow(id, info.lastModified));
  }

  private import(workspace: Workspace, agent: AgentKind, info: ThreadInfo): void {
    const id = crypto.randomUUID();
    const modified = new Date(info.lastModified).toISOString();
    const title = info.title || UNTITLED;
    const session: SessionMeta = {
      id,
      claudeSessionId: info.id,
      ...(agent === "claude" ? {} : { agent }),
      workspace: workspace.name,
      cwd: info.cwd || workspace.path,
      title,
      source: "terminal",
      status: "idle",
      createdAt: info.createdAt ? new Date(info.createdAt).toISOString() : modified,
      updatedAt: modified,
      lastSeq: 0,
    };
    this.file.ids[info.id] = id;
    this.file.sessions[id] = { cursor: null, loaded: false, mtime: info.lastModified, ownWrite: 0, title };
    this.store.create(session);
    this.save();
    this.send({ type: "session", session });
  }

  /**
   * Stores the entries after the cursor as events. Returns the entries stored, or null when a runner
   * turn started meanwhile. `live`: they were written just now, so the session is running first.
   */
  private async readNew(id: string, tracked: Tracked, live = false): Promise<Entry[] | null> {
    const session = this.store.get(id)!;
    const gen = this.generation.get(id) ?? 0;
    const entries = await this.threadsOf(session).entries(session.claudeSessionId!, session.cwd);
    if (this.ours(id) || (this.generation.get(id) ?? 0) !== gen) return null;
    const at = tracked.cursor === null ? -1 : entries.findIndex((m) => m.key === tracked.cursor);
    // A cursor that is gone (the transcript was compacted or rewritten): nothing can be told new, start over from its end.
    const fresh = tracked.cursor !== null && at === -1 ? [] : entries.slice(at + 1);
    if (live && fresh.length) this.grew(id, fresh.at(-1)!.idle);
    for (const entry of fresh) {
      for (const event of entry.events) this.sessions.record(id, event, undefined, entry.time);
    }
    if (entries.length) tracked.cursor = entries.at(-1)!.key;
    tracked.loaded = true;
    return fresh;
  }

  /** A transcript seen with this lastModified: when it grew and the runner isn't running the turn, its new entries become events. */
  private async grow(id: string, mtime: number): Promise<void> {
    if (this.ours(id) || this.stopped) return;
    const session = this.store.get(id);
    if (!session?.claudeSessionId) return;
    const tracked = this.file.sessions[id];
    if (!tracked) {
      // One of the runner's sessions from before the sync (of Codex's: from before D0031): what it has is what it is now.
      const entries = await this.threadsOf(session).entries(session.claudeSessionId, session.cwd);
      this.file.sessions[id] = { cursor: entries.at(-1)?.key ?? null, loaded: true, mtime, ownWrite: 0 };
      this.save();
      return;
    }
    if (mtime <= tracked.mtime) return;
    const fresh = await this.readNew(id, tracked, true);
    if (fresh === null) return;
    tracked.mtime = mtime;
    this.save();
  }

  /** The reader of the session's agent's conversations. */
  private threadsOf(session: Pick<SessionMeta, "agent">): Threads {
    return this.threads[agentOf(session)];
  }

  /** True while what the transcript gets is the runner's own turn's. */
  private ours(id: string): boolean {
    return this.sessions.isRunning(id) || this.ending.has(id);
  }

  /** The transcript grew: the session is running until it stops. `idle`: its last entry may end the turn. */
  private grew(id: string, idle: boolean): void {
    this.live.set(id, { at: this.options.now(), assistant: idle });
    const session = this.store.get(id)!;
    if (session.status !== "running" || !session.terminalTurn) {
      this.send({ type: "session", session: this.store.update(id, { status: "running", terminalTurn: true }) });
    }
  }

  private settle(id: string): void {
    this.live.delete(id);
    const session = this.store.get(id);
    if (session?.status === "running" && !this.sessions.isRunning(id)) this.send({ type: "session", session: this.store.update(id, { status: "idle" }) });
  }

  /** True while the session shows running only because its transcript grows (no runner turn). */
  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * An imported session's history, read from its transcript the first time it is asked for. A no-op
   * for one already read and for the runner's own sessions.
   */
  load(id: string): Promise<void> {
    const tracked = this.file.sessions[id];
    if (!tracked || tracked.loaded) return Promise.resolve();
    return this.lock(id, async () => {
      const session = this.store.get(id);
      if (tracked.loaded || !session?.claudeSessionId) return;
      try {
        const info = await this.threadsOf(session).info(session.claudeSessionId, session.cwd);
        if ((await this.readNew(id, tracked)) === null) return;
        if (info) tracked.mtime = Math.max(tracked.mtime, info.lastModified);
        this.save();
      } catch (e) {
        // Left unread: the next request tries again.
        this.log(`sync: reading ${session.claudeSessionId} failed: ${(e as Error).message}`);
      }
    });
  }

  /**
   * Before a reply: the session's history and anything written since the last round are stored, so
   * the reply follows them. Then whether another process wrote to the transcript in the last
   * OPEN_MS (not counting the runner's own turn).
   */
  async beforeReply(id: string): Promise<{ openElsewhere: boolean }> {
    await this.load(id);
    const session = this.store.get(id);
    if (!session?.claudeSessionId) return { openElsewhere: false };
    let info: ThreadInfo | undefined;
    try {
      info = await this.threadsOf(session).info(session.claudeSessionId, session.cwd);
      if (info) await this.lock(id, () => this.grow(id, info!.lastModified));
    } catch (e) {
      // The transcript can't be read: the reply resumes it all the same, as before the sync.
      this.log(`sync: reading ${session.claudeSessionId} before a reply failed: ${(e as Error).message}`);
    }
    if (!info) return { openElsewhere: false };
    // The runner's own turn is still closing (its result is in, the query shuts down) or its end is
    // being caught up with: the newest writes are its own.
    if (this.ours(id)) return { openElsewhere: false };
    const ownWrite = this.file.sessions[id]?.ownWrite ?? 0;
    const now = this.options.now();
    return { openElsewhere: now - info.lastModified < OPEN_MS && info.lastModified > ownWrite + OWN_SLACK_MS };
  }

  /**
   * The runner writes to a session's transcript itself (a rename): the write counts as its own, so
   * it neither shows the session running nor makes a reply look open in a terminal.
   */
  own<T>(id: string, write: () => Promise<T>): Promise<T> {
    return this.lock(id, async () => {
      try {
        return await write();
      } finally {
        const tracked = this.file.sessions[id];
        const session = this.store.get(id);
        if (tracked && session?.claudeSessionId) {
          tracked.ownWrite = this.options.now();
          this.save();
        }
      }
    });
  }

  /** While a fork is written in this workspace, no new transcript there is imported. Returns the release. */
  hold(workspace: string): () => void {
    this.held.set(workspace, (this.held.get(workspace) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.held.get(workspace) ?? 1) - 1;
      if (n > 0) this.held.set(workspace, n);
      else this.held.delete(workspace);
    };
  }

  /**
   * A session the runner made from a transcript it wrote (a fork): its id is linked and the cursor
   * put at the transcript's end, so nothing of it is stored twice, and the write counts as its own.
   */
  adopt(id: string): Promise<void> {
    this.link();
    return this.lock(id, async () => {
      const session = this.store.get(id);
      if (!session?.claudeSessionId) return;
      const tracked: Tracked = { cursor: null, loaded: true, mtime: 0, ownWrite: this.options.now() };
      try {
        const threads = this.threadsOf(session);
        const [entries, info] = await Promise.all([threads.entries(session.claudeSessionId, session.cwd), threads.info(session.claudeSessionId, session.cwd)]);
        tracked.cursor = entries.at(-1)?.key ?? null;
        tracked.mtime = info?.lastModified ?? 0;
      } catch (e) {
        this.log(`sync: reading the fork ${session.claudeSessionId} failed: ${(e as Error).message}`);
      }
      tracked.ownWrite = this.options.now();
      this.file.sessions[id] = tracked;
      this.save();
    });
  }

  /**
   * A deleted session: what the sync kept of it goes. Its agent ids stay linked to the gone id, so a
   * transcript left behind (a Codex thread always is) is never imported as a new session.
   */
  forget(id: string): void {
    this.live.delete(id);
    delete this.file.sessions[id];
    this.save();
  }

  turnStarted(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.live.delete(id);
    const tracked = this.file.sessions[id];
    if (tracked) tracked.ownWrite = this.options.now();
    else this.file.sessions[id] = { cursor: null, loaded: true, mtime: 0, ownWrite: this.options.now() };
    this.save();
  }

  /**
   * A runner turn ended: what it wrote is already stored as its events, so the cursor moves to the
   * transcript's end without storing anything. Queued at once, before any later round can read it.
   */
  turnEnded(id: string): void {
    this.ending.add(id);
    void this.lock(id, async () => {
      this.link();
      const session = this.store.get(id);
      const tracked = this.file.sessions[id];
      if (!session?.claudeSessionId || !tracked) return;
      // A turn that wrote nothing readable still leaves the cursor where it was, so nothing is stored twice.
      try {
        const threads = this.threadsOf(session);
        const [entries, info] = await Promise.all([threads.entries(session.claudeSessionId, session.cwd), threads.info(session.claudeSessionId, session.cwd)]);
        if (entries.length) tracked.cursor = entries.at(-1)!.key;
        if (info) tracked.mtime = Math.max(tracked.mtime, info.lastModified);
      } catch (e) {
        this.log(`sync: reading ${session.claudeSessionId} after its turn failed: ${(e as Error).message}`);
      }
      tracked.ownWrite = this.options.now();
      this.save();
    }).finally(() => this.ending.delete(id));
  }
}
