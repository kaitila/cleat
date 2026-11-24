// The platform layer: which layout this is, each layout's paths and commands, the settings `shell install`
// writes, start at login through an XDG autostart file, and `holm doctor`. Nothing here installs or starts a shell.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS } from "../shell/src/settings";
import { checks, doctor, nodeIsNew, type Probes, report } from "../src/cli/doctor";
import { makeUi } from "../src/cli/ui";
import { autostart, BUNDLE, withLocalRunner, writeRunnerLocation } from "../src/shell/install";
import type { ShellPaths } from "../src/shell/paths";
import { autostartEntry, detectLayout, electronExe, LAYOUTS, nativeHome, parseLocalRunner, platformFor } from "../src/shell/platform";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "holm-platform-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("which layout", () => {
  const noProc = () => "";

  test("HOLM_PLATFORM names it, whatever the machine", () => {
    for (const layout of LAYOUTS) {
      expect(detectLayout({ HOLM_PLATFORM: layout }, "linux", noProc)).toBe(layout);
      expect(detectLayout({ HOLM_PLATFORM: layout, WSL_DISTRO_NAME: "Ubuntu" }, "darwin", noProc)).toBe(layout);
    }
    for (const bad of ["windows", "Linux", "mac"]) expect(() => detectLayout({ HOLM_PLATFORM: bad }, "linux", noProc)).toThrow("HOLM_PLATFORM");
  });

  test("WSL is windows-wsl, by WSL_DISTRO_NAME or /proc/version; other Linux is linux; darwin is macos", () => {
    expect(detectLayout({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", noProc)).toBe("windows-wsl");
    expect(detectLayout({}, "linux", () => "Linux version 5.15.167.4-microsoft-standard-WSL2")).toBe("windows-wsl");
    expect(detectLayout({}, "linux", () => "Linux version 6.8.0-49-generic (buildd@lcy02-amd64)")).toBe("linux");
    expect(detectLayout({ HOLM_PLATFORM: "" }, "linux", noProc)).toBe("linux");
    expect(detectLayout({}, "darwin", noProc)).toBe("macos");
    expect(() => detectLayout({}, "win32", noProc)).toThrow("inside WSL");
  });
});

describe("each layout's paths and commands", () => {
  test("where the shell is installed on the native layouts", () => {
    expect(nativeHome("linux", {})).toBe(join(homedir(), ".local", "share", "holm"));
    expect(nativeHome("linux", { XDG_DATA_HOME: "/data" })).toBe("/data/holm");
    expect(nativeHome("macos", { XDG_DATA_HOME: "/data" })).toBe(join(homedir(), "Library", "Application Support", "holm"));
    const linux = platformFor("linux").shellPaths();
    expect(linux.app).toBe(join(linux.home, "shell"));
    expect(linux.electronExe).toBe(join(linux.app, "node_modules", "electron", "dist", "electron"));
  });

  test("the Electron executable per OS", () => {
    expect(electronExe("/a", "windows-wsl")).toBe("/a/node_modules/electron/dist/electron.exe");
    expect(electronExe("/a", "macos")).toBe("/a/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    expect(electronExe("/a", "linux")).toBe("/a/node_modules/electron/dist/electron");
  });

  test("Electron is fetched for the shell's OS: Windows x64 from WSL, as before; this machine's OS otherwise", () => {
    expect(platformFor("windows-wsl").electronEnv).toEqual({ npm_config_platform: "win32", npm_config_arch: "x64" });
    expect(platformFor("linux").electronEnv.npm_config_platform).toBe("linux");
    expect(platformFor("macos").electronEnv.npm_config_platform).toBe("darwin");
    for (const layout of ["linux", "macos"] as const) expect(["x64", "arm64", "armv7l"]).toContain(platformFor(layout).electronEnv.npm_config_arch!);
  });

  test("the native layouts hand Electron the app folder as it is; only Linux as root turns Chromium's sandbox off", () => {
    expect(platformFor("linux").appArg("/a b/shell")).toBe("/a b/shell");
    expect(platformFor("macos").electronFlags()).toEqual([]);
    expect(platformFor("windows-wsl").electronFlags()).toEqual([]);
    expect(platformFor("linux").electronFlags()).toEqual(process.getuid?.() === 0 ? ["--no-sandbox"] : []);
  });

  test("the settings file is in Electron's user data folder, named after shell/package.json", () => {
    const name = JSON.parse(readFileSync(join(REPO, "shell", "package.json"), "utf8")).name;
    expect(platformFor("macos").settingsFile()).toBe(join(homedir(), "Library", "Application Support", name, "settings.json"));
    expect(platformFor("linux").settingsFile()).toBe(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name, "settings.json"));
  });

  test("Linux needs a display to start the shell; macOS needs nothing more", () => {
    expect(platformFor("linux").unavailable({})).toContain("display");
    expect(platformFor("linux").unavailable({ DISPLAY: ":0" })).toBeNull();
    expect(platformFor("linux").unavailable({ WAYLAND_DISPLAY: "wayland-0" })).toBeNull();
    expect(platformFor("macos").unavailable({})).toBeNull();
  });

  test("start at login: the shell's Electron login item on Windows and macOS, an autostart file on Linux", () => {
    expect(platformFor("windows-wsl").login).toBe("electron");
    expect(platformFor("macos").login).toBe("electron");
    expect(platformFor("linux").login).toBe("xdg-autostart");
  });
});

describe("where the runner lives, in the shell's settings", () => {
  test("windows-wsl: the distribution, the repo and bun, as before; native: a local runner", () => {
    expect(platformFor("windows-wsl").runnerLocation({ WSL_DISTRO_NAME: "Ubuntu" }, "/r", "/b")).toEqual({ kind: "wsl", wsl: { distro: "Ubuntu", repo: "/r", bun: "/b" } });
    expect(platformFor("windows-wsl").runnerLocation({}, "/r", "/b")).toBeUndefined();
    for (const layout of ["linux", "macos"] as const) {
      expect(platformFor(layout).runnerLocation({}, "/home/a b/repo", "/b")).toEqual({ kind: "local", repo: "/home/a b/repo", bun: "/b" });
      expect(platformFor(layout).runnerLocation({}, "repo", "/b")).toBeUndefined();
    }
  });

  test("a local runner is whole or nothing", () => {
    expect(parseLocalRunner({ kind: "local", repo: "/r", bun: "/b" })).toEqual({ kind: "local", repo: "/r", bun: "/b" });
    for (const bad of [null, "x", { kind: "wsl", repo: "/r", bun: "/b" }, { kind: "local", repo: "r", bun: "/b" }, { kind: "local", repo: "/r" }, { kind: "local", repo: "/r\n", bun: "/b" }, { kind: "local", repo: "/r", bun: "-b" }]) {
      expect(`${JSON.stringify(bad)} ${parseLocalRunner(bad)}`).toBe(`${JSON.stringify(bad)} undefined`);
    }
  });

  test("`shell install` on a native layout writes `runner`, keeping the rest of the file", () => {
    const file = join(dir, "config", "holm-shell", "settings.json");
    const runner = { kind: "local", repo: "/r", bun: "/b" } as const;
    const lines: string[] = [];
    expect(writeRunnerLocation(file, runner, (l) => lines.push(l), platformFor("linux"))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, runner });
    expect(lines).toEqual([`settings: ${file} (the shell starts the runner with /b /r/src/cli.ts start)`]);
    // Nothing to change: nothing written or said.
    expect(writeRunnerLocation(file, runner, (l) => lines.push(l), platformFor("linux"))).toBe(true);
    expect(lines).toHaveLength(1);

    writeFileSync(file, JSON.stringify({ hotkey: "Alt+F9", mine: true, runner: { kind: "local", repo: "/old", bun: "/old" } }));
    writeRunnerLocation(file, runner, () => {}, platformFor("linux"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hotkey: "Alt+F9", mine: true, runner });
    expect(writeRunnerLocation(file, null, () => {}, platformFor("linux"))).toBe(false);
    expect(JSON.parse(withLocalRunner("[1]", runner))).toEqual({ ...DEFAULT_SETTINGS, runner });
    expect(JSON.parse(withLocalRunner("not json", runner))).toEqual({ ...DEFAULT_SETTINGS, runner });
  });

  test("the windows-wsl layout writes `wsl` and nothing else, as before", () => {
    const file = join(dir, "roaming", "settings.json");
    const wsl = { distro: "Ubuntu", repo: "/r", bun: "/b" };
    expect(writeRunnerLocation(file, { kind: "wsl", wsl }, () => {}, platformFor("windows-wsl"))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, wsl });
  });
});

