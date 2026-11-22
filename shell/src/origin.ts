// Which URLs the shell's windows may load, and the runner's page addresses. No Electron imports here.
import { SETTINGS_ALIAS, SETTINGS_PAGE } from "./prefs";

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

/** The dock's page. With a notch, its size in points as `?notch=WxH`: the page draws the island out of it. */
export function dockUrl(runnerUrl: string, notch: { width: number; height: number } | null = null): string {
  const url = new URL("/dock", runnerUrl);
  if (notch) url.searchParams.set("notch", `${notch.width}x${notch.height}`);
  return url.href;
}

/** The Settings page, which the Settings window loads. */
export function settingsUrl(runnerUrl: string): string {
  return new URL(SETTINGS_PAGE, runnerUrl).href;
}

/** True for a link to the Settings page on the runner's origin: /settings or /assets/settings.html, with or without a query or fragment. */
export function isSettingsLink(url: string, runnerUrl: string): boolean {
  if (!sameOrigin(url, runnerUrl)) return false;
  const path = new URL(url).pathname;
  return path === SETTINGS_ALIAS || path === `${SETTINGS_ALIAS}/` || path === SETTINGS_PAGE;
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

/**
 * The address to hand to the default browser for a link a page followed or opened, or null when it
 * is refused: only http:, https: and mailto:, not on the runner's own origin (those are the shell's
 * windows or nothing), and with no user name or password in it.
 */
export function externalLink(url: string, runnerUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:") return u.pathname.trim() || u.search ? u.href : null;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password || sameOrigin(u.href, runnerUrl)) return null;
  return u.href;
}

/** What a link that a page opens in a new window leads to. */
export type WindowTarget = { kind: "chat"; session?: string } | { kind: "prompt" } | { kind: "settings" };

/**
 * The window a page's new-window link opens, or null when it is refused. From any page, the runner's
 * chat view (`/`, `/?session=<id>`) opens the chat window, and the Settings page (`/settings`,
 * `/assets/settings.html`) the Settings window. From the dock, `/prompt` opens the pop-up.
 */
export function windowTarget(url: string, runnerUrl: string, fromDock: boolean): WindowTarget | null {
  if (!sameOrigin(url, runnerUrl)) return null;
  const path = new URL(url).pathname;
  if (path === "/") return { kind: "chat", session: sessionOf(url) };
  if (isSettingsLink(url, runnerUrl)) return { kind: "settings" };
  return fromDock && path === "/prompt" ? { kind: "prompt" } : null;
}
