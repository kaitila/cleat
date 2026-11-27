// The Google Calendar API, called directly (D0059): an installed app's OAuth sign-in (a loopback
// redirect on 127.0.0.1 and PKCE), the refresh token kept in the plugin's data folder, and
// events.list with plain fetch. No Claude Code in between, so a view takes a fraction of a second.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";
export const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
/** The file in the plugin's data folder: the OAuth client and the refresh token. */
export const GRANT_FILE = "google.json";
/** How long before an access token's expiry it is taken as expired. */
const EARLY_MS = 60_000;

export interface Grant {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Fetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

const isGrant = (v: unknown): v is Grant =>
  typeof v === "object" && v !== null && ["clientId", "clientSecret", "refreshToken"].every((k) => typeof (v as Record<string, unknown>)[k] === "string" && (v as Record<string, string>)[k]!.length > 0);

/** The saved grant, or null when there is none (or it is not one). */
export function readGrant(dataDir: string): Grant | null {
  const file = join(dataDir, GRANT_FILE);
  if (!existsSync(file)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isGrant(v) ? { clientId: v.clientId, clientSecret: v.clientSecret, refreshToken: v.refreshToken } : null;
  } catch {
    return null;
  }
}

/** Saves the grant, readable by the person only. */
export function writeGrant(dataDir: string, grant: Grant): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, GRANT_FILE);
  writeFileSync(file, JSON.stringify(grant, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Google's consent page for this client, coming back to `redirectUri`. */
export function authUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Asked every time, so Google gives a refresh token again on a second sign-in.
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  return u.href;
}

async function tokenCall(fetcher: Fetch, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetcher(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(), signal });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const why = [json.error, json.error_description].filter((x) => typeof x === "string").join(": ") || `HTTP ${res.status}`;
    throw new Error(`Google refused the token request (${why})`);
  }
  return json;
}

/** The sign-in's code for a refresh token. */
export async function exchangeCode(
  fetcher: Fetch,
  o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
): Promise<string> {
  const json = await tokenCall(fetcher, {
    client_id: o.clientId,
    client_secret: o.clientSecret,
    code: o.code,
    code_verifier: o.verifier,
    grant_type: "authorization_code",
    redirect_uri: o.redirectUri,
  });
  if (typeof json.refresh_token !== "string") throw new Error("Google gave no refresh token: sign in again");
  return json.refresh_token;
}

/** Access tokens by refresh token, kept until shortly before they expire. */
const tokens = new Map<string, { token: string; until: number }>();

/** An access token for the grant: the one kept while it is good, else a new one. */
export async function accessToken(fetcher: Fetch, grant: Grant, signal?: AbortSignal, now = Date.now()): Promise<string> {
  const kept = tokens.get(grant.refreshToken);
  if (kept && kept.until > now) return kept.token;
  let json: Record<string, unknown>;
  try {
    json = await tokenCall(fetcher, { client_id: grant.clientId, client_secret: grant.clientSecret, refresh_token: grant.refreshToken, grant_type: "refresh_token" }, signal);
  } catch (e) {
    if (/invalid_grant/.test((e as Error).message)) throw new Error("the Google sign-in has expired or was revoked: run cleat plugin login calendar");
    throw e;
  }
  if (typeof json.access_token !== "string") throw new Error("Google gave no access token");
  const seconds = typeof json.expires_in === "number" ? json.expires_in : 3600;
  tokens.set(grant.refreshToken, { token: json.access_token, until: now + seconds * 1000 - EARLY_MS });
  return json.access_token;
}

/** Forgets kept access tokens (tests). */
export function forgetTokens(): void {
  tokens.clear();
}

/** One page of events.list on a calendar, recurring events expanded, in start order. */
export async function listEvents<E>(
  fetcher: Fetch,
  token: string,
  o: { calendar?: string; timeMin: Date; timeMax: Date; signal?: AbortSignal },
): Promise<{ items: E[]; timeZone?: string }> {
  const u = new URL(`${EVENTS_URL}/${encodeURIComponent(o.calendar ?? "primary")}/events`);
  u.search = new URLSearchParams({
    timeMin: o.timeMin.toISOString(),
    timeMax: o.timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  }).toString();
  const res = await fetcher(u, { headers: { authorization: `Bearer ${token}` }, signal: o.signal });
  const json = (await res.json().catch(() => ({}))) as { items?: E[]; timeZone?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Calendar answered ${res.status}${json.error?.message ? `: ${json.error.message}` : ""}`);
  return { items: json.items ?? [], ...(json.timeZone ? { timeZone: json.timeZone } : {}) };
}

/**
 * Waits on 127.0.0.1 for Google's redirect after the person signs in: resolves with the code, or
 * rejects with what Google said (denied) or when `signal` ends. The page says to go back to the terminal.
 */
export function loopback(state: string, signal: AbortSignal): { redirectUri: string; code: Promise<string>; stop: () => void } {
  let settle: { ok: (code: string) => void; fail: (e: Error) => void } = { ok: () => {}, fail: () => {} };
  const code = new Promise<string>((ok, fail) => (settle = { ok, fail }));
  const page = (text: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Cleat</title><p style="font:16px system-ui;margin:3em">${text}</p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/") return new Response("not found", { status: 404 });
      if (u.searchParams.get("state") !== state) return page("This sign-in is not the one Cleat started. Run cleat plugin login calendar again.");
      const error = u.searchParams.get("error");
      if (error) {
        settle.fail(new Error(`Google said: ${error}`));
        return page("Signing in was cancelled. You can close this tab.");
      }
      const got = u.searchParams.get("code");
      if (!got) return page("Google sent no code. Run cleat plugin login calendar again.");
      settle.ok(got);
      return page("Signed in: Cleat's Calendar can read your calendar now. You can close this tab.");
    },
  });
  // Gracefully: the page answering the redirect still reaches the browser.
  const stop = () => void server.stop();
  signal.addEventListener("abort", () => settle.fail(new Error("signing in was stopped")), { once: true });
  return { redirectUri: `http://127.0.0.1:${server.port}/`, code, stop };
}
