// The rename from intuition to holm (D0043): the one-time moves of the folders, the login items and the
// storage keys, the old environment variables, and the sessions stored under the old source. Temp folders only.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { CLI, link, unlink } from "../src/cli/link";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyEnv, moveFolder, storedSource } from "../src/shared/legacy";
import { defaultFolders, runnerFolders } from "../src/runner/legacy";
import { Store } from "../src/runner/store";
import { migrateShell, oldLoginFile, oldShellPaths } from "../src/shell/legacy";
import { electronExe, platformFor, type Platform } from "../src/shell/platform";

const dirs: string[] = [];
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "holm-legacy-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

describe("the old environment variables", () => {
  test("INTUITION_X becomes HOLM_X, and a HOLM_X that is set wins", () => {
    const env: Record<string, string | undefined> = { INTUITION_CONFIG: "/old.json", INTUITION_PORT: "1", HOLM_PORT: "2", OTHER: "x" };
    expect(adoptLegacyEnv(env)).toEqual(["HOLM_CONFIG"]);
    expect(env.HOLM_CONFIG).toBe("/old.json");
    expect(env.HOLM_PORT).toBe("2");
    expect(adoptLegacyEnv(env)).toEqual([]);
  });
});

describe("stored sessions", () => {
  test("the old source and none read as holm; terminal stays", () => {
    expect(storedSource(undefined, "holm")).toBe("holm");
    expect(storedSource("intuition" as "holm", "holm")).toBe("holm");
    expect(storedSource<"holm" | "terminal">("terminal", "holm")).toBe("terminal");
  });

  test("the store reads a sessions.json the old runner wrote", () => {
    const dir = temp();
    const base = { workspace: "w", cwd: dir, title: "t", status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastSeq: 0 };
    writeFileSync(join(dir, "sessions.json"), JSON.stringify([{ ...base, id: "a", source: "intuition" }, { ...base, id: "b", source: "terminal" }, { ...base, id: "c" }]));
    const store = new Store(dir);
    expect(["a", "b", "c"].map((id) => store.get(id)?.source)).toEqual(["holm", "terminal", "holm"]);
  });
});

describe("moveFolder", () => {
  test("moves the whole folder when the new one is missing, and does nothing the second time", () => {
    const dir = temp();
    put(join(dir, "old", "a", "b.json"), "1");
    expect(moveFolder(join(dir, "old"), join(dir, "deep", "new"))).toBe(true);
    expect(readFileSync(join(dir, "deep", "new", "a", "b.json"), "utf8")).toBe("1");
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(moveFolder(join(dir, "old"), join(dir, "deep", "new"))).toBe(false);
  });

  test("when both exist, moves only what the new one lacks and overwrites nothing", () => {
    const dir = temp();
    put(join(dir, "old", "sessions.json"), "old");
    put(join(dir, "old", "events", "x.jsonl"), "e");
    put(join(dir, "new", "sessions.json"), "new");
    expect(moveFolder(join(dir, "old"), join(dir, "new"))).toBe(true);
    expect(readFileSync(join(dir, "new", "sessions.json"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "new", "events", "x.jsonl"), "utf8")).toBe("e");
    // What could not move stays where it was.
    expect(readFileSync(join(dir, "old", "sessions.json"), "utf8")).toBe("old");
  });
});

