// The settings page: its files are served, its pure logic (shortcuts from key presses, keycaps,
// the PUT body, where a 400's field points) does what the page relies on, and its markup has every
// section and field the contract has. The page in a browser: settings-ui.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentLines, fieldKeys, isDraft, keycaps, keyOf, move, putBody, recordKey, setupLines, usedAgents } from "../../src/web/settings-model.js";
import type { AgentsResponse, AgentStatus, PlatformResponse, ShellReport } from "../../src/shared/protocol";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const html = readFileSync(join(WEB, "settings.html"), "utf8");

describe("recording a shortcut", () => {
  test("letters, digits, function keys, arrows and punctuation are Electron's names", () => {
    expect(["KeyA", "Digit7", "F5", "F24", "Space", "ArrowUp", "Minus", "Numpad3", "Slash"].map(keyOf)).toEqual(["A", "7", "F5", "F24", "Space", "Up", "-", "num3", "/"]);
    expect(["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft", "F25", "IntlBackslash", ""].map(keyOf)).toEqual([null, null, null, null, null, null, null]);
  });

  test("a key with modifiers is an accelerator, the modifiers in Electron's order", () => {
    expect(recordKey({ code: "Space", ctrlKey: true, altKey: true })).toEqual({ accelerator: "Control+Alt+Space" });
    expect(recordKey({ code: "KeyS", metaKey: true, shiftKey: true, ctrlKey: true })).toEqual({ accelerator: "Control+Shift+Super+S" });
    expect(recordKey({ code: "F9", altKey: true })).toEqual({ accelerator: "Alt+F9" });
  });

  test("modifiers alone wait, Esc alone cancels, and a key without Ctrl, Alt or Win is refused", () => {
    expect(recordKey({ code: "ControlLeft", ctrlKey: true })).toEqual({ pending: true });
    expect(recordKey({ code: "Escape" })).toEqual({ cancel: true });
    expect(recordKey({ code: "Escape", ctrlKey: true })).toEqual({ accelerator: "Control+Escape" });
    expect("invalid" in recordKey({ code: "KeyK" })).toBe(true);
    expect("invalid" in recordKey({ code: "KeyK", shiftKey: true })).toBe(true);
  });

  test("keycaps: one per key, in the words on a Windows keyboard", () => {
    expect(keycaps("Control+Alt+Space")).toEqual(["Ctrl", "Alt", "Space"]);
    expect(keycaps("CommandOrControl+Shift+s")).toEqual(["Ctrl", "Shift", "S"]);
    expect(keycaps("Super+Up")).toEqual(["Win", "↑"]);
    expect(keycaps("Control+Plus")).toEqual(["Ctrl", "+"]);
    expect(keycaps("Alt+num4")).toEqual(["Alt", "Num 4"]);
    expect(keycaps("")).toEqual([]);
  });

  test("keycaps on a Mac: ⌘ for Super, and the modifiers by their symbols, never Win", () => {
    expect(keycaps("Super+Shift+Space", true)).toEqual(["⌘", "⇧", "Space"]);
    expect(keycaps("Control+Alt+S", true)).toEqual(["⌃", "⌥", "S"]);
    expect(keycaps("CommandOrControl+Return", true)).toEqual(["⌘", "Return"]);
    expect(recordKey({ code: "KeyK" }, true)).toEqual({ invalid: "Use ⌘, ⌥ or ⌃ with the key" });
  });
});

