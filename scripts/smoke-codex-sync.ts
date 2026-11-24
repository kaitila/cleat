// Smoke check of the transcript sync for Codex with real Codex (D0031): needs this machine's Codex
// login (~/.codex), so it is not part of the test suite or CI. Run it with
// `env -u CI bun scripts/smoke-codex-sync.ts`.
//
// It starts the runner in this process on a free port, with a temp config whose one workspace (a
// throwaway mkdtemp folder) runs on Codex, a temp data folder, and the real ~/.codex (or $CODEX_HOME)
// to read from. Then, running the codex binary the SDK brings as a person would in a terminal, in the
// workspace:
//   (a) `codex exec "Reply with exactly: born in terminal"` starts a thread: it appears in
//       GET /api/sessions with source "terminal", agent "codex" and that thread id, and its events have
//       the prompt, the answer and a result;
//   (b) with the session shown (the WebSocket open), `codex exec resume <thread id> "Reply with exactly:
//       grown in terminal"` continues it: the runner streams that turn's user and assistant events,
//       shows the session running, and goes back to idle;
//   (c) a reply from the runner right after is refused with 409 (the thread was just written to), and
//       one with force is answered by Codex in the same thread.
// Exit 0 when all three hold, 1 with what it saw when one doesn't (or after 300 seconds), and 2 when
// Codex is not installed or not logged in.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_IN_TERMINAL, type EventsResponse, type ServerMessage, type SessionEvent, type SessionMeta, type SessionsResponse } from "../src/shared/protocol";
import { codexBinary } from "../src/runner/agent-codex";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

if (process.env.CI) {
  console.log("SKIPPED: CI is set, and CI has no Codex login");
  process.exit(0);
}

const binary = codexBinary();
if (!binary) {
  console.log("NOT RUN: Codex is not installed (bun install brings @openai/codex-sdk and its codex)");
  process.exit(2);
}
const status = Bun.spawnSync([binary, "login", "status"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const statusText = (status.stdout.toString() + status.stderr.toString()).trim();
if (status.exitCode !== 0 || !/^logged in/i.test(statusText)) {
  console.log(`NOT RUN: Codex is not logged in (${statusText || `exit ${status.exitCode}`}): run \`codex login\``);
  process.exit(2);
}

const TIMEOUT_MS = 300_000;
const BORN = "Reply with exactly: born in terminal";
const GROWN = "Reply with exactly: grown in terminal";
const ANSWER = "Reply with exactly: answered in holm";

const dir = mkdtempSync(join(tmpdir(), "holm-smoke-codex-sync-"));
// The real path: Codex records the folder with links resolved.
const workspace = join(realpathSync(dir), "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace, agent: "codex" }] }));
// Its own environment, so a HOLM_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ HOLM_CONFIG: configFile, HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}, codex ${statusText}`);

const seen: Record<string, unknown> = {};
let finished = false;
let ws: WebSocket | undefined;

async function finish(code: number, why: string): Promise<never> {
  finished = true;
  clearTimeout(timer);
  console.log(`${code === 0 ? "PASS" : "FAIL"}: ${why}`);
  console.log(`seen: ${JSON.stringify(seen)}`);
  ws?.close();
  await runner.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, `not finished after ${TIMEOUT_MS / 1000} seconds`), TIMEOUT_MS);

const post = (path: string, body: unknown) =>
  fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const messages: ServerMessage[] = [];
const waiting = new Set<() => void>();

/** Resolves once `check` holds over the messages so far (checked again on every new one). */
function until<T>(what: string, check: () => T | undefined | false, ms = 120_000): Promise<T> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => void finish(1, `waited ${ms / 1000} s for ${what}`), ms);
    const run = () => {
      const found = check();
      if (found === undefined || found === false) return;
      clearTimeout(timeout);
      waiting.delete(run);
      resolve(found);
    };
    waiting.add(run);
    run();
  });
}

const eventsOf = (id: string): SessionEvent[] => messages.flatMap((m) => (m.type === "event" && m.sessionId === id ? [m.event] : []));
const statusesOf = (id: string): SessionMeta[] => messages.flatMap((m) => (m.type === "session" && m.session.id === id ? [m.session] : []));
const lastOf = (id: string): SessionMeta | undefined => statusesOf(id).at(-1);