describe("start at login on Linux: an XDG autostart file", () => {
  function fakeInstall(): ShellPaths {
    const home = mkdtempSync(join(dir, "home-"));
    const app = join(home, "shell");
    const paths = { home, app, electronExe: electronExe(app, "linux") };
    mkdirSync(dirname(paths.electronExe), { recursive: true });
    for (const f of [paths.electronExe, join(app, BUNDLE), join(app, "dock-preload.cjs"), join(app, "snip-preload.cjs")]) writeFileSync(f, "");
    return paths;
  }

  test("on writes the entry that starts the installed Electron on the app folder, status reads it, off removes it", () => {
    const paths = fakeInstall();
    const linux = platformFor("linux");
    const file = join(dir, "autostart", "holm.desktop");
    expect(autostart("status", paths, linux, file)).toEqual({ openAtLogin: false, error: null });
    expect(autostart("on", paths, linux, file)).toEqual({ openAtLogin: true, error: null });
    const text = readFileSync(file, "utf8");
    expect(text).toStartWith("[Desktop Entry]\n");
    expect(text).toContain("Type=Application\n");
    expect(text).toContain(`Exec=${[paths.electronExe, ...linux.electronFlags(), paths.app].map((a) => `"${a}"`).join(" ")}\n`);
    expect(autostart("status", paths, linux, file).openAtLogin).toBe(true);
    expect(autostart("off", paths, linux, file)).toEqual({ openAtLogin: false, error: null });
    expect(autostart("off", paths, linux, file).openAtLogin).toBe(false);
  });

  test("on refuses when the shell is not installed", () => {
    const paths = { home: join(dir, "none"), app: join(dir, "none", "shell"), electronExe: join(dir, "none", "e") };
    expect(() => autostart("on", paths, platformFor("linux"), join(dir, "a2", "holm.desktop"))).toThrow("holm shell install");
  });

  test("the Exec line quotes each argument and escapes what the format reads", () => {
    expect(autostartEntry("/a b/electron", ["/x\"y$z`w\\v", "100%"])).toContain('Exec="/a b/electron" "/x\\"y\\$z\\`w\\\\v" "100%%"\n');
  });
});

