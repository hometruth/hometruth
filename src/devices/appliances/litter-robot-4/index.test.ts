import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { provisionSite } from "../../../config/provision";
import { WhiskerError, parseLr4Robot, type Lr4Robot } from "../../../protocols/whisker/client";
import type { Lr4Command } from "../../../protocols/whisker/constants";
import { SERIAL, robotRecord } from "../../../protocols/whisker/test-fixtures";
import { WhiskerAccount, type WhiskerRobotSource } from "../../../vendors/whisker/site-service";
import {
  LITTER_ROBOT_4, LITTER_ROBOT_4_BUTTON, LITTER_ROBOT_4_BUTTON_CONFIG_SCHEMA, LITTER_ROBOT_4_CONFIG_SCHEMA, LITTER_ROBOT_4_SWITCH,
  LITTER_ROBOT_4_SWITCH_CONFIG_SCHEMA, LitterRobot4, LitterRobot4ButtonDevice, LitterRobot4SwitchDevice, dormantWhiskerSource,
} from ".";

class FakeSource implements WhiskerRobotSource {
  record: Record<string, unknown> = robotRecord();
  failure: Error | undefined;
  readonly commands: string[] = [];
  readonly listeners: (() => void)[] = [];
  async robot(serial: string): Promise<Lr4Robot> {
    if (this.failure) throw this.failure;
    const robot = parseLr4Robot(this.record);
    if (!robot || robot.serial !== serial) throw new WhiskerError(`no robot ${serial}`, "not_found");
    return robot;
  }
  async command(serial: string, command: Lr4Command): Promise<void> { this.commands.push(`${serial}:${command}`); }
  subscribe(listener: () => void): () => void { this.listeners.push(listener); return () => {}; }
}

const instance = { id: "litter-box", name: "Litter box" };
const robotFor = (source: WhiskerRobotSource) => new LitterRobot4(instance, { serial: SERIAL }, source);
const switchFor = (robot: LitterRobot4, control: "nightLight" | "panelLockout") =>
  new LitterRobot4SwitchDevice({ id: `litter-box-${control}`, name: control }, { robot: robot.id, control }, robot);
const buttonFor = (robot: LitterRobot4, action: "cleanCycle" | "reset") =>
  new LitterRobot4ButtonDevice({ id: `litter-box-${action}`, name: action }, { robot: robot.id, action }, robot);

describe("config schemas", () => {
  const ajv = new Ajv2020({ strict: false });
  test("accept the example entries and reject unknown keys and bad values", () => {
    const robot = ajv.compile(LITTER_ROBOT_4_CONFIG_SCHEMA);
    expect(robot({ serial: SERIAL })).toBe(true);
    expect(robot({ serial: SERIAL, password: "x" })).toBe(false);
    expect(robot({ serial: "LR4 C0001; drop" })).toBe(false);
    expect(robot({})).toBe(false);
    const toggle = ajv.compile(LITTER_ROBOT_4_SWITCH_CONFIG_SCHEMA);
    expect(toggle({ robot: "litter-box", control: "nightLight" })).toBe(true);
    expect(toggle({ robot: "litter-box", control: "globeLight" })).toBe(false);
    const button = ajv.compile(LITTER_ROBOT_4_BUTTON_CONFIG_SCHEMA);
    expect(button({ robot: "litter-box", action: "cleanCycle" })).toBe(true);
    expect(button({ robot: "litter-box", action: "empty" })).toBe(false);
  });

  test("no model accepts credentials: the account lives under vendors.whisker", () => {
    for (const model of [LITTER_ROBOT_4, LITTER_ROBOT_4_SWITCH, LITTER_ROBOT_4_BUTTON]) expect(model.secretsSchema).toBeUndefined();
  });
});

