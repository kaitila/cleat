// The runner's HTTP and WebSocket server. Routes are added in handle().
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  HOST,
  type ErrorResponse,
  type EventsResponse,
  type ServerMessage,
  type SessionResponse,
  type SessionsResponse,
  type WorkspacesResponse,
} from "../shared/protocol";
import { driverFor, type AgentDriver } from "./agent";
import type { Config } from "./config";
import { Sessions } from "./sessions";
import { Store } from "./store";

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
  if (req.method === "POST" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
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

async function startSession(req: Request, app: App): Promise<Response> {
  const b = await body(req);
  if (!b) return fail(400, "the body must be a JSON object");
  if (typeof b.workspace !== "string" || !b.workspace) return fail(400, "workspace is missing");
  if (typeof b.prompt !== "string" || !b.prompt.trim()) return fail(400, "prompt is empty");
  const workspace = app.config.workspaces.find((w) => w.name === b.workspace);
  if (!workspace) return fail(400, `unknown workspace "${b.workspace}"`);
  if (!existsSync(workspace.path)) return fail(400, `the folder of workspace "${workspace.name}" is missing: ${workspace.path}`);
  return json({ session: app.sessions.start(workspace, b.prompt) } satisfies SessionResponse, 201);
}

async function handle(req: Request, app: App): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "POST" && path === "/api/sessions") return startSession(req, app);
  if (req.method === "GET") {
    if (path === "/api/workspaces") {
      const workspaces = app.config.workspaces.map((w) => ({ ...w, exists: existsSync(w.path) }));
      const last = app.store.lastWorkspace;
      const lastUsed = workspaces.some((w) => w.name === last) ? last : null;
      return json({ workspaces, lastUsed } satisfies WorkspacesResponse);
    }
    if (path === "/api/sessions") return json({ sessions: app.store.list() } satisfies SessionsResponse);
    const events = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
    if (events) {
      if (!app.store.get(events[1]!)) return fail(404, "no such session");
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d+$/.test(raw)) return fail(400, "after must be a whole number");
      return json({ events: app.store.events(events[1]!, raw === null ? 0 : Number(raw)) } satisfies EventsResponse);
    }
    if (path === "/health") return json({ ok: true, version: VERSION });
    if (path === "/") return page("chat.html");
    if (path === "/prompt") return page("prompt.html");
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

/** Starts the runner. `driver` replaces the agent the config asks for (tests). */
export function startServer(config: Config, driver: AgentDriver = driverFor(config)): Runner {
  const store = new Store(config.dataDir);
  const send = (message: ServerMessage) => void server.publish(TOPIC, JSON.stringify(message));
  const sessions = new Sessions(store, driver, send);
  const app: App = { config, store, sessions };
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
  return {
    port,
    url: `http://${HOST}:${port}`,
    async stop() {
      await sessions.stop();
      await server.stop(true);
    },
  };
}
