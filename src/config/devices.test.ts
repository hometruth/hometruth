import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devicesConfigSchema } from "../schemas";
import { validators } from "../validation";
import { DEFAULT_DEVICES_CONFIG_PATH, DevicesConfigError, hostsForModel, loadDevicesConfig, parseDevicesConfig } from "./devices";

const siteYaml = `# this home's devices
schemaVersion: 2
devices:
  - id: shelly-relay
    name: Shelly Plus 1 relay
    mac: AA:BB:CC:DD:EE:FF
    model: shelly-plus-1
    config:
      host: 10.77.0.228
  - id: shed-relay
    model: shelly-plus-1
    config:
      host: shelly-shed.local
      channel: 1
      timeoutMs: 2000
  - id: kitchen
    model: tkenpro-2k-pet-camera-treat-dispenser
    config:
      host: 10.78.0.147
`;

async function writeTempYaml(contents: string): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "hometruth-devices-"));
  const path = join(directory, DEFAULT_DEVICES_CONFIG_PATH);
  await writeFile(path, contents, "utf8");
  return path;
}

describe("devices configuration", () => {
  test("validates the shipped example and the schema's own examples", async () => {
    const example = await Bun.file("devices.example.yml").text();
    const config = parseDevicesConfig(example, "devices.example.yml");
    expect(config.devices?.map((entry) => entry.model)).toEqual([
      "airgradient-one",
      "tkenpro-2k-pet-camera-treat-dispenser",
      "shelly-plus-1",
      "elgato-key-light-air",
      "broadlink-rm4-pro",
      "wyze-cam-v3",
      "hue-entertainment-light",
      "sonos",
      "samsung-frame",
      "aqara-hub-m2",
      "aqara-presence-sensor-fp2",
      "aqara-door-window-sensor",
      "ring-bridge",
      "ring-smart-light",
    ]);
    for (const documented of devicesConfigSchema.examples) {
      expect(validators.devicesConfig(documented)).toBe(true);
    }
  });

  test("parses YAML into model + config entries", () => {
    const config = parseDevicesConfig(siteYaml);
    expect(config.devices).toEqual([
      { id: "shelly-relay", name: "Shelly Plus 1 relay", mac: "AA:BB:CC:DD:EE:FF", model: "shelly-plus-1", config: { host: "10.77.0.228" } },
      { id: "shed-relay", model: "shelly-plus-1", config: { host: "shelly-shed.local", channel: 1, timeoutMs: 2000 } },
      { id: "kitchen", model: "tkenpro-2k-pet-camera-treat-dispenser", config: { host: "10.78.0.147" } },
    ]);
    expect(hostsForModel(config, "shelly-plus-1")).toEqual(["10.77.0.228", "shelly-shed.local"]);
    expect(hostsForModel(config, "broadlink-rm4-pro")).toEqual([]);
  });

  test("treats an empty file as an error and a version-only file as a site with no devices", () => {
    expect(() => parseDevicesConfig("")).toThrow(DevicesConfigError);
    expect(parseDevicesConfig("schemaVersion: 2\n").devices).toBeUndefined();
  });

  test("rejects malformed YAML, the old format, unknown keys, and duplicate ids", () => {
    const failure = (text: string) => {
      try {
        parseDevicesConfig(text);
      } catch (error) {
        return error instanceof DevicesConfigError ? error.code : "unexpected";
      }
      return "accepted";
    };
    expect(failure("schemaVersion: 2\ndevices: [")).toBe("invalid_yaml");
    expect(failure("schemaVersion: 1\nswitches:\n  - id: a\n    driver: shelly-gen2\n    host: 10.77.0.5\n")).toBe("invalid_config");
    expect(failure("schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    host: 10.77.0.5\n")).toBe("invalid_config");
    expect(failure("schemaVersion: 2\ndevices:\n  - id: a\n    mac: not-a-mac\n    model: shelly-plus-1\n    config: { host: 10.77.0.5 }\n")).toBe("invalid_config");
    expect(failure("schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    config: { host: 10.77.0.5 }\n  - id: a\n    model: shelly-plus-1\n    config: { host: 10.77.0.6 }\n")).toBe("invalid_config");
  });

  test("accepts an enabled flag and rejects a non-boolean value", () => {
    const config = parseDevicesConfig(`schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    config: { host: 10.77.0.5 }\n    enabled: false\n`);
    expect(config.devices?.[0]?.enabled).toBe(false);
    expect(() => parseDevicesConfig(`schemaVersion: 2\ndevices:\n  - id: a\n    model: shelly-plus-1\n    config: { host: 10.77.0.5 }\n    enabled: "no"\n`)).toThrow(DevicesConfigError);
  });

  test("loads a YAML file and reports a missing file clearly", async () => {
    const path = await writeTempYaml(siteYaml);
    expect((await loadDevicesConfig(path)).schemaVersion).toBe(2);
    await expect(loadDevicesConfig(join(path, "..", "absent.yml"))).rejects.toMatchObject({ code: "missing" });
  });
});
