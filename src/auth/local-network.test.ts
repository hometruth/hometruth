import { beforeEach, expect, test } from "bun:test";
import { createApp } from "../server/app";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { Site } from "../site";
import { CLIENT_ADDRESS_HEADER } from "./network";
import { TokenStore } from "./store";

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
  constructor(id: string, name: string, room: string) {
    super(id, name, { host: "10.77.0.228" });
    this.capabilities = { binarySwitch: new Relay(id) };
    this.room = room;
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

let tokens: TokenStore;
let app: ReturnType<typeof createApp>;

function build(trust: string | undefined) {
  const previous = process.env.HOMETRUTH_TRUST_LAN;
  if (trust === undefined) delete process.env.HOMETRUTH_TRUST_LAN;
  else process.env.HOMETRUTH_TRUST_LAN = trust;
  try {
    tokens = new TokenStore();
    const site = new Site([new SwitchDevice("kettle", "Kettle", "Kitchen"), new SwitchDevice("lamp", "Lamp", "Study")]);
    return createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, tokens);
  } finally {
    if (previous === undefined) delete process.env.HOMETRUTH_TRUST_LAN;
    else process.env.HOMETRUTH_TRUST_LAN = previous;
  }
}

/** A request as the supervisor forwards it: the peer address it read off the socket. */
const from = (address: string, extra: Record<string, string> = {}) => ({ [CLIENT_ADDRESS_HEADER]: address, ...extra });

beforeEach(() => { app = build(undefined); });

test("a caller on the LAN needs no token, for anything", async () => {
  const lan = from("10.77.0.40");
  expect((await app.request("/api/devices", { headers: lan })).status).toBe(200);
  expect((await app.request("/api/switches/kettle/turn-on", { method: "POST", headers: { ...lan, "Content-Type": "application/json" } })).status).toBe(200);
  // Including the parts a narrow token would not have reached.
  expect((await app.request("/api/tokens", { headers: lan })).status).toBe(200);
  expect((await app.request("/api/devices/kettle/events", { headers: lan })).status).toBe(200);
  expect((await app.request("/devices", { headers: { ...lan, accept: "text/html" } })).status).toBe(200);
});

test("every private range counts, and nothing else does", async () => {
  for (const address of ["10.1.2.3", "172.20.0.9", "10.78.0.147", "127.0.0.1", "::1", "fd00::5", "::ffff:10.77.0.5"]) {
    expect((await app.request("/api/devices", { headers: from(address) })).status, address).toBe(200);
  }
  for (const address of ["8.8.8.8", "203.0.113.9", "2001:db8::1", "100.64.0.1"]) {
    expect((await app.request("/api/devices", { headers: from(address) })).status, address).toBe(401);
  }
});

/**
 * The whole policy rests on the address being a fact rather than a claim. The
 * supervisor deletes any inbound copy and writes the socket's address; these
 * are the headers an attacker would reach for instead.
 */
test("a caller cannot talk their way onto the local network", async () => {
  const off = "203.0.113.9";
  for (const spoof of [
    { "x-forwarded-for": "10.77.0.5" },
    { "x-forwarded-for": "127.0.0.1, 203.0.113.9" },
    { "x-real-ip": "10.77.0.5" },
    { forwarded: "for=10.77.0.5" },
    { "x-forwarded-host": "10.77.0.5" },
  ]) {
    const response = await app.request("/api/devices", { headers: from(off, spoof) });
    expect(response.status, JSON.stringify(spoof)).toBe(401);
  }
});

test("with no address at all, nothing is assumed", async () => {
  // An app reached some way other than through the supervisor has no trusted
  // address, and a missing fact must never read as a private one.
  expect((await app.request("/api/devices")).status).toBe(401);
  expect((await app.request("/api/devices", { headers: { [CLIENT_ADDRESS_HEADER]: "" } })).status).toBe(401);
  expect((await app.request("/api/devices", { headers: { [CLIENT_ADDRESS_HEADER]: "localhost" } })).status).toBe(401);
});

test("HOMETRUTH_TRUST_LAN=off closes it again", async () => {
  const closed = build("off");
  expect((await closed.request("/api/devices", { headers: from("10.77.0.40") })).status).toBe(401);
  const token = tokens.issue({ name: "still works", permissions: ["read"], subject: { all: true } }).token;
  expect((await closed.request("/api/devices", { headers: { ...from("10.77.0.40"), Authorization: `Bearer ${token}` } })).status).toBe(200);
});

/**
 * The rule that keeps the Kindle honest: presenting a credential means you get
 * that credential, not the run of the house because of where you are standing.
 */