describe("saving", () => {
  const state = {
    theme: "dark",
    permissionMode: "auto",
    port: 4777,
    shell: { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true, startOnLogin: false },
    workspaces: [
      { name: " one ", path: "/a ", permissionMode: "default" },
      { name: "", path: "", fresh: true },
      { name: "two", path: "", fresh: true },
      { name: "three", path: "/c", fresh: true, permissionMode: "" },
      { name: "", path: "/d" },
    ],
  };

  test("a new row is held back until it has a name and a folder; a stored one is always sent", () => {
    expect(state.workspaces.map(isDraft)).toEqual([false, true, true, false, false]);
  });

  test("the body is the whole Settings, trimmed, and maps each sent workspace back to its row", () => {
    const { body, rows } = putBody(state);
    expect(body).toEqual({
      theme: "dark",
      permissionMode: "auto",
      port: 4777,
      shell: state.shell,
      workspaces: [{ name: "one", path: "/a", permissionMode: "default", agent: null }, { name: "three", path: "/c", agent: null }, { name: "", path: "/d", agent: null }],
    });
    expect(rows).toEqual([0, 3, 4]);
  });

  test("the agent goes at the top when the page has one, and on each workspace: its own, or null to clear it", () => {
    const { body } = putBody({ ...state, agent: "codex", workspaces: [{ name: "a", path: "/a", agent: "claude" }, { name: "b", path: "/b", agent: "codex" }, { name: "c", path: "/c" }] });
    expect(body.agent).toBe("codex");
    expect(body.workspaces.map((w) => w.agent)).toEqual(["claude", "codex", null]);
    // A runner from before agents sent none: none is sent, so it keeps its own.
    expect("agent" in putBody(state).body).toBe(false);
  });

  test("a 400's field is the page's keys, most precise first, in any of the usual spellings", () => {
    expect(fieldKeys("workspaces[1].path", [0, 3])).toEqual(["workspaces.3.path", "workspaces.3", "workspaces"]);
    expect(fieldKeys("workspaces.1.name", [0, 3])).toEqual(["workspaces.3.name", "workspaces.3", "workspaces"]);
    expect(fieldKeys("/shell/hotkey")).toEqual(["shell.hotkey", "shell"]);
    expect(fieldKeys("theme")).toEqual(["theme"]);
    expect(fieldKeys(undefined)).toEqual([]);
  });

  test("move keeps everything and refuses out of range", () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(move([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], -1, 0)).toEqual([1, 2, 3]);
  });
});