describe("litter-robot-4 readings", () => {
  test("an online robot reports every reading", async () => {
    const source = new FakeSource();
    const document = await robotFor(source).describe();
    expect(document.status).toBe("online");
    expect(document.serialNumber).toBe(SERIAL);
    const state = (document.capabilities.sensor as { state: { availability: string; sensors: { id: string; value?: number; detail?: string; unit: string; availability: string }[] } }).state;
    const byId = Object.fromEntries(state.sensors.map(sensor => [sensor.id, sensor]));
    expect(state.availability).toBe("online");
    expect(byId.status).toMatchObject({ availability: "online", detail: "Ready" });
    expect(byId["waste-drawer"]).toMatchObject({ value: 40, unit: "%" });
    expect(byId["litter-level"]).toMatchObject({ value: 65, unit: "%", detail: "OPTIMAL" });
    expect(byId["cat-weight"]).toMatchObject({ value: 9.4, unit: "lb" });
    expect(byId["clean-cycle-wait"]).toMatchObject({ value: 7, unit: "min" });
    expect(byId.sleeping).toMatchObject({ value: 0 });
    expect(byId["hopper-connected"]).toMatchObject({ value: 1 });
    expect(byId["night-light-lit"]).toMatchObject({ value: 1 });
    expect(byId["power-source"]).toMatchObject({ detail: "AC" });
    expect(byId.online).toMatchObject({ value: 1, detail: "Last seen 2026-01-01T12:00:00.000Z" });
    expect(source.commands).toEqual([]);
  });

  test("a robot Whisker calls offline is offline, with no stale levels", async () => {
    const source = new FakeSource();
    source.record = robotRecord({ isOnline: false });
    const document = await robotFor(source).describe();
    expect(document.status).toBe("offline");
    const sensors = (document.capabilities.sensor as { state: { sensors: { id: string; value?: number; availability: string }[] } }).state.sensors;
    expect(sensors.find(sensor => sensor.id === "waste-drawer")).toEqual(expect.not.objectContaining({ value: expect.anything() }));
    expect(sensors.find(sensor => sensor.id === "online")).toMatchObject({ availability: "online", value: 0 });
  });

  test("a failed read is offline and probe rejects", async () => {
    const source = new FakeSource();
    source.failure = new WhiskerError("Whisker's Litter-Robot service is unreachable: timeout", "unreachable");
    const robot = robotFor(source);
    const document = await robot.describe();
    expect(document.status).toBe("offline");
    expect((document.capabilities.sensor as { state: { detail?: string } }).state.detail).toContain("unreachable");
    await expect(robot.probe()).rejects.toThrow("unreachable");
  });

  test("missing core readings are degraded", async () => {
    const source = new FakeSource();
    source.record = robotRecord({ DFILevelPercent: null });
    expect((await robotFor(source).describe()).status).toBe("degraded");
  });

  test("a site without a Whisker account is unknown, not offline", async () => {
    const robot = robotFor(dormantWhiskerSource());
    const document = await robot.describe();
    expect((document.capabilities.sensor as { state: { availability: string; detail?: string } }).state).toMatchObject({ availability: "unknown" });
  });

  test("probe proves the serial is on the account", async () => {
    const source = new FakeSource();
    expect(await robotFor(source).probe()).toEqual({ model: "Litter-Robot 4", serialNumber: SERIAL, firmwareVersion: "1.1.50" });
    source.record = robotRecord({ serial: "LR4C000002" });
    await expect(robotFor(source).probe()).rejects.toMatchObject({ code: "not_found" });
  });

  test("health distinguishes healthy, unhealthy and disabled, and never sends a command", async () => {
    const source = new FakeSource();
    const robot = robotFor(source);
    expect((await robot.checkHealth()).status).toBe("healthy");
    source.record = robotRecord({ isOnline: false });
    expect((await robot.checkHealth()).status).toBe("unhealthy");
    robot.enabled = false;
    expect((await robot.checkHealth()).status).toBe("disabled");
    const button = buttonFor(robotFor(source), "cleanCycle");
    source.record = robotRecord();
    expect((await button.checkHealth()).status).toBe("healthy");
    expect(source.commands).toEqual([]);
  });

  test("watch subscribes to the shared account", () => {
    const source = new FakeSource();
    let changes = 0;
    robotFor(source).watch(() => changes++);
    source.listeners.forEach(listener => listener());
    expect(changes).toBe(1);
  });
});

