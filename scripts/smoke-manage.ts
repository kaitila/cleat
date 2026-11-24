// Smoke check of session management with real Claude Code: needs this machine's Claude Code login,
// so it is not part of the test suite or CI. Run it with `bun scripts/smoke-manage.ts`.
//
// It starts the runner in this process on a free port, with a temp config, a temp data folder and a
// throwaway workspace (mkdtemp), so several runs can go at once. Against the runner's API it runs two
// tracks at the same time, each on a session of its own:
//   manage: starts a session; renames it and reads the new title back from the transcript
//     (getSessionInfo's customTitle); forks it and sees the fork idle with its own Claude Code session
//     id; replies to the fork and sees that turn finish while it archives and unarchives the session;
//     deletes the session and the fork and sees both transcripts gone (getSessionInfo undefined).
//   stop: starts a session; replies "Count slowly from 1 to 200, one number per line", stops it once
//     the answer streams and sees it idle with a `stopped` event; deletes it.
// It exits 0 when every step did what it should, else 1 with what it saw. After 300 seconds it exits 1.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { EventsResponse, ServerMessage, SessionMeta, SessionResponse, SessionsResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const TIMEOUT_MS = 300_000;
const COUNT = "Count slowly from 1 to 200, one number per line";

const dir = mkdtempSync(join(tmpdir(), "cleat-smoke-manage-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a CLEAT_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ CLEAT_CONFIG: configFile, CLEAT_DATA_DIR: join(dir, "data"), CLEAT_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

const steps: string[] = [];
let ws: WebSocket | undefined;
/** Claude Code session ids made here: deleted at the end if the script fails, so no transcript is left behind. */
const made = new Set<string>();

async function finish(code: number, why: string): Promise<never> {
  clearTimeout(timer);
  console.log(`${code === 0 ? "PASS" : "FAIL"}: ${why}`);
  ws?.close();
  await runner.stop().catch(() => {});
  if (code !== 0) {
    const { deleteSession } = await import("@anthropic-ai/claude-agent-sdk");
    for (const id of made) await deleteSession(id, { dir: workspace }).catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, `not finished after ${TIMEOUT_MS / 1000} seconds. Done: ${steps.join("; ")}`), TIMEOUT_MS);

async function expectThat(cond: unknown, what: string): Promise<void> {
  if (!cond) await finish(1, `${what}. Done before: ${steps.join("; ")}`);
  steps.push(what);
  console.log(`  ok  ${what}`);
}

const post = (path: string, body: unknown) =>
  fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sessionOf = async (res: Response) => ((await res.json()) as SessionResponse).session;
const list = async (query = "") => ((await (await fetch(`${runner.url}/api/sessions${query}`)).json()) as SessionsResponse).sessions;
const eventsOf = async (id: string) => ((await (await fetch(`${runner.url}/api/sessions/${id}/events`)).json()) as EventsResponse).events;
const find = async (id: string) => [...(await list()), ...(await list("?archived=1"))].find((s) => s.id === id);

/** Polls until the session is idle with more events than `after`; a failed turn ends the script. */
async function idleAfter(id: string, after: number): Promise<SessionMeta> {
  for (;;) {
    const s = await find(id);
    if (s?.status === "error") return finish(1, `the turn failed: ${JSON.stringify((await eventsOf(id)).at(-1))}`);
    if (s && s.status === "idle" && s.lastSeq > after) return s;
    await Bun.sleep(250);
  }
}

/** Resolves true on the first streamed text of the session, false after `ms`. */
const onDelta = new Set<(sessionId: string) => void>();
function firstDelta(id: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (sessionId: string) => {
      if (sessionId !== id) return;
      clearTimeout(t);
      onDelta.delete(listener);
      resolve(true);
    };
    const t = setTimeout(() => {
      onDelta.delete(listener);
      resolve(false);
    }, ms);
    onDelta.add(listener);
  });
}

/** Starts a session and waits for it to be idle with a Claude Code session id. */
async function startIdle(prompt: string, what: string): Promise<SessionMeta> {
  const started = await post("/api/sessions", { workspace: "smoke", prompt });
  await expectThat(started.status === 201, `${what}: the session starts (${started.status})`);
  const session = await idleAfter((await sessionOf(started)).id, 0);
  if (session.claudeSessionId) made.add(session.claudeSessionId);
  await expectThat(session.claudeSessionId, `${what}: it is idle with a Claude Code session id (${session.claudeSessionId})`);
  return session;
}

/** Deletes the session and sees its transcript gone. */
async function deleteIt(session: SessionMeta, what: string): Promise<void> {
  const deleted = await post(`/api/sessions/${session.id}/delete`, {});
  await expectThat(deleted.status === 200 && !(await find(session.id)), `${what}: delete removes the session (${deleted.status})`);
  await expectThat((await getSessionInfo(session.claudeSessionId!, { dir: workspace })) === undefined, `${what}: and its transcript`);
  made.delete(session.claudeSessionId!);
}

