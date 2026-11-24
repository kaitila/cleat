// The runner's HTTP and WebSocket server. Routes are added in handle().
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  AGENTS,
  HOST,
  NO_MAC_SHELL,
  NOT_RUNNING,
  OPEN_IN_TERMINAL,
  type AgentKind,
  type AgentsResponse,
  type ClipboardCapture,
  type DeletedResponse,
  type ErrorResponse,
  type EventsResponse,
  type HealthResponse,
  type NotificationsResponse,
  type PlatformResponse,
  type SentResponse,
  type ServerMessage,
  type SessionMeta,
  type SessionResponse,
  type SessionsResponse,
  type Settings,
  type SettingsErrorResponse,
  type WorkspacesResponse,
} from "../shared/protocol";
import { driverFor, type AgentDriver } from "./agent";
import { fakeStatus, machineStatus, type AgentStatusSource } from "./agent-status";
import { buildId } from "./build";
import { Clipboard, defaultImageRule, type ImageRule, NOT_AN_IMAGE, imagePathOf } from "./clipboard";
import { DELETING, Manage, fakeOps, sdkOps, type Refused, type TranscriptOps } from "./manage";
import { agentFor, applySettings, permissionModeFor, type Config } from "./config";
import { Notifications } from "./notifications";
import { layoutOrNull, parseReport, ShellState } from "./platform";
import { NO_APPROVAL, Sessions, busy } from "./sessions";
import { settingsOf, validateSettings, writeSettings } from "./settings";
import { Store } from "./store";
import { Sync, noThreads, noTranscripts, type SyncOptions } from "./sync";

export const VERSION = "0.1.0";
const WEB_DIR = join(import.meta.dir, "..", "web");

