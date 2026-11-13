// Which URLs the shell's windows may load, and the runner's page addresses. No Electron imports here.

/** True when `url` is on the runner's own origin (scheme, host and port all equal). */
export function sameOrigin(url: string, runnerUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(runnerUrl);
    return (a.protocol === "http:" || a.protocol === "https:") && a.origin === b.origin;
  } catch {
    return false;
  }
}

export function promptUrl(runnerUrl: string): string {
  return new URL("/prompt", runnerUrl).href;
}

export function dockUrl(runnerUrl: string): string {
  return new URL("/dock", runnerUrl).href;
}

/** The chat view, on one session when given its id. */
export function chatUrl(runnerUrl: string, sessionId?: string): string {
  const url = new URL("/", runnerUrl);
  if (sessionId) url.searchParams.set("session", sessionId);
  return url.href;
}

/** The session a chat URL names, if any. */
export function sessionOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("session") ?? undefined;
  } catch {
    return undefined;
  }
}

/** What a link that a page opens in a new window leads to. */
export type WindowTarget = { kind: "chat"; session?: string } | { kind: "prompt" };

/**
 * The window a page's new-window link opens, or null when it is refused. From any page, the runner's
 * chat view (`/`, `/?session=<id>`) opens the chat window. From the dock, `/prompt` opens the pop-up.
 */
export function windowTarget(url: string, runnerUrl: string, fromDock: boolean): WindowTarget | null {
  if (!sameOrigin(url, runnerUrl)) return null;
  const path = new URL(url).pathname;
  if (path === "/") return { kind: "chat", session: sessionOf(url) };
  return fromDock && path === "/prompt" ? { kind: "prompt" } : null;
}