describe("the runner's folders", () => {
  test("~/.config/intuition and ~/.local/share/intuition move to holm once, and say so once", () => {
    const home = temp();
    const { now, old } = defaultFolders(home);
    put(join(old.config, "config.json"), '{"workspaces":[]}');
    put(join(old.data, "sessions.json"), "[]");
    put(join(old.data, "events", "s.jsonl"), "{}");
    const said: string[] = [];
    expect(runnerFolders({}, home, (l) => said.push(l))).toEqual(now);
    expect(readFileSync(join(now.config, "config.json"), "utf8")).toBe('{"workspaces":[]}');
    expect(existsSync(join(now.data, "events", "s.jsonl"))).toBe(true);
    expect(existsSync(old.config) || existsSync(old.data)).toBe(false);
    expect(said).toEqual([`holm: moved ${old.config} to ${now.config} (intuition is now called holm)`, `holm: moved ${old.data} to ${now.data} (intuition is now called holm)`]);
    runnerFolders({}, home, (l) => said.push(l));
    expect(said.length).toBe(2);
  });

  test("folders named by HOLM_CONFIG and HOLM_DATA_DIR are not moved", () => {
    const home = temp();
    const { old } = defaultFolders(home);
    put(join(old.config, "config.json"), "{}");
    put(join(old.data, "sessions.json"), "[]");
    runnerFolders({ HOLM_CONFIG: join(home, "c.json"), HOLM_DATA_DIR: join(home, "d") }, home, () => {});
    expect(existsSync(join(old.config, "config.json")) && existsSync(join(old.data, "sessions.json"))).toBe(true);
  });

  test("while a runner from before the rename runs from the old folder, nothing moves and the old folders are used", async () => {
    const home = temp();
    const { now, old } = defaultFolders(home);
    put(join(old.config, "config.json"), "{}");
    // A process whose command line names runner/main.ts, as the old runner's does.
    const fake = join(home, "app", "src", "runner", "main.ts");
    put(fake, "await Bun.sleep(30_000);\n");
    const child = Bun.spawn([process.execPath, fake], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      put(join(old.data, "runner.pid"), `${child.pid}\n`);
      const said: string[] = [];
      expect(runnerFolders({}, home, (l) => said.push(l))).toEqual(old);
      expect(existsSync(now.config) || existsSync(now.data)).toBe(false);
      expect(said[0]).toContain(`still runs from ${old.data}`);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(runnerFolders({}, home, () => {})).toEqual(now);
    expect(existsSync(join(now.data, "runner.pid"))).toBe(true);
  });
});

/** A layout's platform with its pid check replaced. */
function withAlive(layout: "macos" | "linux", alive: (pid: number) => boolean): Platform {
  return { ...platformFor(layout), pidAlive: alive };
}

function shellLayout(base: string, layout: "macos" | "linux") {
  const app = join(base, "holm", "shell");
  return { now: { home: join(base, "holm"), app, electronExe: electronExe(app, layout) }, userData: join(base, "holm-shell") };
}

describe("the installed shell", () => {
  test("the old paths are the new ones' siblings under the old names", () => {
    const base = temp();
    const { now, userData } = shellLayout(base, "macos");
    const old = oldShellPaths(now, userData, platformFor("macos"));
    expect(old.paths.app).toBe(join(base, "intuition", "shell"));
    expect(old.userData).toBe(join(base, "intuition-shell"));
  });

  test("macOS: the shell, its settings and the launch agent move to the new names", async () => {
    const base = temp();
    const home = temp();
    const { now, userData } = shellLayout(base, "macos");
    put(join(base, "intuition", "shell", "main.cjs"), "bundle");
    put(join(base, "intuition-shell", "settings.json"), '{"runnerUrl":"http://127.0.0.1:4777"}');
    put(join(base, "intuition-shell", "Local Storage", "leveldb", "000003.log"), "storage");
    const oldPlist = join(home, "Library", "LaunchAgents", "dev.intuition.shell.plist");
    put(oldPlist, "<plist/>");
    const log: string[] = [];
    let stopped = 0;
    const moved = await migrateShell({ now, userData, platform: withAlive("macos", () => false), log: (l) => log.push(l), home, stopOld: async () => void stopped++ });
    expect(moved).toBe(true);
    expect(stopped).toBe(0);
    expect(readFileSync(join(now.app, "main.cjs"), "utf8")).toBe("bundle");
    expect(existsSync(join(userData, "Local Storage", "leveldb", "000003.log"))).toBe(true);
    expect(existsSync(join(base, "intuition")) || existsSync(join(base, "intuition-shell"))).toBe(false);
    expect(existsSync(oldPlist)).toBe(false);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "dev.holm.shell.plist"), "utf8");
    expect(plist).toContain("<string>dev.holm.shell</string>");
    expect(plist).toContain(`<string>${now.electronExe}</string>`);
    expect(plist).toContain(`<string>${now.app}</string>`);
    expect(log.length).toBe(3);
    // The second time: nothing to do.
    expect(await migrateShell({ now, userData, platform: withAlive("macos", () => false), log: () => {}, home, stopOld: async () => {} })).toBe(false);
  });

  test("a running old shell is asked to quit before anything moves; one that keeps running is left", async () => {
    const base = temp();
    const { now, userData } = shellLayout(base, "macos");
    put(join(base, "intuition", "shell", "main.cjs"), "bundle");
    put(join(base, "intuition-shell", "shell.pid"), "4242");
    let alive = true;
    const quits = { now, userData, platform: withAlive("macos", () => alive), log: () => {}, home: temp() };
    expect(await migrateShell({ ...quits, stopOld: async () => {} })).toBe(false);
    expect(existsSync(now.app)).toBe(false);
    const asked: string[] = [];
    expect(
      await migrateShell({
        ...quits,
        stopOld: async (old, pid) => {
          asked.push(old.app, pid);
          alive = false;
        },
      }),
    ).toBe(true);
    expect(asked).toEqual([join(base, "intuition", "shell"), join(base, "intuition-shell", "shell.pid")]);
    expect(existsSync(join(now.app, "main.cjs"))).toBe(true);
  });

  test("Linux: the old autostart file gives way to holm.desktop; a new one already there is kept", async () => {
    const base = temp();
    const config = temp();
    const env = { XDG_CONFIG_HOME: config };
    const { now, userData } = shellLayout(base, "linux");
    const login = oldLoginFile(platformFor("linux"), "/nowhere", env)!;
    expect(login).toEqual({ old: join(config, "autostart", "intuition.desktop"), now: join(config, "autostart", "holm.desktop") });
    put(login.old, "[Desktop Entry]\nName=intuition\n");
    expect(await migrateShell({ now, userData, platform: withAlive("linux", () => false), log: () => {}, home: "/nowhere", env, stopOld: async () => {} })).toBe(true);
    expect(existsSync(login.old)).toBe(false);
    const entry = readFileSync(login.now, "utf8");
    expect(entry).toContain("Name=Holm");
    expect(entry).toContain(now.electronExe);
    put(login.old, "old");
    put(login.now, "mine");
    await migrateShell({ now, userData, platform: withAlive("linux", () => false), log: () => {}, home: "/nowhere", env, stopOld: async () => {} });
    expect(readFileSync(login.now, "utf8")).toBe("mine");
    expect(existsSync(login.old)).toBe(false);
  });
});

