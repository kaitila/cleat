// GET /api/agents (each agent as doctor checks it) and the resolved agent of GET /api/workspaces.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { AgentsResponse, WorkspacesResponse } from "../../src/shared/protocol";
import { claudeStatus, codexStatus, machineStatus, STATUS_TTL_MS, type Output } from "../../src/runner/agent-status";
import { testRunner, type TestRunner } from "./helpers";

const runners: TestRunner[] = [];
afterAll(async () => {
  for (const r of runners) await r.stop();
  for (const r of runners) rmSync(r.dir, { recursive: true, force: true });
});

/** An Output that answers from a table, by the command's words, and counts its calls. */
function table(answers: Record<string, string | null>) {
  const calls: string[] = [];
  const output: Output = async (cmd) => {
    const key = cmd.join(" ");
    calls.push(key);
    return answers[key] ?? null;
  };
  return { output, calls };
}

describe("an agent's status, as doctor checks it", () => {
  test("Claude Code: installed and logged in, installed and not, or missing", async () => {
    const ok = table({ "claude --version": "2.1.0 (Claude Code)", "claude auth status": '{"loggedIn": true, "authMethod": "claude.ai"}' });
    expect(await claudeStatus(ok.output)).toEqual({ agent: "claude", installed: true, version: "2.1.0 (Claude Code)", loggedIn: true, detail: "2.1.0 (Claude Code), logged in", fix: "" });
    const out = table({ "claude --version": "2.1.0 (Claude Code)", "claude auth status": '{"loggedIn": false}' });
    expect(await claudeStatus(out.output)).toMatchObject({ installed: true, loggedIn: false, fix: "Log in: cleat login" });
    // The Agent SDK's own Claude Code, when it is there: the same checks, asked of it.
    const sdk = table({ "/sdk/claude --version": "2.1.322 (Claude Code)", "/sdk/claude auth status": '{"loggedIn": true}' });
    expect(await claudeStatus(sdk.output, "/sdk/claude")).toMatchObject({ installed: true, version: "2.1.322 (Claude Code)", loggedIn: true });
    const none = table({});
    expect(await claudeStatus(none.output)).toMatchObject({ installed: false, version: null, loggedIn: false });
    // Not installed: the login isn't asked.
    expect(none.calls).toEqual(["claude --version"]);
  });

  test("Codex: the SDK's binary, its version and its login", async () => {
    const ok = table({ "/x/codex --version": "codex-cli 0.169.0", "/x/codex login status": "Logged in using ChatGPT" });
    expect(await codexStatus(ok.output, "/x/codex")).toEqual({ agent: "codex", installed: true, version: "codex-cli 0.169.0", loggedIn: true, detail: "codex-cli 0.169.0, logged in using ChatGPT", fix: "" });
    const out = table({ "/x/codex --version": "codex-cli 0.169.0", "/x/codex login status": "Not logged in" });
    expect(await codexStatus(out.output, "/x/codex")).toMatchObject({ installed: true, loggedIn: false, fix: "Log in: cleat login codex" });
    const none = table({});
    expect(await codexStatus(none.output, null)).toMatchObject({ installed: false, loggedIn: false });
    expect(none.calls).toEqual([]);
  });

  test("the answer is kept for STATUS_TTL_MS, then asked again", async () => {
    const t = table({ "claude --version": "2.1.0" });
    let now = 1_000_000;
    const status = machineStatus(t.output, () => null, () => now, () => null);
    const first = await status();
    expect(first.agents.map((a) => a.agent)).toEqual(["claude", "codex"]);
    await status();
    expect(t.calls.length).toBe(2);
    now += STATUS_TTL_MS;
    await status();
    expect(t.calls.length).toBe(4);
  });
});

describe("the routes", () => {
  test("GET /api/agents answers both agents; with the fake agent no command runs", async () => {
    const r = testRunner();
    runners.push(r);
    const res = await r.get("/api/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentsResponse;
    expect(body.agents.map((a) => [a.agent, a.installed, a.loggedIn])).toEqual([["claude", true, true], ["codex", true, true]]);
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  test("GET /api/agents passes the same Host and Origin check as every route", async () => {
    const r = testRunner();
    runners.push(r);
    expect((await fetch(`${r.url}/api/agents`, { headers: { origin: "https://example.com" } })).status).toBe(403);
  });

  test("GET /api/workspaces gives each workspace the agent a new session there runs on", async () => {
    const r = testRunner({ agent: "codex", workAgent: "claude" });
    runners.push(r);
    const { workspaces } = (await (await r.get("/api/workspaces")).json()) as WorkspacesResponse;
    expect(workspaces.map((w) => [w.name, w.agent])).toEqual([["work", "claude"], ["gone", "codex"]]);
  });
});
