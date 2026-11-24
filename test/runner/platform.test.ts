// The Setup section's API: GET /api/platform, the shell's report (PUT /api/platform/shell), its socket
// (/ws?client=shell), and the page's ask to open Screen Recording, relayed to the shell as a shell_action.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Layout as ContractLayout, PlatformResponse, ServerMessage, ShellReport } from "../../src/shared/protocol";
import { NO_MAC_SHELL } from "../../src/shared/protocol";
import { layoutOrNull, parseReport, ShellState } from "../../src/runner/platform";
import { VERSION } from "../../src/runner/server";
import type { Layout as DetectedLayout } from "../../src/shell/platform";
import { connect, testRunner, type TestRunner } from "./helpers";

const runners: TestRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const r of runners) rmSync(r.dir, { recursive: true, force: true });
});

/** A runner whose layout is `layout`, as CLEAT_PLATFORM says when it starts. */
function runner(layout = "macos"): TestRunner {
  const before = process.env.CLEAT_PLATFORM;
  process.env.CLEAT_PLATFORM = layout;
  try {
    const r = testRunner();
    runners.push(r);
    return r;
  } finally {
    if (before === undefined) delete process.env.CLEAT_PLATFORM;
    else process.env.CLEAT_PLATFORM = before;
  }
}

const MAC: ShellReport = { os: "macos", startOnLogin: false, hotkeys: { hotkey: true, snipHotkey: false }, dockTransparent: true, screenRecording: "denied" };
const LINUX: ShellReport = { os: "linux", startOnLogin: true, hotkeys: { hotkey: true, snipHotkey: true }, dockTransparent: false };

