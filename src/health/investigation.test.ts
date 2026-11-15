import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Device, type DeviceModel } from "../models/device";
import { HealthService } from "./service";
import { HealthStore } from "./store";
import type { HealthCheck } from "./model";
import { investigationSchema, type HealthInvestigation } from "./investigation";
import type { HealthAdvisor } from "./advisor";

class FixtureDevice extends Device {
  readonly model = { id: "fixture", manufacturer: "Example", product: "Relay", capabilities: [], connectionTypes: ["direct-local"] } as unknown as DeviceModel;
  readonly capabilities = {};
  override readonly parent = { id: "hub", index: 0 };
  calls = 0;
  async probe() { return {}; }
  override async checkHealth(): Promise<HealthCheck> { this.calls++; return { status: "healthy", detail: "Responding normally", checkedAt: new Date().toISOString() }; }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const valid = addFormats(new Ajv({ strict: true })).compile(investigationSchema);

function fixture(store = new HealthStore(), devices = [new FixtureDevice("lights", "Kitchen Lights", {})]) {
  const health = new HealthService({ store, devices: () => devices, services: () => [], timeoutMs: 100 });
  health.start(false); cleanup.push(() => health.stop());
  return { health, devices };
}

function completed(health: HealthService): Promise<HealthInvestigation> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { detach(); reject(new Error("Investigation did not finish")); }, 2000);
    const detach = health.subscribeInvestigations(items => {
      const value = items.find(item => item.status === "complete" || item.status === "interrupted");
      if (value) { clearTimeout(timer); detach(); resolve(health.investigation(value.id)!); }
    });
  });
}

test("a failure publishes a durable starting page before probes and deduplicates the open incident", async () => {
  const { health, devices: [device] } = fixture();
  const phases: string[] = [];
  health.subscribeInvestigations(items => phases.push(items[0]!.status));
  const done = completed(health);
  health.reportAction("device", device!.id, false);
  const first = health.investigations()[0]!;
  expect(first).toMatchObject({ title: "Kitchen Lights failure", status: "starting" });
  expect(first.href).toBe(`/health/investigations/${first.id}`);
  expect(device!.calls).toBe(0);
  expect(valid(health.investigation(first.id))).toBe(true);
  health.reportAction("device", device!.id, false);
  expect(health.investigations()).toHaveLength(1);
  const result = await done;
  expect(result.status).toBe("complete");
  expect(result.summary).toContain("has not been retried");
  expect(result.observations[0]!.health.status).toBe("healthy");
  expect(phases).toEqual(["starting", "checking", "complete"]);
  expect(health.report().entities[0]!.health.reason).toBe("operation_failed");
  health.reportAction("device", device!.id, true);
  expect(health.investigation(first.id)).toBeDefined();
  health.reportAction("device", device!.id, false);
  expect(health.investigations()).toHaveLength(2);
});

test("investigation probes the parent and reports a dependency cause with safe evidence", async () => {
  const lights = new FixtureDevice("lights", "Kitchen Lights", {}), hub = new FixtureDevice("hub", "Example hub", {});
  lights.checkHealth = hub.checkHealth = async () => ({ status: "unhealthy", reason: "unreachable", detail: "Not responding", checkedAt: new Date().toISOString() });
  const { health } = fixture(new HealthStore(), [lights, hub]);
  const done = completed(health);
  health.reportAction("device", lights.id, false);
  const result = await done;
  expect(result.observations).toHaveLength(2);
  expect(result.summary).toBe("Check the parent device first");
  expect(result.likelyCause).toContain("Example hub");
  expect(valid(result)).toBe(true);
});

test("unfinished investigations resume after restart with their original link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-investigations-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "health.sqlite");
  const first = fixture(new HealthStore(path));
  first.health.reportAction("device", "lights", false);
  const link = first.health.investigations()[0]!.href;
  await first.health.stop();
  const second = fixture(new HealthStore(path));
  const result = await completed(second.health);
  expect(result.href).toBe(link);
  expect(result.status).toBe("complete");
});

test("hanging probes finish with timeout evidence without clearing the action failure", async () => {
  const { health, devices: [device] } = fixture();
  device!.checkHealth = () => new Promise(() => {});
  const done = completed(health);
  health.reportAction("device", device!.id, false);
  const result = await done;
  expect(result.observations[0]!.health.detail).toContain("timed out");
  expect(result.summary).toBe("Check power and the connection");
  expect(health.report().entities[0]!.health.reason).toBe("operation_failed");
});

test("with an advisor, Claude's proposal completes the investigation after the rule-based findings", async () => {
  const store = new HealthStore();
  const seen: unknown[] = [];
  const advisor = { advise: async (input: { evidence: unknown }) => { seen.push(input.evidence); return {
    status: "complete" as const, note: "Proposed by Claude", model: "claude-opus-5-5", costUsd: 0.02, summary: "Relay rejected the command",
    likelyCause: "Firmware busy", confidence: "low" as const, proposals: [{ title: "Retry later", rationale: "Transient", steps: ["Retry"], changesDevice: true }],
  }; }, budget: () => undefined } as unknown as HealthAdvisor;
  const devices = [new FixtureDevice("lights", "Kitchen Lights", {})];
  const health = new HealthService({ store, devices: () => devices, services: () => [], timeoutMs: 100, advisor });
  health.start(false); cleanup.push(() => health.stop());
  const done = completed(health);
  health.reportAction("device", "lights", false);
  const result = await done;
  expect(result.summary).toContain("has not been retried");
  expect(result.advice).toMatchObject({ status: "complete", summary: "Relay rejected the command", costUsd: 0.02 });
  expect(seen[0]).toMatchObject({ observations: [{ entity: { key: "device:lights" } }] });
  expect(valid(result)).toBe(true);
});
