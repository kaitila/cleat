// `intuition setup` and `intuition uninstall`: their flow with the machine's steps faked, against a temp config
// and data folder, and the pieces they are built from (the answers, the suggestions, the shell's removal).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actions, type Ask, DEFAULTS, firstRun, parseSetupArgs, parseWorkspaceAnswer, setup, shellOsOf, suggestWorkspaces, workspacesFor } from "../../src/cli/setup";
import { parseUninstallArgs, uninstall, type UninstallActions } from "../../src/cli/uninstall";
import { removeShell } from "../../src/shell/install";
import { platformFor, type Platform } from "../../src/shell/platform";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli.ts");

function temp(): string {
  return mkdtempSync(join(tmpdir(), "intuition-setup-"));
}

function folders() {
  const dir = temp();
  const env = { INTUITION_CONFIG: join(dir, "config", "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0", INTUITION_FAKE_AGENT: "1" };
  const home = join(dir, "home");
  for (const p of ["alpha/.git", "notes", "projects/gamma/.git"]) mkdirSync(join(home, p), { recursive: true });
  writeFileSync(join(home, "notes", "CLAUDE.md"), "# notes\n");
  return { dir, env, home };
}

/** The machine's answers: everything there and logged in, unless a command's answer is given. */
function probes(answers: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    "git --version": "git version 2.43.0",
    "node --version": "v22.12.0",
    "npm --version": "10.9.0",
    "claude --version": "2.1.0 (Claude Code)",
    "claude auth status": '{ "loggedIn": true }',
  };
  const all = { ...base, ...answers };
  return { output: (cmd: string[]) => all[cmd.join(" ")] ?? null };
}

/** Fake actions that record what was called, in order. */
function actions(overrides: Partial<Actions> = {}) {
  const calls: string[] = [];
  const a: Actions = {
    claudeLogin: async () => void calls.push("claudeLogin"),
    startRunner: async () => (calls.push("startRunner"), 0),
    installShell: async () => void calls.push("installShell"),
    startShell: (prompt) => void calls.push(`startShell ${prompt ? "prompt" : "quiet"}`),
    login: async (on) => (calls.push(`login ${on ? "on" : "off"}`), on),
    link: (dir) => (calls.push(`link ${dir ?? "default"}`), 0),
    ...overrides,
  };
  return { calls, a };
}

/** Answers given in order, each question recorded. Past the last answer, the default. */
function scripted(answers: (string | boolean)[]): Ask & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    line: async (q, fallback) => {
      asked.push(q);
      const a = answers.shift();
      return typeof a === "string" && a !== "" ? a : fallback;
    },
    yes: async (q, fallback) => {
      asked.push(q);
      const a = answers.shift();
      return typeof a === "boolean" ? a : fallback;
    },
  };
}

const linux: Platform = { ...platformFor("linux"), unavailable: () => null };

function config(env: { INTUITION_CONFIG: string }) {
  return JSON.parse(readFileSync(env.INTUITION_CONFIG, "utf8"));
}

