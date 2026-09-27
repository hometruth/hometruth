import { beforeEach, expect, test } from "bun:test";
import { createApp } from "../server/app";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { Site } from "../site";
import { TokenStore } from "./store";
import type { TokenCreate } from "./model";
import { parseToken } from "./token";
import { elementKey } from "../tags/identity";
import { publicRequestUrl } from "../runtime/listener-config";

class Relay extends BinarySwitch {
  private state: BinarySwitchState = "off";
  async turnOn() { this.state = "on"; }
  async turnOff() { this.state = "off"; }
  async toggle() { this.state = this.state === "on" ? "off" : "on"; }
  async getState() { return this.state; }
}

class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string, room?: string) {
    super(id, name, { host: "10.77.0.228" });
    this.capabilities = { binarySwitch: new Relay(id) };
    if (room) this.room = room;
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

let tokens: TokenStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tokens = new TokenStore();
  const site = new Site([
    new SwitchDevice("kettle", "Kettle", "Kitchen"),
    new SwitchDevice("lamp", "Lamp", "Study"),
  ]);
  app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, tokens);
});

const issue = (create: TokenCreate) => tokens.issue(create).token;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...bearer(token), "Content-Type": "application/json" });

/**
 * The one invariant that cannot be checked by reading the wiring: an app built
 * with no token store is harmless in tests and refuses everything anywhere
 * else. Without this, forgetting one argument in `prepareApplication` would
 * serve the whole installation to the LAN and every test would still pass.
 */
test("an app built without a token store fails closed outside test mode", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const unguarded = createApp(undefined, new Site([new SwitchDevice("kettle", "Kettle", "Kitchen")]));
    for (const path of ["/api/devices", "/api/health", "/devices"]) {
      const response = await unguarded.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "unconfigured" } });
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("the same app under test is open, so a route test is about the route", async () => {
  const open = createApp(undefined, new Site([new SwitchDevice("kettle", "Kettle", "Kitchen")]));
  expect((await open.request("/api/devices")).status).toBe(200);
});

test("without a credential, the API is closed and a browser is sent to sign in", async () => {
  expect((await app.request("/api/devices")).status).toBe(401);
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: { "Content-Type": "application/json" } })).status).toBe(401);

  const page = await app.request("/devices", { headers: { accept: "text/html" } });
  expect(page.status).toBe(303);
  expect(page.headers.get("location")).toBe("/sign-in?next=%2Fdevices");

  // The sign-in page itself, and liveness, must stay reachable or nobody can recover.
  expect((await app.request("/sign-in", { headers: { accept: "text/html" } })).status).toBe(200);
  expect((await app.request("/api/health")).status).toBe(200);
});