test("a presented token wins over the network it arrives from", async () => {
  const narrow = tokens.issue({ name: "kindle", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } }).token;
  const lan = { ...from("10.77.0.40"), Authorization: `Bearer ${narrow}` };
  expect((await app.request("/api/switches/kettle", { headers: lan })).status).toBe(200);
  expect((await app.request("/api/switches/lamp", { headers: lan })).status).toBe(403);
  expect((await app.request("/api/tokens", { headers: lan })).status).toBe(403);
  const body = await (await app.request("/api/devices", { headers: lan })).json() as { devices: { id: string }[] };
  expect(body.devices.map(device => device.id)).toEqual(["kettle"]);
});

test("a dead cookie does not lock anyone out of their own living room", async () => {
  const token = tokens.issue({ name: "old", permissions: ["read"], subject: { all: true } }).token;
  tokens.revoke(tokens.list()[0]!.kid);
  const lan = { ...from("10.77.0.40"), cookie: `ht_session=${token}` };
  const response = await app.request("/api/devices", { headers: lan });
  expect(response.status).toBe(200);
  // …and the dead cookie is cleared on the way past, rather than failing forever.
  expect(response.headers.get("set-cookie") ?? "").toContain("ht_session=");
  // From outside, the same dead cookie is simply refused.
  expect((await app.request("/api/devices", { headers: { ...from("8.8.8.8"), cookie: `ht_session=${token}` } })).status).toBe(401);
});

test("whoami says how someone got in", async () => {
  const lan = await (await app.request("/api/auth/whoami", { headers: from("10.77.0.40") })).json() as { origin: string; name: string };
  expect(lan.origin).toBe("local-network");
  expect(lan.name).toBe("Local network");

  const token = tokens.issue({ name: "A token", permissions: ["read"], subject: { all: true } }).token;
  const held = await (await app.request("/api/auth/whoami", { headers: { ...from("10.77.0.40"), Authorization: `Bearer ${token}` } })).json() as { origin: string; name: string };
  expect(held.origin).toBe("token");
  expect(held.name).toBe("A token");
});

test("the token list says out loud that it is not the only way in", async () => {
  // The page embeds the whole `tokens.*` dictionary for its script, so the
  // sentence is in the HTML either way; what differs is whether it is rendered.
  const open = await (await app.request("/settings/tokens", { headers: { ...from("10.77.0.40"), accept: "text/html" } })).text();
  expect(open).toContain('class="open-network"');

  const closed = build("off");
  const token = tokens.issue({ name: "admin", permissions: ["admin"], subject: { all: true } }).token;
  const guarded = await (await closed.request("/settings/tokens", { headers: { Authorization: `Bearer ${token}`, accept: "text/html" } })).text();
  expect(guarded).not.toContain('class="open-network"');
});

/**
 * The message a person actually reads when they have been refused. Claiming
 * "you already have full access" on a page that just turned them away hides
 * the real fault, which is nearly always an old server still out in front.
 */
test("the sign-in page describes this request, not the setting", async () => {
  /**
   * Which note was rendered, read off the markup. Every page embeds its whole
   * `auth.*` dictionary for its script, so both sentences are in the HTML
   * whichever one is shown; searching for the words would always match.
   */
  const noteOn = async (headers: Record<string, string>, on = app): Promise<string | undefined> => {
    const html = await (await on.request("/sign-in", { headers: { ...headers, accept: "text/html" } })).text();
    return /<p class="note" data-local-network="([a-z]+)"/u.exec(html)?.[1];
  };

  // Trust is on, but this request did not arrive local: say what is wrong.
  expect(await noteOn(from("203.0.113.9"))).toBe("enabled");
  // No address at all — an old supervisor in front — reads the same way.
  expect(await noteOn({})).toBe("enabled");
  // A caller who really is local, and navigated here anyway.
  expect(await noteOn(from("10.77.0.40"))).toBe("trusted");
  // With trust off there is nothing to explain; a token is simply the way in.
  expect(await noteOn(from("10.77.0.40"), build("off"))).toBeUndefined();

  // And the words themselves are the ones a person reads.
  const remote = await (await app.request("/sign-in", { headers: { ...from("203.0.113.9"), accept: "text/html" } })).text();
  expect(remote).toContain('data-local-network="enabled">This site treats the local network as trusted');
});

test("a local caller is never sent to sign in", async () => {
  const response = await app.request("/devices", { headers: { ...from("10.77.0.40"), accept: "text/html" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
});