describe("setup's words", () => {
  test("--yes, --workspace any number of times and --link-dir; anything else is refused", () => {
    expect(parseSetupArgs([])).toEqual({ yes: false });
    expect(parseSetupArgs(["--yes", "--workspace", "/a", "--workspace", "/b", "--link-dir", "/bin"])).toEqual({ yes: true, workspaces: ["/a", "/b"], linkDir: "/bin" });
    expect(parseSetupArgs(["-y"])).toEqual({ yes: true });
    expect(parseSetupArgs(["--workspace"])).toBeNull();
    expect(parseSetupArgs(["--workspace", "--yes"])).toBeNull();
    expect(parseSetupArgs(["--force"])).toBeNull();
    expect(parseSetupArgs(["extra"])).toBeNull();
  });

  test("uninstall takes --purge and --link-dir", () => {
    expect(parseUninstallArgs([])).toEqual({ purge: false });
    expect(parseUninstallArgs(["--purge", "--link-dir", "/bin"])).toEqual({ purge: true, linkDir: "/bin" });
    expect(parseUninstallArgs(["--link-dir"])).toBeNull();
    expect(parseUninstallArgs(["--all"])).toBeNull();
  });

  test("the command line refuses other words with the usage and exit code 2", async () => {
    for (const words of [["setup", "--bogus"], ["uninstall", "--nope"]]) {
      const p = Bun.spawn([process.execPath, CLI, ...words], { cwd: REPO, env: { ...process.env, ...folders().env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(2);
      expect(err).toContain("setup [--yes]");
    }
  });

  test("plain intuition runs setup only while there is no config", () => {
    const { env } = folders();
    expect(firstRun(env)).toBe(true);
    mkdirSync(join(env.INTUITION_CONFIG, ".."), { recursive: true });
    writeFileSync(env.INTUITION_CONFIG, "{}");
    expect(firstRun(env)).toBe(false);
  });
});

describe("workspaces", () => {
  test("suggested: folders one or two levels down with a .git or a CLAUDE.md, not inside one, not hidden or in node_modules", () => {
    const { home } = folders();
    for (const p of ["alpha/inner/.git", ".hidden/x/.git", "node_modules/y/.git", "deep/a/b/.git", "plain"]) mkdirSync(join(home, p), { recursive: true });
    writeFileSync(join(home, "file.txt"), "");
    expect(suggestWorkspaces(home)).toEqual([join(home, "alpha"), join(home, "notes"), join(home, "projects", "gamma")]);
    expect(suggestWorkspaces(join(home, "missing"))).toEqual([]);
  });

  test("an answer: numbers pick suggestions, paths are folders, separated by commas", () => {
    const { home } = folders();
    const s = suggestWorkspaces(home);
    expect(parseWorkspaceAnswer("1, 3", s)).toEqual({ ok: true, paths: [s[0]!, s[2]!] });
    expect(parseWorkspaceAnswer("notes,2", s, home)).toEqual({ ok: true, paths: [join(home, "notes")] });
    expect(parseWorkspaceAnswer("", s)).toEqual({ ok: true, paths: [] });
    expect(parseWorkspaceAnswer("none", s)).toEqual({ ok: true, paths: [] });
    expect(parseWorkspaceAnswer("4", s)).toEqual({ ok: false, error: "4 is not one of the numbers listed" });
    expect(parseWorkspaceAnswer("0", s)).toMatchObject({ ok: false });
    expect(parseWorkspaceAnswer("nowhere", s, home)).toEqual({ ok: false, error: "no folder at nowhere" });
  });

  test("named after their folders, a taken name gets -2; one in the config keeps its name and mode", () => {
    expect(workspacesFor(["/a/web", "/b/web", "/c/web"])).toEqual([
      { name: "web", path: "/a/web" },
      { name: "web-2", path: "/b/web" },
      { name: "web-3", path: "/c/web" },
    ]);
    expect(workspacesFor(["/a/web"], [{ name: "site", path: "/a/web", permissionMode: "default" }])).toEqual([{ name: "site", path: "/a/web", permissionMode: "default" }]);
  });

  test("the hotkeys' defaults follow the shell's OS", () => {
    expect(shellOsOf(platformFor("windows-wsl"))).toBe("windows");
    expect(shellOsOf(platformFor("macos"))).toBe("macos");
    expect(shellOsOf(platformFor("linux"))).toBe("linux");
  });
});

describe("setup", () => {
  test("--yes with workspaces: writes the config, starts the runner, installs the shell, start at login on, links, starts the shell without the pop-up", async () => {
    const { env, home } = folders();
    const { calls, a } = actions();
    const lines: string[] = [];
    const code = await setup({ yes: true, workspaces: [join(home, "alpha"), join(home, "notes")], linkDir: "/some/bin" }, linux, a, DEFAULTS, env, (l) => lines.push(l), probes(), home);
    expect(code).toBe(0);
    expect(calls).toEqual(["startRunner", "installShell", "login on", "link /some/bin", "startShell quiet"]);
    expect(config(env)).toMatchObject({
      workspaces: [
        { name: "alpha", path: join(home, "alpha") },
        { name: "notes", path: join(home, "notes") },
      ],
      shell: { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true, startOnLogin: true },
    });
    expect(lines.join("\n")).toContain("done. Press Control+Alt+Space anywhere");
  });

  test("--yes on a Mac takes the Command hotkeys, and without workspaces keeps none", async () => {
    const { env, home } = folders();
    const { a } = actions();
    expect(await setup({ yes: true }, { ...platformFor("macos"), unavailable: () => null }, a, DEFAULTS, env, () => {}, probes(), home)).toBe(0);
    expect(config(env)).toMatchObject({ workspaces: [], shell: { hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S" } });
  });

  test("asked: picks suggestions by number, takes the hotkeys typed, start at login off, and opens the pop-up", async () => {
    const { env, home } = folders();
    const { calls, a } = actions();
    const ask = scripted(["1,3", "Control+Shift+K", "", false]);
    const lines: string[] = [];
    expect(await setup({ yes: false }, linux, a, ask, env, (l) => lines.push(l), probes(), home)).toBe(0);
    expect(lines).toContain(`   1  ${join(home, "alpha")}`);
    expect(config(env)).toMatchObject({
      workspaces: [
        { name: "alpha", path: join(home, "alpha") },
        { name: "gamma", path: join(home, "projects", "gamma") },
      ],
      shell: { hotkey: "Control+Shift+K", snipHotkey: "Control+Alt+S", startOnLogin: false },
    });
    expect(calls).toEqual(["startRunner", "installShell", "login off", "link default", "startShell prompt"]);
  });

  test("a wrong answer is asked again; a second run keeps the other keys and offers the workspaces already there", async () => {
    const { env, home } = folders();
    mkdirSync(join(env.INTUITION_CONFIG, ".."), { recursive: true });
    writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ port: 4999, theme: "dark", extra: 1, workspaces: [{ name: "n", path: join(home, "notes"), permissionMode: "default" }] }));
    const { a } = actions();
    const ask = scripted(["9", "nowhere"]);
    const lines: string[] = [];
    expect(await setup({ yes: false }, linux, a, ask, env, (l) => lines.push(l), probes(), home)).toBe(0);
    expect(lines).toContain("  9 is not one of the numbers listed");
    expect(lines).toContain("  no folder at nowhere");
    // The third question took the default: the workspace already in the config, listed first.
    expect(config(env)).toMatchObject({ port: 4999, theme: "dark", extra: 1, workspaces: [{ name: "n", path: join(home, "notes"), permissionMode: "default" }] });
  });

  test("a missing prerequisite stops it before anything is written, with its fix", async () => {
    const { env, home } = folders();
    const { calls, a } = actions();
    const lines: string[] = [];
    expect(await setup({ yes: true }, linux, a, DEFAULTS, env, (l) => lines.push(l), probes({ "node --version": "v20.1.0" }), home)).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(env.INTUITION_CONFIG)).toBe(false);
    expect(lines.join("\n")).toContain("fix: install Node 22.12");
    expect(lines.at(-1)).toContain("missing: node and npm");
  });

  test("not logged in: asked, it runs the login and checks again; with --yes it only warns and goes on", async () => {
    const { env, home } = folders();
    let loggedIn = false;
    const p = { output: (cmd: string[]) => (cmd.join(" ") === "claude auth status" ? `{ "loggedIn": ${loggedIn} }` : probes().output(cmd)) };
    const { calls, a } = actions({ claudeLogin: async () => void (loggedIn = true) });
    const lines: string[] = [];
    expect(await setup({ yes: false }, linux, a, scripted([true]), env, (l) => lines.push(l), p, home)).toBe(0);
    expect(lines).toContain("  ok    Claude Code login: logged in");
    expect(calls[0]).toBe("startRunner");

    loggedIn = false;
    const quiet = actions({ claudeLogin: async () => void quiet.calls.push("claudeLogin") });
    const out: string[] = [];
    expect(await setup({ yes: true }, linux, quiet.a, DEFAULTS, folders().env, (l) => out.push(l), p, home)).toBe(0);
    expect(quiet.calls).not.toContain("claudeLogin");
    expect(out.join("\n")).toContain("sessions will fail until you log in");
  });

  test("without a display the shell steps are skipped and said so; the runner and the link still happen", async () => {
    const { env, home } = folders();
    const { calls, a } = actions();
    const lines: string[] = [];
    expect(await setup({ yes: true }, { ...platformFor("linux"), unavailable: () => "no display" }, a, DEFAULTS, env, (l) => lines.push(l), probes(), home)).toBe(0);
    expect(calls).toEqual(["startRunner", "link default"]);
    expect(lines.join("\n")).toContain("no display: the tray app is not installed");
  });

  test("a runner that fails to start ends it with start's code; one kept (3) goes on", async () => {
    const { env, home } = folders();
    const failing = actions({ startRunner: async () => 1 });
    expect(await setup({ yes: true }, linux, failing.a, DEFAULTS, env, () => {}, probes(), home)).toBe(1);
    expect(failing.calls).toEqual([]);
    const kept = actions({ startRunner: async () => 3 });
    expect(await setup({ yes: true }, linux, kept.a, DEFAULTS, env, () => {}, probes(), home)).toBe(3);
    expect(kept.calls).toContain("installShell");
  });

  test("a start at login that fails is said, and setup finishes", async () => {
    const { env, home } = folders();
    const { calls, a } = actions({
      login: async () => {
        throw new Error("no login items");
      },
    });
    const lines: string[] = [];
    expect(await setup({ yes: true }, linux, a, DEFAULTS, env, (l) => lines.push(l), probes(), home)).toBe(0);
    expect(lines.join("\n")).toContain("start at login was not changed: no login items");
    expect(calls.at(-1)).toBe("startShell quiet");
  });
});

describe("the terminal's questions", () => {
  test("read stdin line by line; an empty answer and the end of input take the default; yes/no is asked again until it is one", async () => {
    const script = `import { terminalAsk } from ${JSON.stringify(join(REPO, "src", "cli", "setup.ts"))};
const a = terminalAsk((t) => process.stderr.write(t));
console.log(JSON.stringify([await a.line("q", "d"), await a.line("q", "d"), await a.yes("y", false), await a.yes("n", true), await a.line("q", "end")]));`;
    const dir = temp();
    writeFileSync(join(dir, "ask.ts"), script);
    const p = Bun.spawn([process.execPath, join(dir, "ask.ts")], { stdin: new Blob(["typed\n\nmaybe\nyes\nn\n"]), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(JSON.parse(out)).toEqual(["typed", "d", true, false, "end"]);
    expect(err).toContain("answer y or n");
  });
});

describe("uninstall", () => {
  function fake(installed = true) {
    const calls: string[] = [];
    const a: UninstallActions = {
      shellInstalled: () => installed,
      loginOff: async () => void calls.push("loginOff"),
      stopShell: async () => void calls.push("stopShell"),
      removeShell: () => (calls.push("removeShell"), installed ? ["/shell"] : []),
      stopRunner: async () => (calls.push("stopRunner"), 0),
      unlink: (dir) => (calls.push(`unlink ${dir ?? "default"}`), 0),
    };
    return { calls, a };
  }

  test("start at login off, the shell stopped and removed, the runner stopped, the link removed; config and data kept", async () => {
    const { env } = folders();
    mkdirSync(join(env.INTUITION_CONFIG, ".."), { recursive: true });
    writeFileSync(env.INTUITION_CONFIG, "{}");
    mkdirSync(env.INTUITION_DATA_DIR, { recursive: true });
    const { calls, a } = fake();
    const lines: string[] = [];
    expect(await uninstall({ purge: false }, linux, a, env, (l) => lines.push(l))).toBe(0);
    expect(calls).toEqual(["loginOff", "stopShell", "removeShell", "stopRunner", "unlink default"]);
    expect(existsSync(env.INTUITION_CONFIG)).toBe(true);
    expect(existsSync(env.INTUITION_DATA_DIR)).toBe(true);
    expect(lines.join("\n")).toContain("`intuition uninstall --purge` removes them too");
  });

  test("--purge removes the config and the data folder", async () => {
    const { env } = folders();
    mkdirSync(join(env.INTUITION_CONFIG, ".."), { recursive: true });
    writeFileSync(env.INTUITION_CONFIG, '{ "workspaces": [] }');
    mkdirSync(join(env.INTUITION_DATA_DIR, "sessions"), { recursive: true });
    const { a } = fake();
    expect(await uninstall({ purge: true, linkDir: "/b" }, linux, a, env, () => {})).toBe(0);
    expect(existsSync(env.INTUITION_CONFIG)).toBe(false);
    expect(existsSync(join(env.INTUITION_CONFIG, ".."))).toBe(false);
    expect(existsSync(env.INTUITION_DATA_DIR)).toBe(false);
  });

  test("a shell not installed is not stopped; on a Mac its login item is then left; a failing step is said and the rest still run", async () => {
    const { env } = folders();
    const mac = fake(false);
    expect(await uninstall({ purge: false }, { ...platformFor("macos"), unavailable: () => null }, mac.a, env, () => {})).toBe(0);
    expect(mac.calls).toEqual(["removeShell", "stopRunner", "unlink default"]);

    const broken = fake();
    broken.a.stopShell = async () => {
      throw new Error("no answer");
    };
    const lines: string[] = [];
    expect(await uninstall({ purge: false }, linux, broken.a, env, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain("stopping the tray app failed: no answer");
    expect(broken.calls).toContain("unlink default");
  });

  test("windows-wsl without the Windows disk leaves the Windows shell as it is", async () => {
    const { env } = folders();
    const { calls, a } = fake();
    expect(await uninstall({ purge: false }, { ...platformFor("windows-wsl"), unavailable: () => "no /mnt/c" }, a, env, () => {})).toBe(0);
    expect(calls).toEqual(["stopRunner", "unlink default"]);
  });

  test("removeShell: the app folder and the shell's settings folder go, and the home only when nothing else is in it", () => {
    const dir = temp();
    const home = join(dir, "home");
    const paths = { home, app: join(home, "shell"), electronExe: join(home, "shell", "electron") };
    const settings = join(dir, "config", "intuition-shell", "settings.json");
    const platform: Platform = { ...platformFor("linux"), settingsFile: () => settings };
    mkdirSync(join(paths.app, "node_modules"), { recursive: true });
    mkdirSync(join(settings, ".."), { recursive: true });
    writeFileSync(settings, "{}");
    mkdirSync(join(home, "sessions"));
    expect(removeShell(paths, platform)).toEqual([paths.app, join(dir, "config", "intuition-shell")]);
    expect(existsSync(join(home, "sessions"))).toBe(true);
    expect(existsSync(join(dir, "config"))).toBe(true);

    mkdirSync(paths.app);
    const bare = join(dir, "bare");
    expect(removeShell({ home: bare, app: join(bare, "shell"), electronExe: "" }, platform)).toEqual([]);
    mkdirSync(join(bare, "shell"), { recursive: true });
    expect(removeShell({ home: bare, app: join(bare, "shell"), electronExe: "" }, platform)).toEqual([join(bare, "shell"), bare]);
  });
});
