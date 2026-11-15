import { describe, expect, test } from "bun:test";
import { DEVICE_ID, fakeRachioCloud, wateringSchedule } from "../../../protocols/rachio/test-fixtures";
import { createRachioSiteService } from "../../../vendors/rachio/site-service";
import { RACHIO_CONTROLLER, RachioControllerDevice } from "../rachio-controller";
import { RACHIO_ZONE_CONTROLS, RachioZoneDevice, zoneMinutes } from "./index";

const SCHEDULE = `device/${DEVICE_ID}/current_schedule`;

function setup(zoneNumber = 3, defaultMinutes?: number) {
  const cloud = fakeRachioCloud();
  let clock = 1_800_000_000_000;
  const service = createRachioSiteService({ schemaVersion: 1, vendors: { rachio: { apiKey: "synthetic-api-key" } } }, { fetch: cloud.fetch, now: () => clock })!;
  const controller = new RachioControllerDevice({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, service.controller(DEVICE_ID));
  const zone = new RachioZoneDevice({ id: `zone-${zoneNumber}`, name: "Example zone" }, { controller: "sprinklers", zoneNumber, ...(defaultMinutes ? { defaultMinutes } : {}) }, controller);
  return { cloud, zone, advance: (ms: number) => { clock += ms; } };
}

const puts = (cloud: ReturnType<typeof fakeRachioCloud>) => cloud.calls.filter(call => call.method === "PUT").map(({ path, body }) => ({ path, body }));

describe("Rachio zone", () => {
  test("is on only while Rachio's current schedule names this zone", async () => {
    const { cloud, zone, advance } = setup(3);
    expect(await zone.getState()).toBe("off");
    cloud.schedule = wateringSchedule(4);
    advance(180_000);
    expect(await zone.getState()).toBe("off");
    cloud.schedule = wateringSchedule(3);
    advance(180_000);
    expect(await zone.getState()).toBe("on");
    const document = await zone.describe();
    expect(document.capabilities.binarySwitch!.state).toMatchObject({ availability: "online", value: "on" });
    expect(document.parent).toEqual({ id: "sprinklers", index: 2 });
  });

  test("turnOn waters for the default, a number of minutes, or { minutes }, and the state is observed, not assumed", async () => {
    const { cloud, zone } = setup(3, 15);
    await zone.invokeControl("turnOn");
    await zone.invokeControl("turnOn", 1);
    await zone.invokeControl("turnOn", { minutes: 180 });
    expect(puts(cloud)).toEqual([
      { path: "zone/start", body: { id: "zone-3-example", duration: 900 } },
      { path: "zone/start", body: { id: "zone-3-example", duration: 60 } },
      { path: "zone/start", body: { id: "zone-3-example", duration: 10_800 } },
    ]);
    // Rachio has not started it yet, so the switch is still off.
    expect(await zone.getState()).toBe("off");
    cloud.schedule = wateringSchedule(3);
    expect(await zone.getState()).toBe("off");
  });

  test("after a command the valve is confirmed on the 15 s settle read", async () => {
    const { cloud, zone, advance } = setup(3);
    await zone.invokeControl("turnOn");
    expect(await zone.getState()).toBe("off");
    cloud.schedule = wateringSchedule(3);
    advance(15_000);
    expect(await zone.getState()).toBe("on");
  });

  test("refuses watering times outside 1..180 minutes before anything is sent", async () => {
    const { cloud, zone } = setup();
    for (const value of [0, 181, 2.5, "10", { minutes: 0 }, { seconds: 60 }, [10]]) {
      await expect(zone.invokeControl("turnOn", value)).rejects.toMatchObject({ code: "invalid_value" });
    }
    expect(puts(cloud)).toEqual([]);
    expect(zoneMinutes(undefined, 12)).toBe(12);
  });

  test("a zone disabled in the Rachio app is not started", async () => {
    const { cloud, zone } = setup(16);
    await expect(zone.invokeControl("turnOn")).rejects.toMatchObject({ code: "not_supported" });
    expect(puts(cloud)).toEqual([]);
  });

  test("respects a shorter per-zone maximum from the account", async () => {
    const { cloud, zone } = setup(3);
    const zones = (cloud.controller.zones as Record<string, unknown>[]).map(entry => entry.zoneNumber === 3 ? { ...entry, maxRuntime: 1800 } : entry);
    cloud.controller = { ...cloud.controller, zones };
    await expect(zone.invokeControl("turnOn", 31)).rejects.toThrow("30 minutes");
  });

  test("turnOff stops watering only when this zone is the one running, on a fresh read", async () => {
    const { cloud, zone } = setup(3);
    await zone.getState();
    cloud.schedule = wateringSchedule(4);
    await zone.invokeControl("turnOff");
    expect(puts(cloud)).toEqual([]);
    cloud.schedule = wateringSchedule(3);
    await zone.invokeControl("turnOff");
    expect(puts(cloud)).toEqual([{ path: "device/stop_water", body: { id: DEVICE_ID } }]);
    expect(cloud.count("GET", SCHEDULE)).toBe(3);
  });

  test("toggle stops a running zone and starts an idle one", async () => {
    const { cloud, zone } = setup(3);
    await zone.invokeControl("toggle");
    expect(puts(cloud).at(-1)).toEqual({ path: "zone/start", body: { id: "zone-3-example", duration: 600 } });
    cloud.schedule = wateringSchedule(3);
    await zone.invokeControl("toggle");
    expect(puts(cloud).at(-1)).toEqual({ path: "device/stop_water", body: { id: DEVICE_ID } });
  });

  test("an unreachable cloud, an offline controller, or a missing zone reads offline; probe rejects", async () => {
    const down = setup();
    down.cloud.down = true;
    expect((await down.zone.describe()).capabilities.binarySwitch!.state).toEqual({ availability: "offline" });
    await expect(down.zone.probe()).rejects.toThrow();

    const offline = setup();
    offline.cloud.controller = { ...offline.cloud.controller, status: "OFFLINE" };
    expect((await offline.zone.describe()).status).toBe("offline");

    const missing = setup(12);
    missing.cloud.controller = { ...missing.cloud.controller, zones: (missing.cloud.controller.zones as unknown[]).slice(0, 8) };
    expect((await missing.zone.describe()).capabilities.binarySwitch!.state).toEqual({ availability: "offline" });
    await expect(missing.zone.invokeControl("turnOn")).rejects.toThrow("no zone 12");
  });

  test("a malformed account is a protocol error, reported offline", async () => {
    const { cloud, zone } = setup();
    cloud.controller = { id: DEVICE_ID, status: "ONLINE", zones: [] };
    await expect(zone.getState()).rejects.toMatchObject({ code: "protocol" });
    expect((await zone.describe()).status).toBe("offline");
  });

  test("a site with no key is unknown, not offline", async () => {
    const controller = RACHIO_CONTROLLER.create({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, {}, {}) as RachioControllerDevice;
    const zone = new RachioZoneDevice({ id: "zone-1", name: "Zone" }, { controller: "sprinklers", zoneNumber: 1 }, controller);
    expect((await zone.describe()).capabilities.binarySwitch!.state).toEqual({ availability: "unknown" });
  });

  test("health checks read only", async () => {
    const { cloud, zone } = setup();
    expect((await zone.checkHealth()).status).toBe("healthy");
    zone.enabled = false;
    expect((await zone.checkHealth()).status).toBe("disabled");
    await expect(zone.invokeControl("turnOn")).rejects.toMatchObject({ code: "device_disabled" });
    expect(puts(cloud)).toEqual([]);
  });

  test("every watering control is marked physical", () => {
    expect(RACHIO_ZONE_CONTROLS.turnOn).toMatchObject({ physical: true, argument: { minimum: 1, maximum: 180, default: 10 } });
    expect(RACHIO_ZONE_CONTROLS.turnOff.physical).toBe(true);
    expect(RACHIO_ZONE_CONTROLS.getState.physical).toBe(false);
  });
});
