// The shell's report of its side to the runner (PUT /api/platform/shell, docs/protocol.md "Platform"),
// for the settings page's Setup section, and the one thing the runner can ask of it on its socket
// (a shell_action). No Electron imports here: main.ts reads Electron and hands the values in.
import type { ScreenAccess, ShellAction, ShellReport } from "../../src/shared/protocol";
import type { ShellOs } from "./os";

export type { ShellReport };

export const REPORT_PATH = "/api/platform/shell";

/** The shell's socket: /ws?client=shell, so the runner knows the shell runs while it is open and sends it shell_action. */
export function shellSocketUrl(runnerUrl: string): string {
  const url = new URL("/ws", runnerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", "shell");
  return url.href;
}

/** What main.ts knows now. `screen` is macOS's Screen Recording status; ignored on the others. */
export interface ReportInput {
  os: ShellOs;
  startOnLogin: boolean | null;
  hotkey: { wanted: string; active: string | null };
  snipHotkey: { wanted: string; active: string | null };
  dockTransparent: boolean;
  screen: ScreenAccess;
}

/** The report: a hotkey counts as registered when the one held is the one the settings want. */
export function shellReport(input: ReportInput): ShellReport {
  const report: ShellReport = {
    os: input.os,
    startOnLogin: input.startOnLogin,
    hotkeys: { hotkey: input.hotkey.active !== null && input.hotkey.active === input.hotkey.wanted, snipHotkey: input.snipHotkey.active !== null && input.snipHotkey.active === input.snipHotkey.wanted },
    dockTransparent: input.dockTransparent,
  };
  if (input.os === "macos") report.screenRecording = input.screen;
  return report;
}

const ACTIONS: readonly ShellAction[] = ["open_screen_recording"];

/** The action of a socket message `{ type: "shell_action", action }`, or null for anything else. The shell takes only the actions it knows: never a URL. */
export function shellAction(data: unknown): ShellAction | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, action } = message as Record<string, unknown>;
  return type === "shell_action" && (ACTIONS as readonly unknown[]).includes(action) ? (action as ShellAction) : null;
}
