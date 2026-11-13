// The runner as a background process: start, stop, status and logs.
// Its pid, its URL and its log live in the data folder, so INTUITION_DATA_DIR moves all three.
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { buildId } from "../runner/build";
import { type Config, loadConfig } from "../runner/config";
import { HOST, type SessionMeta, type SessionsResponse } from "../shared/protocol";

export const PID_FILE = "runner.pid";
export const URL_FILE = "runner.url";
export const LOG_FILE = "runner.log";
const REPO = join(import.meta.dir, "..", "..");
const MAIN = join(REPO, "src", "runner", "main.ts");
/** How long `start` waits for /health, and `stop` for the process to end. */
const START_MS = 10_000;
const STOP_MS = 5_000;
const LOG_LINES = 200;
/**
 * The exit code of `start`, `up` and `restart` when a runner that runs other code than the repo's was
 * kept (a session was in the way, or this command did not start it): not a failure, but to be noticed.
 */
export const KEPT = 3;

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Files {
  config: Config;
  pid: string;
  url: string;
  log: string;
}

function files(env: Env): Files {
  const config = loadConfig(env);
  return { config, pid: join(config.dataDir, PID_FILE), url: join(config.dataDir, URL_FILE), log: join(config.dataDir, LOG_FILE) };
}

function read(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/** True when the pid is a live runner. A pid file can outlive its process, and the number can be given to another one. */
export function isRunner(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(join("runner", "main.ts"));
  } catch {
    // No /proc here: a live pid from our own file is taken at its word.
    return true;
  }
}

export async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** The build id /health reports: null when nothing answers, "" for a runner from before build ids. */
export async function buildOf(url: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; build?: unknown };
    return body.ok === true ? (typeof body.build === "string" ? body.build : "") : null;
  } catch {
    return null;
  }
}

/** The runner's sessions that a restart would cut off: a turn running, or a tool call waiting for Allow or Deny. */
export async function inTheWay(url: string): Promise<SessionMeta[]> {
  const res = await fetch(new URL("/api/sessions", url), { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`${url}/api/sessions answered ${res.status}`);
  return ((await res.json()) as SessionsResponse).sessions.filter((s) => s.status === "running" || s.status === "waiting_approval");
}

/** One line per session: its title, its workspace and why it is in the way. */
export function describeSessions(sessions: SessionMeta[]): string {
  return sessions.map((s) => `  ${s.title} (${s.workspace}, ${s.status === "running" ? "a turn is running" : "waiting for Allow or Deny"})`).join("\n");
}

/** The runner this data folder recorded, if it still runs. Files left by a dead one are removed. */
function recorded(f: Files): { pid: number; url: string } | null {
  const pid = Number(read(f.pid));
  const url = read(f.url);
  if (Number.isSafeInteger(pid) && pid > 0 && url && isRunner(pid)) return { pid, url };
  rmSync(f.pid, { force: true });
  rmSync(f.url, { force: true });
  return null;
}

/** The URL the config gives, or null with port 0, which names no port until a runner has taken one. */
function configuredUrl(config: Config): string | null {
  return config.port === 0 ? null : `http://${HOST}:${config.port}`;
}

function freePort(): number {
  const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

async function waitFor(done: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return true;
    await sleep(100);
  }
  return false;
}

function tail(file: string, lines = LOG_LINES): string {
  return (read(file) ?? "").split("\n").slice(-lines).join("\n");
}

/** Shells whose `-c` takes `exec "$0" "$@"`. Any other login shell is replaced by /bin/sh. */
const POSIX_SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];

/**
 * The runner's command line. With `loginEnv` it goes through the person's login shell, which reads
 * their profile first and then becomes the runner (`exec`), so the pid is the runner's. The paths
 * are arguments of the shell, never part of its script.
 */
export function runnerCommand(loginEnv: boolean, shell: string | null = userInfo().shell, bun = process.execPath): string[] {
  if (!loginEnv) return [bun, MAIN];
  const sh = shell && POSIX_SHELLS.includes(basename(shell)) ? shell : "/bin/sh";
  // -i as well as -l: PATH is often set in .zshrc or .bashrc, which only an interactive shell reads.
  return [sh, ...(basename(sh) === "sh" || basename(sh) === "dash" ? ["-l"] : ["-l", "-i"]), "-c", 'exec "$0" "$@"', bun, MAIN];
}

export interface StartOptions {
  /** Take the environment from the person's login shell: for a start from Windows, which has none of it. */
  loginEnv?: boolean;
}

