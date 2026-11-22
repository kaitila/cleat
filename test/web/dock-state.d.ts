// Types for src/web/dock-state.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/dock-state.js" {
  export type DockState = "idle" | "peek" | "open";
  interface SessionLike { id: string; status: string; updatedAt: string }
  export interface Peek { kind: "finished" | "needs_approval" | "error"; sessionId: string; title: string; body: string }
  export interface Pill { tone: "none" | "running" | "needs" | "failed"; text: string; status: string | null; failed: boolean }
  export interface Size { width: number; height: number }
  export const DOCK_WINDOW: Size;
  export const DOCK_SIZES: Record<DockState, Size>;
  export const QUIET_HEIGHT: number;
  export const NOTCH_WING: number;
  export function parseNotch(search: string): Size | null;
  export function dockSizes(notch: Size | null): Record<DockState, Size>;
  export const PEEK_MS: number;
  export const OPEN_MS: number;
  export const CLOSE_MS: number;
  export const PEEK_MAX: number;
  export const RECENT_EVENTS: number;
  export function islandRect(state: DockState, notch?: Size | null): { x: number; y: number; width: number; height: number };
  export function islandSize(state: DockState, measured?: { pill?: number; panel?: number; quiet?: boolean }, notch?: Size | null): Size;
  export function onIsland(state: DockState, drawn: Size, x: number, y: number, notch?: Size | null): boolean;
  export function pillOf(sessions: Iterable<SessionLike>): Pill;
  export function asPeek(notification: unknown): Peek | null;
  export function enqueue(queue: Peek[], peek: Peek, max?: number): Peek[];
  export function nextPeek(queue: Peek[], sessions: Iterable<SessionLike>): { peek: Peek | null; queue: Peek[] };
  export function peekOver(peek: Peek, sessions: Iterable<SessionLike>, shownMs: number): boolean;
  export function peekLabel(kind: string): string;
  export function peekStatus(kind: string): string;
  export function mayClose(holds: { pointerInside: boolean; pointerDown: boolean; replyFocused: boolean; replyText?: string }): boolean;
  export function preselect(sessions: SessionLike[], peeking: string | null, lastPeeked: string | null, remembered?: string | null): string | null;
  export const SESSION_KEY: string;
  export function savedSession(storage: StorageLike | null | undefined): string | null;
  export function saveSession(storage: StorageLike | null | undefined, id: string | null): void;
  export function dockKey(event: { key?: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean } | null | undefined): { step: -1 | 1 } | { workspace: number } | null;
  export function stepSession(ids: string[], current: string | null, step: number): string | null;
  export function recentEvents<T>(events: T[], max?: number): T[];
  interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
  export const WORKSPACE_KEY: string;
  export function savedWorkspace(storage: StorageLike | null | undefined): string;
  export function saveWorkspace(storage: StorageLike | null | undefined, workspace: string): void;
  export function dockWorkspaces(sessions: Iterable<{ workspace?: string; archived?: boolean }>, chosen?: string): string[];
  export function inWorkspace<T extends { workspace?: string }>(sessions: Iterable<T>, workspace: string): T[];
}
