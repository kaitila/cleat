// The Setup section's facts (docs/protocol.md, "Platform"): this machine's layout, and the shell's side
// as the shell last reported it. The runner checks nothing of the shell's itself: it keeps the report
// while the shell holds its socket (/ws?client=shell), and forgets it when the last such socket closes.
import { z } from "zod";
import type { Layout, PlatformResponse, ShellReport } from "../shared/protocol";
import { detectLayout } from "../shell/platform";

const ReportSchema = z.strictObject({
  os: z.enum(["windows", "macos", "linux"]),
  startOnLogin: z.boolean().nullable(),
  hotkeys: z.strictObject({ hotkey: z.boolean(), snipHotkey: z.boolean(), chatHotkey: z.boolean().optional() }),
  dockTransparent: z.boolean(),
  screenRecording: z.enum(["not-determined", "granted", "denied", "restricted", "unknown"]).optional(),
});

/** The report of PUT /api/platform/shell, or why it is refused. */
export function parseReport(value: unknown): ShellReport | { error: string } {
  const parsed = ReportSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { error: `${where}${issue?.message ?? "not a shell report"}` };
  }
  const report: ShellReport = { ...parsed.data };
  // Screen Recording is macOS's alone.
  if (report.os !== "macos") delete report.screenRecording;
  return report;
}

/** The layout, or null on a platform holm has no layout for (or a bad HOLM_PLATFORM): the runner still answers. */
export function layoutOrNull(env: Record<string, string | undefined> = process.env): Layout | null {
  try {
    return detectLayout(env);
  } catch {
    return null;
  }
}

/** The shell's side: how many shell sockets are open, and the last report while any is. */
export class ShellState {
  private sockets = 0;
  private report: (ShellReport & { reportedAt: string }) | null = null;

  constructor(
    private readonly layout: Layout | null,
    private readonly version: string,
  ) {}

  get connected(): boolean {
    return this.sockets > 0;
  }

  /** The OS of the shell's report, or null without one. */
  get os(): ShellReport["os"] | null {
    return this.report?.os ?? null;
  }

  connect(): void {
    this.sockets += 1;
  }

  /** True when that was the last shell socket: the report is gone with it. */
  disconnect(): boolean {
    this.sockets = Math.max(0, this.sockets - 1);
    if (this.sockets > 0) return false;
    this.report = null;
    return true;
  }

  setReport(report: ShellReport, now = new Date()): void {
    this.report = { ...report, reportedAt: now.toISOString() };
  }

  response(): PlatformResponse {
    return { layout: this.layout, runner: { running: true, version: this.version }, shell: { connected: this.connected, report: this.report } };
  }
}
