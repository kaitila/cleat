// How a plugin reaches its MCP tools (plugin-agent.ts, D0057): the pure parts (tool names, servers'
// status, the locked-down options every call runs with) and the fake. No Claude Code runs here.
import { describe, expect, test } from "bun:test";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ASK_MODEL, fakePluginAgent, MCP_TOOL, normalServer, pluginOptions, serverOf, serversReady, TOOL_MODEL, waitForServers } from "../../src/runner/plugin-agent";
import { eventRow, localDay } from "../../plugins/calendar/plugin";
import { organizationRow, personRow } from "../../plugins/gamma/plugin";

const status = (name: string, s: McpServerStatus["status"]): McpServerStatus => ({ name, status: s });

describe("tool names", () => {
  test("serverOf reads the server out of an MCP tool's full name, null for anything else", () => {
    expect(serverOf("mcp__claude_ai_Google_Calendar__list_events")).toBe("claude_ai_Google_Calendar");
    expect(serverOf("mcp__example__find")).toBe("example");
    for (const not of ["Bash", "mcp__x", "mcp____y", "mcp__a b__c", "xmcp__a__b", ""]) expect(serverOf(not)).toBeNull();
    expect(MCP_TOOL.test("mcp__claude_ai_Gamma__search_people")).toBe(true);
  });

  test("normalServer writes a server's name as its tools' names do", () => {
    expect(normalServer("claude.ai Google Calendar")).toBe("claude_ai_Google_Calendar");
    expect(normalServer("my-server_2")).toBe("my-server_2");
  });
});

describe("serversReady", () => {
  const wanted = ["claude_ai_Example"];
  test("waits while the list is empty or a wanted server is pending", () => {
    expect(serversReady([], wanted)).toBe("wait");
    expect(serversReady([status("claude.ai Example", "pending")], wanted)).toBe("wait");
    // Missing while another still connects: it may yet appear.
    expect(serversReady([status("other", "pending")], wanted)).toBe("wait");
  });

  test("ready when every wanted server is connected", () => {
    expect(serversReady([status("claude.ai Example", "connected"), status("other", "failed")], wanted)).toBe("ready");
    expect(serversReady([status("a", "connected"), status("b", "connected")], ["a", "b"])).toBe("ready");
  });

  test("says why not: missing, failed, needs a sign-in", () => {
    expect(serversReady([status("other", "connected")], wanted)).toContain("no MCP server claude_ai_Example");
    expect(serversReady([status("claude.ai Example", "failed")], wanted)).toBe("claude.ai Example is failed");
    expect(serversReady([status("claude.ai Example", "needs-auth")], wanted)).toContain("sign in to it in Claude");
  });
});

describe("waitForServers", () => {
  const never = new AbortController().signal;
  test("returns at once when no tool is an MCP tool's", async () => {
    let asked = 0;
    await waitForServers(async () => (asked++, []), [], never);
    expect(asked).toBe(0);
  });

  test("polls until ready", async () => {
    const answers = [[], [status("claude.ai Example", "pending")], [status("claude.ai Example", "connected")]];
    let i = 0;
    await waitForServers(async () => answers[Math.min(i++, 2)]!, ["mcp__claude_ai_Example__find"], never, 5000);
    expect(i).toBe(3);
  });

  test("throws why when a server failed, and gives up waiting (without throwing) at the cap", async () => {
    await expect(waitForServers(async () => [status("claude.ai Example", "needs-auth")], ["mcp__claude_ai_Example__find"], never)).rejects.toThrow("needs-auth");
    await waitForServers(async () => [], ["mcp__claude_ai_Example__find"], never, 50);
  });
});

describe("pluginOptions", () => {
  const tools = ["mcp__claude_ai_Example__find"];
  const o = pluginOptions("/tmp/cleat-plugin-example", tools, new AbortController(), TOOL_MODEL);

  test("no built-in tool, only the plugin's allowed, nothing asked, no settings, no transcript", () => {
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(tools);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.cwd).toBe("/tmp/cleat-plugin-example");
    expect(o.model).toBe("haiku");
    expect(ASK_MODEL).toBe("sonnet");
  });

  test("never a mode or flag that skips permissions, and no way to answer canUseTool", () => {
    expect(["bypassPermissions", "acceptEdits", "auto", "default"]).not.toContain(o.permissionMode);
    expect(o).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(o).not.toHaveProperty("canUseTool");
    expect(o).not.toHaveProperty("disallowedTools");
    expect(o.env?.CLAUDE_CODE_ENTRYPOINT).toBeTruthy();
  });
});

