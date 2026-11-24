// The renames from intuition to holm (D0043) and from holm to cleat (D0048): the one-time moves of the
// folders, the login items and the storage keys from either old name, the old environment variables, and
// the sessions stored under the old sources. Temp folders only.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { CLI, link, unlink } from "../src/cli/link";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyEnv, moveFolder, OLD_NAMES, storedSource } from "../src/shared/legacy";
import { defaultFolders, runnerFolders } from "../src/runner/legacy";
import { Store } from "../src/runner/store";
import { migrateShell, oldLoginFiles, oldShellPaths } from "../src/shell/legacy";
import { electronExe, platformFor, type Platform } from "../src/shell/platform";
import { OLD_APP_IDS, dropOldLoginItem } from "../shell/src/legacy";

const dirs: string[] = [];
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cleat-legacy-")));
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

const OLD = ["holm", "intuition"] as const;

test("the old names, newest first", () => {
  expect(OLD_NAMES.map((o) => o.name)).toEqual([...OLD]);
  expect(OLD_NAMES[0]).toEqual({ name: "holm", shell: "holm-shell", launchAgent: "dev.holm.shell", autostart: "holm.desktop", appId: "holm", source: "holm", envPrefix: "HOLM_" });
});

describe("the old environment variables", () => {
  test("HOLM_X and INTUITION_X become CLEAT_X; a CLEAT_X that is set wins, then HOLM_X", () => {
    const env: Record<string, string | undefined> = {
      INTUITION_CONFIG: "/old.json",
      INTUITION_PORT: "1",
      HOLM_PORT: "2",
      HOLM_DATA_DIR: "/holm",
      INTUITION_DATA_DIR: "/intuition",
      INTUITION_PLATFORM: "linux",
      CLEAT_PLATFORM: "macos",
      OTHER: "x",
    };
    expect(adoptLegacyEnv(env).sort()).toEqual(["CLEAT_CONFIG", "CLEAT_DATA_DIR", "CLEAT_PORT"]);
    expect(env.CLEAT_CONFIG).toBe("/old.json");
    expect(env.CLEAT_PORT).toBe("2");
    expect(env.CLEAT_DATA_DIR).toBe("/holm");
    expect(env.CLEAT_PLATFORM).toBe("macos");
    expect(adoptLegacyEnv(env)).toEqual([]);
  });
});

