import { describe, expect, test } from "bun:test";
import { DEVICE_ID, fakeRachioCloud } from "../../../protocols/rachio/test-fixtures";
import { createRachioSiteService } from "../../../vendors/rachio/site-service";
import { RachioControllerDevice } from "../rachio-controller";
import { RachioRainDelayDevice } from "./index";

const NOW = 1_800_000_000_000;

function setup(defaultHours?: number) {
  const cloud = fakeRachioCloud();
  const service = createRachioSiteService({ schemaVersion: 1, vendors: { rachio: { apiKey: "synthetic-api-key" } } }, { fetch: cloud.fetch, now: () => NOW })!;
  const controller = new RachioControllerDevice({ id: "sprinklers", name: "Sprinklers" }, { deviceId: DEVICE_ID }, service.controller(DEVICE_ID));
  const delay = new RachioRainDelayDevice({ id: "rain-delay", name: "Rain delay" }, { controller: "sprinklers", ...(defaultHours ? { defaultHours } : {}) }, controller, { now: () => NOW });
  return { cloud, delay };
}

const puts = (cloud: ReturnType<typeof fakeRachioCloud>) => cloud.calls.filter(call => call.method === "PUT").map(({ path, body }) => ({ path, body }));

describe("Rachio rain delay", () => {
  test("is on while the delay expires in the future", async () => {
    const { cloud, delay } = setup();
    expect(await delay.getState()).toBe("off");
    const later = setup();
    later.cloud.controller = { ...later.cloud.controller, rainDelayExpirationDate: NOW + 3_600_000 };
    expect(await later.delay.getState()).toBe("on");
    const past = setup();
    past.cloud.controller = { ...past.cloud.controller, rainDelayExpirationDate: NOW - 1 };
    expect(await past.delay.getState()).toBe("off");
    expect(cloud.count("PUT", "device/rain_delay")).toBe(0);
  });

  test("turnOn delays for the default or given hours; turnOff cancels", async () => {
    const { cloud, delay } = setup(48);
    await delay.invokeControl("turnOn");
    await delay.invokeControl("turnOn", 1);
    await delay.invokeControl("turnOn", { hours: 168 });
    await delay.invokeControl("turnOff");
    expect(puts(cloud)).toEqual([
      { path: "device/rain_delay", body: { id: DEVICE_ID, duration: 172_800 } },
      { path: "device/rain_delay", body: { id: DEVICE_ID, duration: 3600 } },
      { path: "device/rain_delay", body: { id: DEVICE_ID, duration: 604_800 } },
      { path: "device/rain_delay", body: { id: DEVICE_ID, duration: 0 } },
    ]);
  });

  test("toggle reads first", async () => {
    const { cloud, delay } = setup();
    await delay.invokeControl("toggle");
    expect(puts(cloud).at(-1)).toEqual({ path: "device/rain_delay", body: { id: DEVICE_ID, duration: 86_400 } });
    cloud.controller = { ...cloud.controller, rainDelayExpirationDate: NOW + 1000 };
    await delay.invokeControl("toggle");
    expect(puts(cloud).at(-1)).toEqual({ path: "device/rain_delay", body: { id: DEVICE_ID, duration: 0 } });
  });

  test("refuses hours outside 1..168 before sending", async () => {
    const { cloud, delay } = setup();
    for (const value of [0, 169, 1.5, { hours: 200 }, { days: 1 }]) {
      await expect(delay.invokeControl("turnOn", value)).rejects.toMatchObject({ code: "invalid_value" });
    }
    expect(puts(cloud)).toEqual([]);
  });

  test("an unreachable cloud reads offline and probe rejects", async () => {
    const { cloud, delay } = setup();
    cloud.down = true;
    expect((await delay.describe()).capabilities.binarySwitch!.state).toEqual({ availability: "offline" });
    await expect(delay.probe()).rejects.toThrow();
  });
});
