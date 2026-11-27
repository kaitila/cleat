// The contract between the runner, the web pages and the Windows shell.
// docs/protocol.md describes it in prose. Change both together.

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";

/** running: a turn is in progress. waiting_approval: a tool call waits for Allow / Deny.
 *  idle: the turn finished, a reply continues it. error: the turn failed, a reply may retry. */
export type SessionStatus = "running" | "waiting_approval" | "idle" | "error";

/** The permission mode a session asks for (config `permissionMode`). Nothing else is ever passed to the SDK. */
export type PermissionMode = "auto" | "default";

/**
 * Which agent runs a session: Claude Code through the Claude Agent SDK, or OpenAI Codex through the
 * Codex SDK (docs/agents.md). Config `agent`, per workspace too, and StartSessionRequest.agent.
 */
export type AgentKind = "claude" | "codex";
export const AGENTS: readonly AgentKind[] = ["claude", "codex"];

export interface Workspace {
  name: string;
  /** Absolute WSL path, with ~ expanded. */
  path: string;
  /** False when the folder is missing: the UI shows it disabled. */
  exists: boolean;
  /** The agent a new session here runs on: the workspace's own `agent`, else the top-level one. Absent from a runner before it: read as "claude". */
  agent?: AgentKind;
}

/**
 * cleat: started by the runner. terminal: a Claude Code session the runner found in a workspace's
 * transcripts (started in a terminal, or anywhere else) and imported. See docs/protocol.md, "Terminal sessions".
 */
export type SessionSource = "cleat" | "terminal";

export interface SessionMeta {
  /** The runner's id for the session (a UUID). Stable across turns, and across restarts for imported ones. */
  id: string;
  /**
   * The agent's own id for the conversation, known after the first turn starts, and used to resume:
   * Claude Code's session id, or Codex's thread id for a session whose `agent` is "codex".
   */
  claudeSessionId: string | null;
  /** The agent that runs the session's turns, chosen when it starts; every reply goes to the same one. Absent reads as "claude". */
  agent?: AgentKind;
  workspace: string;
  cwd: string;
  /** First line of the first prompt, cut to 80 characters. An imported session's: its custom title, else summary, else first prompt. */
  title: string;
  /** Where the session came from. The runner always sends it; a session stored before it existed reads as "cleat". */
  source?: SessionSource;
  status: SessionStatus;
  /**
   * True while the session is running only because its transcript grows: a turn arriving from a
   * terminal (or any other Claude Code), not one the runner runs. Absent otherwise.
   */
  terminalTurn?: true;
  createdAt: string;
  updatedAt: string;
  /** seq of the session's newest stored event. */
  lastSeq: number;
  /**
   * The permission mode in effect, as Claude Code reports it at the start of each turn (and when it
   * changes): "auto", "default", or another of the SDK's modes. Absent until the first turn reports it.
   */
  permissionMode?: string;
  /** Hidden from the default lists, kept on disk (POST .../archive). Absent when not archived. */
  archived?: true;
  /** Listed before the others (POST .../pin). Absent when not pinned. */
  pinned?: true;
}

interface EventBase {
  /** Per session, starts at 1, no gaps. */
  seq: number;
  /** ISO time. */
  ts: string;
}

export type SessionEvent = EventBase &
  (
    /** `images`: the pictures pasted into the text, in the order its "[Image #n]" names them (D0056). */
    | { kind: "user"; text: string; imagePath?: string; images?: string[] }
    | { kind: "assistant_text"; text: string }
    | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
    | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
    | { kind: "approval_request"; approvalId: string; toolUseId?: string; toolName: string; input: unknown; reason?: string }
    /** `answers`: an AskUserQuestion's, allowed: each question's text and the person's answer (D0039). */
    | { kind: "approval_resolved"; approvalId: string; decision: ApprovalDecision; answers?: QuestionAnswers }
    | { kind: "result"; ok: boolean; text?: string; costUsd?: number; durationMs?: number }
    /** A call the auto-mode classifier (or a deny rule, or the mode) denied without asking the person. `input` is a one-line summary. */
    | { kind: "auto_denied"; toolUseId: string; toolName: string; input?: string; reason?: string }
    /** Once per session: it asked for `requested` but Claude Code runs it in `mode`, so calls come to the person. */
    | { kind: "permission_mode"; requested: PermissionMode; mode: string }
    | { kind: "error"; message: string }
    /** The person stopped the turn (POST .../stop): it was interrupted, and the session is idle. */
    | { kind: "stopped" }
  );

