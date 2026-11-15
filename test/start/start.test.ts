// The runner's start, status, stop and logs commands, run as a person runs them: `bun src/cli.ts <command>`, and `intuition <command>` through a link in a temp folder,
// against a temp config and data folder, a free port and the fake agent.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { DEFAULT_COMMAND, pick } from "../../src/cli/command";
import { defaultDir, link, onPath, unlink } from "../../src/cli/link";
import { commandLine, isRunner, KEPT, LOG_FILE, PID_FILE, runnerCommand, URL_FILE } from "../../src/cli/runner";
import { buildId } from "../../src/runner/build";

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

describe("a runner that runs older code", () => {
  const { env, data } = folders();
  started.push(env);
  const as = (build: string) => ({ ...env, INTUITION_BUILD_ID: build });
  const pidNow = () => Number(readFileSync(join(data, PID_FILE), "utf8"));
  const urlNow = () => readFileSync(join(data, URL_FILE), "utf8").trim();
  const health = async () => (await (await fetch(`${urlNow()}/health`)).json()) as { build: string };

  test("the runner reports the build id it was started with", async () => {
    expect((await cli(as("one"), "start")).code).toBe(0);
    expect(await health()).toMatchObject({ ok: true, build: "one" });
    // The same code: nothing to do.
    expect(await cli(as("one"), "start")).toEqual({ code: 0, out: `already running: ${urlNow()} (pid ${pidNow()})\n` });
  });

  test("start with a changed build id restarts it, says so, and a new process serves the new id", async () => {
    const pid = pidNow();
    const url = urlNow();
    const { code, out } = await cli(as("two"), "start");
    expect(code).toBe(0);
    expect(out).toStartWith(`the runner at ${url} (pid ${pid}) runs older code than this repo's: restarting it\n`);
    expect(out).toContain("intuition runner on ");
    expect(isRunner(pid)).toBe(false);
    expect(pidNow()).not.toBe(pid);
    expect(isRunner(pidNow())).toBe(true);
    expect((await health()).build).toBe("two");
  });

  let title = "";
  test("with a session waiting for approval, start keeps the old process, names the session and exits 3", async () => {
    const res = await fetch(`${urlNow()}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "work", prompt: "needs approval: write it" }) });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; title: string } };
    title = session.title;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const { sessions } = (await (await fetch(`${urlNow()}/api/sessions`)).json()) as { sessions: { id: string; status: string }[] };
      if (sessions.find((s) => s.id === session.id)?.status === "waiting_approval") break;
      await Bun.sleep(20);
    }
    const pid = pidNow();
    const { code, out } = await cli(as("three"), "start");
    expect(code).toBe(KEPT);
    expect(out).toBe(
      `the runner at ${urlNow()} (pid ${pid}) runs older code than this repo's, and was kept: restarting it would cut off\n` +
        `  ${title} (work, waiting for Allow or Deny)\n` +
        "run `intuition restart` once they are done, or `intuition restart --force` now\n",
    );
    expect(pidNow()).toBe(pid);
    expect(isRunner(pid)).toBe(true);
    expect((await health()).build).toBe("two");
  });

  test("restart keeps it too; restart --force cuts the session off and starts the new code", async () => {
    const pid = pidNow();
    const kept = await cli(as("three"), "restart");
    expect(kept.code).toBe(KEPT);
    expect(kept.out).toContain(`  ${title} (work, waiting for Allow or Deny)`);
    expect(isRunner(pid)).toBe(true);
    const forced = await cli(as("three"), "restart", "--force");
    expect(forced.code).toBe(0);
    expect(forced.out).toStartWith(`restarting anyway (--force), which cuts off\n  ${title} (work, waiting for Allow or Deny)\nstopped (pid ${pid})\n`);
    expect(isRunner(pid)).toBe(false);
    expect((await health()).build).toBe("three");
  });

  test("restart with nothing in the way stops and starts, even with the same code; with no runner it starts one", async () => {
    const pid = pidNow();
    const { code, out } = await cli(as("three"), "restart");
    expect(code).toBe(0);
    expect(out).toStartWith(`stopped (pid ${pid})\nintuition runner on `);
    expect(pidNow()).not.toBe(pid);
    expect((await cli(env, "stop")).code).toBe(0);
    const fresh = await cli(as("four"), "restart");
    expect(fresh.code).toBe(0);
    expect(fresh.out).toStartWith("intuition runner on ");
    expect((await health()).build).toBe("four");
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
    let build: string | undefined = buildId();
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, version: "other", build }) });
    try {
      const { env, data } = folders(String(other.port));
      const url = `http://127.0.0.1:${other.port}`;
      expect(await cli(env, "start")).toEqual({ code: 0, out: `already running: ${url} (not started by this command)\n` });
      // Running other code, or from before build ids: kept, since this command cannot restart it, and said.
      for (build of ["older", undefined]) {
        expect(await cli(env, "start")).toEqual({ code: KEPT, out: `already running: ${url} (not started by this command), with older code than this repo's: restart it where it runs\n` });
      }
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

  test("unknown commands and stray words print the usage on stderr and exit 2", async () => {
    const { env } = folders();
    for (const words of [["nope"], ["start", "now"], ["restart", "now"], ["restart", "--force", "x"], ["stop", "x"], ["shell", "login"], ["shell", "login", "maybe"], ["shell", "login", "on", "x"], ["link", "a", "b"], ["help", "x"]]) {
      const p = Bun.spawnSync([process.execPath, CLI, ...words], { cwd: REPO, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(`${words.join(" ")}: ${p.exitCode}`).toBe(`${words.join(" ")}: 2`);
      expect(p.stderr.toString()).toContain("usage: intuition <command>");
      expect(p.stdout.toString()).toBe("");
    }
  });

  test("help, --help and -h print the usage on stdout and exit 0; it names every command as intuition", async () => {
    const { env } = folders();
    for (const word of ["help", "--help", "-h"]) {
      const p = Bun.spawnSync([process.execPath, CLI, word], { cwd: REPO, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      expect(out).toContain("usage: intuition <command>");
      expect(out).toContain("intuition up");
      expect(out).not.toContain("bun src/cli.ts");
      for (const name of ["up", "start", "restart", "stop", "status", "logs", "shell install", "shell login on|off|status", "doctor", "link [dir]", "unlink [dir]", "help"]) expect(out).toContain(`  ${name}`);
    }
  });
});

// `intuition` alone is never run here: it is `up`, which would install and start the real Windows shell.
describe("which command the words name", () => {
  const names = ["up", "start", "shell install", "shell login", "link", "help"];

  test("no words: up", () => {
    expect(DEFAULT_COMMAND).toBe("up");
    expect(pick([], names)).toEqual({ name: "up", rest: [] });
  });

  test("help, --help and -h: help", () => {
    for (const word of ["help", "--help", "-h"]) expect(pick([word], names)).toEqual({ name: "help", rest: [] });
  });

  test("one word or two, with the rest after it", () => {
    expect(pick(["start", "--login-env"], names)).toEqual({ name: "start", rest: ["--login-env"] });
    expect(pick(["shell", "login", "on"], names)).toEqual({ name: "shell login", rest: ["on"] });
    expect(pick(["link", "/some/bin"], names)).toEqual({ name: "link", rest: ["/some/bin"] });
  });

  test("anything else: none", () => {
    for (const words of [["nope"], ["shell"], ["shell", "nope"], ["--version"], [""]]) expect(pick(words, names)).toBeNull();
  });
});

describe("link and unlink", () => {
  // Always a temp folder: the default, the folder bun is in, is the person's real PATH.
  const bin = () => mkdtempSync(join(tmpdir(), "intuition-bin-"));
  const lines = () => {
    const out: string[] = [];
    return { out, log: (line: string) => void out.push(line) };
  };

  test("the default folder is the one bun is in", () => {
    expect(defaultDir()).toBe(dirname(process.execPath));
  });

  test("link makes a symlink named intuition to src/cli.ts, which is executable and starts with the bun line", () => {
    const dir = bin();
    const { out, log } = lines();
    expect(link(dir, { PATH: `/usr/bin:${dir}` }, log)).toBe(0);
    const path = join(dir, "intuition");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(CLI);
    expect(out).toEqual([`${path} -> ${CLI}`, `${dir} is on the PATH: type \`intuition\` in any folder`]);
    expect(statSync(CLI).mode & 0o111).toBe(0o111);
    expect(readFileSync(CLI, "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("it says when the folder is not on the PATH, and still links", () => {
    const dir = bin();
    const { out, log } = lines();
    expect(link(dir, { PATH: "/usr/bin:/bin" }, log)).toBe(0);
    expect(out[1]).toBe(`${dir} is not on the PATH: add it to the PATH, or run link with a folder that is on it`);
    expect(readlinkSync(join(dir, "intuition"))).toBe(CLI);
    expect(link(dir, {}, lines().log)).toBe(0);
  });

  test("the PATH is compared by real folder: a trailing slash or a link to it counts", () => {
    const dir = bin();
    const alias = join(bin(), "alias");
    symlinkSync(dir, alias);
    expect(onPath(dir, { PATH: `${dir}/` })).toBe(true);
    expect(onPath(dir, { PATH: `/usr/bin:${alias}` })).toBe(true);
    expect(onPath(dir, { PATH: "" })).toBe(false);
    expect(onPath(dir, {})).toBe(false);
  });

  test("link replaces its own link, also one written as a relative path", () => {
    const dir = bin();
    const path = join(dir, "intuition");
    expect(link(dir, {}, lines().log)).toBe(0);
    expect(link(dir, {}, lines().log)).toBe(0);
    expect(readlinkSync(path)).toBe(CLI);
    rmSync(path);
    symlinkSync(relative(realpathSync(dir), CLI), path);
    expect(link(dir, {}, lines().log)).toBe(0);
    expect(readlinkSync(path)).toBe(CLI);
  });

  test("link and unlink refuse a real file, a folder, and a link to another program or to nothing, and say what is there", () => {
    const other = join(bin(), "other-program");
    writeFileSync(other, "#!/bin/sh\n");
    const gone = join(bin(), "gone", "src", "cli.ts");
    const cases: [(path: string) => void, string][] = [
      [(path) => writeFileSync(path, "mine\n"), "a file that is not a link"],
      [(path) => mkdirSync(path), "a folder"],
      [(path) => symlinkSync(other, path), `a link to ${other}`],
      [(path) => symlinkSync(gone, path), `a link to ${gone} (which does not exist)`],
    ];
    for (const [make, what] of cases) {
      const dir = bin();
      const path = join(dir, "intuition");
      make(path);
      const before = lstatSync(path);
      const linked = lines();
      expect(link(dir, {}, linked.log)).toBe(1);
      expect(linked.out).toEqual([`${path} is ${what}: not replaced. Remove it yourself, or give link another folder`]);
      const unlinked = lines();
      expect(unlink(dir, unlinked.log)).toBe(1);
      expect(unlinked.out).toEqual([`${path} is ${what}: not removed`]);
      const after = lstatSync(path);
      expect([after.ino, after.isSymbolicLink()]).toEqual([before.ino, before.isSymbolicLink()]);
    }
    expect(readFileSync(other, "utf8")).toBe("#!/bin/sh\n");
  });

  test("link into a folder that is not there: exit 1, nothing made", () => {
    const dir = join(bin(), "missing");
    const { out, log } = lines();
    expect(link(dir, {}, log)).toBe(1);
    expect(out).toEqual([`${dir} is not a folder`]);
    expect(existsSync(dir)).toBe(false);
  });

  test("unlink removes our link, and says so when there is none", () => {
    const dir = bin();
    const path = join(dir, "intuition");
    link(dir, {}, lines().log);
    const first = lines();
    expect(unlink(dir, first.log)).toBe(0);
    expect(first.out).toEqual([`removed ${path}`]);
    expect(existsSync(path)).toBe(false);
    const second = lines();
    expect(unlink(dir, second.log)).toBe(0);
    expect(second.out).toEqual([`no link at ${path}`]);
    expect(existsSync(CLI)).toBe(true);
  });
});

describe("through the link, from another folder", () => {
  const { dir, env } = folders();
  started.push(env);
  const bin = join(dir, "bin");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(bin);
  mkdirSync(elsewhere);
  // The link is run by name, so its first line finds bun on the PATH, as in a terminal.
  const path = [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);

  async function intuition(...words: string[]): Promise<{ code: number; out: string }> {
    const p = Bun.spawn([join(bin, "intuition"), ...words], { cwd: elsewhere, env: { ...process.env, ...env, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: out + err };
  }

  test("bun src/cli.ts link <dir> makes the command, and says the folder is on the PATH", async () => {
    const { code, out } = await cli({ ...env, PATH: path }, "link", bin);
    expect(out).toBe(`${join(bin, "intuition")} -> ${CLI}\n${bin} is on the PATH: type \`intuition\` in any folder\n`);
    expect(code).toBe(0);
  });

  test("intuition help, run by its name", async () => {
    const { code, out } = await intuition("help");
    expect(code).toBe(0);
    expect(out).toContain("usage: intuition <command>");
  });

  test("intuition start finds the runner in the repo, not beside the link or in the current folder; stop stops it", async () => {
    const start = await intuition("start");
    expect(start.out).toMatch(/^intuition runner on http:\/\/127\.0\.0\.1:\d+ /);
    expect(start.code).toBe(0);
    const pid = Number(readFileSync(join(env.INTUITION_DATA_DIR, PID_FILE), "utf8"));
    expect(commandLine(pid)).toContain(join(REPO, "src", "runner", "main.ts"));
    // Its folder: from /proc where there is one (not on a Mac).
    if (existsSync("/proc/self")) expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(REPO);
    const url = start.out.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    // The pages are served from the repo too.
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect(await intuition("status")).toEqual({ code: 0, out: `running: ${url} (pid ${pid})\n` });
    expect(await intuition("stop")).toEqual({ code: 0, out: `stopped (pid ${pid})\n` });
    expect(isRunner(pid)).toBe(false);
  });

  test("intuition unlink <dir> removes it", async () => {
    expect(await intuition("unlink", bin)).toEqual({ code: 0, out: `removed ${join(bin, "intuition")}\n` });
    expect(existsSync(join(bin, "intuition"))).toBe(false);
  });
});

describe("the runner's command line", () => {
  const main = join(REPO, "src", "runner", "main.ts");

  test("plain: bun on the runner's main file", () => {
    expect(runnerCommand(false, "/usr/bin/zsh", "/home/you/.bun/bin/bun")).toEqual(["/home/you/.bun/bin/bun", main]);
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
