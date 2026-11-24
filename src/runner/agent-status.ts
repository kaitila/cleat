// GET /api/agents: whether each agent can run here, as `cleat doctor` sees it (src/cli/doctor.ts):
// Claude Code installed (the Agent SDK's own binary, else `claude`: `--version`) and logged in (`auth status`), Codex installed
// (the binary the SDK runs, `--version`) and logged in (`codex login status`). The settings page
// shows it beside the agent choice. The commands are the doctor's; their answers are kept a while,
// as each one takes a moment and the page may ask often.
import type { AgentKind, AgentStatus, AgentsResponse } from "../shared/protocol";
import { claudeBinary } from "./agent-claude";
import { codexBinary } from "./agent-codex";

/** What a command prints, trimmed, or null when it can't be run, fails, prints nothing or takes too long. */
export type Output = (cmd: string[]) => Promise<string | null>;

/** How long an answer is kept: long enough for a page that reloads, short enough to see a login. */
export const STATUS_TTL_MS = 30_000;
const TIMEOUT_MS = 10_000;

/** Runs a command with an argument array: its output (stdout, else stderr), or null. */
export const machineOutput: Output = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return null;
    // `codex login status` writes to stderr.
    return out.trim() || err.trim() || null;
  } catch {
    return null;
  }
};

/** Claude Code's status: the doctor's "Claude Code" and "Claude Code login" checks. */
export async function claudeStatus(output: Output, binary: string | null = null): Promise<AgentStatus> {
  const cmd = binary ?? "claude";
  const version = firstLine(await output([cmd, "--version"]));
  if (version === null) return { agent: "claude", installed: false, version: null, loggedIn: false, detail: "Not installed", fix: "cleat update installs it again with the app, then log in: cleat login" };
  const status = await output([cmd, "auth", "status"]);
  const loggedIn = status !== null && /"loggedIn"\s*:\s*true/.test(status);
  return { agent: "claude", installed: true, version, loggedIn, detail: loggedIn ? `${version}, logged in` : `${version}, not logged in`, fix: loggedIn ? "" : "Log in: cleat login" };
}

const firstLine = (text: string | null) => text?.split("\n")[0]?.trim() || null;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Codex's status: the doctor's "Codex" and "Codex login" checks. */
export async function codexStatus(output: Output, binary: string | null): Promise<AgentStatus> {
  const version = binary === null ? null : firstLine(await output([binary, "--version"]));
  if (version === null) return { agent: "codex", installed: false, version: null, loggedIn: false, detail: "Not installed", fix: "cleat update installs it again with the app, then log in: cleat login codex" };
  const status = firstLine(await output([binary!, "login", "status"]));
  const loggedIn = status !== null && /^logged in/i.test(status);
  return { agent: "codex", installed: true, version, loggedIn, detail: loggedIn ? `${version}, ${lower(status!)}` : `${version}, not logged in`, fix: loggedIn ? "" : "Log in: cleat login codex" };
}

/** What the route answers with: a function the server calls for each GET. */
export type AgentStatusSource = () => Promise<AgentsResponse>;

/** The machine's status, asked at most once per STATUS_TTL_MS (and once at a time). */
export function machineStatus(output: Output = machineOutput, binary: () => string | null = codexBinary, now: () => number = Date.now, claude: () => string | null = claudeBinary): AgentStatusSource {
  let kept: { at: number; answer: Promise<AgentsResponse> } | null = null;
  return () => {
    const t = now();
    if (kept === null || t - kept.at >= STATUS_TTL_MS) {
      const answer = Promise.all([claudeStatus(output, claude()), codexStatus(output, binary())]).then((agents) => ({ agents, checkedAt: new Date(t).toISOString() }));
      kept = { at: t, answer };
    }
    return kept.answer;
  };
}

/** With the fake agent (tests, CI) no command runs: both agents are there and logged in. */
export function fakeStatus(): AgentStatusSource {
  const one = (agent: AgentKind): AgentStatus => ({ agent, installed: true, version: "fake", loggedIn: true, detail: "The fake agent stands in", fix: "" });
  return async () => ({ agents: [one("claude"), one("codex")], checkedAt: new Date().toISOString() });
}
