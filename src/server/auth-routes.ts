/**
 * Signing in, signing out, and the tokens themselves.
 *
 * Two of these are unusual and worth naming. `POST /api/auth/sign-in` is the
 * only policed thing that is public, because it is where an unauthenticated
 * caller is *supposed* to arrive; it grants nothing it was not already given,
 * since it only accepts a token that already verifies. And `POST /api/tokens`
 * is the only response in the app that contains a secret — once, for the
 * caller that asked for it, and never again from any route.
 *
 * Issuing requires `admin` over the whole site (see `policy.ts`), so a token
 * cannot mint a broader one than itself: a kitchen-scoped token is not an
 * admin of the site and never reaches this route at all.
 */
import { Hono } from "hono";
import { criteriaProblem } from "../models/automatic-group";
import type { Site } from "../site";
import type { TagStore } from "../tags/store";
import { groupSchemaChoices } from "../models/automatic-group";
import { renderSignInPage, safeNext } from "../ui/sign-in-page";
import { renderTokensPage } from "../ui/tokens-page";
import { describeSubject, validateTokenCreate, type TokenCreate } from "../auth/model";
import { clearSessionCookie, clientAddress, SESSION_COOKIE } from "../auth/guard";
import { isPrivateAddress, trustsLocalNetwork } from "../auth/network";
import type { TokenStore } from "../auth/store";
import { describeValidationErrors } from "../validation";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";
import { setCookie } from "hono/cookie";

/** The token record as the API returns it: everything but the secret, which is not kept. */
function publicToken(token: import("../auth/store").TokenRecord, groupName: (id: string) => string | undefined) {
  return { ...token, reaches: describeSubject(token.subject, groupName) };
}

export function authRoutes(tokens: TokenStore, site: Site, tags: TagStore, trustLocalNetwork = trustsLocalNetwork()): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  const groupName = (id: string) => site.deviceGroups.find(group => group.id === id)?.name;

  app.get("/sign-in", context => {
    // Whether *this* caller is trusted, not merely whether the site would
    // trust a local one: someone reading this page was refused, so saying
    // "you already have full access" without checking would be a lie that
    // hides the actual problem.
    const state = !trustLocalNetwork ? "off"
      : isPrivateAddress(clientAddress(context)) ? "trusted"
      : "enabled";
    return context.html(renderSignInPage(pageContext(context), safeNext(context.req.query("next")), state));
  });

  app.post("/api/auth/sign-in", async context => {
    const body = await requestJson(context) as { token?: unknown } | undefined;
    const presented = typeof body?.token === "string" ? body.token.trim() : "";
    const verified = presented ? tokens.verify(presented) : { ok: false as const, reason: "malformed" as const };
    // One message for every failure: a caller guessing tokens learns nothing
    // about whether the id existed, was revoked, or simply expired.
    if (!verified.ok) return errorJson(context, 401, "unauthenticated", "That token is not valid");
    setCookie(context, SESSION_COOKIE, presented, {
      path: "/", httpOnly: true, sameSite: "Lax",
      secure: new URL(context.req.url).protocol === "https:",
      maxAge: 60 * 60 * 24 * 365,
    });
    return context.json({ name: verified.token.name, permissions: verified.token.permissions });
  });

  app.post("/api/auth/sign-out", context => {
    clearSessionCookie(context);
    return context.json({ signedOut: true });
  });

  app.get("/api/auth/whoami", context => {
    const principal = context.get("principal");
    if (!principal) return errorJson(context, 401, "unauthenticated", "This request needs an API token");
    const reach = principal.devices();
    return context.json({
      kid: principal.kid,
      name: principal.name,
      // How this caller got in, so a script can tell "I hold a token" from
      // "this network is open" without guessing from the name.
      origin: principal.origin,
      permissions: principal.permissions,
      reaches: describeSubject(principal.token.subject, groupName),
      devices: reach === "all" ? "all" : [...reach].sort(),
    });
  });

  app.get("/settings/tokens", context => context.html(renderTokensPage({
    ctx: pageContext(context),
    tokens: tokens.list(),
    devices: site.devices.map(device => ({ id: device.id, name: device.name })),
    groups: site.deviceGroups.map(group => ({ id: group.id, name: group.name })),
    rooms: site.rooms,
    schemas: groupSchemaChoices(site.models, site.devices),
    tags: tags.list(),
    localNetworkTrusted: trustLocalNetwork,
  })));

  app.get("/api/tokens", context =>
    context.json({ tokens: tokens.list().map(token => publicToken(token, groupName)) }));

  app.post("/api/tokens", async context => {
    const body = await requestJson(context);
    if (!validateTokenCreate(body)) {
      return errorJson(context, 400, "invalid_request", "Name the token, choose read, write or admin access, and say what it reaches",
        describeValidationErrors(validateTokenCreate.errors));
    }
    const create = body as TokenCreate;
    if ("device" in create.subject && typeof create.subject.device === "string" && !site.get(create.subject.device)) {
      return errorJson(context, 400, "invalid_request", "No device with that id");
    }
    if ("group" in create.subject && typeof create.subject.group === "string"
      && !site.deviceGroups.some(group => group.id === create.subject.group)) {
      return errorJson(context, 400, "invalid_request", "No group with that id");
    }
    if ("criteria" in create.subject && create.subject.criteria) {
      // The same refusals the group builder gives, from the same function.
      const problem = criteriaProblem(create.subject.criteria, site.models, site.devices, id => Boolean(tags.get(id)));
      if (problem) return errorJson(context, 400, "invalid_request", problem);
    }
    if (create.expiresAt && Date.parse(create.expiresAt) <= Date.now()) {
      return errorJson(context, 400, "invalid_request", "An expiry in the past would issue a dead token");
    }
    const issued = tokens.issue(create);
    console.log(JSON.stringify({ event: "token_issued", kid: issued.record.kid, name: issued.record.name, permissions: issued.record.permissions }));
    // The only time the whole token leaves this process.
    return context.json({ token: issued.token, ...publicToken(issued.record, groupName) }, 201);
  });

  app.post("/api/tokens/:kid/revoke", context => {
    const kid = context.req.param("kid");
    const existing = tokens.get(kid);
    if (!existing) return errorJson(context, 404, "not_found", "No token with that id");
    const revoked = tokens.revoke(kid);
    console.log(JSON.stringify({ event: "token_revoked", kid, name: revoked.name }));
    return context.json(publicToken(revoked, groupName));
  });

  return app;
}
