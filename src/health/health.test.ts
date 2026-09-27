import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinarySwitch } from "../models/binary-switch";
import { Device, type DeviceModel } from "../models/device";
import { Service } from "../models/service";
import { EventLog, type ServiceEventListener } from "../models/event-log";
import { DAY, ERROR_RECHECK_MS, ERROR_REPEAT_MS, HOUR, type HealthCheck } from "./model";
import { HealthService } from "./service";
import { HealthStore } from "./store";
import { validators } from "../validation";

class Relay extends BinarySwitch {
  async turnOn() {} async turnOff() {} async toggle() {} async getState() { return "off" as const; }
}
class TestDevice extends Device {
  readonly model = { id: "example-relay", manufacturer: "Example", product: "Relay", capabilities: ["binarySwitch"], connectionTypes: ["direct-local"] } as unknown as DeviceModel;
  readonly capabilities = this.expose({ binarySwitch: new Relay(this.id) });
  calls = 0;
  failure = false;
  constructor(id = "relay") { super(id, "Example relay", {}); }
  async probe() { this.calls++; if (this.failure) throw new Error("upstream supplied confidential data"); return {}; }
}
class TestService extends Service {
  readonly log = new EventLog();
  constructor(id = "example-service") { super(id, "Example service"); }
  status() { return { availability: "online" as const, detail: "Ready" }; }
  events() { return this.log.recent(); }
  subscribe(listener: ServiceEventListener) { return this.log.subscribe(listener); }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

function fixture(devices: TestDevice[] = [new TestDevice()], services: Service[] = []) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new HealthStore();
  const monitor = new HealthService({ store, devices: () => devices, services: () => services, now: () => now, timeoutMs: 10 });
  monitor.start(false); cleanup.push(() => monitor.stop());
  return { monitor, devices, advance: (ms: number) => { now += ms; monitor.tick(); } };
}

test("every device answers with a valid health contract; upstream errors do not escape", async () => {
  const device = new TestDevice();
  expect(validators.healthCheck(await device.checkHealth())).toBe(true);
  expect(device.health.status).toBe("healthy");
  expect(validators.homeTruthObject(await device.describe())).toBe(true);
  const { health: _, ...missingHealth } = await device.describe();
  expect(validators.homeTruthObject(missingHealth)).toBe(false);
  device.failure = true;
  expect(await device.checkHealth()).toMatchObject({ status: "unhealthy", detail: "Device health check failed" });
  // A stale successful capability document is not proof that a failed probe recovered.
  expect((await device.describe()).health.status).toBe("unhealthy");
  device.enabled = false;
  const calls = device.calls;
  expect((await device.checkHealth()).status).toBe("disabled");
  expect(device.calls).toBe(calls);
});

test("a failed health subscriber cannot turn a working device operation into a failure", async () => {
  const device = new TestDevice();
  device.subscribeHealth(() => { throw new Error("history unavailable"); });
  expect((await device.checkHealth()).status).toBe("healthy");
});

test("hourly polling, immediate errors, bounded reminders, and recovery use the event stream", async () => {
  const { monitor, devices: [device], advance } = fixture();
  const stream: string[] = []; monitor.subscribe(event => stream.push(String(event.data?.source)));
  await monitor.poll(); expect(device!.calls).toBe(1);
  advance(HOUR - 1); await monitor.poll(); expect(device!.calls).toBe(1);
  advance(1); await monitor.poll(); expect(device!.calls).toBe(2);
  device!.reportHealth({ status: "unhealthy", detail: "Connection lost" });
  expect(monitor.report().entities[0]!.health.status).toBe("unhealthy");
  const count = monitor.events().length;
  device!.reportHealth({ status: "unhealthy", detail: "Connection lost" });
  expect(monitor.events()).toHaveLength(count);
  advance(ERROR_REPEAT_MS); expect(stream.at(-1)).toBe("repeat"); expect(device!.calls).toBe(2);
  expect(monitor.report().problems[0]!.occurrences).toBe(2);
  await monitor.check("device", "relay");
  expect(monitor.report().problems[0]!.resolvedAt).not.toBeNull();
});

