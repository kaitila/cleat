// `cleat update` and `cleat login` (D0045).
// update: a git checkout pulls and runs `bun install`; an install made by `bun install -g` (the README's line)
// installs the package again from GitHub. Then `up`, in a new process, so the new code restarts what is older.
// login: the agent's own login, run on this terminal: the Agent SDK's Claude Code (`auth login`), or Codex (`login`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBinary } from "../runner/agent-claude";
import { codexBinary } from "../runner/agent-codex";

/** Where `bun install -g` gets the app: the repository's default branch on GitHub. */
export const PACKAGE = "github:kaitila/cleat";

/** The folder the app runs from: a git checkout, or the package bun installed globally. */
export const APP = join(import.meta.dir, "..", "..");

/** The app's package name (package.json's), as `bun remove --global` takes it. */
export function packageName(app = APP): string {
  try {
    return (JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { name?: string }).name ?? "cleat";
  } catch {
    return "cleat";
  }
}

/**
 * How this copy was installed: a git checkout (it has .git), a package from `bun install -g` (it sits in bun's
 * global node_modules), or neither (a downloaded archive), which `update` does not touch.
 */
export function installKind(app = APP): "git" | "package" | "other" {
  if (existsSync(join(app, ".git"))) return "git";
  return /[\\/]install[\\/]global[\\/]node_modules[\\/]/.test(app) ? "package" : "other";
}

/** A command and the folder it runs in. */
export interface Step {
  cmd: string[];
  cwd: string;
}

/** The commands an update runs, in order, ending with `up` from the new code. */
export function updateSteps(kind: "git" | "package", app = APP, bun = process.execPath): Step[] {
  const fetch: Step[] =
    kind === "git"
      ? [
          { cmd: ["git", "-C", app, "pull", "--ff-only"], cwd: app },
          { cmd: [bun, "install"], cwd: app },
        ]
      : [{ cmd: [bun, "add", "--global", PACKAGE], cwd: app }];
  return [...fetch, { cmd: [bun, join(app, "src", "cli.ts"), "up"], cwd: app }];
}

type Run = (step: Step) => Promise<number>;

/** Runs a step on this terminal and returns its exit code. */
export const runInherit: Run = async ({ cmd, cwd }) => {
  const p = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exited;
};

/** Runs the update's steps until one fails. Returns the exit code of the last one run. */
export async function update(log: (line: string) => void = console.log, run: Run = runInherit, kind = installKind(), app = APP, bun = process.execPath): Promise<number> {
  if (kind === "other") {
    log(`${app} is neither a git checkout nor bun's global package: install it with \`bun install -g ${PACKAGE}\`, or update this copy by hand`);
    return 1;
  }
  log(kind === "git" ? `updating the git checkout in ${app}` : `installing ${PACKAGE} again with bun`);
  for (const step of updateSteps(kind, app, bun)) {
    const code = await run(step);
    if (code !== 0) {
      log(`\`${step.cmd.join(" ")}\` failed (exit ${code})`);
      return code;
    }
  }
  return 0;
}

export type Agent = "claude" | "codex";

/** The words after `login`: nothing or claude, or codex. Null when they are something else. */
export function parseLoginAgent(words: string[]): Agent | null {
  if (words.length === 0) return "claude";
  if (words.length === 1 && (words[0] === "claude" || words[0] === "codex")) return words[0];
  return null;
}

/** The agent's own login command: the binaries the runner runs, else the one on the PATH. */
export function loginCommand(agent: Agent, claude = claudeBinary(), codex = codexBinary()): string[] {
  return agent === "claude" ? [claude ?? "claude", "auth", "login"] : [codex ?? "codex", "login"];
}

/** Runs the agent's login on this terminal. Returns its exit code. */
export async function agentLogin(agent: Agent, run: Run = runInherit): Promise<number> {
  return run({ cmd: loginCommand(agent), cwd: process.cwd() });
}
