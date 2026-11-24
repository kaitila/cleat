// `holm uninstall`: undoes `setup`. Start at login off, the shell stopped and removed, the runner
// stopped, the command unlinked. The config and the sessions stay unless --purge.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { configPath, loadConfig } from "../runner/config";
import type { Platform } from "../shell/platform";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

export interface UninstallOptions {
  /** Remove the config and the data folder (sessions, the runner's log) too. */
  purge: boolean;
  /** Where the link is (else the folder bun is in). */
  linkDir?: string;
}

/** What uninstall does to the machine. */
export interface UninstallActions {
  shellInstalled(): boolean;
  /** Turns start at login off. */
  loginOff(): Promise<void>;
  /** Asks the shell to quit and waits for it. */
  stopShell(): Promise<void>;
  /** Removes the shell's folders; returns them. */
  removeShell(): string[];
  /** Stops the runner; returns stop's exit code. */
  stopRunner(): Promise<number>;
  /** Removes the link; returns unlink's exit code. */
  unlink(dir?: string): number;
}

/** The words after `uninstall`: --purge, --link-dir <folder>. Null when they are not those. */
export function parseUninstallArgs(words: string[]): UninstallOptions | null {
  const options: UninstallOptions = { purge: false };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--purge") options.purge = true;
    else if (w === "--link-dir" && words[i + 1] !== undefined && !words[i + 1]!.startsWith("--")) options.linkDir = words[++i];
    else return null;
  }
  return options;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs uninstall. Returns 1 when a step failed (the others are still done), else 0. */
export async function uninstall(options: UninstallOptions, platform: Platform, actions: UninstallActions, env: Env = process.env, log: Log = console.log): Promise<number> {
  let failed = false;
  const step = async (what: string, run: () => Promise<void> | void) => {
    try {
      await run();
    } catch (e) {
      failed = true;
      log(`${what} failed: ${message(e)}`);
    }
  };
  const unavailable = platform.unavailable(env);
  // Linux's autostart file is the command line's own; Windows and macOS ask the installed shell.
  const reachable = platform.layout === "linux" || (!unavailable && actions.shellInstalled());
  if (reachable) {
    await step("turning start at login off", async () => {
      await actions.loginOff();
      log("start at login is off");
    });
  }
  if (!unavailable && actions.shellInstalled()) {
    await step("stopping the tray app", async () => {
      await actions.stopShell();
      log("the tray app has quit");
    });
  }
  if (platform.layout === "windows-wsl" && unavailable) {
    log(`${unavailable}: the Windows tray app was left as it is`);
  } else {
    await step("removing the tray app", () => {
      const removed = actions.removeShell();
      log(removed.length === 0 ? "no tray app was installed" : `removed ${removed.join(", ")}`);
    });
  }
  await step("stopping the runner", async () => {
    if ((await actions.stopRunner()) !== 0) failed = true;
  });
  await step("removing the link", () => {
    if (actions.unlink(options.linkDir) !== 0) failed = true;
  });
  if (options.purge) {
    await step("removing the config and the data", () => {
      const path = configPath(env);
      let dataDir: string | null = null;
      try {
        dataDir = loadConfig(env).dataDir;
      } catch (e) {
        log(`the config cannot be read (${message(e)}): the data folder is left`);
      }
      for (const p of [path, dataDir]) {
        // A data folder set to the home folder or the root is never removed.
        if (p && (p === homedir() || p === "/")) log(`${p} is the data folder: left as it is`);
        else if (p && existsSync(p)) {
          rmSync(p, { recursive: true, force: true });
          log(`removed ${p}`);
        }
      }
      const folder = dirname(path);
      if (existsSync(folder) && readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
    });
  } else {
    log(`kept the config (${configPath(env)}) and the sessions: \`holm uninstall --purge\` removes them too`);
  }
  log(failed ? "uninstall finished, with the failures above" : "uninstalled. Delete the cloned folder to remove the rest");
  return failed ? 1 : 0;
}