test("service errors are attributed to their service and device, without treating mirrored health as errors", async () => {
  const service = new TestService("relay");
  const { monitor } = fixture([new TestDevice()], [service]);
  await monitor.poll();
  service.log.record("automation_error", "Not persisted verbatim", { subject: "relay" });
  const report = monitor.report();
  expect(report.entities.map(row => row.health.status)).toEqual(["degraded", "degraded"]);
  expect(report.problems.map(problem => problem.kind).sort()).toEqual(["device", "service"]);
  expect(JSON.stringify(report)).not.toContain("Not persisted verbatim");
  const count = monitor.events().length;
  service.log.record("health_checked", "mirrored", { level: "error", data: { kind: "device", id: "relay", status: "unhealthy", detail: "Offline", checkedAt: null, source: "repeat" } });
  expect(monitor.events()).toHaveLength(count);
});

test("errors schedule bounded active recovery checks without repeated reports postponing them", async () => {
  const { monitor, devices: [device], advance } = fixture();
  await monitor.poll();
  device!.failure = true;
  device!.reportHealth({ status: "unhealthy", detail: "Connection lost" });
  advance(ERROR_RECHECK_MS - 1);
  device!.reportHealth({ status: "unhealthy", detail: "Still unavailable" });
  await monitor.poll();
  expect(device!.calls).toBe(1);
  advance(1); await monitor.poll();
  expect(device!.calls).toBe(2);
  expect(monitor.report().entities[0]!.health.status).toBe("unhealthy");
  device!.failure = false;
  advance(ERROR_RECHECK_MS); await monitor.poll();
  expect(device!.calls).toBe(3);
  expect(monitor.report().entities[0]!.health.status).toBe("healthy");
  expect(monitor.report().problems.every(problem => problem.resolvedAt !== null)).toBe(true);
  advance(HOUR - 1); await monitor.poll();
  expect(device!.calls).toBe(3);
  advance(1); await monitor.poll();
  expect(device!.calls).toBe(4);
});

test("changing symptoms remain one ongoing incident until the device recovers", async () => {
  const { monitor, devices: [device], advance } = fixture();
  await monitor.poll();
  device!.reportHealth({ status: "unhealthy", detail: "Connection lost" });
  const startedAt = monitor.report().problems[0]!.startedAt;
  advance(30000);
  device!.reportHealth({ status: "degraded", detail: "Some functions unavailable" });
  const ongoing = monitor.report().problems;
  expect(ongoing).toHaveLength(1);
  expect(ongoing[0]).toMatchObject({ startedAt, resolvedAt: null, occurrences: 2, detail: "Some functions unavailable" });
  device!.reportHealth({ status: "healthy", detail: "Responding normally" });
  expect(monitor.report().problems[0]!.resolvedAt).not.toBeNull();
  advance(30000);
  device!.reportHealth({ status: "unhealthy", detail: "Connection lost again" });
  expect(monitor.report().problems).toHaveLength(2);
});

test("disabled devices are not probed; re-enabling or replacing them schedules a fresh check", async () => {
  const device = new TestDevice(); device.enabled = false;
  const { monitor, devices, advance } = fixture([device]);
  await monitor.poll(); expect(device.calls).toBe(0);
  expect(monitor.report().entities[0]!.health.status).toBe("disabled");
  device.enabled = true; advance(30_000); await monitor.poll(); expect(device.calls).toBe(1);
  const replacement = new TestDevice(); devices[0] = replacement; monitor.reconcile();
  device.reportHealth({ status: "unhealthy", detail: "Old instance" });
  await monitor.poll(); expect(replacement.calls).toBe(1);
  expect(monitor.report().entities[0]!.health.status).toBe("healthy");
  devices.splice(0); monitor.reconcile(); expect(monitor.report().entities).toHaveLength(0);
});

test("hung checks time out, do not overlap, and cannot overwrite a timeout when they return late", async () => {
  const device = new TestDevice(); let resolve!: (answer: HealthCheck) => void;
  let calls = 0;
  device.checkHealth = () => { calls++; return new Promise(answer => { resolve = answer; }); };
  const { monitor } = fixture([device]);
  expect(await monitor.check("device", "relay")).toMatchObject({ status: "unhealthy", detail: "Health check timed out" });
  await monitor.check("device", "relay"); expect(calls).toBe(1);
  device.reportHealth({ status: "healthy", detail: "Late answer" });
  resolve({ status: "healthy", detail: "Late answer", checkedAt: new Date().toISOString() });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(monitor.report().entities[0]!.health.detail).toBe("Health check timed out");
});

