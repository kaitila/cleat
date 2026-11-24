// Smoke check of auto mode with real Claude Code: needs this machine's Claude Code login, so it is
// not part of the test suite or CI. Run it with `env -u CI bun scripts/smoke-auto.ts`.
//
// It starts the runner in this process on a free port, with a temp config that leaves permissionMode
// out (so the default, "auto", applies), a temp data folder and a throwaway workspace, and asks Claude
// to create proof.txt containing "hi". It checks that the turn finishes without any approval_request,
// that proof.txt exists with "hi", and that the session reports the mode in effect.
// It never answers an approval: one that arrives is denied, and the check fails.
// Exit 0 when all hold. Exit 2 when Claude Code runs the session in another mode than auto (the
// account or this machine has no auto mode): it says which, and nothing more was checked. Exit 1
// for anything else, and after 240 seconds, with what it saw.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionEvent, SessionMeta, SessionResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

if (process.env.CI) {
  console.log("SKIPPED: CI is set, and CI has no Claude Code login");
  process.exit(0);
}

const TIMEOUT_MS = 240_000;
const PROMPT = "Create a file named proof.txt in the current directory containing exactly: hi\nUse the Write tool for it, nothing else.";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "holm-smoke-auto-")));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const proof = join(workspace, "proof.txt");
const configFile = join(dir, "config.json");
// No permissionMode: the default config's mode is what is checked.
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a HOLM_FAKE_AGENT left in the shell can't turn this into a fake run.
const config = loadConfig({ HOLM_CONFIG: configFile, HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0" });
const runner = startServer(config);
console.log(`runner on ${runner.url}, workspace ${workspace}, permissionMode asked for: ${config.permissionMode}`);

const seen = {
  asked: config.permissionMode,
  modes: [] as string[],
  approvals: [] as { toolName: string; input: unknown }[],
  autoDenied: [] as SessionEvent[],
  ended: null as string | null,
  text: "",
};
let finished = false;
let ws: WebSocket | undefined;

async function finish(code: number, why: string): Promise<never> {
  finished = true;
  clearTimeout(timer);
  console.log(`${code === 0 ? "PASS" : code === 2 ? "NOT CHECKED" : "FAIL"}: ${why}`);
  console.log(`seen: ${JSON.stringify(seen)}`);
  ws?.close();
  await runner.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, `not finished after ${TIMEOUT_MS / 1000} seconds`), TIMEOUT_MS);

const post = (path: string, body: unknown) =>
  fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  if (config.permissionMode !== "auto") return void finish(1, `the default config asks for ${config.permissionMode}, not auto`);
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  await new Promise<void>((r) => (ws!.onopen = () => r()));

  let id = "";
  let done: () => void = () => {};
  const ended = new Promise<void>((r) => (done = r));
  const early: ServerMessage[] = [];
  const handle = (message: ServerMessage) => {
    if (message.type === "session" && message.session.id === id) {
      const session: SessionMeta = message.session;
      if (session.permissionMode && seen.modes.at(-1) !== session.permissionMode) seen.modes.push(session.permissionMode);
      console.log(`session status=${session.status} permissionMode=${session.permissionMode ?? "-"} lastSeq=${session.lastSeq}`);
      if (session.status === "idle" || session.status === "error") {
        seen.ended = session.status;
        done();
      }
    } else if (message.type === "event" && message.sessionId === id) {
      const event = message.event;
      console.log(`event ${JSON.stringify(event)}`);
      if (event.kind === "assistant_text") seen.text += event.text;
      else if (event.kind === "auto_denied") seen.autoDenied.push(event);
      else if (event.kind === "approval_request") {
        seen.approvals.push({ toolName: event.toolName, input: event.input });
        // This check is that nothing asks: deny, so the turn can end, and fail below.
        void post(`/api/sessions/${id}/approvals/${event.approvalId}`, { decision: "deny" });
      }
    }
  };
  // Messages can arrive before the POST's answer says which session they are about.
  ws.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    if (id) handle(message);
    else early.push(message);
  };
  const started = await post("/api/sessions", { workspace: "smoke", prompt: PROMPT });
  if (started.status !== 201) return void finish(1, `POST /api/sessions answered ${started.status}: ${await started.text()}`);
  id = ((await started.json()) as SessionResponse).session.id;
  console.log(`session ${id} started`);
  for (const message of early) handle(message);
  await ended;

  const mode = seen.modes.at(-1);
  if (!mode) return void finish(1, "the session never reported the permission mode in effect");
  if (mode !== "auto") return void finish(2, `the session asked for auto but Claude Code runs it in "${mode}": this account or machine has no auto mode (or a setting turns it off)`);
  if (seen.ended !== "idle") return void finish(1, "the turn failed");
  if (seen.approvals.length) return void finish(1, `${seen.approvals.length} approval_request(s) arrived in auto mode`);
  if (!existsSync(proof)) return void finish(1, "proof.txt does not exist");
  const content = readFileSync(proof, "utf8");
  if (content.trim() !== "hi") return void finish(1, `proof.txt contains ${JSON.stringify(content)}, not "hi"`);
  return void finish(0, `ran in auto mode with no approval_request; proof.txt written with "hi"`);
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
