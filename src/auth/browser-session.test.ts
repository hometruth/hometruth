import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { TokenStore } from "./store";
import { SESSION_IDLE_MS, SESSION_MAX_MS, FRESH_AUTH_MS, CHALLENGE_MS } from "./browser-store";
import { SESSION_COOKIE } from "./browser-session";
import { createApp } from "../server/app";
import { Site } from "../site";
import { authRateLimit } from "../server/browser-auth-routes";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const create = (tokens: TokenStore) => createApp(undefined, new Site([]), undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, tokens);
function fixture() {
  const tokens = new TokenStore(); cleanup.push(() => tokens.close());
  const grant = tokens.issue({ name: "Test owner", subject: { all: true }, permissions: ["admin"] });
  return { tokens, grant, app: create(tokens) };
}
const headers = (value: string) => ({ cookie: `${SESSION_COOKIE}=${value}`, "Content-Type": "application/json" });

test("browser secrets are hashed, survive database reopen and cannot be used as API tokens", () => {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-sessions-")); cleanup.push(() => rmSync(directory, { recursive: true }));
  const file = join(directory, "tokens.sqlite");
  let tokens = new TokenStore(file);
  const grant = tokens.issue({ name: "Test", permissions: ["read"], subject: { all: true } });
  const issued = tokens.browsers.issue(grant.record.kid, "Test browser"); tokens.close();
  tokens = new TokenStore(file); cleanup.push(() => tokens.close());
  expect(tokens.browsers.verify(issued.value)?.kid).toBe(grant.record.kid);
  expect(tokens.verify(issued.value).ok).toBe(false);
  expect(tokens.browsers.verify(grant.token)).toBeUndefined();
  const db = new Database(file, { readonly: true });
  const rows = JSON.stringify(db.query("SELECT * FROM browser_sessions").all()); db.close();
  expect(rows).not.toContain(issued.value);
  expect(rows).not.toContain(grant.token);
});

test("idle and absolute deadlines are enforced on the server", () => {
  const { tokens, grant } = fixture(); const now = Date.now();
  const idle = tokens.browsers.issue(grant.record.kid, "Idle", null, now);
  expect(tokens.browsers.verify(idle.value, now + SESSION_IDLE_MS - 1)).toBeDefined();
  expect(tokens.browsers.verify(idle.value, now + SESSION_IDLE_MS)).toBeUndefined();
  const active = tokens.browsers.issue(grant.record.kid, "Active", null, now);
  for (let day = 1; day < 90; day++) {
    const at = now + day * 24 * 60 * 60_000;
    const verified = tokens.browsers.verify(active.value, at)!;
    expect(verified).toBeDefined(); tokens.browsers.touch(verified, at);
  }
  expect(tokens.browsers.verify(active.value, now + SESSION_MAX_MS)).toBeUndefined();
});

