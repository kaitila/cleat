// Smoke check of a reply with real Claude Code: needs this machine's Claude Code login, so it is
// not part of the test suite or CI. Run it with `bun scripts/smoke-reply.ts`.
//
// It starts the runner in this process on a free port, with a temp config, a temp data folder and a
// throwaway workspace. It starts one session that asks Claude to remember the word heron, waits for
// it to be idle, then replies asking for the word. It exits 0 when the second turn's assistant text
// contains "heron" and the session is idle again under the same id, with the Claude Code session id
// the SDK reported for the resumed turn (the same one, unless the SDK reports another: the runner
// stores whichever it reports). After 180 seconds it exits 1 and says what it saw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionEvent, SessionMeta, SessionResponse, SessionsResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const TIMEOUT_MS = 180_000;
const FIRST = "Remember the word heron. Reply with exactly: ok";
const SECOND = "Which word did I ask you to remember? Answer with that one word.";

const dir = mkdtempSync(join(tmpdir(), "holm-smoke-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a HOLM_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ HOLM_CONFIG: configFile, HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

const seen = {
  firstIdle: false,
  firstClaudeSessionId: null as string | null,
  replyAccepted: false,
  secondText: "",
  secondResultOk: false,
  secondIdle: false,
  secondClaudeSessionId: null as string | null,
};
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

// This runner has only the one session, so every message on /ws is about it.
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

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  ws.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    if (message.type === "event") {
      events.push(message.event);
      console.log(`event ${JSON.stringify(message.event)}`);
    } else if (message.type === "session") {
      latest = message.session;
      console.log(`session status=${latest.status} claudeSessionId=${latest.claudeSessionId} lastSeq=${latest.lastSeq}`);
      waiting?.();
    }
  };
  await new Promise<void>((resolve) => (ws!.onopen = () => resolve()));

  const started = await post("/api/sessions", { workspace: "smoke", prompt: FIRST });
  if (started.status !== 201) return void finish(1, `POST /api/sessions answered ${started.status}: ${await started.text()}`);
  const { id } = ((await started.json()) as SessionResponse).session;
  console.log(`session ${id} started`);

  const first = await turnEnded(1);
  seen.firstIdle = true;
  seen.firstClaudeSessionId = first.claudeSessionId;
  if (!first.claudeSessionId) return void finish(1, "the first turn ended without a Claude Code session id");

  const replied = await post(`/api/sessions/${id}/messages`, { prompt: SECOND });
  if (replied.status !== 202) return void finish(1, `POST /api/sessions/${id}/messages answered ${replied.status}: ${await replied.text()}`);
  const accepted = ((await replied.json()) as SessionResponse).session;
  if (accepted.id !== id || accepted.status !== "running") return void finish(1, `the reply answered ${JSON.stringify(accepted)}`);
  seen.replyAccepted = true;
  const replySeq = accepted.lastSeq;

  const second = await turnEnded(replySeq);
  seen.secondIdle = true;
  seen.secondClaudeSessionId = second.claudeSessionId;
  const turn = events.filter((e) => e.seq > replySeq);
  seen.secondText = turn.flatMap((e) => (e.kind === "assistant_text" ? [e.text] : [])).join("\n");
  seen.secondResultOk = turn.some((e) => e.kind === "result" && e.ok);

  // What is stored is what the socket said: one session, the same id, idle.
  const { sessions } = (await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse;
  const stored = sessions[0];
  if (sessions.length !== 1 || !stored || stored.id !== id || second.id !== id) return void finish(1, `expected the one session ${id}, stored: ${JSON.stringify(sessions)}`);
  if (stored.status !== "idle") return void finish(1, `the session is ${stored.status}, not idle`);
  if (!stored.claudeSessionId || stored.claudeSessionId !== second.claudeSessionId) return void finish(1, `stored claudeSessionId ${stored.claudeSessionId}, the socket said ${second.claudeSessionId}`);
  if (!seen.secondResultOk) return void finish(1, "the second turn had no ok result");
  if (!seen.secondText.toLowerCase().includes("heron")) return void finish(1, `the second turn's text has no "heron": ${JSON.stringify(seen.secondText)}`);
  const same = stored.claudeSessionId === first.claudeSessionId;
  return void finish(0, `the reply resumed the conversation ("${seen.secondText.trim()}"), the session is idle under the same id, and the SDK reported ${same ? "the same" : "a new"} Claude Code session id`);
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
