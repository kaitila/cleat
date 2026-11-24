// `holm setup` and `holm uninstall`: their flow with the machine's steps faked and the questions
// scripted, against a temp config, data folder and HOME, and the pieces they are built from.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actions, type Ask, CANCEL, CANCELLED, DEFAULTS, firstRun, MAX_SUGGESTIONS, NO_TERMINAL, nameFor, parseSetupArgs, parseWorkspaceFlag, setup, type SetupOptions, shellOsOf, suggestWorkspaces, unanswered, workspacesFor } from "../../src/cli/setup";
import { makeUi } from "../../src/cli/ui";
import { parseUninstallArgs, uninstall, type UninstallActions } from "../../src/cli/uninstall";
import { removeShell } from "../../src/shell/install";
import { platformFor, type Platform } from "../../src/shell/platform";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli.ts");

function temp(): string {
  return mkdtempSync(join(tmpdir(), "holm-setup-"));
}

/** A temp config, data folder and HOME with three project folders: alpha (newest), notes (a CLAUDE.md), projects/gamma (oldest). */
function folders() {
  const dir = temp();
  const env = { HOLM_CONFIG: join(dir, "config", "config.json"), HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0", HOLM_FAKE_AGENT: "1" };
  const home = join(dir, "home");
  for (const p of ["alpha/.git", "notes", "projects/gamma/.git"]) mkdirSync(join(home, p), { recursive: true });
  writeFileSync(join(home, "notes", "CLAUDE.md"), "# notes\n");
  const at = (p: string, t: number) => utimesSync(join(home, p), t, t);
  at("projects/gamma/.git", 1_000);
  at("projects/gamma", 1_000);
  at("notes/CLAUDE.md", 2_000);
  at("notes", 2_000);
  at("alpha/.git", 3_000);
  at("alpha", 3_000);
  return { dir, env, home };
}

/** The machine's answers: everything there and logged in, unless a command's answer is given. No Codex. */
function probes(answers: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    "git --version": "git version 2.43.0",
    "node --version": "v22.12.0",
    "npm --version": "10.9.0",
    "claude --version": "2.1.0 (Claude Code)",
    "claude auth status": '{ "loggedIn": true }',
  };
  const all = { ...base, ...answers };
  return { output: (cmd: string[]) => all[cmd.join(" ")] ?? null, codex: () => null as string | null };
}

/** Fake actions that record what was called, in order. */
function actions(overrides: Partial<Actions> = {}) {
  const calls: string[] = [];
  const a: Actions = {
    link: (dir) => (calls.push(`link ${dir ?? "default"}`), 0),
    installShell: async (log) => (calls.push("installShell"), log("installing Electron 39 for linux")),
    startRunner: async (log) => (calls.push("startRunner"), log("holm runner on http://127.0.0.1:4999 (pid 1, log x)"), 0),
    runnerUrl: async () => "http://127.0.0.1:4999",
    startShell: (prompt) => void calls.push(`startShell ${prompt ? "prompt" : "quiet"}`),
    login: async (on) => (calls.push(`login ${on ? "on" : "off"}`), on),
    ...overrides,
  };
  return { calls, a };
}

type Answer = unknown;

/** Answers given in order, each question's message recorded; `CANCEL` answers as Esc would. Past the last answer, the initial value. */
function scripted(answers: Answer[]): Ask & { asked: string[]; refused: string[] } {
  const asked: string[] = [];
  const refused: string[] = [];
  const next = <T>(message: string, initial: T): T => {
    asked.push(message);
    return (answers.length > 0 ? answers.shift() : initial) as T;
  };
  return {
    asked,
    refused,
    multiselect: async (o) => next(o.message, o.initial),
    select: async (o) => next(o.message, o.initial),
    confirm: async (o) => next(o.message, o.initial),
    text: async (o) => {
      // A text answer goes through validate, as clack does: a refused one is recorded and the next answer is tried.
      for (;;) {
        const v: unknown = next(o.message, o.initial ?? "");
        if (v === CANCEL || typeof v !== "string") return v as typeof CANCEL;
        const why = o.validate?.(v);
        if (!why) return v;
        refused.push(why);
      }
    },
  };
}

const linux: Platform = { ...platformFor("linux"), unavailable: () => null };

/** A plain ui (no terminal, no colour) whose text is kept. */
function plain() {
  let text = "";
  const ui = makeUi({ term: { interactive: false, color: false, unicode: true, columns: 80 }, write: (t) => void (text += t) });
  return { ui, text: () => text };
}

