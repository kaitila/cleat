// `cleat resume`: which session it picks, and what it runs where. Claude Code is never run:
// the command is handed to a stand-in, and the real spawner runs only bun.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, resume, runInTerminal } from "../../src/cli/resume";
import type { SessionMeta } from "../../src/shared/protocol";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cleat-resume-")));
  dirs.push(dir);
  return dir;
}

function meta(id: string, claudeSessionId: string | null, updatedAt: string, cwd = `/work/${id}`): SessionMeta {
  return { id, claudeSessionId, workspace: "w", cwd, title: `title ${id}`, source: "cleat", status: "idle", createdAt: updatedAt, updatedAt, lastSeq: 1 };
}

const sessions = [
  meta("aaaa1111-0000", "claude-old", "2026-11-13T10:00:00.000Z"),
  meta("aaaa2222-0000", "claude-mid", "2026-11-13T11:00:00.000Z"),
  meta("bbbb3333-0000", "claude-new", "2026-11-13T12:00:00.000Z"),
  meta("cccc4444-0000", null, "2026-11-13T13:00:00.000Z"),
];

describe("which session", () => {
  test("no id: the newest session that has a Claude Code session id", () => {
    expect(plan(sessions)).toMatchObject({ cmd: ["claude", "--resume", "claude-new"], cwd: "/work/bbbb3333-0000" });
  });
  test("a full id, a unique prefix, or Claude Code's id", () => {
    expect(plan(sessions, "aaaa1111-0000")).toMatchObject({ cmd: ["claude", "--resume", "claude-old"], cwd: "/work/aaaa1111-0000" });
    expect(plan(sessions, "aaaa2")).toMatchObject({ cmd: ["claude", "--resume", "claude-mid"], cwd: "/work/aaaa2222-0000" });
    expect(plan(sessions, "claude-mid")).toMatchObject({ cwd: "/work/aaaa2222-0000" });
  });
  test("an ambiguous prefix names its matches", () => {
    const result = plan(sessions, "aaaa");
    expect("error" in result && result.error).toContain("matches 2 sessions");
    expect("error" in result && result.error).toContain("title aaaa1111-0000");
    expect("error" in result && result.error).toContain("title aaaa2222-0000");
  });
  test("an unknown id lists the newest sessions", () => {
    const result = plan(sessions, "zzz");
    expect("error" in result && result.error).toContain('no session matches "zzz"');
    expect("error" in result && result.error).toContain("title bbbb3333-0000");
  });
  test("a session without a Claude Code session has nothing to resume", () => {
    expect(plan(sessions, "cccc")).toMatchObject({ error: expect.stringContaining("no Claude Code session yet") });
    expect(plan([sessions[3]!])).toMatchObject({ error: expect.stringContaining("no session to resume") });
  });
});

describe("a Codex session", () => {
  const codex = (id: string, thread: string | null, updatedAt: string): SessionMeta => ({ ...meta(id, thread, updatedAt), agent: "codex" });
  const mixed = [...sessions, codex("dddd5555-0000", "thread-new", "2026-11-13T14:00:00.000Z"), codex("eeee6666-0000", null, "2026-11-13T15:00:00.000Z")];
  test("resumes with codex resume <thread id> in its folder; the rest stay claude --resume", () => {
    expect(plan(mixed)).toMatchObject({ cmd: ["codex", "resume", "thread-new"], cwd: "/work/dddd5555-0000" });
    expect(plan(mixed, "thread-n")).toMatchObject({ cmd: ["codex", "resume", "thread-new"], cwd: "/work/dddd5555-0000" });
    expect(plan(mixed, "bbbb")).toMatchObject({ cmd: ["claude", "--resume", "claude-new"] });
    expect(plan([{ ...meta("ffff", "claude-x", "2026-11-13T10:00:00.000Z"), agent: "claude" }])).toMatchObject({ cmd: ["claude", "--resume", "claude-x"] });
  });
  test("without a thread it says so, not that it lacks a Claude Code session", () => {
    const result = plan(mixed, "eeee");
    expect("error" in result && result.error).toContain("no Codex thread yet");
    expect("error" in result && result.error).not.toContain("Claude Code");
    const listed = plan(mixed, "zzz");
    expect("error" in listed && listed.error).toContain("title eeee6666-0000 (w, no Codex thread yet)");
    expect("error" in listed && listed.error).toContain("title cccc4444-0000 (w, no Claude Code session yet)");
  });
  test("cleat resume runs codex resume in the session's folder", async () => {
    const ran: { cmd: string[]; cwd: string }[] = [];
    const code = await resume("dddd", {}, () => {}, {
      sessions: async () => mixed,
      exists: () => true,
      run: async (cmd, cwd) => {
        ran.push({ cmd, cwd });
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(ran).toEqual([{ cmd: ["codex", "resume", "thread-new"], cwd: "/work/dddd5555-0000" }]);
  });
  test("a codex that won't start is named as Codex", async () => {
    const lines: string[] = [];
    const run = async () => {
      throw new Error("ENOENT");
    };
    expect(await resume("dddd", {}, (l) => lines.push(l), { sessions: async () => mixed, exists: () => true, run })).toBe(1);
    expect(lines.at(-1)).toBe("could not run codex: ENOENT. Is Codex installed and on the PATH?");
  });
});

describe("what it runs", () => {
  test("claude --resume <claudeSessionId> in the session's folder, and its exit code", async () => {
    const ran: { cmd: string[]; cwd: string }[] = [];
    const lines: string[] = [];
    const code = await resume("bbbb", {}, (l) => lines.push(l), {
      sessions: async () => sessions,
      exists: () => true,
      run: async (cmd, cwd) => {
        ran.push({ cmd, cwd });
        return 5;
      },
    });
    expect(code).toBe(5);
    expect(ran).toEqual([{ cmd: ["claude", "--resume", "claude-new"], cwd: "/work/bbbb3333-0000" }]);
  });
  test("nothing runs for an unknown id or a folder that is gone", async () => {
    const run = async () => {
      throw new Error("must not run");
    };
    const lines: string[] = [];
    expect(await resume("zzz", {}, (l) => lines.push(l), { sessions: async () => sessions, run })).toBe(1);
    expect(await resume(undefined, {}, (l) => lines.push(l), { sessions: async () => sessions, run, exists: () => false })).toBe(1);
    expect(lines.at(-1)).toContain("is gone");
  });
  test("the spawner runs in the folder with the terminal inherited and gives back the exit code", async () => {
    const dir = tempDir();
    const script = "require('fs').writeFileSync('seen', JSON.stringify({ cwd: process.cwd() })); process.exit(7)";
    expect(await runInTerminal([process.execPath, "-e", script], dir)).toBe(7);
    expect(JSON.parse(readFileSync(join(dir, "seen"), "utf8"))).toEqual({ cwd: dir });
    // Inherited, not piped: the source says so, since a test has no terminal to hand over.
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "cli", "resume.ts"), "utf8");
    expect(source).toContain('stdin: "inherit", stdout: "inherit", stderr: "inherit"');
  });
  test("the help lists it", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "src", "cli.ts"), "help"], { stdout: "pipe", stdin: "ignore" });
    expect(await new Response(proc.stdout).text()).toContain("resume [id]");
  });
});