export type SessionEventKind = SessionEvent["kind"];
export type ApprovalDecision = "allow" | "deny";
/**
 * The person's answers to an AskUserQuestion call: each question's text and its answer, an option's
 * label, several labels joined by ", " for a multiSelect one, or their own words (D0039).
 */
export type QuestionAnswers = Record<string, string>;
/** The tool whose approval carries answers. */
export const ASK_USER_QUESTION = "AskUserQuestion";

/** What the runner sends on the WebSocket at /ws. Clients send nothing. */
export type ServerMessage =
  /**
   * `build`: the runner's build id (a hash of the code and pages it serves). A page that sees it
   * change on a reconnect reloads itself, so a runner restarted onto new pages never leaves an open
   * window drawing the old ones (D0054).
   */
  | { type: "hello"; sessions: SessionMeta[]; build: string }
  | { type: "session"; session: SessionMeta }
  /** The session was deleted (POST .../delete): its record and events are gone. */
  | { type: "removed"; sessionId: string }
  | { type: "event"; sessionId: string; event: SessionEvent }
  /** A piece of assistant text as it streams. Not stored: the full text follows as an assistant_text event. */
  | { type: "delta"; sessionId: string; text: string }
  /** A notification as it is recorded. Not replayed on connect: GET /api/notifications has the kept ones. */
  | { type: "notification"; notification: Notification }
  /** The whole Settings, after every change (PUT /api/settings). Not sent on connect: GET /api/settings has them. */
  | { type: "settings"; settings: Settings }
  /** GET /api/platform's answer, whenever the shell's side changes: a report, or the shell connecting or going. */
  | { type: "platform"; platform: PlatformResponse }
  /**
   * Something the shell is asked to do (POST /api/platform/open-screen-recording). Sent only to the
   * sockets that connected as the shell (/ws?client=shell), never to the pages.
   */
  | { type: "shell_action"; action: ShellAction }
  /** GET /api/plugins's answer, whenever it changes (loaded again, a plugin turned on or off, a hotkey changed). The shell registers the hotkeys from it. */
  | { type: "plugins"; plugins: PluginInfo[] }
  /** A plugin's view, each time it is worked out again (a refresh that GET /api/plugins/:id/view started). */
  | { type: "plugin_view"; plugin: string; view: PluginViewResponse };

export type Theme = "system" | "light" | "dark";

/** The Windows shell's own settings. The runner only stores them; the shell applies them. */
export interface ShellSettings {
  /** Electron accelerators, e.g. "Alt+Space": New task, Snip, and the chat in the notch (D0046). No two the same. */
  hotkey: string;
  snipHotkey: string;
  /** Absent from settings written before it: the shell and the pages then use its default (⌘⇧J on a Mac, Ctrl+Alt+J elsewhere). */
  chatHotkey?: string;
  dock: boolean;
  startOnLogin: boolean;
}

/**
 * The user's settings, owned by the runner and kept in its config file (docs/protocol.md, "Settings").
 * `port` is the port the runner serves on: read-only here, it is changed only in the file.
 */
export interface Settings {
  theme: Theme;
  permissionMode: PermissionMode;
  /**
   * The agent new sessions run on: "claude" when left out of the file. The runner always sends it;
   * a PUT that leaves it out keeps the current one (clients from before it existed send none).
   */
  agent?: AgentKind;
  /** In order: the first is the default when none was used. `path` as written (it may start with ~/). */
  workspaces: { name: string; path: string; permissionMode?: PermissionMode; agent?: AgentKind }[];
  /** null until something sets it: the shell then sends its local values once and reads them from here after. */
  shell: ShellSettings | null;
  port: number;
}

/** The three layouts (docs/platforms.md; src/shell/platform.ts detectLayout). */
export type Layout = "windows-wsl" | "macos" | "linux";

