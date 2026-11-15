// Types for src/web/agent.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/agent.js" {
  export const AGENTS: string[];
  export const AGENT_NAMES: Record<"claude" | "codex", string>;
  export function agentOf(thing: { agent?: string } | null | undefined): "claude" | "codex";
  export function agentName(kind: unknown): string;
  export function flipAgent(kind: unknown): "claude" | "codex";
  export function agentTitle(kind: unknown): string;
  export function agentSvg(doc: Document, kind: unknown): Element;
  export function agentMark(doc: Document, kind: unknown, className?: string): HTMLElement;
  export function setAgentMark(mark: HTMLElement, kind: unknown): void;
  export function pickAgent(workspaces: { name: string; agent?: string }[], workspace: string | null, override?: string | null): "claude" | "codex";
  export function isAgentKey(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; code?: string; key?: string }): boolean;
  export function taskPlaceholder(kind: unknown, snip?: boolean): string;
}
