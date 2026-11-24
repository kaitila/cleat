// Smoke check of the transcript sync with real Claude Code (D0015): needs this machine's Claude Code
// login and the `claude` command, so it is not part of the test suite or CI. Run it with
// `env -u CI bun scripts/smoke-sync.ts`.
//
// It starts the runner in this process on a free port, with a temp config, a temp data folder and a
// throwaway workspace (mkdtemp), and checks:
//   (a) a session started through the runner, then continued in the terminal with
//       `claude -p --resume <claudeSessionId> "Reply with exactly: from terminal"`, streams that turn's
//       user and assistant events in the runner and goes back to idle;
//   (b) a session started in the terminal with `claude -p "Reply with exactly: born in terminal"`
//       appears in GET /api/sessions with source "terminal" and its events; a reply without force is
//       refused with 409 (it was just written), and one with force is answered;
//   (c) Claude Code's resume picker (`claude --resume`, in a pseudo-terminal made by `script`, in the
//       workspace) lists the session of (a) by its title.
// It exits 0 when all three hold and 1 otherwise, saying what it saw. After 300 seconds it exits 1.
// Opening the picker in the workspace answers Claude Code's "trust this folder" question for the
// throwaway folder, as a person would.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_IN_TERMINAL, type EventsResponse, type ServerMessage, type SessionEvent, type SessionMeta, type SessionResponse, type SessionsResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

if (process.env.CI) {
  console.log("SKIPPED: CI is set, and CI has no Claude Code login");
  process.exit(0);
}

const TIMEOUT_MS = 300_000;
const FIRST = "Reply with exactly: from holm";
const TERMINAL = "Reply with exactly: from terminal";
const BORN = "Reply with exactly: born in terminal";
const ANSWER = "Reply with exactly: answered in holm";

const dir = mkdtempSync(join(tmpdir(), "holm-smoke-sync-"));
// The real path: Claude Code names a project's folder after it.
const workspace = join(realpathSync(dir), "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a HOLM_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ HOLM_CONFIG: configFile, HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

/** The terminal's environment: none of a Claude Code session's own variables this script may run in, so `claude` acts as a person's. */
const terminalEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK)/.test(e[0])),
);

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