describe("fakePluginAgent", () => {
  const signal = new AbortController().signal;
  test("a tool call answers its name and arguments as JSON; an ask its prompt", async () => {
    const fake = fakePluginAgent();
    expect(JSON.parse(await fake.tool({ tool: "mcp__x__y", args: { a: 1 }, cwd: "/tmp", signal }))).toEqual({ fake: true, tool: "mcp__x__y", args: { a: 1 } });
    expect(await fake.ask({ prompt: "who?", schema: {}, tools: [], cwd: "/tmp", signal })).toEqual({ fake: true, prompt: "who?" });
  });
});

// ---------- The built-in plugins' rows ----------

describe("Calendar's rows", () => {
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (h: number, m = 0) => new Date(2026, 10, 27, h, m);

  test("localDay is the day's start in local time, without an offset", () => {
    expect(localDay(new Date(2026, 0, 5, 13, 45))).toBe("2026-01-05T00:00:00");
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31T00:00:00");
  });

  test("a timed event: its times, where, others, its Meet link, and a task that names it", () => {
    const e = {
      summary: "  Board call ",
      start: { dateTime: day(9).toISOString() },
      end: { dateTime: day(10, 30).toISOString() },
      location: "Room Example",
      hangoutLink: "https://meet.example/abc",
      htmlLink: "https://calendar.example/e/1",
      attendees: [{ self: true, responseStatus: "accepted" }, {}, {}],
    };
    const row = eventRow(e, "today", day(8));
    expect(row).toEqual({
      title: "Board call",
      meta: `${clock(day(9))}–${clock(day(10, 30))}`,
      detail: "Room Example · Google Meet · 2 others",
      url: "https://meet.example/abc",
      task: `Prepare me for "Board call" (today, ${clock(day(9))}–${clock(day(10, 30))}) in my calendar: who is attending, what I know about them and our last conversations, and anything I should read first.`,
    });
  });

  test("tone: accent while it runs, muted once over or declined", () => {
    const e = { summary: "x", start: { dateTime: day(9).toISOString() }, end: { dateTime: day(10).toISOString() } };
    expect(eventRow(e, "today", day(9, 30)).tone).toBe("accent");
    expect(eventRow(e, "today", day(11)).tone).toBe("muted");
    expect(eventRow(e, "today", day(8)).tone).toBeUndefined();
    expect(eventRow({ ...e, attendees: [{ self: true, responseStatus: "declined" }] }, "today", day(8)).tone).toBe("muted");
  });

  test("an all-day event without a title; the calendar's link when there is no Meet; one other", () => {
    const row = eventRow({ start: { date: "2026-11-27" }, htmlLink: "https://calendar.example/e/2", attendees: [{ self: true }, {}] }, "tomorrow", day(8));
    expect(row).toMatchObject({ title: "(no title)", meta: "All day", detail: "1 other", url: "https://calendar.example/e/2" });
    expect(eventRow({ summary: "bare", start: { date: "2026-11-27" } }, "today", day(8))).not.toHaveProperty("url");
  });
});

describe("Gamma's rows", () => {
  test("a person: headline, else organization and city; their warmth, else Wave's", () => {
    expect(personRow({ id: "p1", name: "Ada Example", headline: "Founder", myWarmth: "strong" })).toEqual({
      title: "Ada Example",
      detail: "Founder",
      meta: "strong",
      tone: "accent",
      task: "Tell me about Ada Example (Gamma person p1): who they are, how I and Wave know them, and our last interactions.",
    });
    const row = personRow({ id: "p2", name: "Bo Example", organization: "Example Oy", city: "Espoo", myWarmth: "none", waveWarmth: "warm" });
    expect(row).toMatchObject({ detail: "Example Oy · Espoo", meta: "Wave: warm" });
    expect(row).not.toHaveProperty("tone");
    const cold = personRow({ id: "p3", name: "Cy Example", myWarmth: "none", waveWarmth: "none" });
    expect(cold).not.toHaveProperty("meta");
    expect(cold).not.toHaveProperty("detail");
  });

  test("a company: type and industry, how many at Wave know it, its LinkedIn", () => {
    expect(organizationRow({ id: "o1", name: "Example Oy", type: "startup", industry: null, knownBy: ["a"], linkedinUrl: "https://linkedin.example/c/example" })).toEqual({
      title: "Example Oy",
      detail: "startup",
      meta: "1 at Wave know",
      url: "https://linkedin.example/c/example",
      task: "Tell me about Example Oy (Gamma company o1): what they do, who we know there and how warm, and anything Wave has on them.",
    });
    const bare = organizationRow({ id: "o2", name: "Bare Oy" });
    expect(Object.keys(bare).sort()).toEqual(["task", "title"]);
  });
});