describe("the Setup section", () => {
  const report = (r: Partial<ShellReport> = {}): PlatformResponse["shell"]["report"] => ({
    os: "macos", startOnLogin: true, hotkeys: { hotkey: true, snipHotkey: true }, dockTransparent: true, screenRecording: "granted", reportedAt: "2026-11-15T00:00:00.000Z", ...r,
  });
  const platform = (layout: PlatformResponse["layout"], shell: PlatformResponse["shell"] = { connected: false, report: null }): PlatformResponse => ({ layout, runner: { running: true, version: "0.1.0" }, shell });
  const byKey = (lines: ReturnType<typeof setupLines>) => Object.fromEntries(lines.map((l) => [l.key, l]));

  test("all well on a Mac: the layout, runner, shell, start at login, shortcuts and Screen Recording, each ok", () => {
    const lines = setupLines(platform("macos", { connected: true, report: report() }), true);
    expect(lines.map((l) => l.key)).toEqual(["layout", "runner", "shell", "startOnLogin", "hotkeys", "screenRecording"]);
    expect(lines.every((l) => l.tone === "ok")).toBe(true);
    expect(lines.some((l) => l.action)).toBe(false);
  });

  test("Screen Recording missing: bad, says what to do, and has the button while the shell runs", () => {
    const line = byKey(setupLines(platform("macos", { connected: true, report: report({ screenRecording: "denied" }) }), true)).screenRecording!;
    expect(line.tone).toBe("bad");
    expect(line.detail).toContain("System Settings");
    expect(line.detail).toContain("Electron");
    expect(line.action).toBe("open_screen_recording");
  });

  test("no shell: it says how to start it, and what it would report is unknown, with no button", () => {
    const lines = byKey(setupLines(platform("macos"), true));
    expect(lines.shell!.tone).toBe("bad");
    expect(lines.shell!.detail).toContain("cleat up");
    expect(lines.startOnLogin!.tone).toBe("unknown");
    expect(lines.screenRecording!.tone).toBe("unknown");
    expect(lines.screenRecording!.action).toBeUndefined();
    expect(lines.hotkeys).toBeUndefined();
  });

  test("windows-wsl and linux have no Screen Recording line; WSL's fixes say In WSL", () => {
    const wsl = byKey(setupLines(platform("windows-wsl"), true));
    expect(wsl.layout!.value).toBe("Windows with WSL");
    expect(wsl.shell!.detail).toContain("In WSL");
    expect(wsl.screenRecording).toBeUndefined();
    const linux = byKey(setupLines(platform("linux", { connected: true, report: report({ os: "linux", screenRecording: undefined }) }), true));
    expect(linux.screenRecording).toBeUndefined();
    expect(linux.shell!.detail).toContain("Linux");
  });

  test("start at login off, or unreadable: says how to turn it on, or how to find out why", () => {
    const off = byKey(setupLines(platform("linux", { connected: true, report: report({ os: "linux", startOnLogin: false }) }), true)).startOnLogin!;
    expect(off.tone).toBe("off");
    expect(off.detail).toContain("cleat shell login on");
    const unread = byKey(setupLines(platform("linux", { connected: true, report: report({ os: "linux", startOnLogin: null }) }), true)).startOnLogin!;
    expect(unread.tone).toBe("bad");
    expect(unread.detail).toContain("cleat shell login status");
  });

  test("a hotkey not registered names it with its keys; an opaque dock gets a line", () => {
    const lines = byKey(setupLines(platform("linux", { connected: true, report: report({ os: "linux", hotkeys: { hotkey: true, snipHotkey: false }, dockTransparent: false }) }), true, { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S" }));
    expect(lines.hotkeys!.tone).toBe("bad");
    expect(lines.hotkeys!.detail).toContain("Snip (Ctrl+Alt+S)");
    expect(lines.hotkeys!.detail).not.toContain("New task");
    expect(lines.dock!.tone).toBe("off");
  });

  test("the runner not reachable, or no platform answer: the runner is bad and the rest unknown", () => {
    for (const lines of [byKey(setupLines(platform("macos", { connected: true, report: report() }), false)), byKey(setupLines(null, false))]) {
      expect(lines.runner!.tone).toBe("bad");
      expect(lines.runner!.detail).toContain("cleat up");
      expect(lines.shell!.tone).toBe("unknown");
    }
  });

  test("a layout the runner can't name says how to fix CLEAT_PLATFORM", () => {
    const line = byKey(setupLines(platform(null), true)).layout!;
    expect(line.tone).toBe("bad");
    expect(line.detail).toContain("CLEAT_PLATFORM");
  });

  test("every line that isn't ok says what to do", () => {
    const cases = [
      setupLines(null, false),
      setupLines(platform("macos"), true),
      setupLines(platform("macos", { connected: true, report: report({ startOnLogin: false, hotkeys: { hotkey: false, snipHotkey: false }, screenRecording: "not-determined" }) }), true),
      setupLines(platform("linux", { connected: true, report: report({ os: "linux", dockTransparent: false, startOnLogin: null }) }), true),
    ];
    for (const line of cases.flat()) {
      expect({ key: line.key, detail: line.detail.length > 10 }).toEqual({ key: line.key, detail: true });
    }
  });

  test("the page has the section's list and its row, and draws it through setupLines", () => {
    expect(html).toContain('id="setup"');
    expect(html).toContain('id="setup-row"');
    const js = readFileSync(join(WEB, "settings.js"), "utf8");
    expect(js).toContain("/api/platform");
    expect(js).toContain("/api/platform/open-screen-recording");
  });
});

describe("the page", () => {
  test("has every section the task names, in order", () => {
    const sections = [...html.matchAll(/<h2 id="h-[a-z]+" class="label">([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(sections).toEqual(["Setup", "Workspaces", "Agents", "Sessions", "Appearance", "Shortcuts", "Dock", "Startup", "About"]);
  });

  test("has a control for every setting of the contract, each named for the 400's field", () => {
    for (const field of ["workspaces", "permissionMode", "theme", "shell.hotkey", "shell.snipHotkey", "shell.dock", "shell.startOnLogin"]) {
      expect({ field, control: html.includes(`data-field="${field}"`) }).toEqual({ field, control: true });
    }
    for (const value of ["system", "light", "dark"]) expect(html).toContain(`name="theme" value="${value}"`);
    for (const value of ["auto", "default"]) expect(html).toContain(`name="permissionMode" value="${value}"`);
  });

  test("never turns the runner's text into markup", () => {
    const js = readFileSync(join(WEB, "settings.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  const runner = testRunner();
  afterAll(() => runner.stop());
  test("the runner serves it and its files", async () => {
    for (const file of ["settings.html", "settings.css", "settings.js", "settings-model.js", "theme.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect({ file, status: res.status }).toEqual({ file, status: 200 });
    }
  });
});

describe("the Agents section", () => {
  const status = (agent: "claude" | "codex", installed: boolean, loggedIn: boolean, detail = "", fix = ""): AgentStatus => ({ agent, installed, version: installed ? "1.0" : null, loggedIn, detail, fix });
  const answer = (...agents: AgentStatus[]): AgentsResponse => ({ agents, checkedAt: "2026-11-16T00:00:00Z" });

  test("one line per agent, Claude Code first, each saying what it needs and what doctor found", () => {
    const lines = agentLines(answer(status("claude", true, true, "2.1.0 (Claude Code), logged in"), status("codex", true, true, "codex-cli 0.169.0, logged in using ChatGPT")), true);
    expect(lines.map((l) => [l.key, l.name, l.tone, l.value])).toEqual([["claude", "Claude Code", "ok", "Ready"], ["codex", "Codex", "ok", "Ready"]]);
    expect(lines[0]!.detail).toBe("Needs Claude Code installed and logged in. Found 2.1.0 (Claude Code), logged in.");
    expect(lines[1]!.detail).toContain("Needs Codex installed and logged in.");
  });

  test("an agent that can't run says what to do: red when sessions would run on it, amber when nothing uses it", () => {
    const missing = answer(status("claude", true, false, "", "Log in: claude auth login"), status("codex", false, false, "", "bun install in the repo installs it"));
    const [claude, codex] = agentLines(missing, true, ["claude"]);
    expect([claude!.tone, claude!.value, claude!.detail]).toEqual(["bad", "Not logged in", "Needs Claude Code installed and logged in. Log in: claude auth login"]);
    expect([codex!.tone, codex!.value]).toEqual(["off", "Not installed"]);
    expect(agentLines(missing, true, ["codex"])[1]!.tone).toBe("bad");
  });

  test("unknown before the answer, from a runner without the route, and while the runner is away", () => {
    expect(agentLines(null, true).map((l) => [l.tone, l.value])).toEqual([["unknown", "Unknown"], ["unknown", "Unknown"]]);
    expect(agentLines(answer(status("claude", true, true)), false)[0]!.detail).toContain("Shown once the runner answers.");
  });

  test("the agents in use: the default and each workspace's own", () => {
    expect(usedAgents(null)).toEqual(["claude"]);
    expect(usedAgents({ agent: "codex", workspaces: [{}, { agent: "claude" }] })).toEqual(["codex", "claude"]);
  });

  test("the page has the default agent's choice and a workspace's own, with Default to clear it", () => {
    expect(html).toContain('data-field="agent"');
    expect(html).toMatch(/<input type="radio" name="agent" value="claude"><span>Claude Code<\/span>/);
    expect(html).toMatch(/<input type="radio" name="agent" value="codex"><span>Codex<\/span>/);
    expect(html).toMatch(/<select class="select agent" aria-label="Agent">[\s\S]*<option value="">Default agent<\/option>[\s\S]*<option value="codex">Codex<\/option>/);
  });
});
