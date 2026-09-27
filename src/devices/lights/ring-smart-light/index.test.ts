import { describe, expect, test } from "bun:test";
import { parseDevicesConfig } from "../../../config/devices";
import { RingError } from "../../../protocols/ring/client";
import { fakeRingSource, type FakeRingSource } from "../../../protocols/ring/test-fixtures";
import { Site } from "../../../site";
import { RING_BRIDGE } from "../../hubs/ring-bridge";
import { RingSmartLight, RING_SMART_LIGHT } from "./index";

const dimmable = { zid: "zid-1", name: "Garden Spotlight", deviceType: "switch.multilevel.beams", on: false, level: 0.4 };
const onOff = { zid: "zid-2", name: "Path Light", deviceType: "switch.beams", on: false };
const motion = { zid: "zid-3", name: "Garden Motion", deviceType: "motion-sensor.beams" };

function light(source: FakeRingSource, zid = "zid-1") {
  return new RingSmartLight({ id: "spotlight", name: "Garden Spotlight" }, { bridge: "ring-bridge", zid }, source, "Ring Bridge");
}

/** `Light` publishes `methods` as plain strings, so the device forwards none of them; drive the capability. */
const beam = (source: FakeRingSource, zid = "zid-1") => light(source, zid).light;

describe("Ring Smart Lighting fixture", () => {
  test("reports what the account last said, brightness included", async () => {
    const device = light(fakeRingSource([dimmable]));
    const document = await device.describe();
    expect(document.capabilities.light?.state).toMatchObject({ availability: "online", on: false, brightnessPercent: 40 });
    // Ring's lighting is fixed-white, so it must not advertise a control it has not got.
    expect(document.capabilities.light?.actions?.setColorTemperature).toBeUndefined();
    expect(device.controls()).toEqual(["turnOn", "turnOff", "toggle", "setBrightness", "getState"]);
  });

  test("turns on and off through the Bridge", async () => {
    const source = fakeRingSource([dimmable]);
    const device = light(source);
    await device.light.turnOn();
    await device.light.turnOff();
    expect(source.writes).toEqual([{ zid: "zid-1", values: { on: true } }, { zid: "zid-1", values: { on: false } }]);
  });

  test("toggle reads the real state first rather than tracking its own", async () => {
    const source = fakeRingSource([dimmable]);
    const device = light(source);
    source.push("zid-1", { on: true });
    await device.light.toggle();
    expect(source.writes).toEqual([{ zid: "zid-1", values: { on: false } }]);
  });

  test("sends brightness as Ring's 0..1 fraction, and lights the fixture with it", async () => {
    const source = fakeRingSource([dimmable]);
    await beam(source).setBrightness(75);
    expect(source.writes).toEqual([{ zid: "zid-1", values: { level: 0.75, on: true } }]);
    expect(await beam(source).getState()).toEqual({ on: true, brightnessPercent: 75 });
  });

  test("zero brightness turns a dimmable fixture off rather than leaving it lit at nothing", async () => {
    const source = fakeRingSource([dimmable]);
    await beam(source).setBrightness(0);
    expect(source.writes).toEqual([{ zid: "zid-1", values: { level: 0 } }]);
  });

  test("a non-dimmable fixture maps brightness onto the only two it has", async () => {
    const source = fakeRingSource([onOff]);
    const device = light(source, "zid-2");
    await device.light.setBrightness(60);
    expect(source.writes).toEqual([{ zid: "zid-2", values: { on: true } }]);
    expect(await device.light.getState()).toEqual({ on: true, brightnessPercent: 100 });
  });

  test("rejects a brightness that is not a percentage", async () => {
    await expect(beam(fakeRingSource([dimmable])).setBrightness(140)).rejects.toThrow("percentage from 0 to 100");
  });

  test("a dropped connection reads as offline, not as the last state it saw", async () => {
    const source = fakeRingSource([dimmable]);
    const device = light(source);
    source.drop();
    const document = await device.describe();
    expect(document.capabilities.light?.state).toEqual({ availability: "offline" });
    await expect(device.light.getState()).rejects.toThrow("Ring has no device zid-1");
  });

  test("refuses to drive something that is not a light", async () => {
    const source = fakeRingSource([motion]);
    await expect(beam(source, "zid-3").turnOn()).rejects.toThrow("not a light");
    await expect(beam(source, "zid-3").getState()).rejects.toThrow("not a light");
    expect(source.writes).toEqual([]);
  });

  test("names a zid the account does not have, rather than writing into the void", async () => {
    const source = fakeRingSource([dimmable]);
    await expect(beam(source, "typo").turnOn()).rejects.toThrow("Ring has no device typo");
    expect(source.writes).toEqual([]);
  });

  test("surfaces a write that Ring refused", async () => {
    const source = fakeRingSource([dimmable], { writeError: new RingError("Ring cloud request failed or timed out", "unavailable") });
    await expect(beam(source).turnOn()).rejects.toThrow("failed or timed out");
  });

  test("subscribes to the Bridge's pushes instead of polling", () => {
    const source = fakeRingSource([dimmable]);
    let changes = 0;
    const stop = light(source).watch(() => { changes++; });
    source.push("zid-1", { on: true });
    expect(changes).toBe(1);
    stop();
  });

  test("names the Bridge it is reached through", () => {
    expect(light(fakeRingSource([dimmable])).displayHost()).toBe("Via Ring Bridge");
  });
});

describe("Ring Smart Lighting provisioning", () => {
  const yaml = (light: Record<string, unknown>) => `schemaVersion: 2
devices:
  - id: ring-bridge
    model: ring-bridge
    config: { locationId: loc-1 }
  - id: spotlight
    model: ring-smart-light
    config: ${JSON.stringify(light)}
`;
  const site = (light: Record<string, unknown>) => Site.fromConfig(parseDevicesConfig(yaml(light), "test"), {}, undefined, [RING_BRIDGE, RING_SMART_LIGHT]);

  test("binds the fixture to its Bridge entry", () => {
    const built = site({ bridge: "ring-bridge", zid: "zid-1" });
    expect(built.devices.map(device => device.id)).toEqual(["ring-bridge", "spotlight"]);
    expect(built.devices[1]).toBeInstanceOf(RingSmartLight);
  });

  test("names the missing Bridge rather than failing vaguely", () => {
    expect(() => site({ bridge: "nope", zid: "zid-1" })).toThrow(/nope/);
  });

  test("rejects a fixture with no zid to address", () => {
    expect(() => site({ bridge: "ring-bridge" })).toThrow("zid");
  });
});
