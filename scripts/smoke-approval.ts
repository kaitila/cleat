// Smoke check of approvals with real Claude Code: needs this machine's Claude Code login, so it is
// not part of the test suite or CI. Run it with `bun scripts/smoke-approval.ts`.
//
// It starts the runner in this process on a free port, with a temp config, a temp data folder and a
// throwaway workspace, and asks Claude to create proof.txt containing "hi" with the Write tool.
//   Run one: expects an approval_request, answers deny (to every request of the turn), and checks
//            that proof.txt does not exist when the turn ends.
//   Run two: a new session with the same task. It answers allow to the Write of proof.txt (and deny
//            to anything else), and checks that proof.txt exists when the turn ends.
// Exit 0 when both hold. Exit 2 when no approval_request arrives because the person's own Claude
// Code settings already allow the call: it says which setting, and nothing was checked. Exit 1 for
// anything else, and after 240 seconds, with what it saw.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApprovalDecision, ServerMessage, SessionEvent, SessionMeta, SessionResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const TIMEOUT_MS = 240_000;
const PROMPT = "Create a file named proof.txt in the current directory containing exactly: hi\nUse the Write tool for it, nothing else. If the call is denied, do not try another way: just say it was denied.";

type Ask = Extract<SessionEvent, { kind: "approval_request" }>;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "intuition-smoke-")));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const proof = join(workspace, "proof.txt");
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a INTUITION_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ INTUITION_CONFIG: configFile, INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

interface RunSeen {
  approvals: { toolName: string; input: unknown; reason?: string; answered: ApprovalDecision; status: number }[];
  statuses: string[];
  resolved: ApprovalDecision[];
  ended: string | null;
  text: string;
  fileExists: boolean | null;
}
const newRun = (): RunSeen => ({ approvals: [], statuses: [], resolved: [], ended: null, text: "", fileExists: null });
const seen = { deny: newRun(), allow: newRun() };
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

/** The setting of the person's own that lets Claude Code write without asking, as far as this can see. */
function allowingSetting(): string {
  const files = [
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
    "/etc/claude-code/managed-settings.json",
  ];
  const found: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const permissions = (JSON.parse(readFileSync(file, "utf8")) as { permissions?: { defaultMode?: unknown; allow?: unknown } }).permissions ?? {};
      if (typeof permissions.defaultMode === "string" && permissions.defaultMode !== "default") found.push(`permissions.defaultMode "${permissions.defaultMode}" in ${file}`);
      const rules = Array.isArray(permissions.allow) ? permissions.allow.filter((r): r is string => typeof r === "string" && /^(Write|Edit|\*)(\(|$)/.test(r)) : [];
      if (rules.length) found.push(`permissions.allow ${JSON.stringify(rules)} in ${file}`);
    } catch (e) {
      found.push(`${file} could not be read (${(e as Error).message})`);
    }
  }
  return found.length ? found.join("; ") : `none found in ${files.join(" or ")}: look for an allow rule for Write, a defaultMode or a PreToolUse hook in your Claude Code settings`;
}

/** Whether an approval asks for exactly the write this script wants: Write, to proof.txt in the workspace. */
function isTheWrite(ask: Ask): boolean {
  const path = (ask.input as { file_path?: unknown } | null)?.file_path;
  return ask.toolName === "Write" && typeof path === "string" && resolve(workspace, path) === proof;
}

/**
 * Starts a session with the task and answers its approval requests with `decide` until the turn
 * ends. Resolves with what it saw; a turn that failed ends the script.
 */
async function run(name: "deny" | "allow", decide: (ask: Ask) => ApprovalDecision): Promise<RunSeen> {
  const mine = seen[name];
  let id = "";
  let done: () => void = () => {};
  const ended = new Promise<void>((r) => (done = r));
  const early: ServerMessage[] = [];
  const handle = (message: ServerMessage) => {
    if (message.type === "session" && message.session.id === id) {
      const session: SessionMeta = message.session;
      if (mine.statuses.at(-1) !== session.status) mine.statuses.push(session.status);
      console.log(`[${name}] session status=${session.status} lastSeq=${session.lastSeq}`);
      if (session.status === "idle" || session.status === "error") {
        mine.ended = session.status;
        done();
      }
    } else if (message.type === "event" && message.sessionId === id) {
      const event = message.event;
      console.log(`[${name}] event ${JSON.stringify(event)}`);
      if (event.kind === "assistant_text") mine.text += event.text;
      else if (event.kind === "approval_resolved") mine.resolved.push(event.decision);
      else if (event.kind === "approval_request") {
        const answered = decide(event);
        const entry = { toolName: event.toolName, input: event.input, ...(event.reason ? { reason: event.reason } : {}), answered, status: 0 };
        mine.approvals.push(entry);
        void post(`/api/sessions/${id}/approvals/${event.approvalId}`, { decision: answered }).then((res) => {
          entry.status = res.status;
          if (res.status !== 200 && !finished) void finish(1, `answering the approval got ${res.status}`);
        });
      }
    }
  };
  // Messages can arrive before the POST's answer says which session they are about.
  ws!.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    if (id) handle(message);
    else early.push(message);
  };
  const started = await post("/api/sessions", { workspace: "smoke", prompt: PROMPT });
  if (started.status !== 201) return finish(1, `POST /api/sessions answered ${started.status}: ${await started.text()}`);
  id = ((await started.json()) as SessionResponse).session.id;
  console.log(`[${name}] session ${id} started`);
  for (const message of early) handle(message);
  await ended;
  mine.fileExists = existsSync(proof);
  if (mine.ended === "error") return finish(1, `the ${name} run's turn failed`);
  return mine;
}

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  await new Promise<void>((r) => (ws!.onopen = () => r()));

  // Run one: deny everything.
  const denied = await run("deny", () => "deny");
  if (denied.approvals.length === 0) {
    if (denied.fileExists) return void finish(2, `no approval_request arrived and proof.txt was written: your own Claude Code settings already allow the call (${allowingSetting()})`);
    return void finish(1, "no approval_request arrived, and proof.txt was not written either: Claude did not try the Write tool");
  }
  if (!denied.statuses.includes("waiting_approval")) return void finish(1, "the session was never waiting_approval");
  if (denied.resolved.length !== denied.approvals.length || denied.resolved.some((d) => d !== "deny")) return void finish(1, "not every approval was stored as denied");
  if (denied.fileExists) return void finish(1, "proof.txt exists although every approval was denied");

  // Run two: a new session, allow the one write.
  const allowed = await run("allow", (ask) => (isTheWrite(ask) ? "allow" : "deny"));
  if (!allowed.approvals.some((a) => a.answered === "allow")) {
    if (allowed.fileExists) return void finish(2, `the second run wrote proof.txt without an approval_request for it: your own Claude Code settings already allow the call (${allowingSetting()})`);
    return void finish(1, "the second run never asked to Write proof.txt");
  }
  if (!allowed.resolved.includes("allow")) return void finish(1, "the allow was not stored as approval_resolved");
  if (!allowed.fileExists) return void finish(1, "proof.txt does not exist although the Write was allowed");
  const content = readFileSync(proof, "utf8");
  if (content.trim() !== "hi") return void finish(1, `proof.txt contains ${JSON.stringify(content)}, not "hi"`);
  return void finish(0, `denied: ${denied.approvals.length} approval(s), no proof.txt; allowed: proof.txt written with "hi"`);
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