/** Rename, fork and reply to the fork, archive and unarchive, delete: one session, in order, as each needs the one before. */
async function manageTrack(): Promise<void> {
  const what = "manage";
  const first = await startIdle("Reply with exactly: ok", what);
  const { id } = first;
  const claudeId = first.claudeSessionId!;

  const title = `smoke renamed ${Date.now()}`;
  const renamed = await post(`/api/sessions/${id}/rename`, { title });
  await expectThat(renamed.status === 200 && (await sessionOf(renamed)).title === title, `${what}: rename answers with the new title`);
  const info = await getSessionInfo(claudeId, { dir: workspace });
  await expectThat(info?.customTitle === title, `${what}: the transcript has it as its custom title (${info?.customTitle})`);

  const forked = await post(`/api/sessions/${id}/fork`, {});
  if (forked.status !== 201) await expectThat(false, `${what}: fork answered ${forked.status}: ${await forked.text()} (session: ${JSON.stringify(await find(id))})`);
  const fork = await sessionOf(forked);
  if (fork?.claudeSessionId) made.add(fork.claudeSessionId);
  await expectThat(forked.status === 201 && fork.status === "idle" && fork.title === `${title} (fork)`, `${what}: fork makes an idle '${title} (fork)' (${forked.status})`);
  await expectThat(fork.claudeSessionId && fork.claudeSessionId !== claudeId, `${what}: with its own Claude Code session id (${fork.claudeSessionId})`);
  await expectThat((await getSessionInfo(fork.claudeSessionId!, { dir: workspace })) !== undefined, `${what}: whose transcript exists`);

  // The fork's turn runs while the session is archived and brought back: neither waits for the other.
  const forkTurn = (async () => {
    const forkReply = await post(`/api/sessions/${fork.id}/messages`, { prompt: "Reply with exactly: forked" });
    await expectThat(forkReply.status === 202, `${what}: the fork takes a reply (${forkReply.status})`);
    const forkDone = await idleAfter(fork.id, fork.lastSeq);
    const last = (await eventsOf(fork.id)).at(-1);
    await expectThat(last?.kind === "result" && last.ok, `${what}: and its turn finishes`);
    await expectThat(forkDone.claudeSessionId === fork.claudeSessionId, `${what}: in the fork's own conversation`);
  })();
  const archiving = (async () => {
    await post(`/api/sessions/${id}/archive`, { archived: true });
    await expectThat(!(await list()).some((s) => s.id === id) && (await list("?archived=1")).some((s) => s.id === id), `${what}: archived, it leaves the list for ?archived=1`);
    await post(`/api/sessions/${id}/archive`, { archived: false });
    await expectThat((await list()).some((s) => s.id === id), `${what}: unarchived, it is back`);
  })();
  await Promise.all([forkTurn, archiving]);
  await expectThat((await list()).every((s) => s.source !== "terminal"), `${what}: the fork's transcript was not imported as a terminal session`);

  await Promise.all([deleteIt(first, what), deleteIt(fork, `${what} (fork)`)]);
}

/** Stop: a session of its own, so the long turn runs while the other track works. */
async function stopTrack(): Promise<void> {
  const what = "stop";
  const session = await startIdle("Reply with exactly: ok", what);
  const streaming = firstDelta(session.id, 60_000);
  const replied = await post(`/api/sessions/${session.id}/messages`, { prompt: COUNT });
  await expectThat(replied.status === 202, `${what}: the long reply is taken (${replied.status}${replied.status === 202 ? "" : `: ${await replied.text()}`})`);
  await expectThat(await streaming, `${what}: its answer streams`);
  await Bun.sleep(1500);
  const stopped = await post(`/api/sessions/${session.id}/stop`, {});
  const afterStop = await sessionOf(stopped);
  await expectThat(stopped.status === 200 && afterStop.status === "idle", `${what}: stop answers with the session idle (${stopped.status}, ${afterStop.status})`);
  const events = (await eventsOf(session.id)).filter((e) => e.seq > session.lastSeq);
  await expectThat(events.at(-1)?.kind === "stopped", `${what}: its last event is stopped (${events.map((e) => e.kind).join(", ")})`);
  await expectThat(!events.some((e) => e.kind === "result" || e.kind === "error"), `${what}: with no result or error from the interrupted turn`);
  await deleteIt(session, what);
}

async function main(): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    if (m.type === "delta") for (const listener of [...onDelta]) listener(m.sessionId);
  };
  await new Promise((resolve) => (ws!.onopen = resolve));
  // The two tracks share nothing but the runner: they run at once.
  await Promise.all([manageTrack(), stopTrack()]);
  await finish(0, `${steps.length} checks`);
}

main().catch((e) => void finish(1, (e as Error).stack ?? String(e)));