describe("litter-robot-4-switch", () => {
  test("the night light reads Whisker's mode; automatic counts as on", async () => {
    const source = new FakeSource();
    const light = switchFor(robotFor(source), "nightLight");
    expect(await light.getState()).toBe("on");
    source.record = robotRecord({ nightLightMode: "ON" });
    expect(await light.getState()).toBe("on");
    source.record = robotRecord({ nightLightMode: "OFF" });
    expect(await light.getState()).toBe("off");
    expect(light.parent).toEqual({ id: "litter-box", index: 0 });
  });

  test("every control reaches the robot with the right command", async () => {
    const source = new FakeSource();
    const robot = robotFor(source);
    const light = switchFor(robot, "nightLight");
    const lockout = switchFor(robot, "panelLockout");
    await light.invokeControl("turnOn");
    await light.invokeControl("turnOff");
    await light.invokeControl("toggle");
    await lockout.invokeControl("turnOn");
    await lockout.invokeControl("turnOff");
    await lockout.invokeControl("toggle");
    expect(source.commands).toEqual([
      `${SERIAL}:nightLightModeOn`, `${SERIAL}:nightLightModeOff`, `${SERIAL}:nightLightModeOff`,
      `${SERIAL}:keyPadLockOutOn`, `${SERIAL}:keyPadLockOutOff`, `${SERIAL}:keyPadLockOutOn`,
    ]);
    expect(await lockout.getState()).toBe("off");
  });

  test("state comes from the cloud: a write does not change what is read", async () => {
    const source = new FakeSource();
    const lockout = switchFor(robotFor(source), "panelLockout");
    await lockout.turnOn();
    expect(await lockout.getState()).toBe("off");
  });

  test("a malformed field is a protocol error and describes offline", async () => {
    const source = new FakeSource();
    source.record = robotRecord({ nightLightMode: "DISCO" });
    const light = switchFor(robotFor(source), "nightLight");
    await expect(light.getState()).rejects.toMatchObject({ code: "protocol" });
    expect((await light.describe()).status).toBe("offline");
  });

  test("an offline robot refuses writes before sending anything", async () => {
    const source = new FakeSource();
    source.record = robotRecord({ isOnline: false });
    const light = switchFor(robotFor(source), "nightLight");
    await expect(light.turnOn()).rejects.toMatchObject({ code: "unreachable" });
    expect(source.commands).toEqual([]);
  });

  test("without an account the switch is unknown and writes name the fix", async () => {
    const light = switchFor(robotFor(dormantWhiskerSource()), "nightLight");
    expect((await light.describe()).status).toBe("unknown");
    await expect(light.turnOn()).rejects.toThrow("vendors.whisker.username");
  });
});

describe("litter-robot-4-button", () => {
  test("clean cycle and reset send their commands and are declared physical", async () => {
    const source = new FakeSource();
    const robot = robotFor(source);
    const clean = buttonFor(robot, "cleanCycle");
    const reset = buttonFor(robot, "reset");
    await clean.invokeControl("press");
    await reset.invokeControl("press");
    expect(source.commands).toEqual([`${SERIAL}:cleanCycle`, `${SERIAL}:shortResetPress`]);
    expect(clean.button.physical).toBe(true);
    expect(LITTER_ROBOT_4_BUTTON.title).toContain("moves the globe");
    expect(clean.parent).toEqual({ id: "litter-box", index: 2 });
  });

  test("an offline robot is not sent a cycle it would run later", async () => {
    const source = new FakeSource();
    source.record = robotRecord({ isOnline: false });
    const clean = buttonFor(robotFor(source), "cleanCycle");
    await expect(clean.press()).rejects.toThrow("nothing was sent");
    expect(source.commands).toEqual([]);
    expect((await clean.describe()).status).toBe("offline");
  });

  test("a press takes no duration", async () => {
    const clean = buttonFor(robotFor(new FakeSource()), "cleanCycle");
    await expect(clean.invokeControl("press", 500)).rejects.toMatchObject({ code: "not_supported" });
  });
});

describe("provisioning", () => {
  test("one account serves the robot and its children through SiteServices", async () => {
    let fetches = 0;
    const whisker = new WhiskerAccount({ username: "u", password: "p" }, {
      client: { robots: async () => { fetches++; return [parseLr4Robot(robotRecord())!]; }, command: async () => {} },
    });
    const { devices } = provisionSite({ schemaVersion: 2, devices: [
      { id: "litter-box", name: "Litter box", model: "litter-robot-4", config: { serial: SERIAL } },
      { id: "litter-box-night-light", name: "Night light", model: "litter-robot-4-switch", config: { robot: "litter-box", control: "nightLight" } },
      { id: "litter-box-clean", name: "Clean", model: "litter-robot-4-button", config: { robot: "litter-box", action: "cleanCycle" } },
    ] }, [LITTER_ROBOT_4, LITTER_ROBOT_4_SWITCH, LITTER_ROBOT_4_BUTTON], { whisker });
    await Promise.all(devices.map(device => device.describe()));
    expect(devices.map(device => device.parent?.id)).toEqual([undefined, "litter-box", "litter-box"]);
    expect(fetches).toBe(1);
  });

  test("a child must reference a litter-robot-4", () => {
    expect(() => provisionSite({ schemaVersion: 2, devices: [
      { id: "lonely", name: "Lonely", model: "litter-robot-4-switch", config: { robot: "nothing-here", control: "nightLight" } },
    ] }, [LITTER_ROBOT_4, LITTER_ROBOT_4_SWITCH], {})).toThrow();
  });
});
