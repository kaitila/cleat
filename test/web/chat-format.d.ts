// Types for src/web/chat-format.js, so the tests typecheck. Pages are plain JavaScript modules
// (no build step, and tsconfig doesn't check them), so the types live here, next to their only
// TypeScript reader.
declare module "*/web/chat-format.js" {
  export interface Span { text: string; code: boolean }
  export type Block = { type: "text"; spans: Span[] } | { type: "code"; lang: string; text: string };
  interface SessionLike { id: string; status: string; updatedAt: string }
  export const SUMMARY_MAX: number;
  export const RESULT_MAX_CHARS: number;
  export const RESULT_MAX_LINES: number;
  export function inputText(input: unknown, indent?: number): string;
  export function toolSummary(name: string, input: unknown): string;
  export const APPROVAL_MAX_CHARS: number;
  export const APPROVAL_MAX_LINES: number;
  export function approvalView(toolName: string, input: unknown): { path: string; text: string; full: string };
  export function decidedLabel(decision: unknown): string;
  export function relativeTime(iso: string, now?: number): string;
  export function splitInline(text: string): Span[];
  export function splitMarkdown(text: string): Block[];
  export function cutResult(text: string, maxChars?: number, maxLines?: number): { text: string; cut: boolean };
  export function byActivity<T extends SessionLike>(sessions: Iterable<T>): T[];
  export function pickSession(sessions: SessionLike[], wanted: string | null): string | null;
  export function statusLabel(status: string): string;
  export function replyState(session: SessionLike | undefined): { enabled: boolean; hint: string };
  export function resultLine(event: { ok: boolean; durationMs?: number; costUsd?: number }): string;
  export function unknownNote(event: unknown): string;
  export function backoffMs(attempt: number): number;
}
