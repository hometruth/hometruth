import { investigationSchema } from "../health/investigation";
import type { HealthCheck } from "../health/model";
import { afterEach, expect, test } from "bun:test";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { healthReportSchema, availabilityHealth } from "../health/model";
import { HealthStore } from "../health/store";
import { HealthService } from "../health/service";
import { Device, type DeviceModel } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { Button } from "../models/button";
import { LightError } from "../models/light";
import { CapabilityError } from "../models/capability";
import { Site } from "../site";
import { TokenStore } from "../auth/store";
import { StateHub } from "../state/hub";
import { createApp } from "./app";
import { validators } from "../validation";

class MemoryRelay extends BinarySwitch {
  async getState() { return "off" as const; } async turnOn() {} async turnOff() {} async toggle() {}
}
class Relay extends Device {
  readonly model = { id: "example-relay", title: "Relay", manufacturer: "Example", product: "Relay", capabilities: ["binarySwitch"], connectionTypes: ["direct-local"] } as unknown as DeviceModel;
  readonly capabilities = { binarySwitch: new MemoryRelay(this.id) };
  async probe() { return {}; }
}
class FailingButton extends Button { protected async performPress() { throw new Error("Synthetic press failure"); } }
class ButtonDevice extends Device {
  readonly model = { id: "example-button", title: "Button", manufacturer: "Example", product: "Button", capabilities: ["button"], connectionTypes: ["direct-local"] } as unknown as DeviceModel;
  readonly capabilities = { button: new FailingButton(this.id) };
  async probe() { return {}; }
}
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); });

function setup() {
  const devices = [new Relay("one", "First relay", {}), new Relay("two", "Second relay", {}), new ButtonDevice("button", "Example button", {})];
  const health = new HealthService({ store: new HealthStore(), devices: () => devices, services: () => [health] });
  const site = new Site(devices, [], new Map(), [health]);
  const tokens = new TokenStore();
  const hub = new StateHub();
  health.start(false);
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub, tokens);
  cleanups.push(() => hub.stop(), () => health.stop(), () => tokens.close());
  const all = tokens.issue({ name: "Health reader", permissions: ["read"], subject: { all: true } }).token;
  const one = tokens.issue({ name: "One relay reader", permissions: ["read"], subject: { device: "one" } }).token;
  const admin = tokens.issue({ name: "Health administrator", permissions: ["admin"], subject: { all: true } }).token;
  const scopedWriter = tokens.issue({ name: "Scoped writer", permissions: ["write"], subject: { device: "one" } }).token;
  return { app, health, devices, all, one, admin, scopedWriter };
}

