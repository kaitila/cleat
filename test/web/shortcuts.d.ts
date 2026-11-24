// Types for src/web/shortcuts.js, so the tests typecheck (see chat-format.d.ts).
declare module "*/web/shortcuts.js" {
  type Hotkeys = { hotkey: string; snipHotkey: string; chatHotkey: string };
  type Shell = { hotkey?: string; snipHotkey?: string; chatHotkey?: string } | null;
  type Row = { id: string; keys: string[][]; what: string };
  type KeyEvent = { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; repeat?: boolean; code?: string; key?: string };
  export function defaultHotkeys(mac?: boolean): Hotkeys;
  export const GLOBAL: { key: keyof Hotkeys; name: string; what: string; short: string }[];
  export const PAGE_KEYS: { id: string; title: string; rows: Row[] }[];
  export const HINTS: Record<string, [string, string][]>;
  export function comboCaps(combo: string[], mac?: boolean): string[];
  export function capsText(caps: string[], mac?: boolean): string;
  export function pageRow(id: string): Row | undefined;
  export function hotkeysOf(shell: Shell, mac?: boolean): Hotkeys;
  export function keyText(id: string, options?: { mac?: boolean; shell?: Shell }): string;
  export function tip(what: string, id?: string, options?: { mac?: boolean; shell?: Shell }): string;
  export function guide(options?: { mac?: boolean; shell?: Shell; global?: boolean }): { id: string; title: string; rows: { id: string; what: string; keys: string[][] }[] }[];
  export function hintLine(page: string, mac?: boolean): { caps: string[]; word: string }[];
  export function isGuideKey(event: KeyEvent | null): boolean;
  export function typingIn(element: unknown): boolean;
}
