// Types for src/web/dock-plugins.js and settings-plugins.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/dock-plugins.js" {
  export const SESSIONS: string;
  export const LIVE_SEARCH_MS: number;
  export function iconFor(icon: string): string;
  export function tabsOf<T>(plugins: T[] | unknown): T[];
  export function statusLine(response: { view: unknown; at: string | null; loading: boolean; error: string | null } | null | undefined, now?: number): string;
  export function safeUrl(url: unknown): string | null;
}

declare module "*/web/settings-plugins.js" {
  export function toolWords(tool: string): string;
  export function pluginLine(p: { error: string | null; builtIn: boolean; tools: string[] }): string;
}
