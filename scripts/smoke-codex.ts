// Smoke check of the Codex agent with real Codex: needs this machine's Codex login (~/.codex), so it
// is not part of the test suite or CI. Run it with `env -u CI bun scripts/smoke-codex.ts`.
//
// It starts the runner in this process on a free port, with a temp config whose one workspace (a
// throwaway mkdtemp folder) runs on Codex, a temp data folder, and the auto permission mode. Then:
//   1. a session with "Reply with exactly: pong": the text has pong, the result is ok, the session is
//      idle with agent "codex" and a thread id;
//   2. a reply "Which word did you just reply with?": the text has pong (the thread was resumed), the
//      thread id is the same;
//   3. a reply asking for proof.txt containing hi: the file is in the workspace with "hi", and the turn
//      stored a tool_use and its tool_result.
// Exit 0 when all three hold, 1 with what it saw when one doesn't (or after 300 seconds), and 2 when
// Codex is not installed or not logged in.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionEvent, SessionMeta, SessionResponse } from "../src/shared/protocol";
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
const FIRST = "Reply with exactly: pong";
const SECOND = "Which word did you just reply with? Answer with that one word.";
const THIRD = "Create a file named proof.txt in the current folder whose whole content is the two letters hi (no punctuation). Then reply with the word done.";

const dir = mkdtempSync(join(tmpdir(), "intuition-smoke-codex-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace, agent: "codex" }] }));
// Its own environment, so a INTUITION_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ INTUITION_CONFIG: configFile, INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0" }));
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

const events: SessionEvent[] = [];
let waiting: (() => void) | null = null;
let latest: SessionMeta | null = null;

/** Resolves with the session once a turn that stored events after `after` has ended; a failed turn ends the script. */
function turnEnded(after: number): Promise<SessionMeta> {
  return new Promise((resolve) => {
    const check = () => {
      if (!latest || latest.lastSeq <= after) return;
      if (latest.status === "error") return void finish(1, `the turn failed: ${JSON.stringify(events.at(-1))}`);
      if (latest.status !== "idle") return;
      waiting = null;
      resolve({ ...latest });
    };
    waiting = check;
    check();
  });
}

function turnAfter(seq: number) {
  const turn = events.filter((e) => e.seq > seq);
  return {
    turn,
    text: turn.flatMap((e) => (e.kind === "assistant_text" ? [e.text] : [])).join("\n"),
    ok: turn.some((e) => e.kind === "result" && e.ok),
  };
}

async function reply(id: string, prompt: string): Promise<number> {
  const res = await post(`/api/sessions/${id}/messages`, { prompt });
  if (res.status !== 202) return finish(1, `POST /api/sessions/${id}/messages answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as SessionResponse).session.lastSeq;
}

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  ws.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    if (message.type === "event") {
      events.push(message.event);
      console.log(`event ${JSON.stringify(message.event).slice(0, 300)}`);
    } else if (message.type === "session") {
      latest = message.session;
      console.log(`session status=${latest.status} agent=${latest.agent} thread=${latest.claudeSessionId} lastSeq=${latest.lastSeq}`);
      waiting?.();
    }
  };
  await new Promise<void>((resolve) => (ws!.onopen = () => resolve()));

  // 1. A new Codex thread.
  const started = await post("/api/sessions", { workspace: "smoke", prompt: FIRST });
  if (started.status !== 201) return void finish(1, `POST /api/sessions answered ${started.status}: ${await started.text()}`);
  const created = ((await started.json()) as SessionResponse).session;
  if (created.agent !== "codex") return void finish(1, `the session's agent is ${created.agent}, not codex`);
  const first = await turnEnded(1);
  const one = turnAfter(0);
  seen.first = { text: one.text, ok: one.ok, thread: first.claudeSessionId };
  if (!first.claudeSessionId) return void finish(1, "the first turn ended without a Codex thread id");
  if (!one.ok || !one.text.toLowerCase().includes("pong")) return void finish(1, "the first turn did not answer pong with an ok result");

  // 2. The reply resumes the thread.
  const at2 = await reply(created.id, SECOND);
  const second = await turnEnded(at2);
  const two = turnAfter(at2);
  seen.second = { text: two.text, ok: two.ok, thread: second.claudeSessionId };
  if (second.claudeSessionId !== first.claudeSessionId) return void finish(1, `the thread id changed: ${first.claudeSessionId} -> ${second.claudeSessionId}`);
  if (!two.ok || !two.text.toLowerCase().includes("pong")) return void finish(1, "the reply did not remember pong: the thread was not resumed");

  // 3. A file in the workspace, through Codex's workspace-write sandbox (auto mode).
  const at3 = await reply(created.id, THIRD);
  await turnEnded(at3);
  const three = turnAfter(at3);
  const proof = join(workspace, "proof.txt");
  const content = existsSync(proof) ? readFileSync(proof, "utf8") : null;
  const uses = three.turn.filter((e) => e.kind === "tool_use");
  const results = three.turn.filter((e) => e.kind === "tool_result");
  seen.third = { text: three.text, ok: three.ok, content, tools: uses.map((e) => (e.kind === "tool_use" ? e.name : "")) };
  if (!three.ok) return void finish(1, "the file turn had no ok result");
  if (content === null || content.trim() !== "hi") return void finish(1, `proof.txt is ${content === null ? "missing" : JSON.stringify(content)}`);
  if (uses.length === 0 || results.length === 0) return void finish(1, "the file turn stored no tool_use and tool_result");
  const linked = uses.every((u) => u.kind === "tool_use" && results.some((r) => r.kind === "tool_result" && r.toolUseId === u.toolUseId));
  if (!linked) return void finish(1, "a tool_use has no tool_result with its id");
  return void finish(0, `Codex answered pong, the reply resumed thread ${first.claudeSessionId}, and it wrote proof.txt with ${uses.length} tool call(s)`);
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
