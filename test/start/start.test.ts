// The runner's start, status, stop and logs commands, run as a person runs them: `bun src/cli.ts <command>`,
// against a temp config and data folder, a free port and the fake agent.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunner, LOG_FILE, PID_FILE, runnerCommand, URL_FILE } from "../../src/cli/runner";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli.ts");

function folders(port = "0") {
  const dir = mkdtempSync(join(tmpdir(), "intuition-start-"));
  mkdirSync(join(dir, "work"));
  const env = { INTUITION_CONFIG: join(dir, "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: port, INTUITION_FAKE_AGENT: "1" };
  writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ workspaces: [{ name: "work", path: join(dir, "work") }] }));
  return { dir, env, data: env.INTUITION_DATA_DIR };
}

async function cli(env: Record<string, string>, ...words: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...words], { cwd: REPO, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const started: Record<string, string>[] = [];
afterAll(async () => {
  for (const env of started) await cli(env, "stop");
});

describe("start, status, stop", () => {
  const { env, data } = folders();
  started.push(env);
  let url = "";
  let pid = 0;

  test("status and stop before any start: not running", async () => {
    expect(await cli(env, "status")).toEqual({ code: 1, out: "not running\n" });
    expect(await cli(env, "stop")).toEqual({ code: 0, out: "not running\n" });
  });

  test("start runs the runner in the background, writes its pid and log, and prints the URL once /health answers", async () => {
    const { code, out } = await cli(env, "start");
    expect(out).toMatch(/^intuition runner on http:\/\/127\.0\.0\.1:\d+ \(pid \d+, log .*runner\.log\)\n$/);
    expect(code).toBe(0);
    url = out.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    pid = Number(readFileSync(join(data, PID_FILE), "utf8"));
    expect(out).toContain(`pid ${pid},`);
    expect(readFileSync(join(data, URL_FILE), "utf8").trim()).toBe(url);
    // The command has returned and the runner lives on, as its own process.
    expect(pid).not.toBe(process.pid);
    expect(isRunner(pid)).toBe(true);
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: true });
    expect(readFileSync(join(data, LOG_FILE), "utf8")).toContain(`intuition runner on ${url}`);
  });

  test("the runner it started uses the config and the data folder it was given", async () => {
    const workspaces = (await (await fetch(`${url}/api/workspaces`)).json()) as { workspaces: { name: string }[] };
    expect(workspaces.workspaces.map((w) => w.name)).toEqual(["work"]);
  });

  test("status says it runs", async () => {
    expect(await cli(env, "status")).toEqual({ code: 0, out: `running: ${url} (pid ${pid})\n` });
  });

  test("a second start says it is already running, exits 0 and starts nothing", async () => {
    expect(await cli(env, "start")).toEqual({ code: 0, out: `already running: ${url} (pid ${pid})\n` });
    expect(Number(readFileSync(join(data, PID_FILE), "utf8"))).toBe(pid);
    expect(isRunner(pid)).toBe(true);
  });

  test("logs prints the end of the log", async () => {
    const { code, out } = await cli(env, "logs");
    expect(code).toBe(0);
    expect(out).toContain(join(data, LOG_FILE));
    expect(out).toContain(`intuition runner on ${url}`);
  });

  test("stop ends the process and removes the pid file; status then says not running", async () => {
    expect(await cli(env, "stop")).toEqual({ code: 0, out: `stopped (pid ${pid})\n` });
    expect(isRunner(pid)).toBe(false);
    expect(existsSync(join(data, PID_FILE))).toBe(false);
    expect(existsSync(join(data, URL_FILE))).toBe(false);
    expect(await fetch(`${url}/health`).then(() => "answers", () => "refused")).toBe("refused");
    expect(await cli(env, "status")).toEqual({ code: 1, out: "not running\n" });
    expect(await cli(env, "stop")).toEqual({ code: 0, out: "not running\n" });
  });

  test("it starts again after a stop, and the log is kept", async () => {
    const { code, out } = await cli(env, "start");
    expect(code).toBe(0);
    expect(Number(readFileSync(join(data, PID_FILE), "utf8"))).not.toBe(pid);
    expect(readFileSync(join(data, LOG_FILE), "utf8").match(/intuition runner on /g)).toHaveLength(2);
    expect(out).toContain("intuition runner on ");
    expect((await cli(env, "stop")).code).toBe(0);
  });
});