test("health policy is strict, persisted per element and admin-only with device scope enforcement", async () => {
  const { app, health, devices, admin, scopedWriter, all } = setup();
  const put = (path: string, token: string, body: unknown) => app.request(path, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const path = "/api/devices/first-relay/health/policy";
  expect((await put(path, all, { unreachableIsUnhealthy: false })).status).toBe(403);
  expect((await put("/api/devices/second-relay/health/policy", scopedWriter, { unreachableIsUnhealthy: false })).status).toBe(403);
  for (const body of [null, [], {}, { unreachableIsUnhealthy: "false" }, { unreachableIsUnhealthy: false, extra: true }]) {
    expect((await put(path, admin, body)).status).toBe(400);
  }
  devices[0]!.reportHealth(availabilityHealth("offline"));
  expect((await put(path, admin, { unreachableIsUnhealthy: false })).status).toBe(200);
  expect(health.report().entities.find(row => row.id === "one")).toMatchObject({ unreachableIsUnhealthy: false, health: { status: "expected_offline" } });
  expect((await put("/api/services/health/health/policy", admin, { unreachableIsUnhealthy: false })).status).toBe(200);
  expect((await put("/api/devices/missing/health/policy", admin, { unreachableIsUnhealthy: false })).status).toBe(404);
  const page = await (await app.request("/health", { headers: { Authorization: `Bearer ${admin}` } })).text();
  expect(page).toContain('data-health-policy="/api/devices/first-relay/health/policy"');
  expect(page).toContain("Offline (allowed)");
  const readerPage = await (await app.request("/health", { headers: { Authorization: `Bearer ${all}` } })).text();
  expect(readerPage).not.toContain('type="checkbox" data-health-policy=');
});

test("specialized switch commands and button presses are unhealthy even when offline periods are allowed", async () => {
  const { app, health, devices, admin } = setup();
  const relay = devices[0] as Relay;
  relay.capabilities.binarySwitch.turnOn = async () => { throw new Error("Synthetic switch failure"); };
  for (const [id, path] of [["one", "/api/switches/first-relay/turn-on"], ["button", "/api/buttons/example-button/press"]]) {
    health.setUnreachableIsUnhealthy("device", id!, false);
    const response = await app.request(path!, { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBeGreaterThanOrEqual(500);
    const device = devices.find(device => device.id === id)!;
    device.reportHealth(availabilityHealth("offline"));
    expect(health.report().entities.find(row => row.id === id)!.health).toMatchObject({ status: "unhealthy", reason: "operation_failed" });
  }
});

test("execution errors stay unhealthy even with a 4xx response, while invalid requests do not", async () => {
  const { app, health, devices, admin } = setup();
  const relay = devices[0] as Relay;
  const run = () => app.request("/api/switches/first-relay/turn-on", { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: "{}" });
  health.setUnreachableIsUnhealthy("device", relay.id, false);
  relay.reportHealth(availabilityHealth("offline"));
  relay.capabilities.binarySwitch.turnOn = async () => { throw new CapabilityError("Invalid request", "invalid_value"); };
  expect((await run()).status).toBe(400);
  expect(health.report().entities.find(row => row.id === relay.id)!.health.status).toBe("expected_offline");
  relay.capabilities.binarySwitch.turnOn = async () => { throw new LightError("Malformed device response", "protocol"); };
  expect((await run()).status).toBe(400);
  relay.reportHealth(availabilityHealth("offline"));
  expect(health.report().entities.find(row => row.id === relay.id)!.health).toMatchObject({ status: "unhealthy", reason: "operation_failed" });
});

test("failed controls immediately link a private investigation and publish it before checks finish", async () => {
  const { app, health, devices, admin, one } = setup();
  const relay = devices[0] as Relay;
  relay.capabilities.binarySwitch.turnOn = async () => { throw new Error("Synthetic switch failure"); };
  let finish!: (value: HealthCheck) => void;
  relay.checkHealth = () => new Promise(resolve => { finish = resolve; });
  const headers = { Authorization: `Bearer ${admin}` };
  const stream = await app.request("/api/health/investigations/stream", { headers });
  const reader = stream.body!.getReader(), decoder = new TextDecoder();
  await reader.read(); // retry hint
  expect(decoder.decode((await reader.read()).value)).toContain("data: []");
  const failed = await app.request("/api/switches/first-relay/turn-on", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
  expect(failed.status).toBe(500);
  const href = failed.headers.get("X-HomeTruth-Investigation")!;
  expect(href).toStartWith("/health/investigations/");
  const published = decoder.decode((await reader.read()).value);
  expect(published).toContain(href);
  expect(published).toContain('"status":"starting"');
  const page = await app.request(href, { headers });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("First relay failure");
  const value = await (await app.request("/api" + href, { headers })).json();
  expect(addFormats(new Ajv({ strict: true })).compile(investigationSchema)(value)).toBe(true);
  const healthPage = await (await app.request("/health", { headers })).text();
  expect(healthPage).toContain('data-health-investigations');
  expect(healthPage).toContain(`href="${href}"`);
  for (const path of [href, "/api" + href, "/api/health/investigations", "/api/health/investigations/stream"]) {
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { Authorization: `Bearer ${one}` } })).status).toBe(403);
  }
  expect((await app.request("/health/investigations/missing", { headers })).status).toBe(404);
  await reader.cancel();
  if (finish) finish({ status: "healthy", detail: "Responding", checkedAt: new Date().toISOString() });
  expect(health.investigations()).toHaveLength(1);
});

test("health is private, and a device-scoped reader cannot see house health or another device", async () => {
  const { app, all, one } = setup();
  const get = (path: string, token?: string) => app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  expect((await get("/api/health/report")).status).toBe(401);
  expect((await get("/health", one)).status).toBe(403);
  expect((await get("/api/health/report", one)).status).toBe(403);
  expect((await get("/api/devices/second-relay/health", one)).status).toBe(403);
  expect((await get("/api/devices/first-relay/health", one)).status).toBe(200);
  expect((await get("/api/services/health/health", one)).status).toBe(403);
  expect((await get("/api/health/report?period=forever", all)).status).toBe(400);
  expect((await get("/api/health/report?period=toString", all)).status).toBe(400);
  expect((await get("/api/devices/missing/health", all)).status).toBe(404);
});

test("cached reports and explicit checks satisfy their schemas; the dashboard renders existing observations", async () => {
  const { app, health, all, devices } = setup();
  await health.poll();
  const headers = { Authorization: `Bearer ${all}` };
  const checked = await app.request("/api/devices/first-relay/health/check", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
  expect(checked.status).toBe(200); expect(validators.healthCheck(await checked.json())).toBe(true);
  const answer = await app.request("/api/health/report?period=7d", { headers });
  const ajv = addFormats(new Ajv({ strict: true }));
  expect(ajv.compile(healthReportSchema)(await answer.json())).toBe(true);
  devices[0]!.reportHealth({ status: "unhealthy", detail: '<script>alert("example")</script>' });
  const page = await app.request("/health?period=7d", { headers });
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain("First relay"); expect(html).toContain("Recent problems");
  expect(html).toContain('href="/switches/first-relay"');
  expect(html).not.toContain('href="/devices/one"');
  expect(html).toContain('&lt;script&gt;alert(&quot;example&quot;)&lt;/script&gt;');
  expect(html).not.toContain('<script>alert("example")</script>');
  expect(html).toContain('href="/health?period=7d" aria-current="page"');
  expect(html).toContain('/api/services/health/stream');
});
