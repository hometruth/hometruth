/**
 * The one place a request is allowed in.
 *
 * Every request passes through here, and the default is no. A route is let
 * through only when `policy.ts` names it public, or when a presented token
 * both holds the verb the policy asks for and reaches the thing the route
 * touches. There is no third path, and no handler can opt itself out.
 *
 * One credential type, carried two ways. A token is a token whether it arrives
 * as `Authorization: Bearer ht_…` from the CLI or as an HttpOnly cookie from a
 * browser; the cookie is not a separate session object with its own lifetime
 * and its own bugs, it is the same row in the same table, revocable from the
 * same page. Signing in is exchanging the string for the cookie, which is why
 * `/api/auth/sign-in` is the only policed thing that has to be public.
 *
 * (If a human-chosen password or a passkey is ever added, it belongs *in front*
 * of this: verify the credential, then mint a token and set this same cookie.
 * Everything downstream — policy, scope, revocation, the token list — already
 * works, and `Bun.password` already provides Argon2id with no dependency.)
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { parseElementKey } from "../tags/identity";
import { errorJson, type AppEnvironment } from "../server/http";
import type { Permission } from "./model";
import { isPublicRoute, policyFor, type RoutePolicy } from "./policy";
import { CLIENT_ADDRESS_HEADER, isPrivateAddress, trustsLocalNetwork } from "./network";
import { localNetworkPrincipal, Principal, type ScopeSite } from "./scope";
import type { TokenStore } from "./store";

export const SESSION_COOKIE = "ht_session";
/** Where an unauthenticated browser is sent, with the page it wanted. */
export const SIGN_IN_PATH = "/sign-in";
/** How a token may be handed to a browser that cannot paste one — a Kindle, a QR code. */
export const TOKEN_QUERY_PARAM = "token";

export interface GuardSite extends ScopeSite {
  pages(): { resolve(path: string): { entry: { readonly source: string; readonly id: string } } | undefined } | undefined;
}

/** The route Hono actually matched, as `policy.ts` keys it. Middleware entries are skipped. */
export function matchedRoute(context: Context): { method: string; path: string } | undefined {
  const routes = context.req.matchedRoutes ?? [];
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index]!;
    if (route.method !== "ALL") return { method: route.method, path: route.path };
  }
  return undefined;
}

/**
 * The path parameters of the matched route.
 *
 * Hono fills `c.req.param()` from the route that is *currently executing*, and
 * in an `app.use("*")` middleware that is the wildcard, which has no
 * parameters — so asking Hono here silently returns nothing and every scoped
 * check would pass on an empty id. The guard therefore reads them out of the
 * matched pattern itself, which is also what makes `authorized()` testable
 * without a live request.
 */
export function routeParams(pattern: string, pathname: string): Record<string, string> {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    // A trailing wildcard swallows the rest and names nothing.
    if (part === "*") break;
    const value = pathParts[index];
    if (value === undefined) break;
    if (!part.startsWith(":")) continue;
    // `:id`, `:id?` and `:id{regex}` all name `id`.
    const name = part.slice(1).replace(/[{?].*$/u, "");
    try { params[name] = decodeURIComponent(value); }
    catch { params[name] = value; }
  }
  return params;
}

/** A browser asking for a page, as opposed to a program asking for JSON. */
function wantsHtml(context: Context): boolean {
  return context.req.method === "GET" && (context.req.header("accept") ?? "").includes("text/html");
}

