// `cleat update` and `cleat login` (D0045): the steps they run, with the running faked.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKind, loginCommand, PACKAGE, packageName, parseLoginAgent, type Step, update, updateSteps } from "../../src/cli/update";

describe("update", () => {
  test("a folder with .git is a checkout; one in bun's global node_modules is the package; anything else is neither", () => {
    const dir = mkdtempSync(join(tmpdir(), "cleat-update-"));
    expect(installKind(dir)).toBe("other");
    const pkg = join(dir, "bun", "install", "global", "node_modules", "cleat");
    mkdirSync(pkg, { recursive: true });
    expect(installKind(pkg)).toBe("package");
    mkdirSync(join(dir, ".git"));
    expect(installKind(dir)).toBe("git");
  });

  test("a copy that is neither is not touched: it says what to do, exit 1", async () => {
    const ran: string[][] = [];
    const lines: string[] = [];
    expect(await update((l) => lines.push(l), async (s) => (ran.push(s.cmd), 0), "other", "/x", "/bun")).toBe(1);
    expect(ran).toEqual([]);
    expect(lines[0]).toContain("bun install -g github:kaitila/");
  });

  test("the package's name for bun remove is package.json's", () => {
    expect(packageName()).toBe(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).name);
  });

  test("a checkout pulls (fast-forward only) and runs bun install; a package is installed again from GitHub; both then run up from the new code", () => {
    expect(updateSteps("git", "/app", "/bun").map((s) => s.cmd)).toEqual([
      ["git", "-C", "/app", "pull", "--ff-only"],
      ["/bun", "install"],
      ["/bun", "/app/src/cli.ts", "up"],
    ]);
    expect(updateSteps("package", "/app", "/bun").map((s) => s.cmd)).toEqual([
      ["/bun", "add", "--global", PACKAGE],
      ["/bun", "/app/src/cli.ts", "up"],
    ]);
    expect(PACKAGE).toMatch(/^github:kaitila\//);
  });

  test("a failing step stops it, with its exit code", async () => {
    const ran: string[][] = [];
    const run = async (s: Step) => (ran.push(s.cmd), s.cmd.includes("pull") ? 1 : 0);
    const lines: string[] = [];
    expect(await update((l) => lines.push(l), run, "git", "/app", "/bun")).toBe(1);
    expect(ran).toEqual([["git", "-C", "/app", "pull", "--ff-only"]]);
    expect(lines.at(-1)).toContain("failed (exit 1)");
    ran.length = 0;
    expect(await update(() => {}, async (s) => (ran.push(s.cmd), 0), "package", "/app", "/bun")).toBe(0);
    expect(ran).toHaveLength(2);
  });
});

describe("login", () => {
  test("claude by default, or codex; anything else is refused", () => {
    expect(parseLoginAgent([])).toBe("claude");
    expect(parseLoginAgent(["claude"])).toBe("claude");
    expect(parseLoginAgent(["codex"])).toBe("codex");
    expect(parseLoginAgent(["gpt"])).toBeNull();
    expect(parseLoginAgent(["claude", "codex"])).toBeNull();
  });

  test("runs the binaries the runner runs, else the ones on the PATH", () => {
    expect(loginCommand("claude", "/sdk/claude", null)).toEqual(["/sdk/claude", "auth", "login"]);
    expect(loginCommand("claude", null, null)).toEqual(["claude", "auth", "login"]);
    expect(loginCommand("codex", null, "/sdk/codex")).toEqual(["/sdk/codex", "login"]);
    expect(loginCommand("codex", null, null)).toEqual(["codex", "login"]);
  });
});
