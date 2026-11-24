// Types for src/web/settings-model.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/settings-model.js" {
  export interface KeyLike { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }
  export type Recorded = { accelerator: string } | { cancel: true } | { pending: true } | { invalid: string };
  export interface RowLike { name: string; path: string; permissionMode?: string; agent?: string; fresh?: boolean }
  export interface StateLike { theme: string; permissionMode: string; agent?: string; workspaces: RowLike[]; shell: unknown; port: number }
  export function keyOf(code: string): string | null;
  export function recordKey(event: KeyLike, mac?: boolean): Recorded;
  export function keycaps(accelerator: string, mac?: boolean): string[];
  export function isDraft(w: RowLike): boolean;
  export function putBody(state: StateLike): { body: { theme: string; permissionMode: string; agent?: string; workspaces: { name: string; path: string; permissionMode?: string; agent: string | null }[]; shell: unknown; port: number }; rows: number[] };
  export function fieldKeys(field: unknown, rows?: number[]): string[];
  export function move<T>(list: T[], from: number, to: number): T[];
  export interface SetupLine { key: string; name: string; tone: "ok" | "off" | "bad" | "unknown"; value: string; detail: string; action?: "open_screen_recording" }
  export function agentLines(response: import("../../src/shared/protocol").AgentsResponse | null, reachable: boolean, used?: string[]): SetupLine[];
  export function usedAgents(state: { agent?: string; workspaces?: { agent?: string }[] } | null): string[];
  export function setupLines(platform: import("../../src/shared/protocol").PlatformResponse | null, reachable: boolean, shell?: { hotkey: string; snipHotkey: string } | null): SetupLine[];
}
