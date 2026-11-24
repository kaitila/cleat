// Types for src/web/keys.js, so the tests typecheck (see chat-format.d.ts).
declare module "*/web/keys.js" {
  type KeyEvent = { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; code?: string; key?: string };
  export const MAC: boolean;
  export function commandOnly(event: KeyEvent | null, mac?: boolean): boolean;
  export function commandDigit(event: KeyEvent | null, mac?: boolean): number | null;
  export function commandK(event: KeyEvent | null, mac?: boolean): boolean;
  export function commandLabel(mac?: boolean): string;
  export function commandAria(mac?: boolean): string;
}
