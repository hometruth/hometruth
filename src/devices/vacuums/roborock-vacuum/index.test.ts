import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { Device } from "../../../models/device";
import { FakeRoborock, fakeStatus } from "../../../protocols/roborock/fake-device";
import {
  ROBOROCK_VACUUM,
  ROBOROCK_VACUUM_ACTION,
  ROBOROCK_VACUUM_ACTION_CONFIG_SCHEMA,
  ROBOROCK_VACUUM_ACTIONS,
  ROBOROCK_VACUUM_CONFIG_SCHEMA,
  ROBOROCK_VACUUM_SECRETS_SCHEMA,
  RoborockVacuum,
  RoborockVacuumActionDevice,
  parseStatus,
} from "./index";

const LOCAL_KEY = "AbCdEfGh12345678";
const CONFIG = { host: "10.77.0.40", duid: "SyntheticDuid0001", timeoutMs: 500 };

function validator(schema: object) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function vacuum(robot: FakeRoborock, id = "vacuum"): RoborockVacuum {
  return new RoborockVacuum({ id, name: "Vacuum" }, CONFIG, { localKey: LOCAL_KEY }, { connect: robot.connect });
}

function actionDevice(target: RoborockVacuum, action: string): RoborockVacuumActionDevice {
  return ROBOROCK_VACUUM_ACTION.create(
    { id: `${target.id}-${action}`, name: action },
    { vacuum: target.id, action: action as "start" },
    {},
    {},
    { device: (id: string): Device => { if (id !== target.id) throw new Error(`no ${id}`); return target; } },
  ) as RoborockVacuumActionDevice;
}

const robotWith = (methods: ConstructorParameters<typeof FakeRoborock>[0]["methods"] = {}) =>
  new FakeRoborock({ localKey: LOCAL_KEY, methods: { get_status: { result: fakeStatus() }, ...methods } });

describe("parseStatus", () => {
  test("maps codes to text and units", () => {
    expect(parseStatus(fakeStatus())).toEqual({
      state: 8, stateText: "Charging", cleaning: false, batteryPercent: 100,
      errorCode: 0, errorText: "None", cleanAreaSquareMetres: 31.3, cleanTimeSeconds: 1830,
      fanPower: 102, fanPowerText: "Balanced",
    });
    expect(parseStatus(fakeStatus({ state: 18, error_code: 5, fan_power: 108 }))).toMatchObject({ stateText: "Room cleaning", cleaning: true, errorText: "Main brush jammed", fanPowerText: "Max+" });
    expect(parseStatus({ state: 250, battery: 40 })).toMatchObject({ stateText: "State 250", errorCode: 0 });
    expect(parseStatus(fakeStatus({ error_code: 199 }))).toMatchObject({ errorText: "Error 199" });
  });

  test("rejects a reply with no state or battery", () => {
    expect(() => parseStatus(["ok"])).toThrow("status object");
    expect(() => parseStatus([{ battery: 50 }])).toThrow("state");
    expect(() => parseStatus([{ state: 8, battery: 101 }])).toThrow("battery");
  });
});