function put(r: TestRunner, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Promise<Response> {
  return fetch(r.url + "/api/platform/shell", { method: "PUT", headers, body: JSON.stringify(body) });
}

async function platform(r: TestRunner): Promise<PlatformResponse> {
  const res = await r.get("/api/platform");
  expect(res.status).toBe(200);
  return (await res.json()) as PlatformResponse;
}

const isPlatform = (m: ServerMessage): m is Extract<ServerMessage, { type: "platform" }> => m.type === "platform";

describe("GET /api/platform", () => {
  test("answers the layout, the runner running with its version, and no shell before one connects", async () => {
    const r = runner("linux");
    expect(await platform(r)).toEqual({ layout: "linux", runner: { running: true, version: VERSION }, shell: { connected: false, report: null } });
  });

  test("passes the port's guard: a foreign Origin or Host is refused", async () => {
    const r = runner();
    expect((await fetch(r.url + "/api/platform", { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(r.url + "/api/platform", { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("the layout is detectLayout's; one it can't name is null and the runner still answers", () => {
    expect(layoutOrNull({ CLEAT_PLATFORM: "windows-wsl" })).toBe("windows-wsl");
    expect(layoutOrNull({ CLEAT_PLATFORM: "amiga" })).toBeNull();
    // The contract's Layout and the command line's are the same three: this fails to typecheck otherwise.
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const same: Same<ContractLayout, DetectedLayout> = true;
    expect(same).toBe(true);
  });
});

describe("the shell's socket and report", () => {
  test("a socket at ?client=shell makes it connected; its report is kept and sent; its close forgets it", async () => {
    const r = runner();
    const page = await connect(r);
    const shell = await connect(r, "?client=shell");
    await page.waitFor((m) => isPlatform(m) && m.platform.shell.connected && m.platform.shell.report === null);
    expect((await platform(r)).shell).toEqual({ connected: true, report: null });

    const res = await put(r, MAC);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as PlatformResponse;
    expect(answer.shell.connected).toBe(true);
    expect(answer.shell.report).toMatchObject(MAC);
    expect(Number.isNaN(Date.parse(answer.shell.report!.reportedAt))).toBe(false);
    await page.waitFor((m) => isPlatform(m) && m.platform.shell.report?.screenRecording === "denied");
    expect((await platform(r)).shell.report).toMatchObject(MAC);

    shell.close();
    await page.waitFor((m) => isPlatform(m) && !m.platform.shell.connected);
    expect((await platform(r)).shell).toEqual({ connected: false, report: null });
    page.close();
  });

  test("a page's socket (no ?client=shell) is not the shell", async () => {
    const r = runner();
    const page = await connect(r);
    expect((await platform(r)).shell.connected).toBe(false);
    page.close();
  });

  test("the report is validated: a bad field is a 400 naming it, and nothing is kept", async () => {
    const r = runner();
    for (const bad of [{ ...MAC, os: "beos" }, { ...MAC, hotkeys: { hotkey: true } }, { ...MAC, startOnLogin: "yes" }, { ...MAC, extra: 1 }, { ...MAC, screenRecording: "maybe" }]) {
      const res = await put(r, bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect((await put(r, [1])).status).toBe(400);
    expect((await platform(r)).shell.report).toBeNull();
  });

  test("the report passes the port's guard: no JSON content type, or a foreign Origin, is a 403", async () => {
    const r = runner();
    expect((await put(r, MAC, { "content-type": "text/plain" })).status).toBe(403);
    expect((await put(r, MAC, { "content-type": "application/json", origin: "http://evil.example" })).status).toBe(403);
    expect((await platform(r)).shell.report).toBeNull();
  });

  test("Screen Recording is macOS's alone: dropped from another OS's report", () => {
    expect(parseReport({ ...LINUX, screenRecording: "granted" })).toEqual(LINUX);
    expect(parseReport(MAC)).toEqual(MAC);
    expect(parseReport({ ...MAC, startOnLogin: null })).toEqual({ ...MAC, startOnLogin: null });
  });

  test("two shell sockets: the report stays until the last one closes", () => {
    const s = new ShellState("macos", "1");
    s.connect();
    s.connect();
    s.setReport(MAC);
    expect(s.disconnect()).toBe(false);
    expect(s.response().shell.report).not.toBeNull();
    expect(s.disconnect()).toBe(true);
    expect(s.response().shell).toEqual({ connected: false, report: null });
  });
});

describe("POST /api/platform/open-screen-recording", () => {
  const open = (r: TestRunner, headers: Record<string, string> = { "content-type": "application/json" }) =>
    fetch(r.url + "/api/platform/open-screen-recording", { method: "POST", headers, body: "{}" });

  test("409 without a shell, and with a shell that isn't on macOS", async () => {
    const r = runner();
    let res = await open(r);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_MAC_SHELL);
    const shell = await connect(r, "?client=shell");
    expect((await open(r)).status).toBe(409);
    await put(r, LINUX);
    res = await open(r);
    expect(res.status).toBe(409);
    shell.close();
  });

  test("with a shell on macOS: 202, and only the shell's sockets get the shell_action", async () => {
    const r = runner();
    const page = await connect(r);
    const shell = await connect(r, "?client=shell");
    await put(r, MAC);
    const res = await open(r);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });
    expect(await shell.waitFor((m) => m.type === "shell_action")).toEqual({ type: "shell_action", action: "open_screen_recording" });
    // The page's socket got the platform messages, never the action.
    await page.waitFor((m) => isPlatform(m) && m.platform.shell.report !== null);
    await Bun.sleep(100);
    expect(page.messages.some((m) => m.type === "shell_action")).toBe(false);
    page.close();
    shell.close();
  });

  test("passes the port's guard: no JSON content type, or a foreign Origin, is a 403, and nothing is sent", async () => {
    const r = runner();
    const shell = await connect(r, "?client=shell");
    await put(r, MAC);
    expect((await open(r, { "content-type": "text/plain" })).status).toBe(403);
    expect((await open(r, { "content-type": "application/json", origin: "http://evil.example" })).status).toBe(403);
    await Bun.sleep(100);
    expect(shell.messages.some((m) => m.type === "shell_action")).toBe(false);
    shell.close();
  });
});
