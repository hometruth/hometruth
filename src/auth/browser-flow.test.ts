import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./store";
import { createApp } from "../server/app";
import { Site } from "../site";

test("a real browser enrolls a passkey, resumes a persisted session and rejects replayed or unverified assertions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-browser-"));
  const db = join(directory, "tokens.sqlite");
  let tokens = new TokenStore(db);
  const grant = tokens.issue({ name: "Synthetic owner", permissions: ["admin"], subject: { all: true } });
  const build = () => createApp(undefined, new Site([]), undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, tokens);
  let app = build();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request) });
  const origin = `http://localhost:${server.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    let context = await browser.newContext();
    let page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/sign-in?next=%2Fsettings%2Fsecurity`);
    await page.locator('[name="token"]').fill(grant.token);
    await page.locator('[data-sign-in] button').click();
    await page.waitForURL(`${origin}/settings/security`);
    await page.locator('[data-sessions] li').waitFor();
    const cookies = await context.cookies();
    const session = cookies.find(c => c.name === "__Host-ht_session")!;
    expect(session).toBeDefined(); expect(session.httpOnly).toBe(true); expect(session.secure).toBe(true);
    expect(session.expires).toBeGreaterThan(Date.now() / 1000 + 89 * 86400);
    expect(session.value).not.toBe(grant.token);
    const storageState = await context.storageState();
    await context.close(); tokens.close(); tokens = new TokenStore(db); app = build();
    context = await browser.newContext({ storageState }); page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/sign-in?next=%2Fsettings%2Fsecurity`);
    await page.waitForURL(`${origin}/settings/security`);
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.locator('[data-register-passkey] [name="name"]').fill("Synthetic passkey");
    await page.locator('[data-register-passkey] button').click();
    await page.getByText("Passkey added.", { exact: true }).waitFor();
    expect(tokens.browsers.passkeys(grant.record.kid)).toHaveLength(1);
    await page.locator('[data-sign-out]').click(); await page.waitForURL(`${origin}/sign-in`);
    expect(tokens.browsers.verify(session.value)).toBeUndefined();
    await page.locator('[data-passkey-sign-in]').click(); await page.waitForURL(`${origin}/`);
    expect((await page.evaluate(async () => (await fetch("/api/auth/whoami")).json())).origin).toBe("session");

    // Real signed assertions, including invalid UV and replay, exercise the crypto verifier.
    await page.goto(`${origin}/settings/security`);
    const assertion = async () => page.evaluate(async () => {
      const options = await (await fetch("/api/auth/passkeys/authenticate/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) }) as PublicKeyCredential;
      return credential.toJSON();
    });
    const verify = async (body: unknown) => page.evaluate(async credential => {
      const response = await fetch("/api/auth/passkeys/authenticate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential) });
      return response.status;
    }, body);
    const proof = await assertion();
    expect(await verify(proof)).toBe(200); expect(await verify(proof)).toBe(401);
    const wrongChallenge = await assertion(); await assertion();
    expect(await verify(wrongChallenge)).toBe(401);
    const tampered = await assertion() as { response: { signature: string } };
    tampered.response.signature = "AAAA";
    expect(await verify(tampered)).toBe(401);
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    // Ask the authenticator for an assertion without UV, then send it to the required-UV server.
    const noUv = await page.evaluate(async () => {
      const options = await (await fetch("/api/auth/passkeys/authenticate/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      options.userVerification = "discouraged";
      return (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) }) as PublicKeyCredential).toJSON();
    });
    expect(await verify(noUv)).toBe(401);
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    const stolen = await assertion();
    const key = tokens.browsers.passkeys(grant.record.kid)[0]!;
    tokens.browsers.removePasskey(key.id, grant.record.kid);
    expect(await verify(stolen)).toBe(401);
    expect((await page.evaluate(async () => (await fetch("/api/auth/whoami")).status))).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await browser.close(); await server.stop(true); tokens.close(); rmSync(directory, { recursive: true });
  }
}, 60_000);
