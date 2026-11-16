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
  toolSummary,
  unknownNote,
} from "../../src/web/chat-format.js";
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
    expect(imports).toEqual(["chat-format.js", "chat-manage.js", "chat-resume.js", "agent.js", "markdown.js"]);
    expect([...source("chat-manage.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!)).toEqual(["chat-format.js"]);
    expect([...source("chat-resume.js").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!)).toEqual(["chat-format.js"]);
    for (const file of imports) expect((await runner.get(`/assets/${file}`)).status).toBe(200);
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
  test("anything else: the first 80 characters of the input", () => {
    expect(toolSummary("WebSearch", { query: "bun" })).toBe('{"query":"bun"}');
    const long = toolSummary("Task", { prompt: "p".repeat(300) });
    expect(long).toHaveLength(80);
    expect(long.startsWith('{"prompt":"ppp')).toBe(true);
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
    expect(replyState(s("a", "", "waiting_approval"))).toMatchObject({ enabled: false, hint: "Waiting for your Allow or Deny above." });
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
    expect(startedInTerminal({ source: "intuition" })).toBe(false);
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
