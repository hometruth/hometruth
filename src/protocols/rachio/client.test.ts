import { describe, expect, test } from "bun:test";
import { parseCurrentSchedule, parseRateLimitReset, RachioClient, RachioError } from "./client";
import { DEVICE_ID, fakeRachioCloud, PERSON_ID, wateringSchedule } from "./test-fixtures";

const KEY = "synthetic-api-key";

describe("RachioClient", () => {
  test("reads the account with the bearer key, asking for the person id only once", async () => {
    const cloud = fakeRachioCloud();
    const client = new RachioClient(KEY, { fetch: cloud.fetch });
    const [controller] = await client.controllers();
    await client.controllers();
    expect(cloud.count("GET", "person/info")).toBe(1);
    expect(cloud.count("GET", `person/${PERSON_ID}`)).toBe(2);
    expect(cloud.calls.every(call => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(controller).toMatchObject({ id: DEVICE_ID, status: "ONLINE", on: true, model: "GENERATION3_16ZONE", rainSensorTripped: false });
    expect(controller!.zones).toHaveLength(16);
    expect(controller!.zones[0]).toEqual({ id: "zone-1-example", zoneNumber: 1, name: "Example zone 1", enabled: true, maxRuntime: 10_800, lastWateredDate: 1_790_000_000_000 });
    expect(client.requests).toBe(3);
  });

  test("skips deleted controllers", async () => {
    const cloud = fakeRachioCloud();
    expect((await new RachioClient(KEY, { fetch: cloud.fetch }).controllers()).map(controller => controller.id)).toEqual([DEVICE_ID]);
  });

  test("sends every command with the documented path and body", async () => {
    const cloud = fakeRachioCloud();
    const client = new RachioClient(KEY, { fetch: cloud.fetch });
    await client.startZone("zone-3-example", 900);
    await client.stopWater(DEVICE_ID);
    await client.setStandby(DEVICE_ID, true);
    await client.setStandby(DEVICE_ID, false);
    await client.rainDelay(DEVICE_ID, 86_400);
    await client.rainDelay(DEVICE_ID, 0);
    expect(cloud.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "PUT", path: "zone/start", body: { id: "zone-3-example", duration: 900 } },
      { method: "PUT", path: "device/stop_water", body: { id: DEVICE_ID } },
      { method: "PUT", path: "device/off", body: { id: DEVICE_ID } },
      { method: "PUT", path: "device/on", body: { id: DEVICE_ID } },
      { method: "PUT", path: "device/rain_delay", body: { id: DEVICE_ID, duration: 86_400 } },
      { method: "PUT", path: "device/rain_delay", body: { id: DEVICE_ID, duration: 0 } },
    ]);
  });

  test("refuses out-of-range durations before sending anything", async () => {
    const cloud = fakeRachioCloud();
    const client = new RachioClient(KEY, { fetch: cloud.fetch });
    await expect(client.startZone("zone-1-example", 0)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(client.startZone("zone-1-example", 10_801)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(client.startZone("zone-1-example", 1.5)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(client.rainDelay(DEVICE_ID, 604_801)).rejects.toMatchObject({ code: "invalid_value" });
    expect(cloud.calls).toEqual([]);
  });

  test("maps HTTP failures to codes, never echoing the key", async () => {
    const cases: [number | "down", string][] = [[401, "authentication"], [403, "authentication"], [429, "rate_limited"], [404, "unavailable"], [503, "unreachable"], [400, "protocol"], ["down", "unreachable"]];
    for (const [status, code] of cases) {
      const cloud = fakeRachioCloud();
      if (status === "down") cloud.down = true; else cloud.status = status;
      const error = await new RachioClient(KEY, { fetch: cloud.fetch }).controllers().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RachioError);
      expect((error as RachioError).code).toBe(code as RachioError["code"]);
      expect((error as RachioError).message).not.toContain(KEY);
    }
  });

  test("rejects a malformed account as a protocol error", async () => {
    const cloud = fakeRachioCloud();
    cloud.controller = { id: DEVICE_ID, status: "ONLINE", zones: [] };
    await expect(new RachioClient(KEY, { fetch: cloud.fetch }).controllers()).rejects.toMatchObject({ code: "protocol" });
  });

  test("records the rate-limit headers Rachio sends", async () => {
    const cloud = fakeRachioCloud();
    cloud.headers = { "X-RateLimit-Limit": "1700", "X-RateLimit-Remaining": "1234", "X-RateLimit-Reset": "1790000000" };
    const client = new RachioClient(KEY, { fetch: cloud.fetch });
    await client.personId();
    expect(client.rateLimit).toEqual({ limit: 1700, remaining: 1234, resetAt: 1_790_000_000_000 });
  });

  test("an empty API key is refused", () => {
    expect(() => new RachioClient("  ")).toThrow(RachioError);
  });
});

describe("Rachio parsing", () => {
  test("an empty current schedule means nothing is watering", () => {
    expect(parseCurrentSchedule({})).toBeUndefined();
    expect(parseCurrentSchedule(wateringSchedule(4))).toMatchObject({ zoneId: "zone-4-example", zoneNumber: 4, status: "PROCESSING", type: "MANUAL", zoneDuration: 600 });
    expect(() => parseCurrentSchedule([])).toThrow(RachioError);
  });

  test("the reset header is accepted as seconds, milliseconds, or a date", () => {
    expect(parseRateLimitReset("1790000000")).toBe(1_790_000_000_000);
    expect(parseRateLimitReset("1790000000000")).toBe(1_790_000_000_000);
    expect(parseRateLimitReset("Thu, 01 Oct 2026 00:00:00 GMT")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseRateLimitReset(null)).toBeUndefined();
    expect(parseRateLimitReset("soon")).toBeUndefined();
  });
});
