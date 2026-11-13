// Types for src/web/dock-state.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/dock-state.js" {
  export type DockState = "idle" | "peek" | "open";
  interface SessionLike { id: string; status: string; updatedAt: string }
  export interface Peek { kind: "finished" | "needs_approval" | "error"; sessionId: string; title: string; body: string }
  export interface Pill { tone: "none" | "running" | "needs" | "failed"; text: string; status: string | null; failed: boolean }
  export const DOCK_SIZES: Record<DockState, { width: number; height: number }>;
  export const PEEK_MS: number;
  export const OPEN_MS: number;
  export const CLOSE_MS: number;
  export const PEEK_MAX: number;
  export const RECENT_EVENTS: number;
  export function resizeOrder(windowState: DockState, target: DockState): "before" | "after" | "same";
  export function pillOf(sessions: Iterable<SessionLike>): Pill;
  export function asPeek(notification: unknown): Peek | null;
  export function enqueue(queue: Peek[], peek: Peek, max?: number): Peek[];
  export function nextPeek(queue: Peek[], sessions: Iterable<SessionLike>): { peek: Peek | null; queue: Peek[] };
  export function peekOver(peek: Peek, sessions: Iterable<SessionLike>, shownMs: number): boolean;
  export function peekLabel(kind: string): string;
  export function peekStatus(kind: string): string;
  export function mayClose(holds: { pointerInside: boolean; pointerDown: boolean; replyFocused: boolean; replyText?: string }): boolean;
  export function preselect(sessions: SessionLike[], peeking: string | null, lastPeeked: string | null): string | null;
  export function recentEvents<T>(events: T[], max?: number): T[];
}