/** Runs `claude` as a person would in a terminal, in the workspace, and returns its output. */
async function terminal(args: string[]): Promise<string> {
  console.log(`$ claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  const proc = Bun.spawn(["claude", ...args], { cwd: workspace, env: terminalEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  console.log(`  exit ${code}: ${out.trim()}${err.trim() ? ` (stderr: ${err.trim().slice(0, 300)})` : ""}`);
  if (code !== 0) await finish(1, `claude ${args.join(" ")} exited ${code}`);
  return out;
}

/** What a pseudo-terminal showed, without escape sequences and spaces (the picker draws with cursor moves, not spaces). */
const flat = (text: string) => text.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, "");

/** Opens `claude --resume` in a pseudo-terminal in the workspace and returns what it showed once `want` appears, or after 25 s. */
async function picker(want: string): Promise<{ shown: boolean; text: string }> {
  const proc = Bun.spawn(["script", "-qfc", "stty cols 200 rows 50; claude --resume", "/dev/null"], {
    cwd: workspace,
    env: { ...terminalEnv, TERM: "xterm-256color" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let text = "";
  let trusted = false;
  const deadline = Date.now() + 25_000;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let shown = false;
  // One read at a time: a read that loses the race to the timer is kept for the next round, not dropped.
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline) {
    pending ??= reader.read();
    const chunk = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
    if (chunk) pending = null;
    if (chunk?.done) break;
    if (chunk?.value) text += decoder.decode(chunk.value, { stream: true });
    const now = flat(text);
    if (!trusted && /trustthisfolder/i.test(now)) {
      // The throwaway folder is new to Claude Code: choose "Yes, I trust this folder" (below "No, exit").
      trusted = true;
      await Bun.sleep(500);
      proc.stdin.write("\x1b[B");
      await Bun.sleep(300);
      proc.stdin.write("\r");
      proc.stdin.flush();
    }
    if (now.includes(flat(want))) {
      shown = true;
      break;
    }
  }
  proc.stdin.write("\x1b");
  proc.stdin.flush();
  await Bun.sleep(300);
  proc.kill();
  return { shown, text: flat(text) };
}

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onerror = () => void finish(1, "the WebSocket failed");
  ws.onmessage = (e) => {
    if (finished) return;
    const message = JSON.parse(String(e.data)) as ServerMessage;
    messages.push(message);
    if (message.type === "event") console.log(`event ${message.sessionId.slice(0, 8)} ${JSON.stringify(message.event).slice(0, 200)}`);
    else if (message.type === "session") console.log(`session ${message.session.id.slice(0, 8)} ${message.session.source} status=${message.session.status} lastSeq=${message.session.lastSeq} title=${JSON.stringify(message.session.title)}`);
    for (const check of [...waiting]) check();
  };
  await new Promise<void>((resolve) => (ws!.onopen = () => resolve()));

  // (a) A runner session, continued in the terminal.
  const started = await post("/api/sessions", { workspace: "smoke", prompt: FIRST });
  if (started.status !== 201) return void finish(1, `POST /api/sessions answered ${started.status}: ${await started.text()}`);
  const a = ((await started.json()) as SessionResponse).session;
  const first = await until("the first turn to end", () => {
    const s = lastOf(a.id);
    if (s?.status === "error") void finish(1, `the first turn failed: ${JSON.stringify(eventsOf(a.id).at(-1))}`);
    return s?.status === "idle" ? s : undefined;
  });
  if (!first.claudeSessionId) return void finish(1, "the first turn ended without a Claude Code session id");
  seen.a = { id: a.id, claudeSessionId: first.claudeSessionId, title: first.title };
  const before = first.lastSeq;
  await terminal(["-p", "--resume", first.claudeSessionId, TERMINAL]);
  const userSeen = await until("the terminal turn's user event in the runner", () => eventsOf(a.id).find((e) => e.seq > before && e.kind === "user" && e.text.includes(TERMINAL)));
  const answerSeen = await until("the terminal turn's assistant text in the runner", () =>
    eventsOf(a.id).find((e) => e.seq > before && e.kind === "assistant_text" && e.text.toLowerCase().includes("from terminal")),
  );
  await until("the session to show running while the terminal wrote", () => statusesOf(a.id).some((s) => s.lastSeq > before && s.status === "running"));
  await until("the session to go back to idle", () => {
    const s = lastOf(a.id);
    return s && s.lastSeq >= answerSeen.seq && s.status === "idle" ? s : undefined;
  }, 30_000);
  seen.aTerminal = { user: userSeen.seq, assistant: answerSeen.seq, idle: true };

  // (b) A session born in the terminal.
  await terminal(["-p", BORN]);
  let born: SessionMeta | undefined;
  for (let i = 0; i < 40 && !born; i++) {
    const { sessions } = (await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse;
    born = sessions.find((s) => s.source === "terminal" && s.id !== a.id);
    if (!born) await Bun.sleep(500);
  }
  if (!born) return void finish(1, "no session with source terminal appeared in GET /api/sessions");
  const { events } = (await (await fetch(`${runner.url}/api/sessions/${born.id}/events`)).json()) as EventsResponse;
  seen.b = { id: born.id, title: born.title, kinds: events.map((e) => e.kind) };
  if (!events.some((e) => e.kind === "user" && e.text.includes(BORN))) return void finish(1, `the terminal session's events have no user prompt: ${JSON.stringify(events)}`);
  if (!events.some((e) => e.kind === "assistant_text" && e.text.toLowerCase().includes("born in terminal"))) return void finish(1, `the terminal session's events have no answer: ${JSON.stringify(events)}`);
  const refused = await post(`/api/sessions/${born.id}/messages`, { prompt: ANSWER });
  const refusedText = await refused.text();
  seen.bWithoutForce = refused.status;
  if (refused.status !== 409 || !refusedText.includes(OPEN_IN_TERMINAL)) return void finish(1, `a reply without force answered ${refused.status}: ${refusedText}`);
  const replied = await post(`/api/sessions/${born.id}/messages`, { prompt: ANSWER, force: true });
  if (replied.status !== 202) return void finish(1, `a reply with force answered ${replied.status}: ${await replied.text()}`);
  const replySeq = ((await replied.json()) as SessionResponse).session.lastSeq;
  await until("the forced reply's turn to end", () => {
    const s = lastOf(born!.id);
    if (s && s.lastSeq > replySeq && s.status === "error") void finish(1, `the forced reply failed: ${JSON.stringify(eventsOf(born!.id).at(-1))}`);
    return s && s.lastSeq > replySeq && s.status === "idle" ? s : undefined;
  });
  const answer = eventsOf(born.id).filter((e) => e.seq > replySeq && e.kind === "assistant_text").map((e) => (e.kind === "assistant_text" ? e.text : "")).join("\n");
  seen.bAnswer = answer;
  if (!answer.toLowerCase().includes("answered in holm")) return void finish(1, `the forced reply's answer is ${JSON.stringify(answer)}`);
  // The runner's own turn is not taken for the terminal's: nothing of it is stored twice.
  await Bun.sleep(7000);
  const userTurns = eventsOf(born.id).filter((e) => e.kind === "user" && e.text === ANSWER).length;
  if (userTurns !== 1) return void finish(1, `the forced reply's prompt was stored ${userTurns} times`);

  // (c) The runner's session in Claude Code's own resume picker, by its title.
  const { shown, text } = await picker(first.title);
  seen.picker = shown;
  if (!shown) return void finish(1, `claude --resume did not list "${first.title}". It showed: ${text.slice(-1500)}`);
  return void finish(0, "a terminal turn streamed into the runner's session, a terminal session was imported and answered, and claude --resume lists the runner's session by its title");
}

main().catch((e) => void finish(1, `the script threw: ${(e as Error).stack ?? e}`));