/** macOS's answer for Screen Recording (Electron's systemPreferences.getMediaAccessStatus("screen")). */
export type ScreenAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** The shell's side, as it reports it with PUT /api/platform/shell: at its start and whenever any of it changes. */
export interface ShellReport {
  /** The OS the shell runs on. */
  os: "windows" | "macos" | "linux";
  /** Whether start on login is set now (Electron's login item, the launch agent or the autostart file); null when it could not be read. */
  startOnLogin: boolean | null;
  /** Whether each hotkey of the settings is registered now. False: another program holds it, or the desktop refuses global shortcuts. `chatHotkey` is absent from a shell from before it. */
  hotkeys: { hotkey: boolean; snipHotkey: boolean; chatHotkey?: boolean };
  /** False when the dock is an opaque window the island's size (Linux on X11 without a compositor). */
  dockTransparent: boolean;
  /** macOS only: whether the snip may capture the screens. Absent elsewhere. */
  screenRecording?: ScreenAccess;
}

/** What the shell can be asked to do through the runner: open System Settings at Screen Recording (macOS). */
export type ShellAction = "open_screen_recording";

/** GET /api/platform: this machine's layout, the runner (running, since it answers) and the shell as it last reported. */
export interface PlatformResponse {
  /** Null only when CLEAT_PLATFORM names no layout (docs/platforms.md). */
  layout: Layout | null;
  runner: { running: true; version: string };
  /**
   * connected: a shell holds a socket at /ws?client=shell now. report: its last report, kept while it
   * is connected; null before its first, and once its last socket closed.
   */
  shell: { connected: boolean; report: (ShellReport & { reportedAt: string }) | null };
}

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
/**
 * agent: run this session on that agent, instead of the workspace's (config `agent`). images: the
 * paths POST /api/images answered, in the order the prompt's "[Image #n]" names them (D0056).
 */
export interface StartSessionRequest { workspace: string; prompt: string; imagePath?: string; images?: string[]; agent?: AgentKind }
/** force: reply even when another process wrote to the transcript in the last two minutes (else 409, OPEN_IN_TERMINAL). */
export interface ReplyRequest { prompt: string; imagePath?: string; images?: string[]; force?: boolean }
/** POST /api/images: a pasted picture as a base64 PNG (D0056). */
export interface ImageUploadRequest { data: string }
/** 201: where the runner saved it, to name in a StartSessionRequest's or ReplyRequest's images. */
export interface ImageUploadResponse { imagePath: string }
/** The 409 error for a reply to a session another process is writing to, without force. */
export const OPEN_IN_TERMINAL = "it looks open in a terminal: reply with force to continue it here anyway";
export interface SessionResponse { session: SessionMeta }
/** POST /api/sessions/:id/rename. The title is cut as any title (its first line, 80 characters). */
export interface RenameRequest { title: string }
/** POST /api/sessions/:id/archive: true archives, false brings it back. */
export interface ArchiveRequest { archived: boolean }
/** POST /api/sessions/:id/pin. */
export interface PinRequest { pinned: boolean }
/** POST /api/sessions/:id/delete answers with the id that is gone. */
export interface DeletedResponse { deleted: string }
/** The 409 for deleting a session that came from the terminal: those are only archived. */
export const TERMINAL_NOT_DELETED = "a session from the terminal is not deleted here: archive it instead";
/** The 409 for stopping a session the runner runs no turn of. */
export const NOT_RUNNING = "no turn of this session is running here";
export interface EventsResponse { events: SessionEvent[] }
/** `answers`: required to allow an AskUserQuestion call, refused for any other tool. */
export interface ApprovalRequest { decision: ApprovalDecision; answers?: QuestionAnswers }
/** imagePath may be a Windows path (C:\...) here; the runner stores the WSL path. */
export interface ClipboardPostRequest { text?: string; imagePath?: string }
export interface NotificationsResponse { notifications: Notification[]; latest: number }
export interface ErrorResponse { error: string }
/**
 * One agent as `cleat doctor` checks it: installed (its version) and logged in. `detail` is the
 * line to show, `fix` what to do when it can't run (empty when it can).
 */