test("sign-in does not open the protected live connection or show an outage before authentication", async () => {
  const previous = process.env.HOMETRUTH_RELOAD_VERSION;
  process.env.HOMETRUTH_RELOAD_VERSION = "test-generation:ready";
  try {
    const response = await app.request("/sign-in?next=%2Fhealth", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<script type="module"');
    expect(html).not.toContain('data-runtime-state');
    // Keep the form's request helper and preferences available before sign-in.
    expect(html).toContain('window.ht =');
    expect(html).toContain('ht.request("/api/auth/sign-in"');
    expect(html).toContain('name="next" value="/health"');
    expect(html).toMatch(/<form\b[^>]*data-preferences/);
    expect((await app.request("/api/state/stream")).status).toBe(401);

    const admin = issue({ name: "browser", permissions: ["admin"], subject: { all: true } });
    const signedIn = await app.request("/", { headers: { ...bearer(admin), accept: "text/html" } });
    expect(signedIn.status).toBe(200);
    const home = await signedIn.text();
    expect(home).toContain('<script type="module"');
    expect(home).toContain('data-runtime-state');
  } finally {
    if (previous === undefined) delete process.env.HOMETRUTH_RELOAD_VERSION;
    else process.env.HOMETRUTH_RELOAD_VERSION = previous;
  }
});

test("a garbled, revoked or expired token is refused", async () => {
  expect((await app.request("/api/devices", { headers: bearer("nonsense") })).status).toBe(401);
  expect((await app.request("/api/devices", { headers: bearer("ht_short_short") })).status).toBe(401);

  const live = issue({ name: "live", permissions: ["read"], subject: { all: true } });
  expect((await app.request("/api/devices", { headers: bearer(live) })).status).toBe(200);
  tokens.revoke(tokens.list()[0]!.kid);
  expect((await app.request("/api/devices", { headers: bearer(live) })).status).toBe(401);

  const dead = issue({ name: "dead", permissions: ["read"], subject: { all: true }, expiresAt: "2020-01-01T00:00:00.000Z" });
  expect((await app.request("/api/devices", { headers: bearer(dead) })).status).toBe(401);
});

test("a token forged from a real key id but the wrong secret is refused", async () => {
  const real = issue({ name: "real", permissions: ["read"], subject: { all: true } });
  const kid = tokens.list()[0]!.kid;
  const forged = `ht_${kid}_${"A".repeat(43)}`;
  expect(forged).not.toBe(real);
  expect((await app.request("/api/devices", { headers: bearer(forged) })).status).toBe(401);
});

test("switch state needs only read permission and respects device scope", async () => {
  const kitchen = issue({ name: "kitchen", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
  const state = await app.request("/api/switches/kettle/state", { headers: bearer(kitchen) });
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ availability: "online", value: "off" });
  expect((await app.request("/api/switches/lamp/state", { headers: bearer(kitchen) })).status).toBe(403);
  expect((await app.request("/api/switches/kettle/state")).status).toBe(401);
});

test("enabled is readable while enable and disable require scoped admin access", async () => {
  const reader = issue({ name: "kitchen reader", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
  const enabled = await app.request("/api/devices/kettle/enabled", { headers: bearer(reader) });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toBe(true);
  expect((await app.request("/api/devices/lamp/enabled", { headers: bearer(reader) })).status).toBe(403);
  expect((await app.request("/api/devices/kettle/enabled")).status).toBe(401);
  const admin = issue({ name: "kitchen admin", permissions: ["admin"], subject: { criteria: { room: "Kitchen" } } });
  const writer = issue({ name: "kitchen writer", permissions: ["write"], subject: { criteria: { room: "Kitchen" } } });
  for (const action of ["enable", "disable"]) {
    expect((await app.request(`/api/devices/kettle/${action}`, { method: "POST", headers: json(reader) })).status).toBe(403);
    expect((await app.request(`/api/devices/kettle/${action}`, { method: "POST", headers: json(writer) })).status).toBe(403);
    expect((await app.request(`/api/devices/lamp/${action}`, { method: "POST", headers: json(admin) })).status).toBe(403);
    // This fixture has no config writer: authorization succeeds, then the write is unsupported.
    expect((await app.request(`/api/devices/kettle/${action}`, { method: "POST", headers: json(admin) })).status).toBe(409);
  }
});

test("read includes media and events, but cannot write or administer", async () => {
  const reader = issue({ name: "reader", permissions: ["read"], subject: { all: true } });
  expect((await app.request("/api/switches/kettle", { headers: bearer(reader) })).status).toBe(200);
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(reader) })).status).toBe(403);
  // Authorization succeeds, but this fixture is a switch rather than a camera.
  expect((await app.request("/api/cameras/kettle/snapshot", { headers: bearer(reader) })).status).toBe(404);
  expect((await app.request("/api/devices/kettle/events", { headers: bearer(reader) })).status).toBe(200);
  expect((await app.request("/api/tokens", { headers: bearer(reader) })).status).toBe(403);
});

test("write includes read, and admin includes both", async () => {
  const operator = issue({ name: "operator", permissions: ["write"], subject: { all: true } });
  expect((await app.request("/api/switches/kettle", { headers: bearer(operator) })).status).toBe(200);
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(operator) })).status).toBe(200);

  const admin = issue({ name: "admin", permissions: ["admin"], subject: { all: true } });
  expect((await app.request("/api/tokens", { headers: bearer(admin) })).status).toBe(200);
  expect((await app.request("/api/cameras/kettle/snapshot", { headers: bearer(admin) })).status).toBe(404);
  expect((await app.request("/api/switches/kettle/turn-off", { method: "POST", headers: json(admin) })).status).toBe(200);
  expect((await app.request("/api/tokens", { headers: bearer(operator) })).status).toBe(403);
});

test("a subject written as group criteria reaches only that room", async () => {
  const kitchen = issue({ name: "kitchen", permissions: ["write"], subject: { criteria: { room: "Kitchen" } } });
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(kitchen) })).status).toBe(200);
  expect((await app.request("/api/switches/lamp/turn-on", { method: "POST", headers: json(kitchen) })).status).toBe(403);
  // Its pages narrow the same way as its API.
  expect((await app.request("/switches/lamp", { headers: { ...bearer(kitchen), accept: "text/html" } })).status).toBe(403);
});