function config(env: { HOLM_CONFIG: string }) {
  return JSON.parse(readFileSync(env.HOLM_CONFIG, "utf8"));
}

/** Runs setup with a plain ui; `interactive` says whether a scripted Ask may be asked. */
async function run(options: Partial<SetupOptions>, ask: Ask = DEFAULTS, over: { platform?: Platform; actions?: Actions; probes?: ReturnType<typeof probes>; f?: ReturnType<typeof folders>; interactive?: boolean } = {}) {
  const f = over.f ?? folders();
  const out = plain();
  const fake = actions();
  const code = await setup({ yes: false, ...options }, over.platform ?? linux, over.actions ?? fake.a, ask, { env: f.env, home: f.home, probes: over.probes ?? probes(), ui: out.ui, version: "0.1.0", interactive: over.interactive ?? true });
  return { code, text: out.text(), calls: fake.calls, ...f };
}

describe("setup's flags", () => {
  test("--yes, --workspace name=path or path (repeatable), --link-dir, --no-login, --permission-mode, --hotkey, --snip-hotkey", () => {
    const { home } = folders();
    const parsed = parseSetupArgs(["-y", "--workspace", `web=${join(home, "alpha")}`, `--workspace=${join(home, "notes")}`, "--link-dir", "/bin", "--no-login", "--permission-mode", "ask", "--hotkey", "Control+Shift+K", "--snip-hotkey=Alt+F2"]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        yes: true,
        workspaces: [{ name: "web", path: join(home, "alpha") }, { path: join(home, "notes") }],
        linkDir: "/bin",
        login: false,
        permissionMode: "default",
        hotkey: "Control+Shift+K",
        snipHotkey: "Alt+F2",
      },
    });
    expect(parseSetupArgs([])).toEqual({ ok: true, options: { yes: false } });
    expect(parseSetupArgs(["--permission-mode", "auto"])).toEqual({ ok: true, options: { yes: false, permissionMode: "auto" } });
  });

  test("a wrong word is refused with why: an unknown flag, a missing value, no folder, a bad mode, a hotkey Electron would refuse", () => {
    const { home } = folders();
    expect(parseSetupArgs(["--force"])).toEqual({ ok: false, error: "unknown option: --force" });
    expect(parseSetupArgs(["extra"])).toEqual({ ok: false, error: "unknown option: extra" });
    expect(parseSetupArgs(["--workspace"])).toEqual({ ok: false, error: "--workspace needs a value" });
    expect(parseSetupArgs(["--hotkey", "--yes"])).toEqual({ ok: false, error: "--hotkey needs a value" });
    expect(parseSetupArgs(["--workspace", join(home, "nowhere")])).toMatchObject({ ok: false, error: expect.stringContaining("no folder at") });
    expect(parseSetupArgs(["--permission-mode", "bypassPermissions"])).toMatchObject({ ok: false, error: expect.stringContaining("use auto, or default") });
    expect(parseSetupArgs(["--hotkey", "Space"])).toMatchObject({ ok: false, error: expect.stringContaining("add a modifier") });
    expect(parseSetupArgs(["--snip-hotkey", "Control+Banana"])).toMatchObject({ ok: false, error: expect.stringContaining("Banana is not a key") });
  });

  test("--workspace: a name has no slash; ~ is the home folder; an empty name is refused", () => {
    const { home } = folders();
    expect(parseWorkspaceFlag("alpha", home)).toEqual({ ok: true, entry: { path: join(home, "alpha") } });
    expect(parseWorkspaceFlag("n=notes", home)).toEqual({ ok: true, entry: { name: "n", path: join(home, "notes") } });
    expect(parseWorkspaceFlag("=notes", home)).toMatchObject({ ok: false });
    expect(parseWorkspaceFlag("x=", home)).toMatchObject({ ok: false, error: expect.stringContaining("no folder given") });
  });

  test("the flags that answer every question; without a terminal, setup needs them or --yes", () => {
    expect(unanswered({ yes: false })).toEqual(["--workspace", "--hotkey", "--snip-hotkey", "--permission-mode"]);
    expect(unanswered({ yes: false, workspaces: [], hotkey: "Alt+A", snipHotkey: "Alt+B", permissionMode: "auto" })).toEqual([]);
  });

  test("the command line refuses other words with why, the help and exit code 2", async () => {
    for (const words of [["setup", "--bogus"], ["uninstall", "--nope"], ["doctor", "--yaml"]]) {
      const p = Bun.spawn([process.execPath, CLI, ...words], { cwd: REPO, env: { ...process.env, ...folders().env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toContain(words[1]!);
      expect(err).toContain("SETUP FLAGS");
    }
  });

  test("plain holm runs setup only while there is no config", () => {
    const { env } = folders();
    expect(firstRun(env)).toBe(true);
    mkdirSync(join(env.HOLM_CONFIG, ".."), { recursive: true });
    writeFileSync(env.HOLM_CONFIG, "{}");
    expect(firstRun(env)).toBe(false);
  });
});

describe("workspaces", () => {
  test("suggested: git repositories and CLAUDE.md folders one or two levels down, newest first; not inside one, hidden or in node_modules", () => {
    const { home } = folders();
    for (const p of ["alpha/inner/.git", ".hidden/x/.git", "node_modules/y/.git", "deep/a/b/.git", "plain"]) mkdirSync(join(home, p), { recursive: true });
    writeFileSync(join(home, "file.txt"), "");
    expect(suggestWorkspaces(home)).toEqual([join(home, "alpha"), join(home, "notes"), join(home, "projects", "gamma")]);
    expect(suggestWorkspaces(join(home, "missing"))).toEqual([]);
  });

  test(`at most ${MAX_SUGGESTIONS}, the newest`, () => {
    const home = join(temp(), "home");
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(home, `p${i}`, ".git"), { recursive: true });
      utimesSync(join(home, `p${i}`, ".git"), 10_000 + i, 10_000 + i);
      utimesSync(join(home, `p${i}`), 10_000 + i, 10_000 + i);
    }
    const got = suggestWorkspaces(home);
    expect(got).toHaveLength(MAX_SUGGESTIONS);
    expect(got[0]).toBe(join(home, "p19"));
    expect(got.at(-1)).toBe(join(home, `p${20 - MAX_SUGGESTIONS}`));
  });

  test("named after their folders, a taken name gets -2; a given name is kept; one in the config keeps its name, mode and agent", () => {
    expect(workspacesFor(["/a/web", "/b/web", "/c/web"])).toEqual([
      { name: "web", path: "/a/web" },
      { name: "web-2", path: "/b/web" },
      { name: "web-3", path: "/c/web" },
    ]);
    expect(workspacesFor([{ path: "/a/web", name: "site" }, "/b/site", "/a/web"])).toEqual([
      { name: "site", path: "/a/web" },
      { name: "site-2", path: "/b/site" },
    ]);
    expect(workspacesFor(["/a/web"], [{ name: "site", path: "/a/web", permissionMode: "default", agent: "codex" }])).toEqual([{ name: "site", path: "/a/web", permissionMode: "default", agent: "codex" }]);
    expect(nameFor("/", [])).toBe("home");
  });

  test("the hotkeys' defaults follow the shell's OS", () => {
    expect(shellOsOf(platformFor("windows-wsl"))).toBe("windows");
    expect(shellOsOf(platformFor("macos"))).toBe("macos");
    expect(shellOsOf(platformFor("linux"))).toBe("linux");
  });
});