/** Runs `codex exec` as a person would in a terminal, in the workspace (read-only, its default), and returns the thread id it reports. */
async function terminal(args: string[]): Promise<string> {
  const argv = [binary!, "exec", "--json", "--skip-git-repo-check", ...args];
  console.log(`$ codex ${argv.slice(1).map((a) => JSON.stringify(a)).join(" ")}`);
  const proc = Bun.spawn(argv, { cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const lines = out.split("\n").filter((l) => l.trim());
  console.log(`  exit ${code}: ${lines.map((l) => l.slice(0, 160)).join("\n  ")}`);
  if (code !== 0) return finish(1, `codex ${args.join(" ")} exited ${code}: ${err.trim().slice(0, 500)}`);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch {
      // Not an event line.
    }
  }
  return finish(1, "codex exec reported no thread.started");
}

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  ws.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    messages.push(message);
    if (message.type === "event") console.log(`event ${message.sessionId.slice(0, 8)} ${JSON.stringify(message.event).slice(0, 200)}`);
    else if (message.type === "session") console.log(`session ${message.session.id.slice(0, 8)} ${message.session.source} agent=${message.session.agent} status=${message.session.status} lastSeq=${message.session.lastSeq} title=${JSON.stringify(message.session.title)}`);
    for (const check of [...waiting]) check();
  };
  await new Promise<void>((resolve) => (ws!.onopen = () => resolve()));

  // (a) A thread born in the terminal.
  const threadId = await terminal([BORN]);
  let born: SessionMeta | undefined;
  for (let i = 0; i < 40 && !born; i++) {
    const { sessions } = (await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse;
    born = sessions.find((s) => s.claudeSessionId === threadId);
    if (!born) await Bun.sleep(500);
  }
  if (!born) return void finish(1, `no session for thread ${threadId} appeared in GET /api/sessions`);
  seen.a = { id: born.id, thread: threadId, source: born.source, agent: born.agent, title: born.title };
  if (born.source !== "terminal" || born.agent !== "codex") return void finish(1, `the session is source ${born.source}, agent ${born.agent}`);
  const { events } = (await (await fetch(`${runner.url}/api/sessions/${born.id}/events`)).json()) as EventsResponse;
  seen.aKinds = events.map((e) => e.kind);
  if (!events.some((e) => e.kind === "user" && e.text.includes(BORN))) return void finish(1, `the terminal session's events have no user prompt: ${JSON.stringify(events)}`);
  if (!events.some((e) => e.kind === "assistant_text" && e.text.toLowerCase().includes("born in terminal"))) return void finish(1, "the terminal session's events have no answer");
  if (!events.some((e) => e.kind === "result" && e.ok)) return void finish(1, "the terminal session's events have no result");
  const id = born.id;
  const before = events.at(-1)?.seq ?? 0;

  // (b) Continued in the terminal while shown.
  const again = await terminal(["resume", threadId, GROWN]);
  if (again !== threadId) return void finish(1, `codex exec resume reported thread ${again}, not ${threadId}`);
  const userSeen = await until("the terminal turn's user event in the runner", () => eventsOf(id).find((e) => e.seq > before && e.kind === "user" && e.text.includes(GROWN)));
  const answerSeen = await until("the terminal turn's answer in the runner", () =>
    eventsOf(id).find((e) => e.seq > before && e.kind === "assistant_text" && e.text.toLowerCase().includes("grown in terminal")),
  );
  await until("the session to show running while the terminal wrote", () => statusesOf(id).some((s) => s.status === "running" && s.terminalTurn === true));
  await until("the session to go back to idle", () => {
    const s = lastOf(id);
    return s && s.lastSeq >= answerSeen.seq && s.status === "idle" ? s : undefined;
  }, 30_000);
  seen.b = { user: userSeen.seq, assistant: answerSeen.seq, idle: true };

  // (c) A reply right after: refused without force, answered with it.
  const refused = await post(`/api/sessions/${id}/messages`, { prompt: ANSWER });
  const refusedError = refused.status === 409 ? ((await refused.json()) as { error: string }).error : await refused.text();
  seen.c = { refused: refused.status, error: refusedError };
  if (refused.status !== 409 || refusedError !== OPEN_IN_TERMINAL) return void finish(1, `a reply without force answered ${refused.status}: ${refusedError}`);
  const forced = await post(`/api/sessions/${id}/messages`, { prompt: ANSWER, force: true });
  if (forced.status !== 202) return void finish(1, `a reply with force answered ${forced.status}: ${await forced.text()}`);
  const answered = await until("the forced reply's answer", () => eventsOf(id).find((e) => e.seq > answerSeen.seq && e.kind === "assistant_text" && e.text.toLowerCase().includes("answered in holm")));
  const ended = await until("the forced reply to end", () => {
    const s = lastOf(id);
    if (s?.status === "error") void finish(1, `the forced reply failed: ${JSON.stringify(eventsOf(id).at(-1))}`);
    return s && s.lastSeq >= answered.seq && s.status === "idle" ? s : undefined;
  });
  seen.cAnswered = { seq: answered.seq, thread: ended.claudeSessionId };
  if (ended.claudeSessionId !== threadId) return void finish(1, `the reply moved the session to thread ${ended.claudeSessionId}`);
  return void finish(0, `thread ${threadId} from the terminal was imported as a Codex terminal session, grew live when resumed there, and a reply needed force and was answered in the same thread`);
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