describe("RoborockVacuum", () => {
  test("describes state, error, area, time, fan power and battery from one get_status", async () => {
    const robot = robotWith();
    const device = vacuum(robot);
    const object = await device.describe();
    expect(object.status).toBe("online");
    const sensor = object.capabilities.sensor!;
    expect(sensor.state.availability).toBe("online");
    expect(sensor.state.detail).toBe("Charging");
    const byId = Object.fromEntries(sensor.state.sensors.map((reading) => [reading.id, reading]));
    expect(byId.state).toMatchObject({ value: 8, detail: "Charging", availability: "online" });
    expect(byId.error).toMatchObject({ value: 0, detail: "None" });
    expect(byId.cleaning).toMatchObject({ value: 0 });
    expect(byId.cleanArea).toMatchObject({ value: 31.3, unit: "m²" });
    expect(byId.cleanTime).toMatchObject({ value: 1830, unit: "s" });
    expect(byId.fanPower).toMatchObject({ value: 102, detail: "Balanced" });
    expect(object.sensors?.[0]).toMatchObject({ id: "battery", kind: "battery", state: { availability: "online", value: 100 } });
    expect(robot.requests.filter((request) => request.method === "get_status")).toHaveLength(1);
    await device.close();
  });

  test("an error state names the error in the summary", async () => {
    const device = vacuum(robotWith({ get_status: { result: fakeStatus({ state: 12, error_code: 8 }) } }));
    expect((await device.describe()).capabilities.sensor!.state.detail).toBe("Error: Robot trapped");
    await device.close();
  });

  test("missing optional fields degrade rather than invent values", async () => {
    const device = vacuum(robotWith({ get_status: { result: [{ state: 3, battery: 55 }] } }));
    const state = (await device.describe()).capabilities.sensor!.state;
    expect(state.availability).toBe("degraded");
    expect(state.sensors.find((reading) => reading.id === "cleanArea")).toEqual({ id: "cleanArea", name: "Cleaned area", quantity: "area", unit: "m²", availability: "unknown" });
    await device.close();
  });

  test("an unreachable robot is offline in describe() and rejects probe()", async () => {
    const device = vacuum(new FakeRoborock({ localKey: LOCAL_KEY, refuse: true }));
    const object = await device.describe();
    expect(object.status).toBe("offline");
    expect(object.capabilities.sensor!.state).toMatchObject({ availability: "offline", detail: "The vacuum is unreachable on the LAN" });
    expect(object.capabilities.sensor!.state.sensors.every((reading) => reading.availability === "offline" && !("value" in reading))).toBe(true);
    expect(object.sensors?.[0]?.state).toMatchObject({ availability: "offline" });
    await expect(device.probe()).rejects.toMatchObject({ code: "unreachable" });
    expect(await device.locate()).toBeUndefined();
  });

  test("a wrong local key is reported as such", async () => {
    const robot = new FakeRoborock({ localKey: LOCAL_KEY, replyKey: "ZyXwVuTs98765432", methods: { get_status: { result: fakeStatus() } } });
    const device = vacuum(robot);
    expect((await device.describe()).capabilities.sensor!.state.detail).toBe("The vacuum's replies do not decrypt; check its local key");
  });

  test("probe() proves a well-formed get_status", async () => {
    const good = vacuum(robotWith());
    expect(await good.probe()).toEqual({ model: "Robot vacuum" });
    expect(await good.locate()).toEqual({ host: CONFIG.host });
    await good.close();
    const wrong = vacuum(robotWith({ get_status: { result: ["ok"] } }));
    await expect(wrong.probe()).rejects.toMatchObject({ code: "protocol" });
    await wrong.close();
  });

  test("health: healthy, unhealthy when unreachable, disabled when disabled; never sends an action", async () => {
    const robot = robotWith();
    const healthy = vacuum(robot);
    expect((await healthy.checkHealth()).status).toBe("healthy");
    expect(robot.requests.every((request) => request.method === undefined || request.method === "get_status")).toBe(true);
    await healthy.close();
    const down = vacuum(new FakeRoborock({ localKey: LOCAL_KEY, refuse: true }));
    expect(await down.checkHealth()).toMatchObject({ status: "unhealthy", reason: "unreachable" });
    const off = vacuum(robotWith());
    off.enabled = false;
    expect((await off.checkHealth()).status).toBe("disabled");
  });

  test("getState is the only control and it reads", async () => {
    const robot = robotWith();
    const device = vacuum(robot);
    expect(device.controls()).toEqual(["getState"]);
    expect(await device.invokeControl("getState")).toMatchObject({ availability: "online" });
    await device.close();
  });
});