test("sign-in rotates the session, sets secure persistent cookies and logout revokes only that browser", async () => {
  const { tokens, grant, app } = fixture();
  const other = tokens.browsers.issue(grant.record.kid, "Other browser");
  const old = tokens.browsers.issue(grant.record.kid, "Old browser");
  const response = await app.request("https://control.example.test/api/auth/sign-in", {
    method: "POST", headers: headers(old.value), body: JSON.stringify({ token: grant.token }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  for (const flag of ["__Host-ht_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=7776000"]) expect(cookie).toContain(flag);
  expect(cookie).not.toContain(grant.token); expect(cookie).not.toContain("Domain=");
  expect(tokens.browsers.verify(old.value)).toBeUndefined();
  const signedIn = { cookie: cookie.split(";")[0]! };
  const who = await app.request("/api/auth/whoami", { headers: signedIn });
  expect((await who.json()).origin).toBe("session");
  expect((await app.request("/sign-in?next=/devices", { headers: signedIn })).headers.get("location")).toBe("/devices");
  expect((await app.request("/sign-in?reauth=1", { headers: signedIn })).status).toBe(200);
  expect((await app.request("/api/auth/sign-out", { method: "POST", headers: { ...signedIn, "Content-Type": "application/json" } })).status).toBe(200);
  expect((await app.request("/api/auth/whoami", { headers: signedIn })).status).toBe(401);
  expect(tokens.browsers.verify(other.value)).toBeDefined(); expect(tokens.verify(grant.token).ok).toBe(true);
});

test("revoking or expiring an access grant immediately refuses its browser sessions", async () => {
  const { tokens, grant, app } = fixture();
  const browser = tokens.browsers.issue(grant.record.kid, "Browser"); tokens.revoke(grant.record.kid);
  expect((await app.request("/api/auth/whoami", { headers: headers(browser.value) })).status).toBe(401);
  const expired = tokens.issue({ name: "Expired", subject: { all: true }, permissions: ["read"], expiresAt: "2020-01-01T00:00:00Z" });
  const session = tokens.browsers.issue(expired.record.kid, "Expired browser");
  expect((await app.request("/api/auth/whoami", { headers: headers(session.value) })).status).toBe(401);
});

test("session listings and revocations cannot cross access grants", async () => {
  const { tokens, grant, app } = fixture();
  const own = tokens.browsers.issue(grant.record.kid, "Own");
  const outsider = tokens.issue({ name: "Other", permissions: ["admin"], subject: { all: true } });
  const other = tokens.browsers.issue(outsider.record.kid, "Other browser");
  const list = await (await app.request("/api/auth/sessions", { headers: headers(own.value) })).json();
  expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([own.session.id]);
  expect((await app.request(`/api/auth/sessions/${other.session.id}/revoke`, { method: "POST", headers: headers(own.value) })).status).toBe(404);
  expect(tokens.browsers.verify(other.value)).toBeDefined();
});

test("old sessions require reauthentication for security changes but still read and sign out", async () => {
  const { tokens, grant, app } = fixture();
  const old = tokens.browsers.issue(grant.record.kid, "Old", null, Date.now() - FRESH_AUTH_MS - 1);
  for (const path of ["/api/tokens", `/api/tokens/${grant.record.kid}/revoke`, "/api/auth/passkeys/register/options", "/api/auth/passkeys/key/revoke", "/api/auth/sessions/browser/revoke"]) {
    const response = await app.request(path, { method: "POST", headers: headers(old.value), body: "{}" });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("reauthentication_required");
  }
  expect((await app.request("/api/auth/sessions", { headers: headers(old.value) })).status).toBe(200);
  expect((await app.request("/api/auth/sign-out", { method: "POST", headers: headers(old.value) })).status).toBe(200);
});

test("plaintext LAN sign-in, cookie authentication, cross-origin writes and raw-token cookies are refused", async () => {
  const { grant, tokens, app } = fixture();
  const browser = tokens.browsers.issue(grant.record.kid, "Browser");
  expect((await app.request("http://control.local/api/auth/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: grant.token }) })).status).toBe(403);
  expect((await app.request("http://control.local/api/auth/whoami", { headers: headers(browser.value) })).status).toBe(401);
  expect((await app.request("/api/auth/whoami", { headers: headers(grant.token) })).status).toBe(401);
  expect((await app.request("/api/auth/sign-in", { method: "POST", headers: { ...headers(browser.value), Origin: "https://evil.example" }, body: JSON.stringify({ token: grant.token }) })).status).toBe(403);
});

test("passkey challenges expire, are browser-bound and are consumed even when verification fails", async () => {
  const { app, tokens } = fixture();
  const options = await app.request("/api/auth/passkeys/authenticate/options", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{}" });
  expect(options.status).toBe(200);
  const cookie = options.headers.get("set-cookie")!.split(";")[0]!;
  const binding = cookie.split("=")[1]!;
  expect((await app.request("/api/auth/passkeys/authenticate/verify", { method: "POST", headers: { cookie, Origin: "http://localhost", "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  expect(tokens.browsers.consume(binding)).toBeFalsy();
  const at = Date.now();
  const expired = tokens.browsers.challenge({ kind: "authenticate", challenge: "test", origin: "http://localhost", kid: null, sessionId: null }, at);
  expect(tokens.browsers.consume(expired, at + CHALLENGE_MS)).toBeFalsy();
  const fresh = tokens.browsers.challenge({ kind: "authenticate", challenge: "test", origin: "http://localhost", kid: null, sessionId: null });
  expect(tokens.browsers.consume(fresh)?.challenge).toBe("test");
  expect(tokens.browsers.consume(fresh)).toBeFalsy();
  expect((await app.request("/api/auth/passkeys/authenticate/options", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
});

test("authentication throttling has an enforced window and bounded client storage", () => {
  const allow = authRateLimit();
  for (let i = 0; i < 30; i++) expect(allow("client", 0)).toBe(true);
  expect(allow("client", 1)).toBe(false); expect(allow("client", 60_000)).toBe(true);
  for (let i = 0; i < 2047; i++) expect(allow(String(i), 60_000)).toBe(true);
  expect(allow("overflow", 60_000)).toBe(false);
});