export interface Runner {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function fail(status: number, error: string): Response {
  return json({ error } satisfies ErrorResponse, status);
}

/**
 * Why a request is refused, or null. The port is local, but any web page can send requests to it,
 * so the Host and Origin must be the runner's own (docs/protocol.md, "Guarding the port").
 */
export function refusal(req: Request, port: number): string | null {
  const allowed = [`${HOST}:${port}`, `localhost:${port}`];
  const host = req.headers.get("host");
  if (!host || !allowed.includes(host)) return "host not allowed";
  const origin = req.headers.get("origin");
  if (origin !== null && !allowed.some((h) => origin === `http://${h}`)) return "origin not allowed";
  if ((req.method === "POST" || req.method === "PUT") && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return "content-type must be application/json";
  }
  return null;
}

async function page(file: string): Promise<Response> {
  const f = Bun.file(join(WEB_DIR, file));
  return (await f.exists()) ? new Response(f, { headers: { "cache-control": "no-store" } }) : fail(404, "not found");
}

interface App {
  config: Config;
  store: Store;
  sessions: Sessions;
  clipboard: Clipboard;
  notifications: Notifications;
  sync: Sync;
  manage: Manage;
  /** The build id of the code this process loaded, taken once at its start (build.ts). */
  build: string;
  /** Which image paths are taken: under the Windows drives' mounts (/mnt), or in the shell's temp folder on macOS and Linux. */
  mounts: ImageRule;
  /** The shell's side for GET /api/platform: its sockets and its last report. */
  shell: ShellState;
  /** GET /api/agents: each agent's doctor status (agent-status.ts). */
  agentStatus: AgentStatusSource;
  /** The port the server listens on (config.port may be 0 in tests). */
  port(): number;
  send(message: ServerMessage): void;
  /** Sends to the shell's sockets only (/ws?client=shell). */
  sendShell(message: ServerMessage): void;
}

/** What a WebSocket carries: whether it connected as the shell. */
interface SocketData {
  shell: boolean;
}

/** The request's JSON body as an object, or null when it isn't one. */
async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The request's imagePath as the path Claude reads, undefined without one, or null when it is refused. */
function imageOf(b: Record<string, unknown>, app: App): string | undefined | null {
  return b.imagePath === undefined ? undefined : imagePathOf(b.imagePath, app.mounts);
}

async function startSession(req: Request, app: App): Promise<Response> {
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  if (typeof b.workspace !== "string" || !b.workspace) return fail(400, "workspace is missing");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return fail(400, "prompt is empty");
  const workspace = app.config.workspaces.find((w) => w.name === b.workspace);
  if (!workspace) return fail(400, `unknown workspace "${b.workspace}"`);
  if (!existsSync(workspace.path)) return fail(400, `the folder of workspace "${workspace.name}" is missing: ${workspace.path}`);
  if (b.agent !== undefined && !AGENTS.includes(b.agent as AgentKind)) return fail(400, `agent must be one of ${AGENTS.join(", ")}`);
  const imagePath = imageOf(b, app);
  if (imagePath === null) return fail(400, NOT_AN_IMAGE);
  const agent = (b.agent as AgentKind | undefined) ?? agentFor(app.config, workspace.name);
  return json({ session: app.sessions.start(workspace, b.prompt, imagePath, agent) } satisfies SessionResponse, 201);
}

async function reply(req: Request, app: App, id: string): Promise<Response> {
  if (!app.store.get(id)) return fail(404, "no such session");
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return fail(400, "prompt is empty");
  const imagePath = imageOf(b, app);
  if (imagePath === null) return fail(400, NOT_AN_IMAGE);
  if (b.force !== undefined && typeof b.force !== "boolean") return fail(400, "force must be true or false");
  // The history (of an imported session) and what a terminal wrote since the last round are stored
  // first, so the reply follows them. A session another process wrote to lately waits for force.
  const { openElsewhere } = await app.sync.beforeReply(id);
  if (openElsewhere && b.force !== true) return fail(409, OPEN_IN_TERMINAL);
  // Nothing awaits between this check and the turn starting, so two replies sent at once
  // can't both start one. A session shown running only because its transcript grows is no runner turn.
  const session = app.store.get(id);
  if (!session) return fail(404, "no such session");
  if (app.manage.deleting.has(id)) return fail(409, DELETING);
  const why = !app.sessions.isRunning(id) && app.sync.isLive(id) ? null : busy(session);
  if (why) return fail(409, why);
  return json({ session: app.sessions.reply(id, b.prompt, imagePath) } satisfies SessionResponse, 202);
}

async function answerApproval(req: Request, app: App, id: string, approvalId: string): Promise<Response> {
  if (!app.store.get(id)) return fail(404, "no such session");
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  if (b.decision !== "allow" && b.decision !== "deny") return fail(400, 'decision must be "allow" or "deny"');
  const session = app.sessions.answer(id, approvalId, b.decision, b.answers);
  if (!session) return fail(404, NO_APPROVAL);
  return "refused" in session ? fail(400, session.refused) : json({ session } satisfies SessionResponse);
}

/** The session's answer, or the refusal's. */
function answer(result: SessionMeta | Refused, status = 200): Response {
  return "error" in result && "status" in result ? fail(result.status, result.error) : json({ session: result as SessionMeta } satisfies SessionResponse, status);
}

/** POST /api/sessions/:id/<action>: the person's operations on a session (manage.ts, and stop in sessions.ts). */
async function manageSession(req: Request, app: App, id: string, action: string): Promise<Response> {
  if (!app.store.get(id)) return fail(404, "no such session");
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  switch (action) {
    case "rename":
      if (typeof b.title !== "string") return fail(400, "title must be a string");
      return answer(await app.manage.rename(id, b.title));
    case "archive":
      if (typeof b.archived !== "boolean") return fail(400, "archived must be true or false");
      return answer(app.manage.archive(id, b.archived));
    case "pin":
      if (typeof b.pinned !== "boolean") return fail(400, "pinned must be true or false");
      return answer(app.manage.pin(id, b.pinned));
    case "stop": {
      const session = await app.sessions.interrupt(id);
      return session ? answer(session) : fail(409, NOT_RUNNING);
    }
    case "fork":
      return answer(await app.manage.fork(id), 201);
    case "delete": {
      const result = await app.manage.remove(id);
      return "deleted" in result ? json(result satisfies DeletedResponse) : fail(result.status, result.error);
    }
  }
  return fail(404, "not found");
}

/** GET /api/sessions: the unarchived sessions, or with ?archived=1 the archived ones. Pinned first, then newest first. */
function listSessions(app: App, url: URL): Response {
  const raw = url.searchParams.get("archived");
  if (raw !== null && raw !== "0" && raw !== "1") return fail(400, "archived must be 0 or 1");
  const archived = raw === "1";
  const sessions = app.store.list().filter((s) => (s.archived === true) === archived);
  // A stable sort: the store's order (newest first) stays within the pinned and the others.
  sessions.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
  return json({ sessions } satisfies SessionsResponse);
}

async function postClipboard(req: Request, app: App): Promise<Response> {
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  const stored = app.clipboard.post(b);
  return typeof stored === "string" ? fail(400, stored) : json(stored satisfies ClipboardCapture);
}

/** The latest capture's PNG, for the pop-up's thumbnail. No path is taken from the request. */
function clipboardImage(app: App): Response {
  const path = app.clipboard.image();
  if (path === null) return fail(404, "no image");
  return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** PUT /api/settings: the whole Settings, validated, written to the config file, put into effect and sent to every client. */
async function putSettings(req: Request, app: App): Promise<Response> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return json({ error: "the body must be JSON", field: "" } satisfies SettingsErrorResponse, 400);
  }
  const settings = validateSettings(value, app.config.settings);
  if ("field" in settings) return json(settings satisfies SettingsErrorResponse, 400);
  writeSettings(app.config.configPath, settings);
  applySettings(app.config, settings);
  const answer: Settings = settingsOf(settings, app.port());
  app.send({ type: "settings", settings: answer });
  return json(answer);
}