describe("setup", () => {
  test("--yes with workspaces: every default, the config written, then link, shell, runner, shell started quietly, login item", async () => {
    const f = folders();
    const { code, text, calls } = await run({ yes: true, workspaces: [{ path: join(f.home, "alpha") }, { path: join(f.home, "notes"), name: "n" }], linkDir: "/some/bin" }, DEFAULTS, { f, interactive: false });
    expect(code).toBe(0);
    expect(calls).toEqual(["link /some/bin", "installShell", "startRunner", "startShell quiet", "login on"]);
    expect(config(f.env)).toMatchObject({
      permissionMode: "auto",
      workspaces: [
        { name: "alpha", path: join(f.home, "alpha") },
        { name: "n", path: join(f.home, "notes") },
      ],
      shell: { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true, startOnLogin: true },
    });
    for (const done of ["config written", "command linked", "shell installed", "runner started", "shell started", "login item set"]) expect(text).toContain(`✓ ${done}`);
    expect(text).toContain("[Ctrl] [Alt] [Space]  a new task");
    expect(text).toContain("http://127.0.0.1:4999/settings");
    expect(text).toContain("holm doctor");
  });

  test("--yes on a Mac takes the Command hotkeys, and without workspaces keeps none", async () => {
    const r = await run({ yes: true }, DEFAULTS, { platform: { ...platformFor("macos"), unavailable: () => null }, interactive: false });
    expect(r.code).toBe(0);
    expect(config(r.env)).toMatchObject({ workspaces: [], shell: { hotkey: "Command+Shift+Space", snipHotkey: "Command+Shift+S" } });
    expect(r.text).toContain("none for now");
  });

  test("without a terminal and without --yes it asks nothing: it says to pass --yes or the flags, writes nothing, exit 2", async () => {
    const ask = scripted([]);
    const r = await run({}, ask, { interactive: false });
    expect(r.code).toBe(NO_TERMINAL);
    expect(ask.asked).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(existsSync(r.env.HOLM_CONFIG)).toBe(false);
    expect(r.text).toContain("pass --yes to take every default, or answer them with --workspace, --hotkey");
  });

  test("without a terminal, the flags for every question are enough", async () => {
    const f = folders();
    const r = await run({ workspaces: [{ path: join(f.home, "notes") }], hotkey: "Alt+Space", snipHotkey: "Alt+S", permissionMode: "default", login: false }, scripted([]), { f, interactive: false });
    expect(r.code).toBe(0);
    expect(config(f.env)).toMatchObject({ permissionMode: "default", workspaces: [{ name: "notes" }], shell: { hotkey: "Alt+Space", snipHotkey: "Alt+S", startOnLogin: false } });
    expect(r.calls).toContain("login off");
  });

  test("asked: picks folders and adds one by path, picks the default, changes a hotkey, ask-for-everything, start at login off; opens the pop-up", async () => {
    const f = folders();
    mkdirSync(join(f.home, "elsewhere", "site"), { recursive: true });
    const ask = scripted([
      [join(f.home, "alpha"), join(f.home, "projects", "gamma"), "\0add"],
      join(f.home, "nowhere"), // refused: no folder
      join(f.home, "alpha"), // refused: already picked
      join(f.home, "elsewhere", "site"),
      "", // refused: a name is needed
      "alpha", // refused: taken
      "my-site",
      false, // no other folder
      "gamma", // the default
      false, // change the hotkeys
      "Control+K", // new task
      "Control+K", // refused: the same as new task
      "Alt+Shift+S",
      "default",
      false,
    ]);
    const r = await run({}, ask, { f });
    expect(r.code).toBe(0);
    expect(ask.refused).toEqual([`no folder at ${join(f.home, "nowhere")}`, "that folder is already picked", "a name, as the pop-up shows it", "alpha is taken", "the new task hotkey is already this"]);
    expect(config(f.env)).toMatchObject({
      permissionMode: "default",
      workspaces: [
        { name: "gamma", path: join(f.home, "projects", "gamma") },
        { name: "alpha", path: join(f.home, "alpha") },
        { name: "my-site", path: join(f.home, "elsewhere", "site") },
      ],
      shell: { hotkey: "Control+K", snipHotkey: "Alt+Shift+S", startOnLogin: false },
    });
    expect(r.calls).toEqual(["link default", "installShell", "startRunner", "startShell prompt", "login off"]);
    expect(r.text).toContain("gamma  ~/projects/gamma  (default)");
  });

  test("the folder list offers the config's workspaces first, ticked, then the suggestions, then Add a folder…", async () => {
    const f = folders();
    mkdirSync(join(f.env.HOLM_CONFIG, ".."), { recursive: true });
    writeFileSync(f.env.HOLM_CONFIG, JSON.stringify({ port: 4999, theme: "dark", extra: 1, workspaces: [{ name: "n", path: join(f.home, "notes"), permissionMode: "default" }] }));
    let offered: string[] = [];
    let initial: unknown[] = [];
    const ask = scripted([]);
    const spy: Ask = {
      ...ask,
      multiselect: async (o) => {
        offered = o.options.map((x) => x.label);
        initial = o.initial;
        return o.initial;
      },
    };
    const r = await run({}, spy, { f });
    expect(r.code).toBe(0);
    expect(offered).toEqual(["~/notes", "~/alpha", "~/projects/gamma", "Add a folder…"]);
    expect(initial).toEqual([join(f.home, "notes")]);
    // The other keys stay, and the workspace keeps its name and mode.
    expect(config(f.env)).toMatchObject({ port: 4999, theme: "dark", extra: 1, workspaces: [{ name: "n", path: join(f.home, "notes"), permissionMode: "default" }] });
  });

  test("Esc or Ctrl+C at any question cancels: nothing written, nothing done, exit 130", async () => {
    // Each question in turn: the workspaces, the default, keep the hotkeys, permissions, start at login.
    const f0 = folders();
    const before = [[join(f0.home, "alpha"), join(f0.home, "notes")], "alpha", true, "auto"];
    for (let at = 0; at <= before.length; at++) {
      const f = folders();
      const answers = [[join(f.home, "alpha"), join(f.home, "notes")], "alpha", true, "auto"].slice(0, at);
      const r = await run({}, scripted([...answers, CANCEL]), { f });
      expect(`${at}: ${r.code}`).toBe(`${at}: ${CANCELLED}`);
      expect(r.calls).toEqual([]);
      expect(existsSync(f.env.HOLM_CONFIG)).toBe(false);
      expect(r.text).toContain("cancelled: nothing was written");
    }
    // In the middle of adding a folder, and in the hotkey's text.
    for (const answers of [["\0add"].map((x) => [x]), [[], false]] as Answer[][]) {
      const f = folders();
      const r = await run({}, scripted([...answers, CANCEL]), { f });
      expect(r.code).toBe(CANCELLED);
      expect(existsSync(f.env.HOLM_CONFIG)).toBe(false);
    }
  });

  test("a missing requirement stops it before any question, with its fix; asked, it offers to check again", async () => {
    const f = folders();
    const r = await run({ yes: true }, DEFAULTS, { f, probes: probes({ "node --version": "v20.1.0" }), interactive: false });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(existsSync(f.env.HOLM_CONFIG)).toBe(false);
    expect(r.text).toContain("✗ node and npm       node v20.1.0 is older than 22.12");
    expect(r.text).toContain("fix: install Node 22.12");
    expect(r.text).toContain("missing: node and npm");

    // Asked: fixed in another terminal, then Check again goes on.
    let node = "v20.1.0";
    const p = { ...probes(), output: (cmd: string[]) => (cmd.join(" ") === "node --version" ? node : probes().output(cmd)) };
    const ask = scripted([]);
    const again: Ask = { ...ask, select: async (o) => (o.message === "Once they are fixed" ? ((node = "v22.12.0"), true) : o.initial) as never };
    const fixed = await run({}, again, { probes: p });
    expect(fixed.code).toBe(0);
    expect(fixed.text).toContain("✓ node and npm       node v22.12.0");

    const quit = await run({}, { ...ask, select: async (o) => (o.message === "Once they are fixed" ? false : o.initial) as never }, { probes: probes({ "claude --version": null }) });
    expect(quit.code).toBe(1);
    expect(quit.text).toContain("fix: install Claude Code");
  });

  test("not logged in to Claude Code: it never logs in for you; it warns with the command and goes on", async () => {
    const r = await run({ yes: true }, DEFAULTS, { probes: probes({ "claude auth status": '{ "loggedIn": false }' }), interactive: false });
    expect(r.code).toBe(0);
    expect(r.text).toContain("✗ Claude Code login  not logged in");
    expect(r.text).toContain("sessions fail until you log in: run claude auth login");
  });

  test("Codex is shown as optional: a dash when it is missing, a tick when it is there", async () => {
    const r = await run({ yes: true }, DEFAULTS, { probes: { ...probes(), codex: () => "/x/codex" }, interactive: false });
    expect(r.text).toContain("– Codex              not installed (optional)");
    const there = probes({ "/x/codex --version": "codex-cli 0.169.0", "/x/codex login status": "Logged in using ChatGPT" });
    const ok = await run({ yes: true }, DEFAULTS, { probes: { ...there, codex: () => "/x/codex" }, interactive: false });
    expect(ok.text).toContain("✓ Codex              codex-cli 0.169.0");
    expect(ok.text).toContain("✓ Codex login        Logged in using ChatGPT");
  });

  test("without a display the shell steps are skipped and said so; the runner and the link still happen", async () => {
    const r = await run({ yes: true }, DEFAULTS, { platform: { ...platformFor("linux"), unavailable: () => "no display" }, interactive: false });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["link default", "startRunner"]);
    expect(r.text).toContain("– shell not installed  (no display");
  });

  test("each failing step says what went wrong and the command to retry it; the rest still run, exit 1", async () => {
    const { calls, a } = actions({
      installShell: async () => {
        throw new Error("npm failed");
      },
      startRunner: async (log) => (log("the runner exited with code 1"), 1),
      link: (_d, log) => (log("/bin/holm is a folder: not replaced"), 1),
    });
    const r = await run({ yes: true }, DEFAULTS, { actions: a, interactive: false });
    expect(r.code).toBe(1);
    expect(r.text).toContain("✗ shell not installed: npm failed");
    expect(r.text).toContain("retry: holm shell install");
    expect(r.text).toContain("✗ runner not started");
    expect(r.text).toContain("retry: holm start");
    expect(r.text).toContain("retry: bun src/cli.ts link");
    expect(calls).not.toContain("startShell quiet");
  });

  test("a runner kept (3) goes on with a warning and exit 3; a login item that fails says how to retry", async () => {
    const kept = actions({ startRunner: async () => 3 });
    const r = await run({ yes: true }, DEFAULTS, { actions: kept.a, interactive: false });
    expect(r.code).toBe(3);
    expect(kept.calls).toContain("startShell quiet");
    expect(r.text).toContain("▲ runner kept");

    const broken = actions({
      login: async () => {
        throw new Error("no login items");
      },
    });
    const b = await run({ yes: true, login: false }, DEFAULTS, { actions: broken.a, interactive: false });
    expect(b.code).toBe(1);
    expect(b.text).toContain("start at login not changed: no login items");
    expect(b.text).toContain("retry: holm shell login off");
  });

  test("a config it cannot write ends it at once: nothing else is done", async () => {
    const f = folders();
    // A folder where the config's own folder should be.
    writeFileSync(join(f.env.HOLM_CONFIG, ".."), "");
    const r = await run({ yes: true }, DEFAULTS, { f, interactive: false });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });

  test("the plain text has no colour codes and no cursor movement", async () => {
    const f = folders();
    const r = await run({ yes: true, workspaces: [{ path: join(f.home, "alpha") }] }, DEFAULTS, { f, interactive: false });
    expect(r.text).not.toContain("\x1b");
    expect(r.text).not.toContain("\r");
    expect(r.text.split("\n")[0]).toBe("holm 0.1.0 setup");
    expect(r.text).toContain("\n1. Requirements\n");
    expect(r.text).toContain("\n6. Setting up\n");
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
    mkdirSync(join(env.HOLM_CONFIG, ".."), { recursive: true });
    writeFileSync(env.HOLM_CONFIG, "{}");
    mkdirSync(env.HOLM_DATA_DIR, { recursive: true });
    const { calls, a } = fake();
    const lines: string[] = [];
    expect(await uninstall({ purge: false }, linux, a, env, (l) => lines.push(l))).toBe(0);
    expect(calls).toEqual(["loginOff", "stopShell", "removeShell", "stopRunner", "unlink default"]);
    expect(existsSync(env.HOLM_CONFIG)).toBe(true);
    expect(existsSync(env.HOLM_DATA_DIR)).toBe(true);
    expect(lines.join("\n")).toContain("`holm uninstall --purge` removes them too");
  });

  test("--purge removes the config and the data folder", async () => {
    const { env } = folders();
    mkdirSync(join(env.HOLM_CONFIG, ".."), { recursive: true });
    writeFileSync(env.HOLM_CONFIG, '{ "workspaces": [] }');
    mkdirSync(join(env.HOLM_DATA_DIR, "sessions"), { recursive: true });
    const { a } = fake();
    expect(await uninstall({ purge: true, linkDir: "/b" }, linux, a, env, () => {})).toBe(0);
    expect(existsSync(env.HOLM_CONFIG)).toBe(false);
    expect(existsSync(join(env.HOLM_CONFIG, ".."))).toBe(false);
    expect(existsSync(env.HOLM_DATA_DIR)).toBe(false);
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
    const settings = join(dir, "config", "holm-shell", "settings.json");
    const platform: Platform = { ...platformFor("linux"), settingsFile: () => settings };
    mkdirSync(join(paths.app, "node_modules"), { recursive: true });
    mkdirSync(join(settings, ".."), { recursive: true });
    writeFileSync(settings, "{}");
    mkdirSync(join(home, "sessions"));
    expect(removeShell(paths, platform)).toEqual([paths.app, join(dir, "config", "holm-shell")]);
    expect(existsSync(join(home, "sessions"))).toBe(true);
    expect(existsSync(join(dir, "config"))).toBe(true);

    mkdirSync(paths.app);
    const bare = join(dir, "bare");
    expect(removeShell({ home: bare, app: join(bare, "shell"), electronExe: "" }, platform)).toEqual([]);
    mkdirSync(join(bare, "shell"), { recursive: true });
    expect(removeShell({ home: bare, app: join(bare, "shell"), electronExe: "" }, platform)).toEqual([join(bare, "shell"), bare]);
  });
});
