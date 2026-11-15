import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./store";
import { validateTokenCreate, type TokenSubject } from "./model";
import { Principal } from "./scope";
import { authGuard } from "./guard";
import { SESSION_COOKIE } from "./browser-session";
import { protectStream } from "./stream";
import type { AppEnvironment } from "../server/http";
import { createApp } from "../server/app";
import { Site } from "../site";
import { Device } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { StateHub } from "../state/hub";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const store = () => { const tokens = new TokenStore(); cleanups.push(() => tokens.close()); return tokens; };
class Relay extends BinarySwitch {
  async turnOn() {} async turnOff() {} async toggle() {} async getState() { return "off" as const; }
}
class Switch extends Device {
  model = SHELLY_PLUS_1;
  capabilities;
  constructor(id: string) { super(id, id, { host: "192.0.2.10" }); this.capabilities = { binarySwitch: new Relay(id) }; }
  async probe() { return {}; }
}
function fixture() {
  const tokens = store();
  const site = new Site([new Switch("allowed"), new Switch("forbidden-device")], undefined, undefined, undefined, undefined, undefined, [{ id: "delegated", name: "delegated", members: ["allowed", "forbidden-device"] }]);
  const hub = new StateHub({ generation: "security-test" }); cleanups.push(() => hub.stop());
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, hub, tokens);
  return { tokens, site, app, hub };
}
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("device, group and criteria admin grants are refused at schema, store and principal boundaries", () => {
  const tokens = store();
  for (const subject of [{ device: "allowed" }, { group: "delegated" }, { criteria: { room: "Kitchen" } }] as TokenSubject[]) {
    for (const permissions of [["admin"], ["read", "admin"]] as const) {
      const input = { name: "Invalid delegated admin", permissions: [...permissions], subject };
      expect(validateTokenCreate(input)).toBe(false);
      expect(() => tokens.issue(input)).toThrow();
      const principal = new Principal({ ...input, kid: "synthetic", createdAt: new Date().toISOString() }, new Site([]));
      expect(principal.allows("read")).toBe(false);
      expect(principal.allows("admin")).toBe(false);
    }
  }
});

test("invalid persisted admin grants cannot authenticate through bearer, session, or bootstrap eligibility", () => {
  const directory = mkdtempSync(join(tmpdir(), "ht-invalid-grant-")); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tokens.sqlite"); const tokens = new TokenStore(path); cleanups.push(() => tokens.close());
  const issued = tokens.issue({ name: "Synthetic", permissions: ["admin"], subject: { all: true } });
  const db = new Database(path);
  db.query("UPDATE tokens SET subject = ? WHERE kid = ?").run(JSON.stringify({ device: "allowed" }), issued.record.kid); db.close();
  expect(tokens.verify(issued.token).ok).toBe(false);
  expect(tokens.active(issued.record.kid)).toBeUndefined();
  expect(tokens.hasUsableToken()).toBe(false);
});

test("scoped writers cannot change group membership or read/write router reservations", async () => {
  const { tokens, app } = fixture();
  const token = tokens.issue({ name: "Scoped operator", permissions: ["write"], subject: { device: "allowed" } }).token;
  for (const [method, path, body] of [
    ["GET", "/api/devices/allowed/network/settings", undefined],
    ["POST", "/api/devices/allowed/network/settings", { mac: "02:00:00:00:00:99", address: "192.0.2.77" }],
    ["POST", "/api/device-groups/delegated/settings", { members: ["allowed", "forbidden-device"] }],
  ] as const) {
    const response = await app.request(path, { method, headers: headers(token), ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
  }
});

test("schema HTML excludes other devices, and site graph endpoints reject narrow readers", async () => {
  const { tokens, app } = fixture();
  const token = tokens.issue({ name: "Scoped reader", permissions: ["read"], subject: { device: "allowed" } }).token;
  const response = await app.request("/schemas/binary-switch", { headers: headers(token) });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("allowed"); expect(html).not.toContain("forbidden-device");
  for (const path of ["/graph", "/api/graph", "/api/graph/scene"]) {
    expect([403, 404]).toContain((await app.request(path, { headers: headers(token) })).status);
  }
});

function streamFixture(subject: TokenSubject = { device: "allowed" }) {
  const tokens = store();
  const groups = [{ id: "delegated", name: "Delegated", members: ["allowed"] }];
  const site = { deviceGroups: groups, automaticGroupMembers: () => [], pages: () => undefined };
  const grant = tokens.issue({ name: "Stream reader", permissions: ["read"], subject });
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const app = new Hono<AppEnvironment>();
  app.use("*", authGuard({ tokens, site, trustLocalNetwork: false }));
  app.get("/api/devices/:id/events/stream", c => c.body(new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } }), 200, { "content-type": "text/event-stream" }));
  return { tokens, grant, groups, app, send: () => controller.enqueue(new TextEncoder().encode("data: confidential\n\n")), cancelled: () => cancelled };
}

for (const mode of ["revoke", "session", "scope", "expiry"] as const) test(`existing streams close before forwarding data after ${mode}`, async () => {
  const f = streamFixture(mode === "scope" ? { group: "delegated" } : { device: "allowed" });
  const session = f.tokens.browsers.issue(f.grant.record.kid, "Synthetic browser");
  const response = await f.app.request("https://control.example.test/api/devices/allowed/events/stream", {
    headers: mode === "session" ? { cookie: `${SESSION_COOKIE}=${session.value}` } : headers(f.grant.token),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const initial = reader.read(); f.send(); expect((await initial).done).toBe(false);
  const pending = reader.read();
  if (mode === "revoke") f.tokens.revoke(f.grant.record.kid);
  if (mode === "session") f.tokens.browsers.revoke(session.session.id, f.grant.record.kid);
  if (mode === "scope") f.groups[0]!.members = [];
  if (mode === "expiry") {
    const active = f.tokens.active.bind(f.tokens);
    f.tokens.active = (kid, now) => kid === f.grant.record.kid ? undefined : active(kid, now);
  }
  f.send(); expect((await pending).done).toBe(true); expect(f.cancelled()).toBe(true);
});

test("idle streams close and cancel upstream when authority expires", async () => {
  let allowed = true, cancelled = false;
  const response = protectStream(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }), () => allowed, 5);
  const reader = response.body!.getReader(); const pending = reader.read(); allowed = false;
  await Bun.sleep(20);
  expect((await pending).done).toBe(true); expect(cancelled).toBe(true);
});

test("cancelling a protected stream releases its upstream", async () => {
  let cancelled = false;
  const response = protectStream(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" } }), () => true);
  await response.body!.cancel(); expect(cancelled).toBe(true);
});

test("revoking a real state stream releases its subscription and suppresses subsequent state", async () => {
  const { tokens, app, hub } = fixture();
  const grant = tokens.issue({ name: "State reader", permissions: ["read"], subject: { device: "allowed" } });
  const response = await app.request("/api/state/stream?node=allowed", { headers: headers(grant.token) });
  expect(response.status).toBe(200); expect(hub.streams.count).toBe(1);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  tokens.revoke(grant.record.kid);
  hub.observer.publish("allowed", { schemaVersion: 1, id: "allowed", name: "AFTER-REVOCATION", status: "online", manufacturer: "Test", model: "Test", capabilities: {}, health: { status: "unknown", detail: "", checkedAt: null } });
  hub.graph.flush();
  expect((await reader.read()).done).toBe(true);
  expect(hub.streams.count).toBe(0);
});