/** PUT /api/platform/shell: the shell's report, kept and sent to every client as a 'platform' message. */
async function putShellReport(req: Request, app: App): Promise<Response> {
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  const report = parseReport(b);
  if ("error" in report) return fail(400, report.error);
  app.shell.setReport(report);
  const answer = app.shell.response();
  app.send({ type: "platform", platform: answer });
  return json(answer satisfies PlatformResponse);
}

/**
 * POST /api/platform/open-screen-recording: the page cannot open System Settings itself, so the
 * shell on macOS is asked to, on its socket. 409 when none is connected.
 */
async function openScreenRecording(req: Request, app: App): Promise<Response> {
  if (!(await body(req))) return fail(400, "the body must be a JSON object");
  if (!app.shell.connected || app.shell.os !== "macos") return fail(409, NO_MAC_SHELL);
  app.sendShell({ type: "shell_action", action: "open_screen_recording" });
  return json({ sent: true } satisfies SentResponse, 202);
}

async function handle(req: Request, app: App): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "PUT" && path === "/api/settings") return putSettings(req, app);
  if (req.method === "PUT" && path === "/api/platform/shell") return putShellReport(req, app);
  if (req.method === "POST") {
    if (path === "/api/sessions") return startSession(req, app);
    if (path === "/api/platform/open-screen-recording") return openScreenRecording(req, app);
    if (path === "/api/clipboard") return postClipboard(req, app);
    const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messages) return reply(req, app, messages[1]!);
    const approval = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
    if (approval) return answerApproval(req, app, approval[1]!, approval[2]!);
    const op = /^\/api\/sessions\/([^/]+)\/(rename|archive|pin|stop|fork|delete)$/.exec(path);
    if (op) return manageSession(req, app, op[1]!, op[2]!);
  }
  if (req.method === "GET") {
    if (path === "/api/workspaces") {
      const workspaces = app.config.workspaces.map((w) => ({ ...w, exists: existsSync(w.path), agent: agentFor(app.config, w.name) }));
      const last = app.store.lastWorkspace;
      const lastUsed = workspaces.some((w) => w.name === last) ? last : null;
      return json({ workspaces, lastUsed } satisfies WorkspacesResponse);
    }
    if (path === "/api/settings") return json(settingsOf(app.config.settings, app.port()) satisfies Settings);
    if (path === "/api/platform") return json(app.shell.response() satisfies PlatformResponse);
    if (path === "/api/agents") return json((await app.agentStatus()) satisfies AgentsResponse);
    if (path === "/api/sessions") return listSessions(app, url);
    const events = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
    if (events) {
      if (!app.store.get(events[1]!)) return fail(404, "no such session");
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d+$/.test(raw)) return fail(400, "after must be a whole number");
      // An imported session's events are read from its transcript the first time they are asked for.
      await app.sync.load(events[1]!);
      return json({ events: app.store.events(events[1]!, raw === null ? 0 : Number(raw)) } satisfies EventsResponse);
    }
    if (path === "/api/notifications") {
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d+$/.test(raw)) return fail(400, "after must be a whole number");
      return json(app.notifications.after(raw === null ? 0 : Number(raw)) satisfies NotificationsResponse);
    }
    if (path === "/api/clipboard") return json(app.clipboard.get() ?? {});
    if (path === "/api/clipboard/image") return clipboardImage(app);
    if (path === "/health") return json({ ok: true, version: VERSION, build: app.build } satisfies HealthResponse);
    if (path === "/") return page("chat.html");
    if (path === "/prompt") return page("prompt.html");
    if (path === "/dock") return page("dock.html");
    if (path === "/settings") return page("settings.html");
    if (path.startsWith("/assets/")) {
      const rel = normalize(path.slice("/assets/".length));
      if (rel.startsWith("..") || rel.startsWith("/")) return fail(404, "not found");
      return page(rel);
    }
  }
  return fail(404, "not found");
}