/** Starts the runner detached, waits for /health and prints the URL. Returns the exit code. */
export async function start(env: Env = process.env, log: Log = console.log, options: StartOptions = {}): Promise<number> {
  const f = files(env);
  const want = buildId(f.config.buildId);
  const running = recorded(f);
  if (running) {
    if (!(await waitFor(() => answers(running.url), START_MS))) {
      log(`pid ${running.pid} is a runner but nothing answers at ${running.url}: run \`intuition stop\`, then start again`);
      return 1;
    }
    if ((await buildOf(running.url)) === want) {
      log(`already running: ${running.url} (pid ${running.pid})`);
      return 0;
    }
    const blocked = await inTheWay(running.url);
    if (blocked.length > 0) {
      log(
        `the runner at ${running.url} (pid ${running.pid}) runs older code than this repo's, and was kept: restarting it would cut off\n` +
          `${describeSessions(blocked)}\n` +
          "run `intuition restart` once they are done, or `intuition restart --force` now",
      );
      return KEPT;
    }
    log(`the runner at ${running.url} (pid ${running.pid}) runs older code than this repo's: restarting it`);
    await kill(f, running.pid);
  } else {
    const configured = configuredUrl(f.config);
    const build = configured ? await buildOf(configured) : null;
    if (configured && build !== null) {
      if (build === want) {
        log(`already running: ${configured} (not started by this command)`);
        return 0;
      }
      log(`already running: ${configured} (not started by this command), with older code than this repo's: restart it where it runs`);
      return KEPT;
    }
  }
  const port = f.config.port || freePort();
  const url = `http://${HOST}:${port}`;
  const out = openSync(f.log, "a");
  let child;
  try {
    child = Bun.spawn(runnerCommand(Boolean(options.loginEnv)), {
      cwd: REPO,
      env: { ...env, INTUITION_PORT: String(port) },
      stdin: "ignore",
      stdout: out,
      stderr: out,
      detached: true,
    });
  } finally {
    closeSync(out);
  }
  child.unref();
  const up = await waitFor(async () => child.exitCode !== null || (await answers(url)), START_MS);
  if (child.exitCode !== null) {
    // Another start won the port while this one was on its way.
    if (await answers(url)) {
      log(`already running: ${url}`);
      return 0;
    }
    log(`the runner exited with code ${child.exitCode}. The end of ${f.log}:\n${tail(f.log, 20)}`);
    return 1;
  }
  if (!up) {
    child.kill();
    log(`the runner did not answer at ${url} within ${START_MS / 1000} seconds and was stopped. The end of ${f.log}:\n${tail(f.log, 20)}`);
    return 1;
  }
  writeFileSync(f.pid, `${child.pid}\n`);
  writeFileSync(f.url, `${url}\n`);
  log(`intuition runner on ${url} (pid ${child.pid}, log ${f.log})`);
  return 0;
}

/** Stops the runner this data folder recorded. Returns the exit code: 0 also when none ran. */
export async function stop(env: Env = process.env, log: Log = console.log): Promise<number> {
  const f = files(env);
  const running = recorded(f);
  if (!running) {
    const configured = configuredUrl(f.config);
    if (configured && (await answers(configured))) {
      log(`a runner answers at ${configured}, but this command did not start it (no ${f.pid}): stop it where it runs`);
      return 1;
    }
    log("not running");
    return 0;
  }
  await kill(f, running.pid);
  log(`stopped (pid ${running.pid})`);
  return 0;
}

/** Ends the recorded runner, by force after STOP_MS, and removes its files. */
async function kill(f: Files, pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  if (!(await waitFor(() => !isRunner(pid), STOP_MS))) {
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isRunner(pid), STOP_MS);
  }
  rmSync(f.pid, { force: true });
  rmSync(f.url, { force: true });
}

export interface RestartOptions extends StartOptions {
  /** Restart even when sessions are running or waiting for approval: they are cut off. */
  force?: boolean;
}

/**
 * Stops the recorded runner and starts it again, whatever code it runs. Like `start`, it keeps a
 * runner whose sessions are running or waiting for approval (exit KEPT), unless `force`.
 */
export async function restart(env: Env = process.env, log: Log = console.log, options: RestartOptions = {}): Promise<number> {
  const f = files(env);
  const running = recorded(f);
  if (running && (await answers(running.url))) {
    const blocked = await inTheWay(running.url);
    if (blocked.length > 0 && !options.force) {
      log(
        `the runner at ${running.url} (pid ${running.pid}) was kept: restarting it would cut off\n` +
          `${describeSessions(blocked)}\n` +
          "run `intuition restart` once they are done, or `intuition restart --force` now",
      );
      return KEPT;
    }
    if (blocked.length > 0) log(`restarting anyway (--force), which cuts off\n${describeSessions(blocked)}`);
  }
  if (running) {
    await kill(f, running.pid);
    log(`stopped (pid ${running.pid})`);
  }
  return start(env, log, options);
}

/** The URL of the runner that answers: the one this data folder recorded, else the configured port's. Null when none does. */
export async function runnerUrl(env: Env = process.env): Promise<string | null> {
  const f = files(env);
  const running = recorded(f);
  if (running && (await answers(running.url))) return running.url;
  const configured = configuredUrl(f.config);
  return configured && (await answers(configured)) ? configured : null;
}

/** Says whether the runner runs. Returns 0 when it answers, 1 when not. */
export async function status(env: Env = process.env, log: Log = console.log): Promise<number> {
  const f = files(env);
  const running = recorded(f);
  if (running) {
    const ok = await answers(running.url);
    log(ok ? `running: ${running.url} (pid ${running.pid})` : `not answering: pid ${running.pid} is a runner, but nothing answers at ${running.url}`);
    return ok ? 0 : 1;
  }
  const configured = configuredUrl(f.config);
  if (configured && (await answers(configured))) {
    log(`running: ${configured} (not started by this command)`);
    return 0;
  }
  log("not running");
  return 1;
}

/** Prints where the log is and its last lines. */
export function logs(env: Env = process.env, log: Log = console.log): number {
  const f = files(env);
  if (!existsSync(f.log)) {
    log(`no log yet: ${f.log}`);
    return 0;
  }
  log(`${f.log}, its last ${LOG_LINES} lines:`);
  log(tail(f.log));
  return 0;
}