describe("stored sessions", () => {
  test("both old sources and none read as cleat; terminal stays", () => {
    expect(storedSource(undefined, "cleat")).toBe("cleat");
    for (const old of OLD) expect(storedSource(old as "cleat", "cleat")).toBe("cleat");
    expect(storedSource<"cleat" | "terminal">("terminal", "cleat")).toBe("terminal");
  });

  test("the store reads a sessions.json an old runner wrote", () => {
    const dir = temp();
    const base = { workspace: "w", cwd: dir, title: "t", status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastSeq: 0 };
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify([{ ...base, id: "a", source: "intuition" }, { ...base, id: "b", source: "terminal" }, { ...base, id: "c" }, { ...base, id: "d", source: "holm" }]),
    );
    const store = new Store(dir);
    expect(["a", "b", "c", "d"].map((id) => store.get(id)?.source)).toEqual(["cleat", "terminal", "cleat", "cleat"]);
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
  test("the default folders, under the new name and each old one", () => {
    const { now, old } = defaultFolders("/h");
    expect(now).toEqual({ config: "/h/.config/cleat", data: "/h/.local/share/cleat" });
    expect(old).toEqual(OLD.map((name) => ({ name, config: `/h/.config/${name}`, data: `/h/.local/share/${name}` })));
  });

  for (const [i, name] of OLD.entries()) {
    test(`~/.config/${name} and ~/.local/share/${name} move to cleat once, and say so once`, () => {
      const home = temp();
      const { now } = defaultFolders(home);
      const old = defaultFolders(home).old[i]!;
      put(join(old.config, "config.json"), '{"workspaces":[]}');
      put(join(old.data, "sessions.json"), "[]");
      put(join(old.data, "events", "s.jsonl"), "{}");
      const said: string[] = [];
      expect(runnerFolders({}, home, (l) => said.push(l))).toEqual(now);
      expect(readFileSync(join(now.config, "config.json"), "utf8")).toBe('{"workspaces":[]}');
      expect(existsSync(join(now.data, "events", "s.jsonl"))).toBe(true);
      expect(existsSync(old.config) || existsSync(old.data)).toBe(false);
      expect(said).toEqual([`cleat: moved ${old.config} to ${now.config} (${name} is now called cleat)`, `cleat: moved ${old.data} to ${now.data} (${name} is now called cleat)`]);
      runnerFolders({}, home, (l) => said.push(l));
      expect(said.length).toBe(2);
    });
  }

  test("with both old names and a cleat folder: cleat's files are kept, then holm's, then intuition's fill what is left", () => {
    const home = temp();
    const { now, old } = defaultFolders(home);
    const [holm, intuition] = old as [(typeof old)[0], (typeof old)[0]];
    put(join(now.config, "config.json"), "cleat");
    put(join(holm.config, "config.json"), "holm");
    put(join(holm.data, "sessions.json"), "holm");
    put(join(intuition.data, "sessions.json"), "intuition");
    put(join(intuition.data, "events", "old.jsonl"), "e");
    put(join(intuition.config, "config.json"), "intuition");
    expect(runnerFolders({}, home, () => {})).toEqual(now);
    expect(readFileSync(join(now.config, "config.json"), "utf8")).toBe("cleat");
    expect(readFileSync(join(now.data, "sessions.json"), "utf8")).toBe("holm");
    expect(readFileSync(join(now.data, "events", "old.jsonl"), "utf8")).toBe("e");
    // What could not move stays where it was, and holm's folders, emptied, are gone.
    expect(readFileSync(join(intuition.data, "sessions.json"), "utf8")).toBe("intuition");
    expect(existsSync(holm.data)).toBe(false);
  });

  test("folders named by CLEAT_CONFIG and CLEAT_DATA_DIR are not moved", () => {
    const home = temp();
    for (const old of defaultFolders(home).old) {
      put(join(old.config, "config.json"), "{}");
      put(join(old.data, "sessions.json"), "[]");
    }
    runnerFolders({ CLEAT_CONFIG: join(home, "c.json"), CLEAT_DATA_DIR: join(home, "d") }, home, () => {});
    for (const old of defaultFolders(home).old) expect(existsSync(join(old.config, "config.json")) && existsSync(join(old.data, "sessions.json"))).toBe(true);
  });

  for (const [i, name] of OLD.entries()) {
    test(`while a ${name} runner runs from its old folder, nothing moves and its folders are used`, async () => {
      const home = temp();
      const { now } = defaultFolders(home);
      const old = defaultFolders(home).old[i]!;
      put(join(old.config, "config.json"), "{}");
      // A process whose command line names runner/main.ts, as an old runner's does.
      const fake = join(home, "app", "src", "runner", "main.ts");
      put(fake, "await Bun.sleep(30_000);\n");
      const child = Bun.spawn([process.execPath, fake], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        put(join(old.data, "runner.pid"), `${child.pid}\n`);
        const said: string[] = [];
        expect(runnerFolders({}, home, (l) => said.push(l))).toEqual({ config: old.config, data: old.data });
        expect(existsSync(now.config) || existsSync(now.data)).toBe(false);
        expect(said[0]).toContain(`still runs from ${old.data}`);
      } finally {
        child.kill();
        await child.exited;
      }
      expect(runnerFolders({}, home, () => {})).toEqual(now);
      expect(existsSync(join(now.data, "runner.pid"))).toBe(true);
    });
  }
});

/** A layout's platform with its pid check replaced. */
function withAlive(layout: "macos" | "linux", alive: (pid: number) => boolean): Platform {
  return { ...platformFor(layout), pidAlive: alive };
}

function shellLayout(base: string, layout: "macos" | "linux") {
  const app = join(base, "cleat", "shell");
  return { now: { home: join(base, "cleat"), app, electronExe: electronExe(app, layout) }, userData: join(base, "cleat-shell") };
}

describe("the installed shell", () => {
  test("the old paths are the new ones' siblings under the old names", () => {
    const base = temp();
    const { now, userData } = shellLayout(base, "macos");
    const old = oldShellPaths(now, userData, platformFor("macos"));
    expect(old.map((o) => [o.name, o.paths.app, o.userData])).toEqual(OLD.map((n) => [n, join(base, n, "shell"), join(base, `${n}-shell`)]));
  });

  for (const name of OLD) {
    test(`macOS: the ${name} shell, its settings and the launch agent move to the new names`, async () => {
      const base = temp();
      const home = temp();
      const { now, userData } = shellLayout(base, "macos");
      put(join(base, name, "shell", "main.cjs"), "bundle");
      put(join(base, `${name}-shell`, "settings.json"), '{"runnerUrl":"http://127.0.0.1:4777"}');
      put(join(base, `${name}-shell`, "Local Storage", "leveldb", "000003.log"), "storage");
      const oldPlist = join(home, "Library", "LaunchAgents", `dev.${name}.shell.plist`);
      put(oldPlist, "<plist/>");
      const log: string[] = [];
      let stopped = 0;
      const moved = await migrateShell({ now, userData, platform: withAlive("macos", () => false), log: (l) => log.push(l), home, stopOld: async () => void stopped++ });
      expect(moved).toBe(true);
      expect(stopped).toBe(0);
      expect(readFileSync(join(now.app, "main.cjs"), "utf8")).toBe("bundle");
      expect(existsSync(join(userData, "Local Storage", "leveldb", "000003.log"))).toBe(true);
      expect(existsSync(join(base, name)) || existsSync(join(base, `${name}-shell`))).toBe(false);
      expect(existsSync(oldPlist)).toBe(false);
      const plist = readFileSync(join(home, "Library", "LaunchAgents", "dev.cleat.shell.plist"), "utf8");
      expect(plist).toContain("<string>dev.cleat.shell</string>");
      expect(plist).toContain(`<string>${now.electronExe}</string>`);
      expect(plist).toContain(`<string>${now.app}</string>`);
      expect(log.length).toBe(3);
      expect(log[0]).toContain(`(${name} is now called cleat)`);
      // The second time: nothing to do.
      expect(await migrateShell({ now, userData, platform: withAlive("macos", () => false), log: () => {}, home, stopOld: async () => {} })).toBe(false);
    });
  }

  test("macOS with both old shells: holm's moves first and is kept, intuition's fills only what is missing, both launch agents go", async () => {
    const base = temp();
    const home = temp();
    const { now, userData } = shellLayout(base, "macos");
    put(join(base, "holm", "shell", "main.cjs"), "holm");
    put(join(base, "intuition", "shell", "main.cjs"), "intuition");
    put(join(base, "intuition", "shell", "extra.txt"), "x");
    put(join(base, "holm-shell", "settings.json"), "holm");
    put(join(base, "intuition-shell", "settings.json"), "intuition");
    const agents = join(home, "Library", "LaunchAgents");
    put(join(agents, "dev.holm.shell.plist"), "<plist/>");
    put(join(agents, "dev.intuition.shell.plist"), "<plist/>");
    expect(await migrateShell({ now, userData, platform: withAlive("macos", () => false), log: () => {}, home, stopOld: async () => {} })).toBe(true);
    expect(readFileSync(join(now.app, "main.cjs"), "utf8")).toBe("holm");
    expect(readFileSync(join(now.app, "extra.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(userData, "settings.json"), "utf8")).toBe("holm");
    expect(existsSync(join(agents, "dev.holm.shell.plist")) || existsSync(join(agents, "dev.intuition.shell.plist"))).toBe(false);
    expect(existsSync(join(agents, "dev.cleat.shell.plist"))).toBe(true);
  });

  test("a running old shell is asked to quit before anything moves; one that keeps running is left", async () => {
    const base = temp();
    const { now, userData } = shellLayout(base, "macos");
    put(join(base, "holm", "shell", "main.cjs"), "bundle");
    put(join(base, "holm-shell", "shell.pid"), "4242");
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
    expect(asked).toEqual([join(base, "holm", "shell"), join(base, "holm-shell", "shell.pid")]);
    expect(existsSync(join(now.app, "main.cjs"))).toBe(true);
  });

  test("Linux: the old autostart files give way to cleat.desktop; a new one already there is kept", async () => {
    const base = temp();
    const config = temp();
    const env = { XDG_CONFIG_HOME: config };
    const { now, userData } = shellLayout(base, "linux");
    const login = oldLoginFiles(platformFor("linux"), "/nowhere", env)!;
    expect(login).toEqual({ old: OLD.map((n) => join(config, "autostart", `${n}.desktop`)), now: join(config, "autostart", "cleat.desktop") });
    for (const file of login.old) put(file, "[Desktop Entry]\nName=old\n");
    expect(await migrateShell({ now, userData, platform: withAlive("linux", () => false), log: () => {}, home: "/nowhere", env, stopOld: async () => {} })).toBe(true);
    for (const file of login.old) expect(existsSync(file)).toBe(false);
    const entry = readFileSync(login.now, "utf8");
    expect(entry).toContain("Name=Cleat");
    expect(entry).toContain(now.electronExe);
    put(login.old[1]!, "old");
    put(login.now, "mine");
    await migrateShell({ now, userData, platform: withAlive("linux", () => false), log: () => {}, home: "/nowhere", env, stopOld: async () => {} });
    expect(readFileSync(login.now, "utf8")).toBe("mine");
    expect(existsSync(login.old[1]!)).toBe(false);
  });

  test("Windows: the shell removes both old Run values by name", () => {
    const calls: { openAtLogin: boolean; name: string }[] = [];
    dropOldLoginItem({ setLoginItemSettings: (s) => void calls.push({ openAtLogin: s.openAtLogin, name: s.name }) }, "C:\\electron.exe");
    expect(OLD_APP_IDS).toEqual([...OLD]);
    expect(calls).toEqual(OLD.map((name) => ({ openAtLogin: false, name })));
  });
});

describe("the command's link", () => {
  test("link replaces holm and intuition links to this checkout with cleat; one to elsewhere is left", () => {
    const dir = temp();
    for (const name of OLD) symlinkSync(CLI, join(dir, name));
    expect(link(dir, { PATH: "" }, () => {})).toBe(0);
    for (const name of OLD) expect(existsSync(join(dir, name))).toBe(false);
    expect(realpathSync(join(dir, "cleat"))).toBe(realpathSync(CLI));
    const other = temp();
    for (const name of OLD) symlinkSync(join(other, "cli.ts"), join(other, name));
    expect(unlink(other, () => {})).toBe(0);
    for (const name of OLD) expect(lstatSync(join(other, name)).isSymbolicLink()).toBe(true);
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

  for (const name of OLD) {
    test(`${name}.* keys become cleat.* once; a new value already there wins`, () => {
      const s = storage({ [`${name}.theme`]: "dark", [`${name}.dock.session`]: "abc", [`${name}.dock.workspace`]: "web", [`${name}.chat.folded`]: "[]", "cleat.theme": "light", other: "x" });
      run(s);
      expect(Object.fromEntries(s.map)).toEqual({ "cleat.theme": "light", "cleat.dock.session": "abc", "cleat.dock.workspace": "web", "cleat.chat.folded": "[]", other: "x" });
      run(s);
      expect(s.map.size).toBe(5);
    });
  }

  test("with both old names, holm's value wins over intuition's, and both old keys go", () => {
    const s = storage({ "holm.theme": "dark", "intuition.theme": "light", "intuition.chat.folded": "[1]" });
    run(s);
    expect(Object.fromEntries(s.map)).toEqual({ "cleat.theme": "dark", "cleat.chat.folded": "[1]" });
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
