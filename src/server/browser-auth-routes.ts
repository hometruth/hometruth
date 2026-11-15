import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { TokenStore } from "../auth/store";
import { clientAddress } from "../auth/guard";
import { browserOrigin, CHALLENGE_COOKIE, cookieOptions, currentSession, startSession } from "../auth/browser-session";
import { CHALLENGE_MS, SESSION_IDLE_MS } from "../auth/browser-store";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";
import { renderSecurityPage } from "../ui/security-page";

/** Bounded, per-socket-client throttling; forwarding headers never identify a client. */
export function authRateLimit() {
  const attempts = new Map<string, { at: number; count: number }>();
  return (address = "unknown", now = Date.now()) => {
    for (const [key, entry] of attempts) if (entry.at + 60_000 <= now) attempts.delete(key);
    let entry = attempts.get(address);
    if (!entry) {
      if (attempts.size >= 2048) return false;
      entry = { at: now, count: 0 };
      attempts.set(address, entry);
    }
    return ++entry.count <= 30;
  };
}

export function browserAuthRoutes(tokens: TokenStore): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  const limited = authRateLimit();
  app.use("/api/auth/passkeys/*", async (c, next) => {
    const origin = browserOrigin(c);
    if (!origin) return errorJson(c, 403, "https_required", "Passkeys require trusted HTTPS");
    if (c.req.method !== "GET" && c.req.header("origin") !== origin.origin) {
      return errorJson(c, 403, "invalid_request", "Passkeys require a same-origin request");
    }
    if (!limited(clientAddress(c))) return errorJson(c, 429, "rate_limited", "Wait a minute before trying again");
    return next();
  });

  app.get("/settings/security", c => c.html(renderSecurityPage(pageContext(c))));
  app.get("/api/auth/sessions", c => {
    const principal = c.get("principal")!;
    return c.json({ sessions: tokens.browsers.list(principal.kid).map(session => ({
      ...session, expiresAt: Math.min(session.expiresAt, session.lastUsedAt + SESSION_IDLE_MS,
        principal.token.expiresAt ? Date.parse(principal.token.expiresAt) : Infinity), current: session.id === c.get("browserSession")?.id,
    })) });
  });
  app.post("/api/auth/sessions/:id/revoke", c => {
    const removed = tokens.browsers.revoke(c.req.param("id"), c.get("principal")!.kid);
    return removed ? c.json({ revoked: true }) : errorJson(c, 404, "not_found", "No signed-in browser with that id");
  });
  app.get("/api/auth/passkeys", c => c.json({ passkeys: tokens.browsers.passkeys(c.get("principal")!.kid)
    .map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })) }));
  app.post("/api/auth/passkeys/:id/revoke", c => {
    const removed = tokens.browsers.removePasskey(c.req.param("id"), c.get("principal")!.kid);
    return removed ? c.json({ revoked: true }) : errorJson(c, 404, "not_found", "No passkey with that id");
  });

  app.post("/api/auth/passkeys/register/options", async c => {
    const browser = currentSession(c, tokens);
    if (!browser) return errorJson(c, 401, "unauthenticated", "Sign in to this browser before adding a passkey");
    const origin = browserOrigin(c)!;
    const options = await generateRegistrationOptions({
      rpName: "HomeTruth", rpID: origin.hostname,
      userID: new TextEncoder().encode(browser.token.kid), userName: browser.token.name,
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: tokens.browsers.passkeys(browser.token.kid).map(({ id, transports }) => ({ id, ...(transports ? { transports } : {}) })),
    });
    const binding = tokens.browsers.challenge({ challenge: options.challenge, kind: "register", origin: origin.origin,
      kid: browser.token.kid, sessionId: browser.session.id });
    setCookie(c, CHALLENGE_COOKIE, binding, { ...cookieOptions, sameSite: "strict", maxAge: CHALLENGE_MS / 1000 });
    return c.json(options);
  });

  app.post("/api/auth/passkeys/register/verify", async c => {
    const browser = currentSession(c, tokens);
    const challenge = tokens.browsers.consume(getCookie(c, CHALLENGE_COOKIE) || "");
    setCookie(c, CHALLENGE_COOKIE, "", { ...cookieOptions, maxAge: 0 });
    const body = await requestJson(c) as { name?: unknown; credential?: RegistrationResponseJSON } | undefined;
    if (!browser || !challenge || challenge.kind !== "register" || challenge.origin !== browserOrigin(c)!.origin
      || challenge.kid !== browser.token.kid || challenge.sessionId !== browser.session.id
      || typeof body?.name !== "string" || !body.name.trim() || body.name.length > 100 || !body.credential) {
      return errorJson(c, 400, "invalid_request", "Passkey setup expired or was invalid. Try again");
    }
    try {
      const result = await verifyRegistrationResponse({ response: body.credential, expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin, expectedRPID: browserOrigin(c)!.hostname, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo || currentSession(c, tokens)?.session.id !== browser.session.id) throw new Error("Refused");
      tokens.browsers.addPasskey(browser.token.kid, body.name.trim(), result.registrationInfo.credential);
      return c.json({ registered: true }, 201);
    } catch {
      return errorJson(c, 400, "invalid_request", "Could not verify that passkey. Try again");
    }
  });

  app.post("/api/auth/passkeys/authenticate/options", async c => {
    const origin = browserOrigin(c)!;
    const options = await generateAuthenticationOptions({ rpID: origin.hostname, userVerification: "required" });
    const browser = currentSession(c, tokens);
    const binding = tokens.browsers.challenge({ challenge: options.challenge, kind: "authenticate", origin: origin.origin,
      kid: browser?.token.kid ?? null, sessionId: browser?.session.id ?? null });
    setCookie(c, CHALLENGE_COOKIE, binding, { ...cookieOptions, sameSite: "strict", maxAge: CHALLENGE_MS / 1000 });
    return c.json(options);
  });

  app.post("/api/auth/passkeys/authenticate/verify", async c => {
    const challenge = tokens.browsers.consume(getCookie(c, CHALLENGE_COOKIE) || "");
    setCookie(c, CHALLENGE_COOKIE, "", { ...cookieOptions, maxAge: 0 });
    const body = await requestJson(c) as AuthenticationResponseJSON | undefined;
    const passkey = typeof body?.id === "string" ? tokens.browsers.passkey(body.id) : undefined;
    if (!body || !challenge || challenge.kind !== "authenticate" || challenge.origin !== browserOrigin(c)!.origin
      || !passkey || !tokens.active(passkey.kid) || (challenge.kid && challenge.kid !== passkey.kid)
      || (challenge.sessionId && currentSession(c, tokens)?.session.id !== challenge.sessionId)
      || body.response?.userHandle !== Buffer.from(passkey.kid).toString("base64url")) {
      return errorJson(c, 401, "unauthenticated", "Could not sign in with that passkey");
    }
    try {
      const result = await verifyAuthenticationResponse({ response: body, credential: passkey,
        expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: browserOrigin(c)!.hostname,
        requireUserVerification: true });
      if (!result.verified || !tokens.active(passkey.kid)
        || (challenge.sessionId && currentSession(c, tokens)?.session.id !== challenge.sessionId)
        || !tokens.browsers.advancePasskey(passkey.id, passkey.counter, result.authenticationInfo.newCounter)) throw new Error("Refused");
      startSession(c, tokens, passkey.kid, passkey.id);
      return c.json({ signedIn: true });
    } catch {
      return errorJson(c, 401, "unauthenticated", "Could not sign in with that passkey");
    }
  });
  return app;
}
