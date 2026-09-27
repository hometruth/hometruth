import { expect, test } from "bun:test";
import { createApp } from "../server/app";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { Site } from "../site";
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

function fixture() {
  const tokens = new TokenStore();
  const site = new Site([new SwitchDevice("kettle", "Kettle", "Kitchen")]);
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, tokens);
  return { tokens, app };
}

test("the sign-in page renders with no session and offers nowhere else to go", async () => {
  const { app } = fixture();
  const html = await (await app.request("/sign-in?next=/devices", { headers: { accept: "text/html" } })).text();
  expect(html).toContain("<!doctype html>");
  expect(html).toContain('name="token"');
  expect(html).toContain('type="password"');
  expect(html).toContain('value="/devices"');
  // No navigation: every link on it would be a link to a refusal.
  expect(html).not.toContain('class="site-nav"');
  // And no tag editor panel: there is no session yet to tag anything with, and
  // its own requests would be refused. (The name still appears in the shared
  // stylesheet, so this looks for the element itself.)
  expect(html).not.toContain('<section class="element-tag-panel"');
  // The one hint a person needs on a first start.
  expect(html).toContain("log");
});

test("a next that points off-site is discarded", async () => {
  const { app } = fixture();
  for (const attempt of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)"]) {
    const html = await (await app.request(`/sign-in?next=${encodeURIComponent(attempt)}`, { headers: { accept: "text/html" } })).text();
    expect(html).toContain('value="/"');
    expect(html).not.toContain("evil.example");
  }
});

test("the tokens page lists what exists and offers the group builder's own fields", async () => {
  const { app, tokens } = fixture();
  const admin = tokens.issue({ name: "Admin", permissions: ["admin"], subject: { all: true } }).token;
  tokens.issue({ name: "Kindle dashboard", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
  const html = await (await app.request("/settings/tokens", { headers: { Authorization: `Bearer ${admin}`, accept: "text/html" } })).text();

  expect(html).toContain("Kindle dashboard");
  expect(html).toContain("room Kitchen");
  // The subject fields are the group builder's, by name.
  expect(html).toContain('name="criteriaRoom"');
  expect(html).toContain('name="schemaId"');
  expect(html).toContain('data-criteria-fields');
  // Every permission is offered with its own plain-language hint.
  for (const level of ["read", "write", "admin"]) expect(html).toContain(`type="radio" name="permissions" value="${level}"`);
  for (const removed of ["control", "media", "events"]) expect(html).not.toContain(`name="permissions" value="${removed}"`);
  expect(html).toContain('name="subject" value="device"');
  expect(html).toContain('<select name="device"><option value="kettle">Kettle</option>');
  // Built-in groups are selectable as a subject.
  expect(html).toContain("automatic:switches");
});

test("the tokens link appears for an admin and not for anyone else", async () => {
  const { app, tokens } = fixture();
  const admin = tokens.issue({ name: "Admin", permissions: ["admin"], subject: { all: true } }).token;
  const reader = tokens.issue({ name: "Reader", permissions: ["read"], subject: { all: true } }).token;
  const page = async (token: string) => await (await app.request("/devices", { headers: { Authorization: `Bearer ${token}`, accept: "text/html" } })).text();
  expect(await page(admin)).toContain("/settings/tokens");
  expect(await page(reader)).not.toContain("/settings/tokens");
});

test("a page renders in the language the browser asks for", async () => {
  const { app } = fixture();
  const html = await (await app.request("/sign-in", { headers: { accept: "text/html", "accept-language": "de" } })).text();
  expect(html).toContain('lang="de"');
  expect(html).toContain("API-Token");
});
