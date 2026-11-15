import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnvironment } from "../server/http";
import type { TokenStore } from "./store";
import { FRESH_AUTH_MS, SESSION_MAX_MS } from "./browser-store";

export const SESSION_COOKIE = "__Host-ht_session";
export const CHALLENGE_COOKIE = "__Host-ht_challenge";
export const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: true } as const;

/** Loopback HTTP is for local development only. LAN sign-in always needs HTTPS. */
export function browserOrigin(context: Context): URL | undefined {
  const url = new URL(process.env.HOMETRUTH_PUBLIC_ORIGIN || context.req.url);
  if (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) return url;
  return undefined;
}

export function currentSession(context: Context, tokens: TokenStore) {
  if (!browserOrigin(context)) return undefined;
  const value = getCookie(context, SESSION_COOKIE);
  const session = value ? tokens.browsers.verify(value) : undefined;
  if (!session) return undefined;
  const token = tokens.active(session.kid);
  if (!token) return undefined;
  return { session, token };
}

export function startSession(context: Context, tokens: TokenStore, kid: string, passkeyId: string | null = null) {
  const old = currentSession(context, tokens);
  if (old) tokens.browsers.revoke(old.session.id, old.session.kid);
  const issued = tokens.browsers.issue(kid, context.req.header("user-agent") || "Browser", passkeyId);
  setCookie(context, SESSION_COOKIE, issued.value, { ...cookieOptions, maxAge: SESSION_MAX_MS / 1000 });
  return issued.session;
}

export function clearSessionCookie(context: Context) {
  setCookie(context, SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

/** Bearer callers prove their API credential on each request; LAN trust is not reauthentication. */
export function freshAuthentication(context: Context<AppEnvironment>): boolean {
  const principal = context.get("principal");
  if (principal?.origin === "token") return true;
  const session = context.get("browserSession");
  return Boolean(session && Date.now() - session.authenticatedAt < FRESH_AUTH_MS);
}
