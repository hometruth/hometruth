import { describe, expect, test } from "bun:test";
import { parseDevicesConfig } from "../../../config/devices";
import { DEVICE_ID, fakeRachioCloud, wateringSchedule } from "../../../protocols/rachio/test-fixtures";
import { Site } from "../../../site";
import { createRachioSiteService } from "../../../vendors/rachio/site-service";
import { RACHIO_RAIN_DELAY } from "../rachio-rain-delay";
import { RACHIO_ZONE } from "../rachio-zone";
import { RACHIO_CONTROLLER, RachioControllerDevice } from "./index";

const NOW = 1_800_000_000_000;

function setup() {
  const cloud = fakeRachioCloud();
  const service = createRachioSiteService({ schemaVersion: 1, vendors: { rachio: { apiKey: "synthetic-api-key" } } }, { fetch: cloud.fetch, now: () => NOW })!;
  const device = new RachioControllerDevice({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, service.controller(DEVICE_ID), { now: () => NOW });
  return { cloud, service, device };
}

describe("Rachio controller", () => {
  test("describes status, zones, standby, stop, and sensors from one account read and one schedule read", async () => {
    const { cloud, device } = setup();
    cloud.controller = { ...cloud.controller, rainDelayExpirationDate: NOW + 90 * 60_000, rainSensorTripped: true };
    cloud.schedule = wateringSchedule(5);
    const document = await device.describe();
    expect(document.status).toBe("online");
    const hub = document.capabilities.hub!.state;
    expect(hub.availability).toBe("online");
    expect(hub.accessories).toHaveLength(16);
    expect(hub.accessories![15]).toEqual({ id: "zone-16-example", name: "Example zone 16", model: "Zone 16 (disabled)" });
    expect(document.capabilities.binarySwitch!.state).toMatchObject({ availability: "online", value: "off" });
    expect(document.capabilities.button!.state).toEqual({ availability: "online" });
    expect(document.capabilities.button!.actions.press).toEqual({});
    const sensors = document.capabilities.sensor!.state.sensors;
    expect(sensors.map(sensor => [sensor.id, sensor.value, sensor.detail])).toEqual([
      ["rain-sensor", 1, "Tripped"],
      ["rain-delay", 90, `Until ${new Date(NOW + 90 * 60_000).toISOString()}`],
      ["watering-zone", 5, "Example zone 5"],
    ]);
    expect(cloud.calls.filter(call => call.method === "GET")).toHaveLength(3);
  });

  test("standby is on when Rachio says the controller is off, and is read back rather than assumed", async () => {
    const { cloud, device } = setup();
    expect(await device.capabilities.binarySwitch.getState()).toBe("off");
    await device.invokeControl("turnOn");
    expect(cloud.calls.at(-1)).toMatchObject({ method: "PUT", path: "device/off", body: { id: DEVICE_ID } });
    // Rachio has not applied it yet: the switch says what Rachio says.
    expect(await device.capabilities.binarySwitch.getState()).toBe("off");
    cloud.controller = { ...cloud.controller, on: false };
    await device.invokeControl("turnOff");
    expect(cloud.calls.at(-1)).toMatchObject({ method: "PUT", path: "device/on" });
    expect(await device.capabilities.binarySwitch.getState()).toBe("on");
    await device.invokeControl("toggle");
    expect(cloud.calls.at(-1)).toMatchObject({ method: "PUT", path: "device/on" });
  });

  test("stop watering stops the whole controller", async () => {
    const { cloud, device } = setup();
    await device.invokeControl("press");
    expect(cloud.calls.at(-1)).toMatchObject({ method: "PUT", path: "device/stop_water", body: { id: DEVICE_ID } });
    await expect(device.invokeControl("press", { durationMs: 1000 })).rejects.toMatchObject({ code: "not_supported" });
  });

  test("an unreachable cloud reads as offline and probe rejects", async () => {
    const { cloud, device } = setup();
    cloud.down = true;
    const document = await device.describe();
    expect(document.status).toBe("offline");
    expect(document.capabilities.binarySwitch!.state).toEqual({ availability: "offline" });
    expect(document.capabilities.hub!.state.availability).toBe("offline");
    await expect(device.probe()).rejects.toThrow("could not be reached");
  });

  test("a controller Rachio reports offline is offline, with no watering read", async () => {
    const { cloud, device } = setup();
    cloud.controller = { ...cloud.controller, status: "OFFLINE" };
    const document = await device.describe();
    expect(document.capabilities.hub!.state).toEqual({ availability: "offline", detail: "Rachio reports the controller offline" });
    expect(document.capabilities.button!.state).toEqual({ availability: "offline" });
    expect(cloud.count("GET", `device/${DEVICE_ID}/current_schedule`)).toBe(0);
    await expect(device.probe()).rejects.toThrow("offline");
  });

  test("a refused key is degraded, naming the fix", async () => {
    const { cloud, device } = setup();
    cloud.status = 401;
    const state = (await device.describe()).capabilities.hub!.state;
    expect(state.availability).toBe("degraded");
    expect(state.detail).toContain("vendors.rachio.apiKey");
  });

  test("a site without a key reads as unknown, and commands name the missing secret", async () => {
    const device = RACHIO_CONTROLLER.create({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, {}, {});
    const document = await device.describe();
    expect(document.capabilities.hub!.state).toEqual({ availability: "unknown" });
    expect(document.capabilities.binarySwitch!.state).toEqual({ availability: "unknown" });
    await expect(device.invokeControl("press")).rejects.toThrow("vendors.rachio.apiKey");
  });

  test("probe reports the model and serial from the account", async () => {
    const { device } = setup();
    expect(await device.probe()).toEqual({ model: "GENERATION3_16ZONE", serialNumber: "EXAMPLE-SERIAL" });
    expect((await device.describe()).serialNumber).toBe("EXAMPLE-SERIAL");
  });

  test("health is healthy, unhealthy, unknown, or disabled without sending a command", async () => {
    const { cloud, device } = setup();
    expect((await device.checkHealth()).status).toBe("healthy");
    const offline = setup();
    offline.cloud.controller = { ...offline.cloud.controller, status: "OFFLINE" };
    expect((await offline.device.checkHealth()).status).toBe("unhealthy");
    const dormant = RACHIO_CONTROLLER.create({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, {}, {});
    expect((await dormant.checkHealth()).status).not.toBe("healthy");
    device.enabled = false;
    expect((await device.checkHealth()).status).toBe("disabled");
    expect([...cloud.calls, ...offline.cloud.calls].every(call => call.method === "GET")).toBe(true);
  });
});

describe("Rachio provisioning", () => {
  const yaml = (controller: Record<string, unknown>, zone: Record<string, unknown> = { controller: "sprinklers", zoneNumber: 1 }) => `schemaVersion: 2
devices:
  - id: sprinklers
    name: Sprinklers
    model: rachio-controller
    config: ${JSON.stringify(controller)}
  - id: front-lawn
    name: Front lawn
    model: rachio-zone
    config: ${JSON.stringify(zone)}
  - id: rain-delay
    name: Rain delay
    model: rachio-rain-delay
    config: { controller: sprinklers, defaultHours: 48 }
`;
  const site = (controller: Record<string, unknown>, zone?: Record<string, unknown>) =>
    Site.fromConfig(parseDevicesConfig(yaml(controller, zone), "test"), {}, undefined, [RACHIO_CONTROLLER, RACHIO_ZONE, RACHIO_RAIN_DELAY]);

  test("builds the controller with its zone and rain delay", () => {
    const built = site({ deviceId: DEVICE_ID, pollIntervalMs: 300_000 });
    expect(built.devices.map(device => device.model.id)).toEqual(["rachio-controller", "rachio-zone", "rachio-rain-delay"]);
    expect(built.devices[1]!.parent).toEqual({ id: "sprinklers", index: 0 });
  });

  test("rejects unknown keys, a too-fast poll, and a missing device id", () => {
    expect(() => site({ deviceId: DEVICE_ID, apiKey: "nope" })).toThrow();
    expect(() => site({ deviceId: DEVICE_ID, pollIntervalMs: 5_000 })).toThrow();
    expect(() => site({})).toThrow("deviceId");
  });

  test("rejects a zone beyond 16, a zone duration beyond 180 minutes, and a missing controller", () => {
    expect(() => site({ deviceId: DEVICE_ID }, { controller: "sprinklers", zoneNumber: 17 })).toThrow();
    expect(() => site({ deviceId: DEVICE_ID }, { controller: "sprinklers", zoneNumber: 1, defaultMinutes: 181 })).toThrow();
    expect(() => site({ deviceId: DEVICE_ID }, { controller: "nope", zoneNumber: 1 })).toThrow(/nope/);
  });
});