test("a subject naming an existing group reaches exactly that group's members", async () => {
  const scoped = issue({ name: "switches", permissions: ["write"], subject: { group: "automatic:switches" } });
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(scoped) })).status).toBe(200);

  const missing = issue({ name: "gone", permissions: ["write"], subject: { group: "automatic:nothing-like-this" } });
  // A group that no longer exists narrows a token to nothing; it never widens it.
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(missing) })).status).toBe(403);
});

test("a narrow token cannot reach site-wide routes even holding the verb", async () => {
  const kitchenAdmin = issue({ name: "kitchen admin", permissions: ["admin"], subject: { criteria: { room: "Kitchen" } } });
  expect((await app.request("/api/devices/kettle/name", { method: "POST", headers: json(kitchenAdmin), body: JSON.stringify({ name: "Kettle" }) })).status).not.toBe(403);
  // The ontology decides what "Kitchen" means, so a kitchen-scoped token must not edit it.
  expect((await app.request("/api/tags", { method: "POST", headers: json(kitchenAdmin), body: JSON.stringify({ name: "room", value: "Anywhere" }) })).status).toBe(403);
  // Nor may it mint itself a wider token.
  expect((await app.request("/api/tokens", { headers: bearer(kitchenAdmin) })).status).toBe(403);
});

test("a listing shows only what the token reaches", async () => {
  const kitchen = issue({ name: "kitchen", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
  const body = await (await app.request("/api/devices", { headers: bearer(kitchen) })).json() as { devices: { id: string }[] };
  expect(body.devices.map(device => device.id)).toEqual(["kettle"]);
});

test("a single-device admin can enable and disable only that device", async () => {
  const writes: { id: string; enabled: boolean }[] = [];
  const site = new Site([new SwitchDevice("kettle", "Kettle"), new SwitchDevice("lamp", "Lamp")]);
  const configured = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, {
    add: async () => {}, addAll: async () => {}, rename: async () => {},
    setEnabled: async (id, enabled) => { writes.push({ id, enabled }); },
  }, undefined, undefined, undefined, undefined, undefined, tokens);
  const admin = issue({ name: "Kettle administrator", permissions: ["admin"], subject: { device: "kettle" } });
  const writer = issue({ name: "Kettle operator", permissions: ["write"], subject: { device: "kettle" } });
  for (const [action, expected] of [["disable", false], ["enable", true]] as const) {
    expect((await configured.request(`/api/devices/kettle/${action}`, { method: "POST", headers: json(writer) })).status).toBe(403);
    expect((await configured.request(`/api/devices/lamp/${action}`, { method: "POST", headers: json(admin) })).status).toBe(403);
    expect(writes).toHaveLength(expected ? 1 : 0);
    const changed = await configured.request(`/api/devices/kettle/${action}`, { method: "POST", headers: json(admin) });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toBe(expected);
    const enabled = await configured.request("/api/devices/kettle/enabled", { headers: bearer(admin) });
    expect(await enabled.json()).toBe(expected);
  }
  expect(writes).toEqual([{ id: "kettle", enabled: false }, { id: "kettle", enabled: true }]);
  expect((await configured.request("/api/tokens", { headers: bearer(admin) })).status).toBe(403);
  expect((await configured.request(`/api/elements/${elementKey("device", "kettle")}`, { headers: bearer(admin) })).status).toBe(200);
  expect((await configured.request(`/api/elements/${elementKey("device", "lamp")}`, { headers: bearer(admin) })).status).toBe(403);
  const listed = await (await configured.request("/api/devices", { headers: bearer(admin) })).json() as { devices: { id: string }[] };
  expect(listed.devices.map(device => device.id)).toEqual(["kettle"]);
});

test("issuing a token validates its access level and device scope", async () => {
  const admin = issue({ name: "Administrator", permissions: ["admin"], subject: { all: true } });
  const create = (permissions: string[], device = "kettle") => app.request("/api/tokens", {
    method: "POST", headers: json(admin), body: JSON.stringify({ name: "Device token", permissions, subject: { device } }),
  });
  for (const removed of ["control", "media", "events"]) expect((await create([removed])).status).toBe(400);
  expect((await create(["admin"], "missing")).status).toBe(400);
  const response = await create(["admin"]);
  expect(response.status).toBe(201);
  const issued = await response.json() as { token: string };
  expect((await app.request("/api/devices/kettle/enabled", { headers: bearer(issued.token) })).status).toBe(200);
  expect((await app.request("/api/devices/lamp/enabled", { headers: bearer(issued.token) })).status).toBe(403);
});

test("signing in exchanges the token for a cookie that works on its own", async () => {
  const token = issue({ name: "browser", permissions: ["read"], subject: { all: true } });
  const refused = await app.request("/api/auth/sign-in", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "ht_no_no" }),
  });
  expect(refused.status).toBe(401);

  const response = await app.request("/api/auth/sign-in", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("ht_session=");
  expect(cookie).toContain("HttpOnly");
  expect((await app.request("/api/devices", { headers: { cookie: `ht_session=${token}` } })).status).toBe(200);
});

