import { afterEach, expect, test } from "bun:test";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { healthReportSchema } from "../health/model";
import { HealthStore } from "../health/store";
import { HealthService } from "../health/service";
import { Device, type DeviceModel } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
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
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); });

function setup() {
  const devices = [new Relay("one", "First relay", {}), new Relay("two", "Second relay", {})];
  const health = new HealthService({ store: new HealthStore(), devices: () => devices, services: () => [health] });
  const site = new Site(devices, [], new Map(), [health]);
  const tokens = new TokenStore();
  const hub = new StateHub();
  health.start(false);
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub, tokens);
  cleanups.push(() => hub.stop(), () => health.stop(), () => tokens.close());
  const all = tokens.issue({ name: "Health reader", permissions: ["read"], subject: { all: true } }).token;
  const one = tokens.issue({ name: "One relay reader", permissions: ["read"], subject: { device: "one" } }).token;
  return { app, health, devices, all, one };
}

test("health is private, and a device-scoped reader cannot see house health or another device", async () => {
  const { app, all, one } = setup();
  const get = (path: string, token?: string) => app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  expect((await get("/api/health/report")).status).toBe(401);
  expect((await get("/health", one)).status).toBe(403);
  expect((await get("/api/health/report", one)).status).toBe(403);
  expect((await get("/api/devices/two/health", one)).status).toBe(403);
  expect((await get("/api/devices/one/health", one)).status).toBe(200);
  expect((await get("/api/services/health/health", one)).status).toBe(403);
  expect((await get("/api/health/report?period=forever", all)).status).toBe(400);
  expect((await get("/api/health/report?period=toString", all)).status).toBe(400);
  expect((await get("/api/devices/missing/health", all)).status).toBe(404);
});

test("cached reports and explicit checks satisfy their schemas; the dashboard renders existing observations", async () => {
  const { app, health, all, devices } = setup();
  await health.poll();
  const headers = { Authorization: `Bearer ${all}` };
  const checked = await app.request("/api/devices/one/health/check", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
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
