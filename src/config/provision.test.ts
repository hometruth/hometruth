import { describe, expect, test } from "bun:test";
import { BroadlinkRm4Pro } from "../devices/blasters/broadlink-rm4-pro";
import { ElgatoKeyLightAir } from "../devices/lights/elgato-key-light-air";
import { ShellyGen2Switch, ShellyPlus1 } from "../devices/switches/shelly-plus-1";
import { TkenproPet3T } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { MODELS } from "../registry";
import { parseDevicesConfig, DevicesConfigError } from "./devices";
import { provision } from "./provision";

const config = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: kitchen
    name: Kitchen pet camera
    model: tkenpro-2k-pet-camera-treat-dispenser
    config: { host: 10.78.0.147, serialNumber: "100000001" }
  - id: relay
    model: shelly-plus-1
    config: { host: 10.77.0.228, channel: 1, timeoutMs: 2000 }
  - id: desk
    model: elgato-key-light-air
    config: { host: 10.77.0.153, port: 9123 }
  - id: blaster
    model: broadlink-rm4-pro
    config: { host: 10.78.0.30 }
`);

describe("provision", () => {
  test("builds one device per entry from its model, in file order, with the model's capabilities", () => {
    const devices = provision(config, MODELS, {});
    expect(devices.map((device) => [device.id, device.name, device.model.id, Object.keys(device.capabilities)])).toEqual([
      ["kitchen", "Kitchen pet camera", "tkenpro-2k-pet-camera-treat-dispenser", ["camera", "treatDispenser", "motionSensor"]],
      ["relay", "relay", "shelly-plus-1", ["binarySwitch"]],
      ["desk", "desk", "elgato-key-light-air", ["light"]],
      ["blaster", "blaster", "broadlink-rm4-pro", ["infraredBlaster", "radioFrequencyBlaster"]],
    ]);
    expect(devices[0]).toBeInstanceOf(TkenproPet3T);
    expect(devices[1]).toBeInstanceOf(ShellyPlus1);
    expect((devices[1] as ShellyPlus1).switch).toBeInstanceOf(ShellyGen2Switch);
    expect((devices[1] as ShellyPlus1).switch).toMatchObject({ id: "relay", host: "10.77.0.228", channel: 1 });
    expect(devices[2]).toBeInstanceOf(ElgatoKeyLightAir);
    expect(devices[3]).toBeInstanceOf(BroadlinkRm4Pro);
    expect(devices[0]?.config).toEqual({ host: "10.78.0.147", serialNumber: "100000001" });
  });

  test("names the entry when its model is unknown or its config does not fit the model", () => {
    const unknown = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - id: a\n    model: tasmota\n    config: { host: 10.77.0.5 }\n");
    expect(() => provision(unknown, MODELS, {})).toThrow(`Device "a" uses unknown model "tasmota"; known models: ${MODELS.map((model) => model.id).join(", ")}`);
    const wrongKey = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    config: { host: 10.77.0.5, password: x }\n");
    expect(() => provision(wrongKey, MODELS, {})).toThrow(/Device "a" has invalid Shelly Plus 1 config/u);
    const noHost = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    config: {}\n");
    let caught: unknown;
    try { provision(noHost, MODELS, {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DevicesConfigError);
    expect((caught as DevicesConfigError).code).toBe("invalid_config");
  });

  test("validates each device's secrets against its model and hands them to the product", () => {
    const secrets = { schemaVersion: 1 as const, devices: { kitchen: { onvif: { username: "admin", password: "pw" } } } };
    const [camera] = provision(config, MODELS, {}, secrets);
    expect(camera).toBeInstanceOf(TkenproPet3T);
    const bad = { schemaVersion: 1 as const, devices: { kitchen: { onvif: { username: "admin" } } } };
    expect(() => provision(config, MODELS, {}, bad)).toThrow(/Device "kitchen" has invalid TKENPRO 2K Pet Camera Treat Dispenser secrets \(devices\.kitchen in the secrets file\)/u);
    const stray = { schemaVersion: 1 as const, devices: { kitchen: { wifi: { password: "x" } } } };
    expect(() => provision(config, MODELS, {}, stray)).toThrow(/must NOT have additional properties/u);
    // A product without a secrets schema ignores whatever is stored under its id.
    const relayOnly = { schemaVersion: 1 as const, devices: { relay: { anything: "x" } } };
    expect(provision(config, MODELS, {}, relayOnly)).toHaveLength(4);
  });

  test("refuses a configured host outside the local network", () => {
    const cloud = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - id: cloud\n    model: shelly-plus-1\n    config: { host: example.com }\n");
    expect(() => provision(cloud, MODELS, {})).toThrow(/private LAN/u);
    const blaster = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - id: cloud\n    model: broadlink-rm4-pro\n    config: { host: example.com }\n");
    expect(() => provision(blaster, MODELS, {})).toThrow(/private LAN/u);
  });

  test("keeps a disabled entry fully provisioned, flagged disabled, and refusing controls", async () => {
    const withDisabled = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: kitchen
    model: tkenpro-2k-pet-camera-treat-dispenser
    config: { host: 10.78.0.147, serialNumber: "100000001" }
  - id: relay
    model: shelly-plus-1
    config: { host: 10.77.0.228 }
    enabled: false
  - id: relay-button
    model: action-button
    config: { device: relay, control: turnOn }
`);
    const devices = provision(withDisabled, MODELS, {});
    expect(devices.map((device) => [device.id, device.enabled])).toEqual([
      ["kitchen", true],
      ["relay", false],
      ["relay-button", true],
    ]);
    const relay = devices.find((device) => device.id === "relay")!;
    await expect(relay.invoke("binarySwitch", "turnOn")).rejects.toMatchObject({ code: "device_disabled" });
  });

  test("a camera provisioned without the camera service describes itself as offline", async () => {
    const [camera] = provision(config, MODELS, {});
    const object = await camera!.describe();
    expect(object.status).toBe("offline");
    expect(object.serialNumber).toBe("100000001");
    expect(Object.keys(object.capabilities)).toEqual(["camera", "treatDispenser", "motionSensor"]);
  });
});