test("a token in the URL is taken once, moved to the cookie and stripped", async () => {
  const token = issue({ name: "kindle", permissions: ["read"], subject: { all: true } });
  const response = await app.request(`/devices?token=${encodeURIComponent(token)}`, { headers: { accept: "text/html" } });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/devices");
  expect(response.headers.get("set-cookie") ?? "").toContain("ht_session=");
});

test("a configured HTTPS proxy origin permits same-origin sign-in and sets secure cookies", async () => {
  const token = issue({ name: "browser", permissions: ["read"], subject: { all: true } });
  const origin = "https://control.example.test";
  const url = publicRequestUrl("http://127.0.0.1:3000/api/auth/sign-in", origin);
  const response = await app.request(url, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("Secure");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const previous = process.env.HOMETRUTH_PUBLIC_ORIGIN;
  try {
    process.env.HOMETRUTH_PUBLIC_ORIGIN = origin;
    for (const other of ["https://attacker.example.test", "http://hometruth.localhost"]) {
      const denied = await app.request(url, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: other }, body: JSON.stringify({ token }),
      });
      expect(denied.status).toBe(403);
    }
  } finally {
    if (previous === undefined) delete process.env.HOMETRUTH_PUBLIC_ORIGIN;
    else process.env.HOMETRUTH_PUBLIC_ORIGIN = previous;
  }
});

test("the token a create call returns is the only copy the server ever hands out", async () => {
  const admin = issue({ name: "admin", permissions: ["admin"], subject: { all: true } });
  const created = await app.request("/api/tokens", {
    method: "POST", headers: json(admin),
    body: JSON.stringify({ name: "Matter bridge", permissions: ["write"], subject: { group: "automatic:switches" } }),
  });
  expect(created.status).toBe(201);
  const issued = await created.json() as { token: string; kid: string };
  expect(issued.token.startsWith("ht_")).toBe(true);
  // It works…
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: json(issued.token) })).status).toBe(200);
  // …and no later read of the list can reproduce it.
  const listed = await (await app.request("/api/tokens", { headers: bearer(admin) })).json() as { tokens: Record<string, unknown>[] };
  expect(JSON.stringify(listed)).not.toContain(parseToken(issued.token)!.secret);
});


test("saved Filters require site read/write permissions and cannot be read through scoped event queries", async () => {
  const reader = issue({ name: "filter reader", permissions: ["read"], subject: { all: true } });
  const writer = issue({ name: "filter writer", permissions: ["write"], subject: { all: true } });
  const scoped = issue({ name: "scoped reader", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
  const input = { name: "All events", condition: { all: [] } };
  expect((await app.request("/api/filters", { method: "POST", headers: json(reader), body: JSON.stringify(input) })).status).toBe(403);
  expect((await app.request("/api/filters", { headers: bearer(scoped) })).status).toBe(403);
  const created = await app.request("/api/filters", { method: "POST", headers: json(writer), body: JSON.stringify(input) });
  expect(created.status).toBe(201);
  const { filter } = await created.json();
  expect((await app.request(`/api/filters/${filter.id}`, { headers: bearer(reader) })).status).toBe(200);
  expect((await app.request(`/api/devices/kettle/events?filter=${filter.id}`, { headers: bearer(scoped) })).status).toBe(403);
  expect((await app.request(`/api/filters/${filter.id}?revision=1`, { method: "DELETE", headers: json(reader) })).status).toBe(403);
});
