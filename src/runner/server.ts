// The runner's HTTP and WebSocket server. Routes are added in handle().
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  HOST,
  OPEN_IN_TERMINAL,
  type ClipboardCapture,
  type ErrorResponse,
  type EventsResponse,
  type HealthResponse,
  type NotificationsResponse,
  type ServerMessage,
  type SessionResponse,
  type SessionsResponse,
  type Settings,
  type SettingsErrorResponse,
  type WorkspacesResponse,
} from "../shared/protocol";
import { driverFor, type AgentDriver } from "./agent";
import { buildId } from "./build";
import { Clipboard, MOUNTS, NOT_AN_IMAGE, imagePathOf } from "./clipboard";
import { applySettings, permissionModeFor, type Config } from "./config";
import { Notifications } from "./notifications";
import { NO_APPROVAL, Sessions, busy } from "./sessions";
import { settingsOf, validateSettings, writeSettings } from "./settings";
import { Store } from "./store";
import { Sync, noTranscripts, type SyncOptions } from "./sync";

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
  /** The build id of the code this process loaded, taken once at its start (build.ts). */
  build: string;
  /** Where the Windows drives are mounted (/mnt). */
  mounts: string;
  /** The port the server listens on (config.port may be 0 in tests). */
  port(): number;
  send(message: ServerMessage): void;
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

/** The request's imagePath as a WSL path, undefined without one, or null when it is refused. */
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
  const imagePath = imageOf(b, app);
  if (imagePath === null) return fail(400, NOT_AN_IMAGE);
  return json({ session: app.sessions.start(workspace, b.prompt, imagePath) } satisfies SessionResponse, 201);
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
  const session = app.store.get(id)!;
  const why = !app.sessions.isRunning(id) && app.sync.isLive(id) ? null : busy(session);
  if (why) return fail(409, why);
  return json({ session: app.sessions.reply(id, b.prompt, imagePath) } satisfies SessionResponse, 202);
}

async function answerApproval(req: Request, app: App, id: string, approvalId: string): Promise<Response> {
  if (!app.store.get(id)) return fail(404, "no such session");
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  if (b.decision !== "allow" && b.decision !== "deny") return fail(400, 'decision must be "allow" or "deny"');
  const session = app.sessions.answer(id, approvalId, b.decision);
  return session ? json({ session } satisfies SessionResponse) : fail(404, NO_APPROVAL);
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

async function handle(req: Request, app: App): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "PUT" && path === "/api/settings") return putSettings(req, app);
  if (req.method === "POST") {
    if (path === "/api/sessions") return startSession(req, app);
    if (path === "/api/clipboard") return postClipboard(req, app);
    const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messages) return reply(req, app, messages[1]!);
    const approval = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
    if (approval) return answerApproval(req, app, approval[1]!, approval[2]!);
  }
  if (req.method === "GET") {
    if (path === "/api/workspaces") {
      const workspaces = app.config.workspaces.map((w) => ({ ...w, exists: existsSync(w.path) }));
      const last = app.store.lastWorkspace;
      const lastUsed = workspaces.some((w) => w.name === last) ? last : null;
      return json({ workspaces, lastUsed } satisfies WorkspacesResponse);
    }
    if (path === "/api/settings") return json(settingsOf(app.config.settings, app.port()) satisfies Settings);
    if (path === "/api/sessions") return json({ sessions: app.store.list() } satisfies SessionsResponse);
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

/**
 * Starts the runner. `driver` replaces the agent the config asks for, `mounts` the folder the
 * Windows drives are mounted in, and `sync` the transcript sync's reader and timings (all for tests:
 * CI has no /mnt/c and no transcripts). With the fake agent there are no transcripts to read.
 */
export function startServer(config: Config, driver: AgentDriver = driverFor(config), mounts = MOUNTS, sync: Partial<SyncOptions> = {}): Runner {
  const store = new Store(config.dataDir);
  const send = (message: ServerMessage) => void server.publish(TOPIC, JSON.stringify(message));
  const notifications = new Notifications((notification) => send({ type: "notification", notification }));
  const sessions = new Sessions(store, driver, send, notifications, (workspace) => permissionModeFor(config, workspace));
  const transcriptSync = new Sync(store, sessions, send, config.workspaces, config.dataDir, {
    ...(config.fakeAgent ? { transcripts: noTranscripts() } : {}),
    ...sync,
  });
  sessions.watcher = transcriptSync;
  const app: App = { config, store, sessions, sync: transcriptSync, clipboard: new Clipboard(mounts), notifications, build: buildId(config.buildId), mounts, port: () => server.port ?? config.port, send };
  const server = Bun.serve({
    hostname: HOST,
    port: config.port,
    async fetch(req, srv) {
      const why = refusal(req, srv.port ?? config.port);
      if (why) return fail(403, why);
      try {
        if (req.method === "GET" && new URL(req.url).pathname === "/ws") {
          return srv.upgrade(req, { data: undefined }) ? undefined : fail(400, "expected a WebSocket upgrade");
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
      },
      // Clients send nothing (docs/protocol.md): whatever arrives is ignored.
      message() {},
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
