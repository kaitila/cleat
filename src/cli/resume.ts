// `intuition resume [id or prefix]`: continue one of the runner's sessions in this terminal, in
// the agent's own UI. It runs `claude --resume <claudeSessionId>` (`codex resume <thread id>` for a
// Codex session) in the session's folder and hands the terminal over (stdin, stdout and stderr
// inherited) until the agent exits.
import { existsSync } from "node:fs";
import type { SessionMeta, SessionsResponse } from "../shared/protocol";
import { runnerUrl } from "./runner";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/** What resume runs: the command and the folder it runs in. */
export interface ResumePlan {
  session: SessionMeta;
  cmd: string[];
  cwd: string;
}

/** Most recent activity first, as the chat view lists them. */
function newestFirst(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Whether Codex runs the session (agent "codex"); Claude Code otherwise, an absent agent included. */
function isCodex(s: SessionMeta): boolean {
  return s.agent === "codex";
}

/** What the agent calls the conversation whose id resume needs. */
function idName(s: SessionMeta): string {
  return isCodex(s) ? "Codex thread" : "Claude Code session";
}

/** The command that continues the session in its agent's own UI: `codex resume <thread id>` or `claude --resume <id>`. */
export function resumeCmd(s: SessionMeta): string[] {
  return isCodex(s) ? ["codex", "resume", s.claudeSessionId!] : ["claude", "--resume", s.claudeSessionId!];
}

/** One line for a session in a list of matches. */
export function describe(s: SessionMeta): string {
  return `  ${s.id.slice(0, 8)}  ${s.title || "Untitled"} (${s.workspace}${s.claudeSessionId ? "" : `, no ${idName(s)} yet`})`;
}

/**
 * The session `wanted` names and what resuming it runs, or the error to print. No `wanted`: the
 * newest session that has the agent's id (Claude Code's session id or Codex's thread id). Otherwise
 * a runner id, the agent's id, or the start of either, naming exactly one session.
 */
export function plan(sessions: SessionMeta[], wanted?: string): ResumePlan | { error: string } {
  const ordered = newestFirst(sessions);
  let session: SessionMeta | undefined;
  if (!wanted) {
    session = ordered.find((s) => s.claudeSessionId);
    if (!session) return { error: "no session to resume: none has a Claude Code session or a Codex thread yet" };
  } else {
    const exact = ordered.filter((s) => s.id === wanted || s.claudeSessionId === wanted);
    const matches = exact.length ? exact : ordered.filter((s) => s.id.startsWith(wanted) || s.claudeSessionId?.startsWith(wanted));
    if (matches.length === 0) {
      const some = ordered.slice(0, 10);
      return { error: `no session matches "${wanted}"${some.length ? `. The newest:\n${some.map(describe).join("\n")}` : ""}` };
    }
    if (matches.length > 1) return { error: `"${wanted}" matches ${matches.length} sessions: give more of the id\n${matches.map(describe).join("\n")}` };
    session = matches[0]!;
    if (!session.claudeSessionId) return { error: `"${session.title}" has no ${idName(session)} yet: there is nothing to resume` };
  }
  return { session, cmd: resumeCmd(session), cwd: session.cwd };
}

export interface ResumeDeps {
  /** The runner's sessions. By default, asked of the runner that answers. */
  sessions?: () => Promise<SessionMeta[]>;
  /** Runs the command with the terminal handed over and resolves to its exit code. By default Bun.spawn. */
  run?: (cmd: string[], cwd: string) => Promise<number>;
  exists?: (path: string) => boolean;
}

async function runnerSessions(env: Env): Promise<SessionMeta[]> {
  const url = await runnerUrl(env);
  if (!url) throw new Error("the runner is not running: start it with `intuition start`");
  const res = await fetch(new URL("/api/sessions", url), { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`${url}/api/sessions answered ${res.status}`);
  return ((await res.json()) as SessionsResponse).sessions;
}

/** Spawns with stdin, stdout and stderr inherited. Ctrl+C is the agent's while it runs, so this process ignores it. */
export async function runInTerminal(cmd: string[], cwd: string): Promise<number> {
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const child = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
}

/** `intuition resume [wanted]`. Returns the exit code: the agent's, or 1 when there was nothing to run. */
export async function resume(wanted: string | undefined, env: Env = process.env, log: Log = console.log, deps: ResumeDeps = {}): Promise<number> {
  const sessions = await (deps.sessions ?? (() => runnerSessions(env)))();
  const picked = plan(sessions, wanted);
  if ("error" in picked) {
    log(picked.error);
    return 1;
  }
  if (!(deps.exists ?? existsSync)(picked.cwd)) {
    log(`the folder of "${picked.session.title}" is gone: ${picked.cwd}`);
    return 1;
  }
  log(`resuming "${picked.session.title}" in ${picked.cwd}`);
  try {
    return await (deps.run ?? runInTerminal)(picked.cmd, picked.cwd);
  } catch (e) {
    const name = isCodex(picked.session) ? "Codex" : "Claude Code";
    log(`could not run ${picked.cmd[0]}: ${(e as Error).message}. Is ${name} installed and on the PATH?`);
    return 1;
  }
}
