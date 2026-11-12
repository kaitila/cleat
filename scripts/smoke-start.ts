// Smoke check of the shell's way of starting the runner: needs Windows, so it is not part of the
// test suite or CI. Run it with `bun scripts/smoke-start.ts`.
//
// It runs the very command the shell builds (shell/src/wsl.ts) for this distribution, this repo and
// this bun, through the real wsl.exe: `wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env`.
// The runner it starts uses a temp config, a temp data folder, a free port and the fake agent: the
// INTUITION_ variables cross into Windows and back through WSLENV. No Electron, no shell, no login item.
// It exits 0 when wsl.exe has returned, the runner still answers /health afterwards as a process of
// its own, and it got a PATH from the login shell. It stops that runner and removes the folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerCommand } from "../shell/src/wsl";
import { answers, isRunner, LOG_FILE, PID_FILE, stop, URL_FILE } from "../src/cli/runner";
import { runnerLocation } from "../src/shell/install";
import { hasWindows, toWsl } from "../src/shell/paths";

if (process.env.CI || !hasWindows()) {
  console.log("skipped: starting the runner through wsl.exe needs Windows");
  process.exit(0);
}
const wsl = runnerLocation();
if (!wsl) {
  console.error("FAILED: WSL_DISTRO_NAME is not set");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "intuition-smoke-start-"));
mkdirSync(join(dir, "work"));
const env = { INTUITION_CONFIG: join(dir, "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0", INTUITION_FAKE_AGENT: "1" };
writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ workspaces: [{ name: "work", path: join(dir, "work") }] }));

const { file, args } = runnerCommand(wsl);
console.log(`${file} ${JSON.stringify(args)}`);
const bad: string[] = [];
try {
  const started = Date.now();
  // From a Windows folder, as the shell is. WSLENV names the variables wsl.exe hands on.
  const p = Bun.spawn([toWsl(file), ...args], { cwd: "/mnt/c", env: { ...process.env, ...env, WSLENV: Object.keys(env).join(":") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  console.log(`wsl.exe exited ${code} after ${Date.now() - started} ms: ${(out + err).trim()}`);
  if (code !== 0) bad.push(`wsl.exe exited ${code}`);
  // wsl.exe is gone. The runner must not have gone with it.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const pid = Number(readFileSync(join(env.INTUITION_DATA_DIR, PID_FILE), "utf8"));
  const url = readFileSync(join(env.INTUITION_DATA_DIR, URL_FILE), "utf8").trim();
  if (!isRunner(pid)) bad.push(`pid ${pid} is not a running runner three seconds after wsl.exe returned`);
  if (!(await answers(url))) bad.push(`nothing answers at ${url} three seconds after wsl.exe returned`);
  if (isRunner(pid)) {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const path = environ.find((e) => e.startsWith("PATH="))?.slice(5) ?? "";
    console.log(`the runner's PATH: ${path}`);
    // The login shell's PATH holds the folder bun is in, on a machine where bun was installed for the person.
    if (!path.split(":").some((folder) => wsl.bun.startsWith(`${folder}/`))) bad.push("the runner's PATH does not hold bun's folder: the login shell's environment did not arrive");
  }
  console.log(`the runner's log:\n${readFileSync(join(env.INTUITION_DATA_DIR, LOG_FILE), "utf8").trim()}`);
} catch (e) {
  bad.push(e instanceof Error ? e.message : String(e));
} finally {
  await stop(env, console.log);
  rmSync(dir, { recursive: true, force: true });
}
for (const b of bad) console.error(`FAILED: ${b}`);
if (!bad.length) console.log("the runner started through wsl.exe, and outlived it");
process.exit(bad.length ? 1 : 0);