describe("the command's link", () => {
  test("link replaces an intuition link to this checkout with holm; one to elsewhere is left", () => {
    const dir = temp();
    symlinkSync(CLI, join(dir, "intuition"));
    expect(link(dir, { PATH: "" }, () => {})).toBe(0);
    expect(existsSync(join(dir, "intuition"))).toBe(false);
    expect(realpathSync(join(dir, "holm"))).toBe(realpathSync(CLI));
    const other = temp();
    symlinkSync(join(other, "cli.ts"), join(other, "intuition"));
    expect(unlink(other, () => {})).toBe(0);
    expect(lstatSync(join(other, "intuition")).isSymbolicLink()).toBe(true);
  });
});

describe("the pages' storage keys", () => {
  function storage(initial: Record<string, string>) {
    const m = new Map(Object.entries(initial));
    return {
      map: m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }
  const script = readFileSync(join(import.meta.dir, "..", "src", "web", "legacy-storage.js"), "utf8");
  const run = (s: ReturnType<typeof storage>) => new Function("localStorage", script)(s);

  test("intuition.* keys become holm.* once; a new value already there wins", () => {
    const s = storage({ "intuition.theme": "dark", "intuition.dock.session": "abc", "intuition.dock.workspace": "web", "intuition.chat.folded": "[]", "holm.theme": "light", other: "x" });
    run(s);
    expect(Object.fromEntries(s.map)).toEqual({ "holm.theme": "light", "holm.dock.session": "abc", "holm.dock.workspace": "web", "holm.chat.folded": "[]", other: "x" });
    run(s);
    expect(s.map.size).toBe(5);
  });

  test("storage that throws is left alone", () => {
    expect(() => new Function("localStorage", script)({ getItem: () => { throw new Error("off"); } })).not.toThrow();
  });

  test("the chat and the dock load it right after theme.js", () => {
    for (const page of ["chat.html", "dock.html"]) {
      const html = readFileSync(join(import.meta.dir, "..", "src", "web", page), "utf8");
      expect(html).toContain('<script src="/assets/theme.js"></script>\n  <script src="/assets/legacy-storage.js"></script>');
    }
  });
});