describe("RoborockVacuumActionDevice", () => {
  test("every action reaches the robot with its method and is marked physical", async () => {
    const methods = Object.fromEntries(ROBOROCK_VACUUM_ACTIONS.map((action) => [action.method, { result: ["ok"] }]));
    const robot = robotWith(methods);
    const target = vacuum(robot);
    for (const action of ROBOROCK_VACUUM_ACTIONS) {
      expect(action.physical).toBe(true);
      const button = actionDevice(target, action.id);
      expect(button.parent).toEqual({ id: "vacuum", index: ROBOROCK_VACUUM_ACTIONS.indexOf(action) });
      expect(button.controls()).toEqual(["press"]);
      await button.invokeControl("press");
    }
    expect(robot.requests.flatMap((request) => request.method ?? [])).toEqual(["app_start", "app_pause", "app_stop", "app_charge", "find_me"]);
    await target.close();
  });

  test("a refused or unacknowledged action fails the press", async () => {
    const robot = robotWith({ app_start: { error: { code: -10007, message: "invalid status" } }, app_pause: { result: ["busy"] } });
    const target = vacuum(robot);
    await expect(actionDevice(target, "start").press()).rejects.toMatchObject({ code: "rejected" });
    await expect(actionDevice(target, "pause").press()).rejects.toMatchObject({ code: "protocol" });
    await target.close();
  });

  test("availability and health follow the robot; probe never presses", async () => {
    const robot = robotWith({ app_start: { result: ["ok"] } });
    const target = vacuum(robot);
    const start = actionDevice(target, "start");
    expect(start.availability()).toBe("unknown");
    await target.describe();
    expect(start.availability()).toBe("online");
    expect((await start.describe()).capabilities.button!.state.availability).toBe("online");
    expect(await start.probe()).toEqual({ model: "Robot vacuum: Start cleaning" });
    expect(robot.requests.some((request) => request.method === "app_start")).toBe(false);
    target.enabled = false;
    await expect(start.press()).rejects.toThrow("disabled");
    await target.close();
  });

  test("refuses a target that is not a Roborock vacuum", () => {
    const other = { id: "lamp" } as unknown as Device;
    expect(() => ROBOROCK_VACUUM_ACTION.create({ id: "x", name: "x" }, { vacuum: "lamp", action: "start" }, {}, {}, { device: () => other })).toThrow("roborock-vacuum");
    expect(() => ROBOROCK_VACUUM_ACTION.create({ id: "x", name: "x" }, { vacuum: "lamp", action: "start" }, {}, {})).toThrow("part of a site");
  });
});

describe("schemas", () => {
  test("config accepts the example and rejects a public host, an unknown key, and a missing duid", () => {
    const validate = validator(ROBOROCK_VACUUM_CONFIG_SCHEMA);
    expect(validate({ host: "192.168.50.70", duid: "SyntheticDuid0001" })).toBe(true);
    expect(validate({ host: "vacuum.local", duid: "SyntheticDuid0001", port: 58867, timeoutMs: 4000 })).toBe(true);
    expect(validate({ host: "192.168.50.70", duid: "SyntheticDuid0001", localKey: LOCAL_KEY })).toBe(false);
    expect(validate({ host: "192.168.50.70" })).toBe(false);
    expect(() => new RoborockVacuum({ id: "v", name: "v" }, { host: "8.8.8.8", duid: "SyntheticDuid0001" }, { localKey: LOCAL_KEY })).toThrow("private LAN");
  });

  test("secrets require the local key", () => {
    const validate = validator(ROBOROCK_VACUUM_SECRETS_SCHEMA);
    expect(validate({ localKey: LOCAL_KEY })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ localKey: LOCAL_KEY, token: "x" })).toBe(false);
    expect(() => ROBOROCK_VACUUM.create({ id: "v", name: "v" }, CONFIG, {}, {})).toThrow("devices.v.localKey");
  });

  test("action config names a vacuum and a known action", () => {
    const validate = validator(ROBOROCK_VACUUM_ACTION_CONFIG_SCHEMA);
    expect(validate({ vacuum: "vacuum", action: "dock" })).toBe(true);
    expect(validate({ vacuum: "vacuum", action: "selfDestruct" })).toBe(false);
    expect(validate({ vacuum: "vacuum" })).toBe(false);
  });
});
