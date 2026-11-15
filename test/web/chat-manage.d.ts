// Types for src/web/chat-manage.js, so the tests typecheck (see chat-format.d.ts).
declare module "*/web/chat-manage.js" {
  interface SessionLike { id: string; status: string; updatedAt: string; title?: string; workspace?: string; source?: string; claudeSessionId?: string | null; archived?: boolean; pinned?: boolean; terminalTurn?: boolean }
  export function ordered<T extends SessionLike>(sessions: Iterable<T>): T[];
  export function visible<T extends SessionLike>(sessions: Iterable<T>, view?: { archived?: boolean; workspace?: string; query?: string }): T[];
  export function workspacesOf(sessions: Iterable<SessionLike>): string[];
  export function canStop(session: SessionLike | undefined): boolean;
  export function canDelete(session: SessionLike | undefined): boolean;
  export function canFork(session: SessionLike | undefined): boolean;
  export function menuItems(session: SessionLike | undefined, full?: boolean): { action: string; label: string; disabled?: boolean; danger?: boolean }[];
  export function deleteConfirm(session: SessionLike | undefined): { title: string; body: string; confirm: string };
  export function archivedLine(session: SessionLike | undefined): string;
  export const UNDO_MS: number;
}
