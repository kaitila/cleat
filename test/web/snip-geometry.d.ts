// Types for src/web/snip-geometry.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/snip-geometry.js" {
  interface Point { x: number; y: number }
  interface Size { width: number; height: number }
  interface Rect { x: number; y: number; width: number; height: number }
  interface Workspace { name: string; exists: boolean }
  export const CLICK_SLOP: number;
  export const GAP: number;
  export const UNREACHABLE: string;
  export function isClick(start: Point, end: Point): boolean;
  export function wholeDisplay(viewport: Size): Rect;
  export function selectionOf(start: Point, end: Point, viewport: Size): Rect;
  export function devicePixels(rect: Rect, ratio: number, viewport: Size): Rect;
  export function sizeText(size: Size): string;
  export function anchorBox(sel: Rect, box: Size, viewport: Size): { placement: "below" | "above" | "inside"; x: number; y: number };
  export function anchorLabel(sel: Rect, label: Size, viewport: Size, boxPlacement?: string): { x: number; y: number; inside: boolean };
  export function initialWorkspace(workspaces: Workspace[], lastUsed: string | null): string | null;
  export function stepWorkspace(workspaces: Workspace[], current: string | null, step: number): string | null;
  export function workspaceDigit(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; isComposing?: boolean; code?: string; key?: string }, mac?: boolean): number | null;
  export function errorText(status: number, body: unknown): string;
  export function sessionBody(workspace: string, prompt: string, imagePath: string, agent?: string | null): { workspace: string; prompt: string; imagePath: string; agent?: string };
}
