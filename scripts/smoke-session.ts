// Smoke check with real Claude Code: needs this machine's Claude Code login, so it is not part of
// the test suite or CI. Run it with `bun scripts/smoke-session.ts`.
//
// It starts the runner in this process on a free port, with a temp config, a temp data folder and a
// throwaway workspace, starts one session with the prompt "Reply with exactly: pong" and listens on
// /ws. It exits 0 once it has seen "pong" in a delta or an assistant_text, a result event with ok
// true, and the session idle with a claudeSessionId. After 120 seconds it exits 1 and says what it saw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const TIMEOUT_MS = 120_000;
const PROMPT = "Reply with exactly: pong";

const dir = mkdtempSync(join(tmpdir(), "intuition-smoke-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a INTUITION_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ INTUITION_CONFIG: configFile, INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

// This runner has only the one session, so every message on /ws is about it.
const seen = { pong: false, resultOk: false, idleWithClaudeId: false };
let deltas = "";
let finished = false;

async function finish(code: number, why: string): Promise<never> {
  finished = true;
  clearTimeout(timer);
  if (deltas) console.log(`deltas: ${JSON.stringify(deltas)}`);
  console.log(`${code === 0 ? "PASS" : "FAIL"}: ${why}`);
  console.log(`seen: ${JSON.stringify(seen)}`);
  ws.close();
  await runner.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, `not finished after ${TIMEOUT_MS / 1000} seconds`), TIMEOUT_MS);

const ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
ws.onerror = () => void finish(1, "the WebSocket failed");
ws.onmessage = (e) => {
  if (finished) return;
  const message = JSON.parse(String(e.data)) as ServerMessage;
  if (message.type === "hello") return;
  if (message.type === "delta") {
    deltas += message.text;
    if (deltas.includes("pong")) seen.pong = true;
  } else if (message.type === "event") {
    const event = message.event;
    console.log(`event ${JSON.stringify(event)}`);
    if (event.kind === "assistant_text" && event.text.includes("pong")) seen.pong = true;
    if (event.kind === "result" && event.ok) seen.resultOk = true;
    if (event.kind === "error" || (event.kind === "result" && !event.ok)) void finish(1, "the turn failed");
  } else {
    const s = message.session;
    console.log(`session status=${s.status} claudeSessionId=${s.claudeSessionId} lastSeq=${s.lastSeq}`);
    if (s.status === "idle" && s.claudeSessionId) seen.idleWithClaudeId = true;
  }
  if (!finished && seen.pong && seen.resultOk && seen.idleWithClaudeId) void finish(0, "pong, an ok result, and the session idle with a Claude Code session id");
};

ws.onopen = async () => {
  const res = await fetch(`${runner.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: "smoke", prompt: PROMPT }),
  });
  if (res.status !== 201) return void finish(1, `POST /api/sessions answered ${res.status}: ${await res.text()}`);
  console.log(`session ${((await res.json()) as SessionResponse).session.id} started`);
};
