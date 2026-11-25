// Types for src/web/chat-format.js, so the tests typecheck. Pages are plain JavaScript modules
// (no build step, and tsconfig doesn't check them), so the types live here, next to their only
// TypeScript reader.
declare module "*/web/chat-format.js" {
  interface SessionLike { id: string; status: string; updatedAt: string }
  export const SUMMARY_MAX: number;
  export const RESULT_MAX_CHARS: number;
  export const RESULT_MAX_LINES: number;
  export function inputText(input: unknown, indent?: number): string;
  export function toolSummary(name: string, input: unknown): string;
  export function toolLabel(name: unknown): { source: string; action: string };
  export function toolLabelText(name: unknown): string;
  export const STEP_SOURCES: number;
  export function stepsSummary(names: string[]): { count: string; sources: string };
  export const APPROVAL_MAX_CHARS: number;
  export const APPROVAL_MAX_LINES: number;
  export function approvalView(toolName: string, input: unknown): { path: string; text: string; full: string };
  export function decidedLabel(decision: unknown): string;
  export function relativeTime(iso: string, now?: number): string;
  export function cutResult(text: string, maxChars?: number, maxLines?: number): { text: string; cut: boolean };
  export function byActivity<T extends SessionLike>(sessions: Iterable<T>): T[];
  export function pickSession(sessions: SessionLike[], wanted: string | null): string | null;
  export function statusLabel(status: string): string;
  export function replyState(session: (SessionLike & { terminalTurn?: boolean }) | undefined): { enabled: boolean; hint: string };
  export function sessionStatus(session: { status: string; terminalTurn?: boolean } | undefined): string;
  export const TERMINAL_MARK_TITLE: string;
  export function startedInTerminal(session: { source?: string } | undefined): boolean;
  export function isOpenInTerminal(status: number, error: unknown): boolean;
  export const OPEN_IN_TERMINAL_HINT: string;
  export function shellWord(word: string): string;
  export function resumeCommand(session: { claudeSessionId: string | null; cwd: string; agent?: "claude" | "codex" } | undefined): string | null;
  export function resultLine(event: { ok: boolean; durationMs?: number; costUsd?: number }): string;
  export function unknownNote(event: unknown): string;
  export function backoffMs(attempt: number): number;
}
