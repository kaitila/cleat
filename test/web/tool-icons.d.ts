// Types for src/web/tool-icons.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/tool-icons.js" {
  export function iconKey(name: unknown): string;
  export const ICON_KEYS: string[];
  export function toolIcon(doc: Document, name: unknown): SVGElement;
}
