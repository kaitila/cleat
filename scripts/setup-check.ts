// From a fresh clone to a running app, as a new user does it: `bun scripts/setup-check.ts` (add --keep to leave it all running).
// Needs a desktop, Node with npm, and Claude Code logged in, so it is not part of the test suite or CI.
//
// In a temp folder it makes a home with two projects in it, clones this repo's HEAD, runs `bun install` and
// `bun src/cli.ts setup --yes --workspace <each> --link-dir <a temp bin>` with HOME set to the temp home, then checks
// that the link is there, that the config has the two workspaces, that the shell is installed and runs, and that
// `intuition doctor`, run through the link, reports every check green. Last it runs `intuition uninstall --purge` and
// checks that it removed the link, the shell, start at login and the config, and removes the temp folder.
//
// The temp home moves everything: the config, the data folder, the shell's folders and start at login. The runner gets
// a free port and the fake agent: no real session starts. Inside WSL it uses the linux layout under WSLg, so the
// Windows user's real shell, its settings and its login item are not touched. Claude Code's login is copied into the
// temp home (Linux keeps it in ~/.claude/.credentials.json; a Mac's is in the keychain and needs nothing), and removed with it.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { detectLayout } from "../src/shell/platform";

const REPO = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");

if (process.env.CI) {
  console.log("skipped: setup from a fresh clone needs a desktop, Node with npm and a Claude Code login");
  process.exit(0);
}
const layout = detectLayout() === "windows-wsl" ? "linux" : detectLayout();
if (layout === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error("FAILED: the linux layout needs a display (DISPLAY or WAYLAND_DISPLAY); inside WSL, WSLg gives one");
  process.exit(1);
}

const realHome = homedir();
const dir = mkdtempSync(join(tmpdir(), "intuition-setup-check-"));
const home = join(dir, "home");
const bin = join(dir, "bin");
const clone = join(dir, "intuition");
const workspaces = [join(home, "projects", "website"), join(home, "notes")];
mkdirSync(join(workspaces[0]!, ".git"), { recursive: true });
mkdirSync(workspaces[1]!, { recursive: true });
writeFileSync(join(workspaces[1]!, "CLAUDE.md"), "# notes\n");
mkdirSync(bin);

const credentials = join(realHome, ".claude", ".credentials.json");
if (existsSync(credentials)) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  copyFileSync(credentials, join(home, ".claude", ".credentials.json"));
  chmodSync(join(home, ".claude", ".credentials.json"), 0o600);
}

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
void probe.stop(true);
// The shell finds the runner by its settings' runnerUrl: the free port, written before setup adds where the runner lives.
const shellName = JSON.parse(readFileSync(join(REPO, "shell", "package.json"), "utf8")).name as string;
const appData = layout === "macos" ? join(home, "Library", "Application Support") : join(home, ".config");
mkdirSync(join(appData, shellName), { recursive: true });
writeFileSync(join(appData, shellName, "settings.json"), JSON.stringify({ runnerUrl: `http://127.0.0.1:${port}` }, null, 2) + "\n");

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("INTUITION_") && !k.startsWith("XDG_CONFIG") && !k.startsWith("XDG_DATA")) env[k] = v;
Object.assign(env, {
  HOME: home,
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  INTUITION_PORT: String(port),
  INTUITION_FAKE_AGENT: "1",
  ...(detectLayout() === "windows-wsl" ? { INTUITION_PLATFORM: "linux" } : {}),
  // The downloads are kept in the real caches, so a second run does not fetch them again.
  BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? join(realHome, ".bun", "install", "cache"),
  npm_config_cache: process.env.npm_config_cache ?? join(realHome, ".npm"),
  electron_config_cache: process.env.electron_config_cache ?? join(realHome, layout === "macos" ? "Library/Caches/electron" : ".cache/electron"),
});

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  console.log(`$ ${cmd.join(" ")}`);
  const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const text = out + err;
  if (text.trim()) console.log(text.trimEnd().replace(/^/gm, "  "));
  return { code, out: text };
}

const bad: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) bad.push(what);
};
const linkPath = join(bin, "intuition");
const configFile = join(home, ".config", "intuition", "config.json");
const app = layout === "macos" ? join(home, "Library", "Application Support", "intuition", "shell") : join(home, ".local", "share", "intuition", "shell");

try {
  const head = Bun.spawnSync(["git", "-C", REPO, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  if ((await run(["git", "clone", "--quiet", REPO, clone], dir)).code !== 0) throw new Error("git clone failed");
  if ((await run(["git", "checkout", "--quiet", head], clone)).code !== 0) throw new Error(`git checkout ${head} failed`);
  if ((await run(["bun", "install"], clone)).code !== 0) throw new Error("bun install failed");

  const setup = await run([process.execPath, "src/cli.ts", "setup", "--yes", ...workspaces.flatMap((w) => ["--workspace", w]), "--link-dir", bin], clone);
  check(setup.code === 0, `setup --yes exited 0 (it exited ${setup.code})`);

  let linked = false;
  try {
    linked = lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === join(clone, "src", "cli.ts");
  } catch {
    // Not there.
  }
  check(linked, `${linkPath} links to the clone's src/cli.ts`);

  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null;
  const paths = (config?.workspaces ?? []).map((w: { path: string }) => w.path);
  check(JSON.stringify(paths) === JSON.stringify(workspaces), `${configFile} has the two workspaces (it has ${JSON.stringify(paths)})`);
  check(config?.shell?.startOnLogin === true, "the config has start at login on");
  check(existsSync(join(app, "main.cjs")), `the shell is installed in ${app}`);

  // The shell writes its pid once it is up.
  const pidFile = join(appData, shellName, "shell.pid");
  const end = Date.now() + 20_000;
  while (Date.now() < end && !existsSync(pidFile)) await Bun.sleep(250);
  check(existsSync(pidFile), "the shell runs (it wrote its pid)");

  const doctor = await run(["intuition", "doctor"], home);
  const lines = doctor.out.split("\n").filter((l) => /^\s{2}(ok|MISS|--)\s/.test(l));
  check(doctor.code === 0 && lines.length > 0 && lines.every((l) => l.trimStart().startsWith("ok")), "`intuition doctor`, through the link, reports every check green");
} catch (e) {
  bad.push(e instanceof Error ? e.message : String(e));
  console.log(`FAIL  ${bad.at(-1)}`);
} finally {
  if (keep) {
    console.log(`kept: ${dir}. HOME=${home} PATH=${bin}:$PATH intuition uninstall --purge removes it`);
  } else {
    if (existsSync(linkPath)) {
      const un = await run(["intuition", "uninstall", "--purge", "--link-dir", bin], home);
      check(un.code === 0, "`intuition uninstall --purge` exited 0");
      check(!existsSync(linkPath), "uninstall removed the link");
      check(!existsSync(app), "uninstall removed the shell");
      check(!existsSync(join(home, ".config", "autostart", "intuition.desktop")) || layout === "macos", "uninstall turned start at login off");
      check(!existsSync(configFile), "uninstall --purge removed the config");
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(bad.length === 0 ? "setup from a fresh clone: every check passed" : `FAILED: ${bad.length} check(s)`);
process.exit(bad.length === 0 ? 0 : 1);