describe("edges", () => {
  test("a pid file left by a dead runner, or naming another program, is not believed", async () => {
    const { env, data } = folders();
    mkdirSync(data, { recursive: true });
    // This test's own pid: alive, and not a runner.
    writeFileSync(join(data, PID_FILE), `${process.pid}\n`);
    writeFileSync(join(data, URL_FILE), "http://127.0.0.1:9\n");
    expect(await cli(env, "status")).toEqual({ code: 1, out: "not running\n" });
    expect(existsSync(join(data, PID_FILE))).toBe(false);
    writeFileSync(join(data, PID_FILE), `${process.pid}\n`);
    writeFileSync(join(data, URL_FILE), "http://127.0.0.1:9\n");
    // stop does not signal it.
    expect(await cli(env, "stop")).toEqual({ code: 0, out: "not running\n" });
    expect(isRunner(process.pid)).toBe(false);
  });

  test("a runner that this command did not start is seen on the configured port, and is not stopped", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, version: "other" }) });
    try {
      const { env, data } = folders(String(other.port));
      const url = `http://127.0.0.1:${other.port}`;
      expect(await cli(env, "start")).toEqual({ code: 0, out: `already running: ${url} (not started by this command)\n` });
      expect(existsSync(join(data, PID_FILE))).toBe(false);
      expect(await cli(env, "status")).toEqual({ code: 0, out: `running: ${url} (not started by this command)\n` });
      const stop = await cli(env, "stop");
      expect(stop.code).toBe(1);
      expect(stop.out).toContain("this command did not start it");
      expect((await fetch(`${url}/health`)).ok).toBe(true);
    } finally {
      await other.stop(true);
    }
  });

  test("a runner that cannot start: exit 1 with the end of its log, and no pid file", async () => {
    const { env, data } = folders();
    writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ workspaces: [{ name: "a", path: "/tmp" }, { name: "a", path: "/tmp" }] }));
    const { code, out } = await cli(env, "start");
    expect(code).toBe(1);
    expect(out).toContain('workspace "a" is listed twice');
    expect(existsSync(join(data, PID_FILE))).toBe(false);
  });

  test("unknown commands and stray words print the usage and exit 1", async () => {
    const { env } = folders();
    for (const words of [["nope"], ["start", "now"], ["stop", "x"], ["shell", "login"], ["shell", "login", "maybe"], ["shell", "login", "on", "x"]]) {
      const { code, out } = await cli(env, ...words);
      expect(`${words.join(" ")}: ${code}`).toBe(`${words.join(" ")}: 1`);
      expect(out).toContain("usage: bun src/cli.ts <command>");
    }
    const bare = await cli(env);
    expect(bare.code).toBe(0);
    for (const name of ["up", "start", "stop", "status", "logs", "shell install", "shell login on|off|status"]) expect(bare.out).toContain(`  ${name}`);
  });
});

describe("the runner's command line", () => {
  const main = join(REPO, "src", "runner", "main.ts");

  test("plain: bun on the runner's main file", () => {
    expect(runnerCommand(false, "/usr/bin/zsh", "/root/.bun/bin/bun")).toEqual(["/root/.bun/bin/bun", main]);
  });

  test("--login-env: through the login shell, which execs the runner; the paths are arguments, not script", () => {
    const script = 'exec "$0" "$@"';
    expect(runnerCommand(true, "/usr/bin/zsh", "/home/a b/bun")).toEqual(["/usr/bin/zsh", "-l", "-i", "-c", script, "/home/a b/bun", main]);
    expect(runnerCommand(true, "/bin/bash", "/b; rm -rf ~")).toEqual(["/bin/bash", "-l", "-i", "-c", script, "/b; rm -rf ~", main]);
    expect(runnerCommand(true, "/bin/sh", "/b")).toEqual(["/bin/sh", "-l", "-c", script, "/b", main]);
    // A shell that would not understand the script, or none: /bin/sh.
    for (const shell of ["/usr/bin/fish", "/usr/sbin/nologin", "", null]) expect(runnerCommand(true, shell, "/b")).toEqual(["/bin/sh", "-l", "-c", script, "/b", main]);
  });

  test("the script execs what it is given, so the pid the command records is the runner's", () => {
    const [sh, ...rest] = runnerCommand(true, "/bin/sh", "/bin/echo");
    const p = Bun.spawnSync([sh!, ...rest.slice(0, -1), "a b", "$(id)", ";ls"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    expect(p.stdout.toString()).toBe("a b $(id) ;ls\n");
  });
});
