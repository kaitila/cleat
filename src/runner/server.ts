// The runner's HTTP and WebSocket server. Routes are added in handle().
import { join, normalize } from "node:path";
import { HOST, type ErrorResponse } from "../shared/protocol";
import type { Config } from "./config";

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

async function handle(req: Request, _config: Config): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "GET") {
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

export function startServer(config: Config): Runner {
  const server = Bun.serve({
    hostname: HOST,
    port: config.port,
    async fetch(req) {
      const why = refusal(req, server.port ?? config.port);
      if (why) return fail(403, why);
      try {
        return await handle(req, config);
      } catch (e) {
        console.error(e);
        return fail(500, "internal error");
      }
    },
  });
  const port = server.port ?? config.port;
  return { port, url: `http://${HOST}:${port}`, stop: () => server.stop(true) };
}