function setSessionCookie(context: Context, token: string): void {
  setCookie(context, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    // Only meaningful behind TLS; harmless (and correct) to omit on plain LAN HTTP.
    secure: new URL(context.req.url).protocol === "https:",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function clearSessionCookie(context: Context): void {
  setCookie(context, SESSION_COOKIE, "", { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 0 });
}

/** Header first, then cookie: a program's explicit token always beats a stale browser cookie. */
function presentedToken(context: Context): string | undefined {
  const header = context.req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return getCookie(context, SESSION_COOKIE) || undefined;
}

/** Whether a principal satisfies one policy against this request's parameters. */
export function authorized(principal: Principal, site: GuardSite, policy: RoutePolicy, context: Context, route: { method: string; path: string }): boolean {
  const { permission, target } = policy;
  const params = routeParams(route.path, new URL(context.req.url).pathname);
  switch (target.kind) {
    case "site":
      return principal.allowsSite(permission);
    case "listing":
      // The verb is checked here; the handler is responsible for showing only
      // the rows this principal reaches.
      return principal.allows(permission);
    case "device":
      return principal.allowsDevice(params[target.param] ?? "", permission);
    case "group":
      return groupAllowed(principal, site, params[target.param] ?? "", permission);
    case "element": {
      const parsed = parseElementKey(params[target.param] ?? "");
      // Only a device key narrows to a device. Anything else — a tag, a schema,
      // the site node itself — is site-wide, and needs a site-wide token.
      if (parsed?.kind === "device" && parsed.ids[0]) return principal.allowsDevice(parsed.ids[0], permission);
      return principal.allowsSite(permission);
    }
    case "page":
      return pageAllowed(principal, site, context, permission);
  }
}

/**
 * A group is reachable only when *every* member is. A control on a group fans
 * out to all of them, so partial reach must never be enough to send it, and a
 * group document that silently dropped the members you cannot see would be a
 * lie about what the group is.
 */
function groupAllowed(principal: Principal, site: GuardSite, groupId: string, permission: Permission): boolean {
  if (!principal.allows(permission)) return false;
  const devices = principal.devices();
  if (devices === "all") return true;
  const group = site.deviceGroups.find(candidate => candidate.id === groupId);
  return group !== undefined && group.members.length > 0 && group.members.every(member => devices.has(member));
}

function pageAllowed(principal: Principal, site: GuardSite, context: Context, permission: Permission): boolean {
  if (!principal.allows(permission)) return false;
  if (principal.devices() === "all") return true;
  const resolved = site.pages()?.resolve(new URL(context.req.url).pathname);
  if (!resolved) return false;
  const { source, id } = resolved.entry;
  if (source === "device") return principal.allowsDevice(id, permission);
  if (source === "group" || source === "group-switch") return groupAllowed(principal, site, id, permission);
  // A service or speaker-group page is site furniture, not a device.
  return false;
}

export interface GuardOptions {
  readonly tokens: TokenStore;
  readonly site: GuardSite;
  /**
   * Whether a caller on a private network needs no token at all. On unless
   * `HOMETRUTH_TRUST_LAN` switches it off. Injected so tests can state which
   * posture they are testing rather than reaching for the environment.
   */
  readonly trustLocalNetwork?: boolean;
}

/**
 * The address the supervisor read off the socket, or undefined when the app is
 * not behind one. Undefined means *not* trusted: a missing fact is never
 * treated as a private address, or anything reaching the app another way would
 * inherit the run of the house.
 */
export function clientAddress(context: Context): string | undefined {
  return context.req.header(CLIENT_ADDRESS_HEADER)?.trim() || undefined;
}

export function authGuard({ tokens, site, trustLocalNetwork = trustsLocalNetwork() }: GuardOptions): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const route = matchedRoute(context);
    // Nothing matched: let Hono's own 404 answer. There is nothing here to protect.
    if (!route) return await next();
    if (isPublicRoute(route.method, route.path)) return await next();

    const url = new URL(context.req.url);
    const fromQuery = url.searchParams.get(TOKEN_QUERY_PARAM);
    /**
     * A token in the URL is how a browser that cannot paste one signs in: the
     * Kindle's bookmark, or a QR code scanned by a phone. It is accepted once,
     * moved straight into the cookie, and stripped by a redirect so it stops
     * living in history, logs and bookmarks. Pages already send
     * `Referrer-Policy: no-referrer`, so it does not leak on the way out.
     */
    if (fromQuery && wantsHtml(context)) {
      const verified = tokens.verify(fromQuery);
      if (verified.ok) {
        setSessionCookie(context, fromQuery);
        url.searchParams.delete(TOKEN_QUERY_PARAM);
        return context.redirect(`${url.pathname}${url.search}`, 303);
      }
    }

    /**
     * Who is asking. A presented token always wins over the network a caller
     * is on: a credential means what it says, so a Kindle carrying a narrow
     * token stays narrow at home rather than quietly becoming an admin. Only
     * the absence of one falls through to local-network trust.
     */
    const address = clientAddress(context);
    const localTrusted = trustLocalNetwork && isPrivateAddress(address);
    const presented = presentedToken(context);
    let principal: Principal | undefined;
    let kid: string | undefined;

    if (presented) {
      const verified = tokens.verify(presented);
      if (verified.ok) {
        principal = new Principal(verified.token, site);
        kid = verified.token.kid;
      } else {
        // A revoked or expired cookie is dead weight in the browser; drop it so
        // the next page load lands on sign-in instead of failing again silently.
        if (getCookie(context, SESSION_COOKIE)) clearSessionCookie(context);
        // A dead cookie must not lock someone out of their own living room, so
        // on a trusted network this falls through rather than refusing.
        if (!localTrusted) {
          return refuse(context, 401, "unauthenticated", verified.reason === "expired" ? "That token has expired" : "That token is not valid");
        }
      }
    }
    if (!principal && localTrusted) principal = localNetworkPrincipal(site, address!);
    if (!principal) return refuse(context, 401, "unauthenticated", "This request needs an API token");

    const policy = policyFor(route.method, route.path);
    // Unreachable while `policy.test.ts` passes, and deliberately fatal if it
    // ever is reached: an unpoliced route is denied, never waved through.
    if (!policy) return refuse(context, 403, "forbidden", "This route has no access policy");

    if (!authorized(principal, site, policy, context, route)) {
      return refuse(context, 403, "forbidden", `This token does not hold "${policy.permission}" for that`);
    }

    context.set("principal", principal);
    if (kid) tokens.touch(kid, address);
    await next();
  };
}

/** JSON for a program, a trip to sign-in for a browser that has nowhere else to go. */
function refuse(context: Context<AppEnvironment>, status: 401 | 403, code: string, message: string) {
  if (status === 401 && wantsHtml(context)) {
    const url = new URL(context.req.url);
    const next = `${url.pathname}${url.search}`;
    return context.redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`, 303);
  }
  return errorJson(context, status, code, message);
}
