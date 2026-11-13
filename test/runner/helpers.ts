// Shared by the runner tests: a runner on a free port with a temp config, data folder and workspace,
// running the fake agent.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionMeta } from "../../src/shared/protocol";
import type { AgentDriver } from "../../src/runner/agent";
import { loadConfig, type Config } from "../../src/runner/config";
import { startServer, type Runner } from "../../src/runner/server";
import type { SyncOptions } from "../../src/runner/sync";

export interface TestRunner extends Runner {
  dir: string;
  config: Config;
  env: Record<string, string>;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  /** Starts a session in the "work" workspace and returns its metadata. */
  startSession(prompt: string): Promise<SessionMeta>;
}

/**
 * `dir` reuses an earlier runner's folders, as a restart does. `mounts` stands in for /mnt, which CI lacks.
 * `permissionMode` goes in the config file at the top, `workMode` on the "work" workspace. `sync`
 * replaces the transcript sync's reader and timings (with the fake agent it reads no transcripts).
 */
export function testRunner(
  options: { dir?: string; driver?: AgentDriver; mounts?: string; permissionMode?: string; workMode?: string; sync?: Partial<SyncOptions> } = {},
): TestRunner {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "intuition-runner-"));
  const workspace = join(dir, "work");
  mkdirSync(workspace, { recursive: true });
  const env = {
    INTUITION_CONFIG: join(dir, "config.json"),
    INTUITION_DATA_DIR: join(dir, "data"),
    INTUITION_PORT: "0",
    INTUITION_FAKE_AGENT: "1",
  };
  writeFileSync(
    env.INTUITION_CONFIG,
    JSON.stringify({
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      workspaces: [{ name: "work", path: workspace, ...(options.workMode ? { permissionMode: options.workMode } : {}) }, { name: "gone", path: join(dir, "gone") }],
    }),
  );
  const config = loadConfig(env);
  const runner = startServer(config, options.driver, options.mounts, options.sync);
  const get = (path: string) => fetch(runner.url + path);
  const post = (path: string, body: unknown) =>
    fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    ...runner,
    dir,
    config,
    env,
    get,
    post,
    async startSession(prompt) {
      const res = await post("/api/sessions", { workspace: "work", prompt });
      if (res.status !== 201) throw new Error(`POST /api/sessions answered ${res.status}: ${await res.text()}`);
      return ((await res.json()) as { session: SessionMeta }).session;
    },
  };
}

export interface Socket {
  messages: ServerMessage[];
  /** Resolves with the first message (already received or still to come) that matches. */
  waitFor(match: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  close(): void;
}

/** Connects to /ws and resolves once `hello` has arrived. */
export async function connect(runner: Runner): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  const messages: ServerMessage[] = [];
  const waiting = new Set<() => void>();
  ws.onmessage = (e) => {
    messages.push(JSON.parse(String(e.data)) as ServerMessage);
    for (const check of [...waiting]) check();
  };
  const waitFor: Socket["waitFor"] = (match, ms = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find(match);
        if (!found) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        waiting.delete(check);
        reject(new Error(`no matching message in ${ms} ms. Received: ${JSON.stringify(messages)}`));
      }, ms);
      waiting.add(check);
      check();
    });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the WebSocket did not connect"));
  });
  await waitFor((m) => m.type === "hello");
  return { messages, waitFor, close: () => ws.close() };
}

/** Waits until the session's turn has ended (idle or error). */
export function settled(socket: Socket, id: string): Promise<ServerMessage> {
  return socket.waitFor((m) => m.type === "session" && m.session.id === id && (m.session.status === "idle" || m.session.status === "error"));
}