test("replacing a device releases its stuck check without blocking the replacement", async () => {
  const old = new TestDevice(); old.checkHealth = () => new Promise(() => {});
  const { monitor, devices } = fixture([old]);
  const checking = monitor.check("device", old.id);
  await Promise.resolve();
  const replacement = new TestDevice(); devices[0] = replacement;
  monitor.reconcile();
  await checking;
  await monitor.poll();
  expect(replacement.calls).toBe(1);
  expect(monitor.report().entities[0]!.health.status).toBe("healthy");
});

test("a hung device cannot hold up other checks, and observations eventually become unknown", async () => {
  const stuck = new TestDevice("stuck"); stuck.checkHealth = () => new Promise(() => {});
  const others = Array.from({ length: 5 }, (_, index) => new TestDevice(`relay-${index}`));
  const { monitor, advance } = fixture([stuck, ...others]);
  await monitor.poll();
  expect(others.every(device => device.calls === 1)).toBe(true);
  advance(2 * HOUR + 1);
  expect(monitor.report().entities.every(row => row.health.status === "unknown")).toBe(true);
});

test("invalid answers fail closed and stop cancels deadlines without writing late results", async () => {
  const device = new TestDevice();
  device.checkHealth = async () => ({ status: "invented" } as unknown as HealthCheck);
  const { monitor } = fixture([device]);
  expect((await monitor.check("device", "relay"))?.detail).toContain("invalid health answer");
  device.checkHealth = async () => ({ status: "healthy", detail: "OK", checkedAt: null } as unknown as HealthCheck);
  expect((await monitor.check("device", "relay"))?.status).toBe("unhealthy");
  device.checkHealth = async () => ({ status: "healthy", detail: "OK", checkedAt: new Date().toISOString(), extra: "must not reach the API" });
  expect(JSON.stringify(await monitor.check("device", "relay"))).not.toContain("must not reach the API");
  device.checkHealth = () => new Promise(() => {});
  const pending = monitor.check("device", "relay");
  await monitor.stop(); await pending;
});

test("uptime is time weighted, excludes unknown/disabled time, and preserves outage history across a crash", () => {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-health-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "health.sqlite");
  const entity = { key: "device:relay", kind: "device" as const, id: "relay", name: "Example relay" };
  const check = (status: HealthCheck["status"]): HealthCheck => ({ status, detail: status, checkedAt: "2026-01-01T00:00:00Z" });
  const start = Date.parse("2026-01-01T00:00:00Z");
  let store = new HealthStore(file); store.begin(start);
  store.observe(entity, check("healthy"), start);
  store.observe(entity, check("unhealthy"), start + HOUR); store.problem(entity, "Disconnected", start + HOUR);
  store.heartbeat(start + 2 * HOUR); store.close(); // Crash: no end().
  store = new HealthStore(file); store.begin(start + 4 * HOUR);
  store.observe(entity, check("healthy"), start + 4 * HOUR);
  store.observe(entity, check("disabled"), start + 5 * HOUR);
  store.heartbeat(start + 6 * HOUR);
  const report = store.report(start, start + 6 * HOUR, HOUR);
  expect(report.entities[0]).toMatchObject({ observedMs: 3 * HOUR, disabledMs: HOUR, unknownMs: 2 * HOUR });
  expect(report.entities[0]!.uptimePercent).toBeCloseTo(200 / 3);
  expect(report.problems[0]).toMatchObject({ detail: "Disconnected", resolvedAt: new Date(start + 4 * HOUR).toISOString() });
  const shorter = store.report(start + 4 * HOUR, start + 6 * HOUR, HOUR);
  expect(shorter.entities[0]!.uptimePercent).toBe(100);
  store.retain([], start + 40 * DAY); expect(store.report(start, start + 40 * DAY, HOUR).problems).toEqual([]);
  store.close();
});
