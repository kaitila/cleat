// The two agents as the pages show them (src/web/agent.js): names, the switch's choice and key, the
// placeholder, and that every page that shows an agent imports the module the runner serves.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentName, agentOf, agentTitle, flipAgent, isAgentKey, pickAgent, taskPlaceholder } from "../../src/web/agent.js";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");

describe("agent names", () => {
  test("Codex only when it says so; anything else, absent included, is Claude Code", () => {
    expect(agentOf({ agent: "codex" })).toBe("codex");
    expect(agentOf({ agent: "claude" })).toBe("claude");
    expect(agentOf({})).toBe("claude");
    expect(agentOf(undefined)).toBe("claude");
    expect([agentName("codex"), agentName("claude"), agentName("x")]).toEqual(["Codex", "Claude Code", "Claude Code"]);
    expect(agentTitle("codex")).toBe("Runs on Codex");
  });

  test("the flip goes to the other one", () => {
    expect(flipAgent("claude")).toBe("codex");
    expect(flipAgent("codex")).toBe("claude");
  });
});

describe("the switch", () => {
  const workspaces = [{ name: "a" }, { name: "b", agent: "codex" }, { name: "c", agent: "claude" }];
  test("defaults to the chosen workspace's agent, Claude Code when it has none or none is chosen", () => {
    expect(pickAgent(workspaces, "a")).toBe("claude");
    expect(pickAgent(workspaces, "b")).toBe("codex");
    expect(pickAgent(workspaces, null)).toBe("claude");
  });
  test("a flip sticks, whichever workspace is chosen after", () => {
    expect(pickAgent(workspaces, "b", "claude")).toBe("claude");
    expect(pickAgent(workspaces, "a", "codex")).toBe("codex");
    expect(pickAgent(workspaces, "b", "nonsense")).toBe("codex");
  });
  test("its key is Alt+A, by the physical key, and not with Ctrl, Meta or Shift", () => {
    expect(isAgentKey({ altKey: true, code: "KeyA", key: "å" })).toBe(true);
    expect(isAgentKey({ altKey: true, key: "a" })).toBe(true);
    expect(isAgentKey({ code: "KeyA", key: "a" })).toBe(false);
    expect(isAgentKey({ altKey: true, ctrlKey: true, code: "KeyA" })).toBe(false);
    expect(isAgentKey({ altKey: true, shiftKey: true, code: "KeyA" })).toBe(false);
    expect(isAgentKey({ altKey: true, code: "KeyS" })).toBe(false);
  });
  test("the task box asks who will do it", () => {
    expect(taskPlaceholder("claude")).toBe("What should Claude do?");
    expect(taskPlaceholder("codex", true)).toBe("What should Codex do with this?");
  });
});

describe("the pages", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("the runner serves the module, and it imports nothing", async () => {
    const res = await runner.get("/assets/agent.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(source("agent.js")).not.toMatch(/from "/);
  });

  test("the pop-up, the snip, the settings, the chat and the dock take the agents from it", () => {
    for (const file of ["prompt.js", "snip.js", "settings.js", "chat.js", "dock.js"]) expect({ file, imports: source(file).includes('from "./agent.js"') }).toEqual({ file, imports: true });
  });

  test("the pop-up's switch sits beside the workspaces, and the hints name its key", () => {
    const html = source("prompt.html");
    expect(html).toMatch(/id="workspaces"[\s\S]*<button id="agent" class="agent-switch[^"]*" type="button" aria-keyshortcuts="Alt\+A"/);
    expect(html).toContain("<kbd>Alt</kbd><kbd>A</kbd><span>agent</span>");
  });
});
