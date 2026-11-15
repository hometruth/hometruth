import { describe, expect, test } from "bun:test";
import { DEVICE_ID, fakeRachioCloud, PERSON_ID, wateringSchedule } from "../../protocols/rachio/test-fixtures";
import type { SecretsFile } from "../../schemas";
import { createRachioSiteService, dormantRachioSource, RACHIO_DEFAULTS } from "./site-service";

const withKey = (apiKey: string): SecretsFile => ({ schemaVersion: 1, vendors: { rachio: { apiKey } } });
const SCHEDULE = `device/${DEVICE_ID}/current_schedule`;
const ACCOUNT = `person/${PERSON_ID}`;

function setup() {
  const cloud = fakeRachioCloud();
  let clock = 1_800_000_000_000;
  const service = createRachioSiteService(withKey("synthetic-api-key"), { fetch: cloud.fetch, now: () => clock })!;
  return { cloud, service, source: service.controller(DEVICE_ID), advance: (ms: number) => { clock += ms; } };
}

describe("createRachioSiteService", () => {
  test("a site without a Rachio key has no Rachio service", () => {
    expect(createRachioSiteService({ schemaVersion: 1 })).toBeUndefined();
    expect(createRachioSiteService(withKey("   "))).toBeUndefined();
  });

  test("hands out one source per controller", () => {
    const { service } = setup();
    expect(service.controller(DEVICE_ID)).toBe(service.controller(DEVICE_ID));
  });

  test("sixteen zones reading at once cost one account read and one schedule read", async () => {
    const { cloud, source } = setup();
    await Promise.all(Array.from({ length: 17 }, () => source.watering()));
    await Promise.all(Array.from({ length: 17 }, () => source.watering()));
    expect(cloud.count("GET", "person/info")).toBe(1);
    expect(cloud.count("GET", ACCOUNT)).toBe(1);
    expect(cloud.count("GET", SCHEDULE)).toBe(1);
  });

  test("re-reads the schedule every interval and the account every account interval", async () => {
    const { cloud, source, advance } = setup();
    await source.watering();
    advance(RACHIO_DEFAULTS.scheduleIntervalMs - 1);
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(1);
    advance(1);
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(2);
    expect(cloud.count("GET", ACCOUNT)).toBe(1);
    advance(RACHIO_DEFAULTS.accountIntervalMs);
    await source.watering();
    expect(cloud.count("GET", ACCOUNT)).toBe(2);
  });

  test("a per-controller poll interval is honoured", async () => {
    const cloud = fakeRachioCloud();
    let clock = 0;
    const service = createRachioSiteService(withKey("k"), { fetch: cloud.fetch, now: () => clock })!;
    const source = service.controller(DEVICE_ID, { scheduleIntervalMs: 600_000 });
    await source.watering();
    clock += 300_000;
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(1);
  });

  test("a failed read is the answer until the retry time, and is never replaced by an older success", async () => {
    const { cloud, source, advance } = setup();
    await source.controller();
    advance(RACHIO_DEFAULTS.accountIntervalMs);
    cloud.down = true;
    await expect(source.controller()).rejects.toMatchObject({ code: "unreachable" });
    cloud.down = false;
    await expect(source.controller()).rejects.toMatchObject({ code: "unreachable" });
    advance(RACHIO_DEFAULTS.failureRetryMs);
    await expect(source.controller()).resolves.toMatchObject({ controller: { id: DEVICE_ID } });
  });

  test("a zone command forces a new schedule read and checks every 15 s for a minute", async () => {
    const { cloud, source, advance } = setup();
    await source.watering();
    await source.startZone("zone-2-example", 600);
    cloud.schedule = wateringSchedule(2);
    expect((await source.watering()).schedule?.zoneId).toBe("zone-2-example");
    expect(cloud.count("GET", SCHEDULE)).toBe(2);
    advance(RACHIO_DEFAULTS.settleIntervalMs);
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(3);
    // Past the settle window the ordinary interval applies again.
    advance(RACHIO_DEFAULTS.settleWindowMs);
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(3);
    advance(RACHIO_DEFAULTS.scheduleIntervalMs - RACHIO_DEFAULTS.settleWindowMs);
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(4);
  });

  test("a read already in flight when a command lands is not kept", async () => {
    const { cloud, source } = setup();
    await source.controller();
    const slow = source.watering();
    await source.stopWatering();
    await slow;
    cloud.schedule = {};
    await source.watering();
    expect(cloud.count("GET", SCHEDULE)).toBe(2);
  });

  test("standby and rain delay commands force a new account read", async () => {
    const { cloud, source } = setup();
    await source.controller();
    await source.setStandby(true);
    cloud.controller = { ...cloud.controller, on: false };
    expect((await source.controller()).controller.on).toBe(false);
    await source.setRainDelay(3600);
    await source.controller();
    expect(cloud.count("GET", ACCOUNT)).toBe(3);
  });

  test("an offline controller costs no schedule read", async () => {
    const { cloud, source } = setup();
    cloud.controller = { ...cloud.controller, status: "OFFLINE" };
    await expect(source.watering()).rejects.toMatchObject({ code: "unreachable" });
    expect(cloud.count("GET", SCHEDULE)).toBe(0);
  });

  test("an unknown controller id names the discover script", async () => {
    const { service } = setup();
    await expect(service.controller("not-on-account").controller()).rejects.toThrow("discover.ts");
  });

  test("polling pauses on the reserve until reset, but commands and fresh reads still go out", async () => {
    const { cloud, source, advance } = setup();
    cloud.headers = { "x-ratelimit-remaining": String(RACHIO_DEFAULTS.reserveCalls), "x-ratelimit-reset": String((1_800_000_000_000 + 3_600_000) / 1000) };
    await source.controller();
    advance(RACHIO_DEFAULTS.accountIntervalMs);
    await expect(source.controller()).rejects.toMatchObject({ code: "rate_limited" });
    const before = cloud.calls.length;
    await expect(source.controller()).rejects.toMatchObject({ code: "rate_limited" });
    expect(cloud.calls.length).toBe(before);
    await source.stopWatering();
    expect(cloud.count("PUT", "device/stop_water")).toBe(1);
    advance(3_600_000);
    cloud.headers = { "x-ratelimit-remaining": "1700" };
    await expect(source.controller()).resolves.toBeDefined();
  });

  test("the dormant source names the missing secret on every path", async () => {
    const source = dormantRachioSource(DEVICE_ID);
    await expect(source.controller()).rejects.toMatchObject({ code: "not_configured" });
    await expect(source.startZone("zone", 60)).rejects.toThrow("vendors.rachio.apiKey");
  });
});
