// The chat view: its files are served by the runner, its pure helpers do what the page relies on,
// and its sources keep the two rules a reader can't see on the page: untrusted text never becomes
// markup. (That the stylesheet has no raw values of its own is test/web/design.test.ts.)
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_MAX_CHARS,
  APPROVAL_MAX_LINES,
  RESULT_MAX_CHARS,
  approvalView,
  backoffMs,
  byActivity,
  cutResult,
  decidedLabel,
  inputText,
  isOpenInTerminal,
  pickSession,
  relativeTime,
  replyState,
  resultLine,
  resumeCommand,
  sessionStatus,
  shellWord,
  startedInTerminal,
  stepsSummary,
  toolLabel,
  toolLabelText,
  toolSummary,
  unknownNote,
  WORKING_WORDS,
  workingWord,
  pagesChanged,
  elapsedLabel,
} from "../../src/web/chat-format.js";
import { ICON_KEYS, iconKey } from "../../src/web/tool-icons.js";
import { OPEN_IN_TERMINAL } from "../../src/shared/protocol";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");

describe("served by the runner", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("/ is the chat page and loads its stylesheets and module from /assets", async () => {
    const res = await runner.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const asset of ["/assets/base.css", "/assets/chat.css", "/assets/chat.js"]) expect(html).toContain(asset);
    expect(html).toContain('href="/prompt"');
  });

  test("the modules and the stylesheet are served with their types", async () => {
    for (const file of ["chat.js", "chat-format.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    }
    const css = await runner.get("/assets/chat.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("every module chat.js imports is one the runner serves", async () => {
    const imports = [...source("chat.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imports).toEqual(["chat-format.js", "chat-manage.js", "chat-resume.js", "agent.js", "markdown.js", "questions.js", "keys.js", "shortcuts.js", "shortcuts-sheet.js", "tool-icons.js", "working.js"]);
    expect([...source("working.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!)).toEqual(["chat-format.js", "tool-icons.js"]);
    expect([...source("tool-icons.js").matchAll(/from "\.\/([^"]+)"/g)]).toEqual([]);
    expect([...source("chat-manage.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!)).toEqual(["chat-format.js"]);
    expect([...source("chat-resume.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!)).toEqual(["chat-format.js"]);
    for (const file of imports) expect((await runner.get(`/assets/${file}`)).status).toBe(200);
  });
});

describe("pages reload when the runner serves new ones (D0054)", () => {
  test("only a known build id that changes is a change", () => {
    expect(pagesChanged(null, "abc123")).toBe(false);
    expect(pagesChanged("abc123", "abc123")).toBe(false);
    expect(pagesChanged("abc123", undefined)).toBe(false);
    expect(pagesChanged("abc123", "")).toBe(false);
    expect(pagesChanged("abc123", "def456")).toBe(true);
  });

  test("the chat and the dock reload on a hello with another build, before drawing anything", () => {
    for (const script of ["chat.js", "dock.js"]) {
      expect(source(script)).toMatch(/case "hello": \{\n(?:\s*\/\/[^\n]*\n)?\s*if \(pagesChanged\(build, message\.build\)\) return location\.reload\(\);\n\s*build \?\?= message\.build \?\? null;/);
    }
  });
});

describe("the working mark (D0051, D0053)", () => {
  test("its word is island lingo, one of the list, ending in an ellipsis", () => {
    expect(WORKING_WORDS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(WORKING_WORDS).size).toBe(WORKING_WORDS.length);
    expect(workingWord(0)).toBe(`${WORKING_WORDS[0]}…`);
    expect(workingWord(0.9999)).toBe(`${WORKING_WORDS.at(-1)}…`);
    expect(workingWord(1)).toBe(`${WORKING_WORDS.at(-1)}…`);
    expect(workingWord(-1)).toBe(`${WORKING_WORDS[0]}…`);
    for (let i = 0; i < 50; i++) expect(WORKING_WORDS.map((w) => `${w}…`)).toContain(workingWord());
  });

  test("the next word never repeats the one shown (D0055)", () => {
    for (let i = 0; i < WORKING_WORDS.length; i++) {
      const shown = `${WORKING_WORDS[i]}…`;
      expect(workingWord((i + 0.5) / WORKING_WORDS.length, shown)).not.toBe(shown);
    }
  });

  test("the time beside it: seconds, then minutes and seconds, then hours and minutes; nothing under a second", () => {
    expect(elapsedLabel(0)).toBe("");
    expect(elapsedLabel(999)).toBe("");
    expect(elapsedLabel(4_200)).toBe("4s");
    expect(elapsedLabel(59_999)).toBe("59s");
    expect(elapsedLabel(65_000)).toBe("1m 05s");
    expect(elapsedLabel(3_725_000)).toBe("1h 02m");
    expect(elapsedLabel(Number.NaN)).toBe("");
  });

  test("the chat and the dock both draw it from one template: the Ledge, the step's icon, the word, the time", () => {
    for (const [page, script] of [["chat.html", "chat.js"], ["dock.html", "dock.js"]] as const) {
      expect(source(page)).toMatch(/<template id="working-template"><div class="working" role="status" aria-label="Working"><svg class="working-mark"[^]*<circle class="working-dot"[^]*<\/svg><span class="working-step" hidden><\/span><span class="working-word"><\/span><span class="working-time" hidden><\/span><\/div><\/template>/);
      expect(source(script)).toContain('session?.status !== "running"');
      expect(source(script)).toContain("workingIndicator(document)");
      // A turn that ends lets it fade away rather than vanish.
      expect(source(script)).toContain("working?.leave()");
    }
    const working = source("working.js");
    expect(working).toContain('getElementById("working-template")');
    expect(working).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    // A loop of 2.5 to 4 seconds (D0055).
    expect(working).toContain("WORD_MS = 4000");
  });
});

describe("tool icons (D0055)", () => {
  test("a built-in tool has its own, a connector its server's, any other connector a plug, any other tool a wrench", () => {
    expect(iconKey("Bash")).toBe("terminal");
    expect(iconKey("Read")).toBe("file");
    expect(iconKey("Edit")).toBe("pencil");
    expect(iconKey("Grep")).toBe("search");
    expect(iconKey("WebFetch")).toBe("globe");
    expect(iconKey("Skill")).toBe("spark");
    expect(iconKey("ToolSearch")).toBe("plug");
    expect(iconKey("mcp__claude_ai_Gmail__search_threads")).toBe("mail");
    expect(iconKey("mcp__claude_ai_Google_Calendar__list_events")).toBe("calendar");
    expect(iconKey("mcp__claude_ai_Google_Drive__search_files")).toBe("folder");
    expect(iconKey("mcp__claude_ai_Google_Sheets__get_values")).toBe("grid");
    expect(iconKey("mcp__claude_ai_Slack__slack_search_public")).toBe("bubble");
    expect(iconKey("mcp__claude_ai_Notion__notion-search")).toBe("page");
    expect(iconKey("mcp__claude_ai_Gamma__list_funds")).toBe("graph");
    expect(iconKey("mcp__claude_ai_NoCFO__constants_retrieve")).toBe("receipt");
    expect(iconKey("mcp__somewhere__else")).toBe("plug");
    expect(iconKey("Mystery")).toBe("tool");
    expect(iconKey(undefined)).toBe("tool");
    expect(iconKey("constructor")).toBe("tool");
  });

  test("every key has a shape, and the markup is fixed: a tool's name only picks a key", () => {
    const code = source("tool-icons.js");
    for (const key of ICON_KEYS) expect(code).toContain(`${key}: '`);
    // The only interpolations in the markup are the key and its shape, never the name itself.
    const inserted = [...code.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    expect(inserted).toEqual(["iconKey(name)", "SHAPES[iconKey(name)]"]);
    expect(code).not.toMatch(/\bdocument\b|\bwindow\b/);
  });
});

describe("toolLabel and stepsSummary", () => {
  test("an MCP tool is its server, without claude.ai, and its tool's words", () => {
    expect(toolLabel("mcp__claude_ai_Gamma__list_funds")).toEqual({ source: "Gamma", action: "list funds" });
    expect(toolLabel("mcp__claude_ai_Google_Drive__read_file_content")).toEqual({ source: "Google Drive", action: "read file content" });
    expect(toolLabel("mcp__foreman__claim_task")).toEqual({ source: "foreman", action: "claim task" });
    expect(toolLabelText("mcp__claude_ai_Slack__slack_search_public")).toBe("Slack search public");
    expect(toolLabel("mcp__claude_ai_Notion__notion")).toEqual({ source: "Notion", action: "notion" });
  });
  test("ToolSearch is loading tools; anything else is its own name", () => {
    expect(toolLabel("ToolSearch")).toEqual({ source: "Tools", action: "load" });
    expect(toolLabel("Bash")).toEqual({ source: "Bash", action: "" });
    expect(toolLabel(undefined)).toEqual({ source: "Tool", action: "" });
    expect(toolLabelText("Read")).toBe("Read");
  });
  test("a run says how many steps and names its first three sources", () => {
    expect(stepsSummary(["Bash"])).toEqual({ count: "1 step", sources: "Bash" });
    const names = ["Skill", "ToolSearch", "Bash", "mcp__claude_ai_Google_Drive__search_files", "mcp__claude_ai_Gamma__list_funds", "mcp__claude_ai_Gamma__list_deals", "Bash"];
    expect(stepsSummary(names)).toEqual({ count: "7 steps", sources: "Skill, Bash, Google Drive +1" });
    expect(stepsSummary(["ToolSearch", "ToolSearch"])).toEqual({ count: "2 steps", sources: "Tools" });
    expect(stepsSummary(["mcp__claude_ai_Gamma__a", "mcp__claude_ai_Gamma__b"])).toEqual({ count: "2 steps", sources: "Gamma" });
  });
});

describe("toolSummary", () => {
  test("Bash: the command, on one line", () => {
    expect(toolSummary("Bash", { command: "echo fake" })).toBe("echo fake");
    expect(toolSummary("Bash", { command: "cd /tmp &&\n  ls -la", description: "x" })).toBe("cd /tmp && ls -la");
  });
  test("file tools: the path", () => {
    expect(toolSummary("Read", { file_path: "/src/a.ts", limit: 10 })).toBe("/src/a.ts");
    expect(toolSummary("Edit", { file_path: "/src/b.ts", old_string: "x", new_string: "y" })).toBe("/src/b.ts");
    expect(toolSummary("Grep", { pattern: "x", path: "src" })).toBe("src");
    expect(toolSummary("NotebookEdit", { notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
  });
  test("anything else: its telling text field, else its first text, at most 80 characters", () => {
    expect(toolSummary("WebSearch", { query: "bun" })).toBe("bun");
    expect(toolSummary("Skill", { skill: "book-investment", args: "Pyramid" })).toBe("book-investment");
    expect(toolSummary("mcp__claude_ai_Gamma__list_deals", { stage: "all", q: "Pyramid" })).toBe("Pyramid");
    expect(toolSummary("mcp__claude_ai_Gmail__get", { limit: 3, threadId: "t1" })).toBe("t1");
    expect(toolSummary("mcp__claude_ai_Gamma__list_funds", {})).toBe("");
    expect(toolSummary("Task", { prompt: "p".repeat(300) })).toBe("p".repeat(80));
  });
  test("ToolSearch: the tools it loads, by their labels", () => {
    expect(toolSummary("ToolSearch", { query: "select:mcp__claude_ai_Google_Drive__search_files,mcp__claude_ai_Gmail__get_thread" })).toBe("Google Drive search files, Gmail get thread");
    expect(toolSummary("ToolSearch", { query: "+Gamma portal" })).toBe("+Gamma portal");
  });
  test("an input with no text: JSON, at most 80 characters", () => {
    const long = toolSummary("Odd", { n: [1, 2, 3], deep: { x: "p".repeat(300) } });
    expect(long).toHaveLength(80);
    expect(long.startsWith('{"n":[1,2,3]')).toBe(true);
    expect(toolSummary("Odd", "plain\ntext")).toBe("plain text");
    expect(toolSummary("Odd", undefined)).toBe("");
    expect(toolSummary("Odd", null)).toBe("null");
    expect(toolSummary("Bash", { command: 5 })).toBe('{"command":5}');
  });
  test("inputText keeps a string and prints the rest as JSON", () => {
    expect(inputText("as is")).toBe("as is");
    expect(inputText({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    expect(inputText(undefined)).toBe("");
  });
});

describe("approvalView", () => {
  test("Bash: the whole command as it is, however long", () => {
    const command = `cd /tmp &&\n  rm -rf ${"x".repeat(5000)}`;
    expect(approvalView("Bash", { command, description: "tidy" })).toEqual({ path: "", text: command, full: command });
  });
  test("file tools: the path and a cut preview of the text to be written", () => {
    expect(approvalView("Write", { file_path: "/w/proof.txt", content: "hi" })).toEqual({ path: "/w/proof.txt", text: "hi", full: "hi" });
    expect(approvalView("Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" })).toEqual({ path: "/w/a.ts", text: "y", full: "y" });
    expect(approvalView("Read", { file_path: "/etc/hosts" })).toEqual({ path: "/etc/hosts", text: "", full: "" });
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const byLines = approvalView("Write", { file_path: "/w/b", content: long });
    expect(byLines.text.split("\n")).toHaveLength(APPROVAL_MAX_LINES);
    expect(byLines.full).toBe(long);
    const wide = approvalView("Write", { file_path: "/w/c", content: "x".repeat(APPROVAL_MAX_CHARS + 50) });
    expect(wide.text).toHaveLength(APPROVAL_MAX_CHARS);
  });
  test("anything else: the input as JSON, cut", () => {
    expect(approvalView("WebFetch", { url: "https://example.com" })).toEqual({ path: "", text: '{\n  "url": "https://example.com"\n}', full: '{\n  "url": "https://example.com"\n}' });
    expect(approvalView("Bash", { command: 5 }).text).toBe('{\n  "command": 5\n}');
    expect(approvalView("Odd", undefined)).toEqual({ path: "", text: "", full: "" });
    expect(approvalView("Odd", "plain")).toEqual({ path: "", text: "plain", full: "plain" });
    const big = approvalView("Task", { prompt: "p".repeat(3000) });
    expect(big.text.length).toBeLessThan(big.full.length);
  });
  test("what a decided card says", () => {
    expect(decidedLabel("allow")).toBe("Allowed");
    expect(decidedLabel("deny")).toBe("Denied");
    expect(decidedLabel(undefined)).toBe("Not answered");
    expect(decidedLabel("constructor")).toBe("Not answered");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  test("now, minutes, hours, days, then the date", () => {
    expect(relativeTime(ago(5_000), now)).toBe("now");
    expect(relativeTime(ago(50_000), now)).toBe("1m");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(ago(59 * 60_000 + 59_000), now)).toBe("60m");
    expect(relativeTime(ago(3 * 3_600_000 + 60_000), now)).toBe("3h");
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe("2d");
    expect(relativeTime(ago(30 * 86_400_000), now)).toMatch(/13/);
  });
  test("a clock that is behind, and a time that isn't one", () => {
    expect(relativeTime(ago(-60_000), now)).toBe("now");
    expect(relativeTime("nonsense", now)).toBe("");
  });
});

describe("the rest of the helpers", () => {
  test("cutResult cuts by lines and by characters, and says so", () => {
    expect(cutResult("short")).toEqual({ text: "short", cut: false });
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const byLines = cutResult(lines);
    expect(byLines.cut).toBe(true);
    expect(byLines.text.split("\n")).toHaveLength(30);
    const byChars = cutResult("x".repeat(RESULT_MAX_CHARS + 1));
    expect(byChars).toEqual({ text: "x".repeat(RESULT_MAX_CHARS), cut: true });
  });
  const s = (id: string, updatedAt: string, status = "idle") => ({ id, updatedAt, status });
  test("sessions are ordered by newest activity, and the newest is picked unless the URL names one", () => {
    const list = [s("a", "2026-11-12T10:00:00.000Z"), s("b", "2026-11-12T12:00:00.000Z"), s("c", "2026-11-12T11:00:00.000Z")];
    expect(byActivity(list).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(pickSession(list, null)).toBe("b");
    expect(pickSession(list, "a")).toBe("a");
    expect(pickSession(list, "gone")).toBe("b");
    expect(pickSession([], "gone")).toBeNull();
  });
  test("the reply box is off while a turn runs or waits for approval", () => {
    expect(replyState(undefined).enabled).toBe(false);
    expect(replyState(s("a", "", "running"))).toMatchObject({ enabled: false });
    expect(replyState(s("a", "", "running")).hint).not.toBe("");
    expect(replyState(s("a", "", "waiting_approval"))).toMatchObject({ enabled: false, hint: "Waiting for your answer above." });
    expect(replyState(s("a", "", "idle")).enabled).toBe(true);
    expect(replyState(s("a", "", "error")).enabled).toBe(true);
  });
  test("a turn arriving from the terminal: 'in terminal', and the reply box stays on (the runner asks for force)", () => {
    const live = { ...s("a", "", "running"), terminalTurn: true };
    expect(sessionStatus(live)).toBe("in terminal");
    expect(sessionStatus(s("a", "", "running"))).toBe("working");
    expect(sessionStatus({ ...s("a", "", "idle"), terminalTurn: true })).toBe("idle");
    expect(replyState(live).enabled).toBe(true);
    expect(replyState(live).hint).not.toBe(replyState(s("a", "", "running")).hint);
  });
  test("the terminal mark is for sessions whose source is terminal", () => {
    expect(startedInTerminal({ source: "terminal" })).toBe(true);
    expect(startedInTerminal({ source: "cleat" })).toBe(false);
    expect(startedInTerminal({})).toBe(false);
  });
  test("the runner's OPEN_IN_TERMINAL 409 is told apart from other refusals", () => {
    expect(isOpenInTerminal(409, OPEN_IN_TERMINAL)).toBe(true);
    expect(isOpenInTerminal(409, "a turn is running: wait for it to finish")).toBe(false);
    expect(isOpenInTerminal(400, OPEN_IN_TERMINAL)).toBe(false);
    expect(isOpenInTerminal(409, undefined)).toBe(false);
  });
  test("resumeCommand: cd to the folder, then claude --resume, quoted for the shell", () => {
    expect(resumeCommand({ claudeSessionId: null, cwd: "/home/a/w" })).toBeNull();
    expect(resumeCommand(undefined)).toBeNull();
    expect(resumeCommand({ claudeSessionId: "abc-123", cwd: "/home/a/w" })).toBe("cd /home/a/w && claude --resume abc-123");
    expect(resumeCommand({ claudeSessionId: "abc", cwd: "/home/a/my work" })).toBe("cd '/home/a/my work' && claude --resume abc");
    expect(resumeCommand({ claudeSessionId: "abc", cwd: "/home/a/w", agent: "claude" })).toBe("cd /home/a/w && claude --resume abc");
  });
  test("resumeCommand: a Codex session resumes with codex resume <thread id>", () => {
    expect(resumeCommand({ claudeSessionId: "thread-9", cwd: "/home/a/my work", agent: "codex" })).toBe("cd '/home/a/my work' && codex resume thread-9");
    expect(resumeCommand({ claudeSessionId: null, cwd: "/home/a/w", agent: "codex" })).toBeNull();
    expect(shellWord("it's $here")).toBe(`'it'\\''s $here'`);
  });
  test("resultLine", () => {
    expect(resultLine({ ok: true })).toBe("Done");
    expect(resultLine({ ok: true, durationMs: 4210, costUsd: 0.0312 })).toBe("Done · 4.2 s · $0.031");
    expect(resultLine({ ok: true, durationMs: 75_000, costUsd: 0 })).toBe("Done · 1 min 15 s");
    expect(resultLine({ ok: false, durationMs: 12_400, costUsd: 1.234 })).toBe("Ended with an error · 12 s · $1.23");
  });
  test("an unknown event kind is one quiet line", () => {
    expect(unknownNote({ kind: "approval_request", toolName: "Write", input: { file_path: "/x" } })).toBe("approval request: Write");
    expect(unknownNote({ kind: "approval_resolved", decision: "deny" })).toBe("approval resolved: deny");
    expect(unknownNote({ kind: "something_new\nwith a break" })).toBe("something new with a break");
    expect(unknownNote({})).toBe("event");
  });
  test("reconnecting backs off from half a second to five", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("the sources", () => {
  test("chat-format.js has no DOM access", () => {
    const code = source("chat-format.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    expect(code).not.toMatch(/\b(document|window|navigator|location|fetch|WebSocket)\b/);
  });
  test("no script of the page builds markup from text", () => {
    for (const file of ["chat.js", "chat-format.js", "chat-resume.js"]) {
      expect(source(file)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|setHTML/);
    }
    expect(source("chat.html")).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