describe("holm doctor", () => {
  const all = (over: Partial<Probes> = {}): Probes => ({
    output: (cmd) =>
      ({ git: "git version 2.43.0", node: "v22.12.0", npm: "10.9.0", claude: cmd[1] === "auth" ? '{ "loggedIn": true }' : "2.1.0 (Claude Code)", "/c/codex": cmd[1] === "login" ? "Logged in using ChatGPT" : "codex-cli 0.169.0" })[cmd[0]!] ?? null,
    codex: () => "/c/codex",
    config: () => ({ ok: true, path: "/c/config.json" }),
    runner: async () => "http://127.0.0.1:4777",
    shellInstalled: () => true,
    shellPid: () => 42,
    login: async () => true,
    ...over,
  });
  const display = { DISPLAY: ":0" };
  /** No terminal, no colour: what doctor prints into a pipe. */
  const ui = makeUi({ term: { interactive: false, color: false, unicode: true, columns: 80 }, write: () => {} });
  const has = (lines: string[], mark: string, name: string) => lines.findIndex((l) => new RegExp(`^${mark} ${name.replace(/[()]/g, "\\$&")} +\\S`).test(l));

  test("Node 22.12 or later", () => {
    for (const v of ["v22.12.0", "v22.23.0", "v23.0.0", "24.1.0"]) expect(nodeIsNew(v)).toBe(true);
    for (const v of ["v22.11.9", "v20.18.0", "v8.0.0", "nope"]) expect(nodeIsNew(v)).toBe(false);
  });

  test("everything there: exit 0, the layout first, no fixes", async () => {
    const lines: string[] = [];
    expect(await doctor(display, (l) => lines.push(l), platformFor("linux"), all(), {}, ui)).toBe(0);
    expect(lines[0]).toBe("layout: linux (the runner and the shell on this machine)");
    expect(lines.join("\n")).not.toContain("fix:");
    expect(lines.at(-1)).toBe("✓ everything needed is there");
    for (const name of ["git", "bun", "node and npm", "Claude Code", "Claude Code login", "config", "display", "runner", "shell installed", "shell running", "start at login", "Codex", "Codex login"]) {
      expect(`${name}: ${has(lines, "✓", name) > 0}`).toBe(`${name}: true`);
    }
  });

  test("a needed prerequisite missing: exit 1, with its fix on the next line", async () => {
    for (const [what, probes, name] of [
      ["no git", all({ output: (cmd) => (cmd[0] === "git" ? null : all().output(cmd)) }), "git"],
      ["old node", all({ output: (cmd) => (cmd[0] === "node" ? "v20.18.0" : all().output(cmd)) }), "node and npm"],
      ["no npm", all({ output: (cmd) => (cmd[0] === "npm" ? null : all().output(cmd)) }), "node and npm"],
      ["no claude", all({ output: (cmd) => (cmd[0] === "claude" ? null : all().output(cmd)) }), "Claude Code"],
      ["logged out", all({ output: (cmd) => (cmd[1] === "auth" ? '{ "loggedIn": false }' : all().output(cmd)) }), "Claude Code login"],
      ["broken config", all({ config: () => ({ ok: false, error: "/c/config.json is not valid JSON" }) }), "config"],
    ] as const) {
      const lines: string[] = [];
      expect(`${what}: ${await doctor(display, (l) => lines.push(l), platformFor("linux"), probes, {}, ui)}`).toBe(`${what}: 1`);
      const at = has(lines, "✗", name);
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toMatch(/^ +fix: /);
      expect(lines.at(-1)).toBe(`✗ missing: ${name}`);
    }
  });

  test("parts not up yet (runner, shell, start at login, a display) are shown with their fix, and are not a failure", async () => {
    const lines: string[] = [];
    const probes = all({ runner: async () => null, shellInstalled: () => false, shellPid: () => 42, login: async () => true });
    expect(await doctor({}, (l) => lines.push(l), platformFor("linux"), probes, {}, ui)).toBe(0);
    const text = lines.join("\n");
    for (const [name, fix] of [["display", "desktop session"], ["runner", "holm start"], ["shell installed", "holm shell install"], ["shell running", "holm shell start"], ["start at login", "holm shell login on"]]) {
      expect(text).toMatch(new RegExp(`– ${name} +.*\\n +fix: .*${fix}`));
    }
    // Not installed: neither its pid nor its login item is asked for.
    expect(text).toMatch(/start at login +the shell is not installed/);
  });

  test("Codex is optional: not installed, or logged out, is shown with its fix and is not a failure", async () => {
    const missing = await checks(platformFor("linux"), all({ codex: () => null }), display);
    expect(missing.find((c) => c.name === "Codex")).toMatchObject({ ok: false, needed: false, detail: "not installed" });
    expect(missing.some((c) => c.name === "Codex login")).toBe(false);
    const out = all({ output: (cmd) => (cmd[0] === "/c/codex" && cmd[1] === "login" ? null : all().output(cmd)) });
    const lines: string[] = [];
    expect(await doctor(display, (l) => lines.push(l), platformFor("linux"), out, {}, ui)).toBe(0);
    const at = lines.findIndex((l) => /^– Codex login +not logged in/.test(l));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toContain("codex login");
  });

  test("windows-wsl checks the Windows disk, and needs it; macOS has no display check", async () => {
    // Without Windows (CI), asking for the shell's folder throws: doctor still reports.
    const noWindows = { ...platformFor("windows-wsl"), unavailable: () => "no /mnt/c", shellPaths: () => { throw new Error("cmd.exe failed"); } };
    const win = await checks(noWindows, all({ shellInstalled: () => false }));
    expect(win.find((c) => c.name === "Windows")).toMatchObject({ ok: false, needed: true, detail: "no /mnt/c" });
    expect(win.find((c) => c.name === "shell installed")?.detail).toContain("Windows could not be asked");
    expect(win.some((c) => c.name === "display")).toBe(false);
    const mac = await checks(platformFor("macos"), all({ shellInstalled: () => false }));
    expect(mac.some((c) => c.name === "Windows" || c.name === "display")).toBe(false);
    expect(report(platformFor("macos"), mac, ui)[0]).toBe("layout: macos (the runner and the shell on this Mac)");
  });

  test("the command: a layout line first, and a fix under every line that is not ok; a wrong HOLM_PLATFORM is refused", () => {
    const env = { ...process.env, HOLM_CONFIG: join(dir, "doctor", "config.json"), HOLM_DATA_DIR: join(dir, "doctor", "data"), HOLM_PORT: "0", XDG_DATA_HOME: join(dir, "doctor", "share"), XDG_CONFIG_HOME: join(dir, "doctor", "xdg") };
    const p = Bun.spawnSync([process.execPath, CLI, "doctor"], { cwd: REPO, env: { ...env, HOLM_PLATFORM: "linux" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const lines = p.stdout.toString().trim().split("\n");
    expect(lines[0]).toBe("layout: linux (the runner and the shell on this machine)");
    expect(lines.some((l) => /^– shell installed +not in /.test(l))).toBe(true);
    lines.forEach((l, i) => {
      if (/^[✗–] (?!missing:)\S/.test(l)) expect(lines[i + 1]).toMatch(/^ +fix: /);
    });
    expect(p.exitCode).toBe(lines.some((l) => l.startsWith("✗ missing")) ? 1 : 0);

    const bad = Bun.spawnSync([process.execPath, CLI, "doctor"], { cwd: REPO, env: { ...env, HOLM_PLATFORM: "beos" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("HOLM_PLATFORM");
  });
});