/** Every WebSocket client is subscribed to this one topic. */
const TOPIC = "all";
/** And the shell's sockets to this one too, for what only the shell is asked (shell_action). */
const SHELL_TOPIC = "shell";

/**
 * Starts the runner. `driver` replaces the agent the config asks for, `mounts` the rule for image
 * paths (by default this layout's: /mnt for windows-wsl, <temp>/intuition/ on macOS and Linux), and `sync` the transcript sync's reader and timings (all for tests:
 * CI has no /mnt/c and no transcripts). With the fake agent there are no transcripts to read, Claude Code's or Codex's.
 * `ops` replaces what renames, forks and deletes transcripts (manage.ts): with the fake agent, nothing does.
 */
export function startServer(
  config: Config,
  driver: AgentDriver = driverFor(config),
  mounts: ImageRule = defaultImageRule(),
  sync: Partial<SyncOptions> = {},
  ops: TranscriptOps = config.fakeAgent ? fakeOps() : sdkOps(),
  agentStatus: AgentStatusSource = config.fakeAgent ? fakeStatus() : machineStatus(),
): Runner {
  const store = new Store(config.dataDir);
  const send = (message: ServerMessage) => void server.publish(TOPIC, JSON.stringify(message));
  const sendShell = (message: ServerMessage) => void server.publish(SHELL_TOPIC, JSON.stringify(message));
  const shell = new ShellState(layoutOrNull(), VERSION);
  const notifications = new Notifications((notification) => send({ type: "notification", notification }));
  const sessions = new Sessions(store, driver, send, notifications, (workspace) => permissionModeFor(config, workspace));
  const transcriptSync = new Sync(store, sessions, send, config.workspaces, config.dataDir, {
    ...(config.fakeAgent ? { transcripts: noTranscripts(), codex: noThreads() } : {}),
    ...sync,
  });
  sessions.watcher = transcriptSync;
  const manage = new Manage(store, sessions, transcriptSync, ops, send);
  const app: App = { config, store, sessions, sync: transcriptSync, manage, clipboard: new Clipboard(mounts), notifications, build: buildId(config.buildId), mounts, shell, agentStatus, port: () => server.port ?? config.port, send, sendShell };
  const server = Bun.serve<SocketData>({
    hostname: HOST,
    port: config.port,
    async fetch(req, srv) {
      const why = refusal(req, srv.port ?? config.port);
      if (why) return fail(403, why);
      try {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/ws") {
          // The shell connects as ?client=shell: its sockets say whether it runs (GET /api/platform).
          const data: SocketData = { shell: url.searchParams.get("client") === "shell" };
          return srv.upgrade(req, { data }) ? undefined : fail(400, "expected a WebSocket upgrade");
        }
        return await handle(req, app);
      } catch (e) {
        console.error(e);
        return fail(500, "internal error");
      }
    },
    websocket: {
      open(ws) {
        ws.subscribe(TOPIC);
        ws.send(JSON.stringify({ type: "hello", sessions: store.list() } satisfies ServerMessage));
        if (ws.data.shell) {
          ws.subscribe(SHELL_TOPIC);
          shell.connect();
          send({ type: "platform", platform: shell.response() });
        }
      },
      // Clients send nothing (docs/protocol.md): whatever arrives is ignored.
      message() {},
      close(ws) {
        if (ws.data.shell && shell.disconnect()) send({ type: "platform", platform: shell.response() });
      },
    },
  });
  const port = server.port ?? config.port;
  transcriptSync.start();
  return {
    port,
    url: `http://${HOST}:${port}`,
    async stop() {
      await transcriptSync.stop();
      await sessions.stop();
      await server.stop(true);
    },
  };
}