export interface AgentStatus { agent: AgentKind; installed: boolean; version: string | null; loggedIn: boolean; detail: string; fix: string }
/** GET /api/agents: both agents, Claude Code first, and when they were checked (answers are kept 30 seconds). */
export interface AgentsResponse { agents: AgentStatus[]; checkedAt: string }
/** The body of PUT /api/settings: a whole Settings. A port in it is ignored. */
/**
 * agent left out keeps the current one, at the top and on a workspace of the same name; a
 * workspace's `agent: null` clears its own, so it runs on the top-level agent.
 */
export type SettingsRequest = Omit<Settings, "port" | "workspaces"> & {
  port?: number;
  workspaces: { name: string; path: string; permissionMode?: PermissionMode; agent?: AgentKind | null }[];
};
/** The 409 of POST /api/platform/open-screen-recording when no shell on macOS is connected to open it. */
export const NO_MAC_SHELL = "no shell on macOS is connected to open System Settings";
/** POST /api/platform/open-screen-recording's 202: the connected shells were asked. */
export interface SentResponse { sent: true }
/** The 400 of PUT /api/settings: the first bad field as a dotted path ("workspaces.1.path"), and why. */
export interface SettingsErrorResponse { error: string; field: string }

// ---------- Plugins (D0057, docs/plugins.md) ----------

/** The glyphs a plugin's tab can carry (src/web/tool-icons.js draws them, through iconFor in dock-plugins.js). */
export const PLUGIN_ICONS = ["calendar", "search", "people", "mail", "note", "star", "bolt", "globe", "chart", "list"] as const;
export type PluginIcon = (typeof PLUGIN_ICONS)[number];

/**
 * One row of a plugin's view. Text only: the dock sets it as text, never as markup. `url` (http or
 * https only) opens in the browser on a click; `task` is a prompt the row's Ask starts a session with.
 */
export interface PluginRow {
  title: string;
  /** A second, muted line. */
  detail?: string;
  /** Small text at the row's right end: a time, a count, a word. */
  meta?: string;
  /** A dot before the title: "accent" (now, live), "muted" (past), "error". */
  tone?: "accent" | "muted" | "error";
  url?: string;
  task?: string;
}

export interface PluginSection {
  title?: string;
  rows: PluginRow[];
  /** Shown when `rows` is empty. */
  empty?: string;
}

/** What a plugin's view() and search() give: sections of rows, and an optional line under them. */
export interface PluginView {
  sections: PluginSection[];
  note?: string;
}

/** A plugin as GET /api/plugins lists it. */
export interface PluginInfo {
  /** Its folder's name: lowercase letters, digits and dashes. */
  id: string;
  title: string;
  icon: PluginIcon;
  /** Built in (the repo's plugins/ folder), or the person's own (plugins/ beside the config file). */
  builtIn: boolean;
  enabled: boolean;
  /** The Electron accelerator that opens the dock on its tab: the config's, else the plugin's own; null for none. */
  hotkey: string | null;
  /** It has a view (worked out when its tab opens) and/or a search (a find field at the tab's top). */
  view: boolean;
  search: boolean;
  /** The find field's placeholder. */
  placeholder: string | null;
  /** Searches as the person types (a cheap search), or only on Enter (one that runs an agent). */
  live: boolean;
  /** The MCP tools it may call (ctx.tool, ctx.ask), as declared: nothing else runs for it. */
  tools: string[];
  /** Why it could not be loaded. A plugin with an error is listed, never run. */
  error: string | null;
}

export interface PluginsResponse { plugins: PluginInfo[] }

/**
 * GET /api/plugins/:id/view: the last view worked out and when (null before the first), whether a
 * new one is being worked out now, and the last refresh's error (null when it worked).
 */
export interface PluginViewResponse { view: PluginView | null; at: string | null; loading: boolean; error: string | null }

/** POST /api/plugins/:id/search's body and answer. */
export interface PluginSearchRequest { query: string }
export interface PluginSearchResponse { query: string; view: PluginView }

/** PUT /api/plugins/:id: turns it on or off and sets its hotkey (null: none; absent: unchanged). */
export interface PluginSettingsRequest { enabled?: boolean; hotkey?: string | null }
