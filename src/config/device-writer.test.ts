import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDeviceEntry, DeviceConfigWriteError, FileDeviceConfigWriter, renameDeviceEntry, setDeviceEnabledEntry, setDeviceRoomEntry } from "./device-writer";
import { parseDevicesConfig } from "./devices";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const entry = {
  id: "candles",
  name: "Candles",
  model: "optimistic-switch",
  config: { onButton: "candles-on", offButton: "candles-off", initialState: "off" as const },
};

describe("appendDeviceEntry", () => {
  test("preserves comments and appends an optimistic switch to a block device list", () => {
    const before = `# My home\nschemaVersion: 2\ndevices:\n  # RF actions\n  - id: candles-on\n    model: action-button\n    config: { device: remote, savedCodeId: on }\n`;
    const after = appendDeviceEntry(before, entry);
    expect(after).toContain("# My home");
    expect(after).toContain("# RF actions");
    expect(after).toContain('  - id: "candles"');
    expect(parseDevicesConfig(after).devices?.at(-1)).toEqual(entry);
  });

  test("creates or expands the devices sequence without accepting duplicate ids", () => {
    expect(parseDevicesConfig(appendDeviceEntry("schemaVersion: 2\n", entry)).devices).toEqual([entry]);
    expect(parseDevicesConfig(appendDeviceEntry("schemaVersion: 2\ndevices: []\n", entry)).devices).toEqual([entry]);
    expect(() => appendDeviceEntry(appendDeviceEntry("schemaVersion: 2\n", entry), entry)).toThrow(DeviceConfigWriteError);
  });

  test("refuses compact non-empty sequences instead of rewriting human-authored YAML", () => {
    expect(() => appendDeviceEntry("schemaVersion: 2\ndevices: [{id: one, model: x, config: {}}]\n", entry))
      .toThrow("cannot safely edit a compact devices sequence");
  });

  test("appends a hub-linked Aqara contact sensor and rejects an incomplete one", () => {
    const contact = { id: "hub-old-contact", name: "Old contact", model: "aqara-door-window-sensor", config: { hub: "hub", serialNumber: "old-sensor" } };
    const after = appendDeviceEntry("schemaVersion: 2\n", contact);
    expect(parseDevicesConfig(after).devices).toEqual([contact]);
    expect(() => appendDeviceEntry("schemaVersion: 2\n", { id: "x", model: "aqara-door-window-sensor", config: { hub: "hub" } }))
      .toThrow(DeviceConfigWriteError);
  });
});

describe("renameDeviceEntry", () => {
  test("changes only the selected name and preserves surrounding comments", () => {
    const before = `# My home\nschemaVersion: 2\ndevices:\n  - id: gate\n    name: Gate relay # shown in the UI\n    model: shelly-plus-1\n    config: { host: 10.77.0.2 }\n  - id: lamp\n    model: elgato-key-light-air\n    config: { host: 10.77.0.3 }\n`;
    const renamed = renameDeviceEntry(before, "gate", "Driveway Gate");
    expect(renamed).toContain('    name: "Driveway Gate" # shown in the UI');
    expect(renamed).toContain("# My home");
    expect(parseDevicesConfig(renamed).devices?.[1]?.name).toBeUndefined();
    const named = renameDeviceEntry(renamed, "lamp", "Desk Light");
    expect(named).toContain('  - id: lamp\n    name: "Desk Light"\n');
  });

  test("rejects unknown devices and compact entries rather than rewriting YAML", () => {
    expect(() => renameDeviceEntry("schemaVersion: 2\ndevices: []\n", "nope", "Nope")).toThrow("No device");
    expect(() => renameDeviceEntry("schemaVersion: 2\ndevices:\n  - { id: gate, model: x, config: {} }\n", "gate", "Gate"))
      .toThrow("Expand this device");
  });
});

describe("FileDeviceConfigWriter", () => {
  test("commits atomically, preserves the file mode, and reloads after the write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-switch-writer-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, "schemaVersion: 2\ndevices: []\n", { mode: 0o640 });
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads += 1; });
    await writer.add(entry);
    expect(parseDevicesConfig(await readFile(path, "utf8")).devices).toEqual([entry]);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(reloads).toBe(1);
  });

  test("adds saved Broadlink Buttons and their optimistic Switch in one commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-switch-writer-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, "schemaVersion: 2\n", "utf8");
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads += 1; });
    await writer.addAll([
      { id: "candles-on", name: "Candles on", model: "action-button", config: { device: "blaster", savedCodeId: "code-on" } },
      { id: "candles-off", name: "Candles off", model: "action-button", config: { device: "blaster", savedCodeId: "code-off" } },
      entry,
    ]);
    expect(parseDevicesConfig(await readFile(path, "utf8")).devices).toEqual([
      { id: "candles-on", name: "Candles on", model: "action-button", config: { device: "blaster", savedCodeId: "code-on" } },
      { id: "candles-off", name: "Candles off", model: "action-button", config: { device: "blaster", savedCodeId: "code-off" } },
      entry,
    ]);
    expect(reloads).toBe(1);
  });

  test("adds and updates a Workflow Button without rewriting its inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-workflow-writer-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, "# keep this\nschemaVersion: 2\ndevices:\n  - id: relay\n    model: shelly-plus-1\n    config: { host: 10.77.0.2 }\n", "utf8");
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads += 1; });
    const initial = { start: "on", nodes: [
      { id: "on", type: "action" as const, device: "relay", control: "turnOn", next: "off" },
      { id: "off", type: "end" as const },
    ] };
    await writer.add({ id: "scene", name: "Scene", model: "workflow-button", config: { workflow: initial } });
    const updated = { start: "wait", nodes: [
      { id: "wait", type: "delay" as const, durationMs: 300_000, next: "on" },
      { id: "on", type: "action" as const, device: "relay", control: "turnOn", next: "off" },
      { id: "off", type: "end" as const },
    ] };
    await writer.setWorkflow("scene", updated);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# keep this");
    expect(parseDevicesConfig(text).devices).toEqual([
      { id: "relay", model: "shelly-plus-1", config: { host: "10.77.0.2" } },
      { id: "scene", name: "Scene", model: "workflow-button", config: { workflow: updated } },
    ]);
    expect(reloads).toBe(2);
  });

  test("renames through the same atomic writer and reloads once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-name-writer-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, "schemaVersion: 2\ndevices:\n  - id: gate\n    model: shelly-plus-1\n    config: { host: 10.77.0.2 }\n", "utf8");
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads += 1; });
    await writer.rename("gate", "Driveway Gate");
    expect(parseDevicesConfig(await readFile(path, "utf8")).devices?.[0]?.name).toBe("Driveway Gate");
    expect(reloads).toBe(1);
  });
});

describe("device rooms", () => {
  const inventory = 'schemaVersion: 2\ndevices:\n  - id: candles\n    name: Candles # keep this\n    model: optimistic-switch\n    config: { onButton: on, offButton: off }\n';

  test("adds, changes, clears and remembers rooms while preserving device configuration", () => {
    let text = setDeviceRoomEntry(inventory, "candles", "Living Room");
    expect(parseDevicesConfig(text).devices?.[0]?.room).toBe("Living Room");
    text = setDeviceRoomEntry(text, "candles", 'Guest "Suite"');
    text = setDeviceRoomEntry(text, "candles", null);
    const config = parseDevicesConfig(text);
    expect(config.rooms).toEqual(["Living Room", 'Guest "Suite"']);
    expect(config.devices).toEqual(parseDevicesConfig(inventory).devices);
    expect(text).toContain("name: Candles # keep this");
  });

  test("preserves block room lists and comments, and rejects invalid room names", () => {
    const text = setDeviceRoomEntry('rooms:\n  - Kitchen # keep room note\n' + inventory, "candles", "Office");
    expect(parseDevicesConfig(text).rooms).toEqual(["Kitchen", "Office"]);
    expect(text).toContain("Kitchen # keep room note");
    for (const name of ["", "  ", " Kitchen", "Kitchen\nOffice", "x".repeat(101)]) {
      expect(() => setDeviceRoomEntry(inventory, "candles", name)).toThrow();
    }
  });

  test("serializes room and name edits and persists both across a file reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-rooms-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, inventory, { mode: 0o640 });
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads++; });
    await Promise.all([writer.setRoom("candles", "Living Room"), writer.rename("candles", "Fireplace Candles")]);
    const config = parseDevicesConfig(await readFile(path, "utf8"));
    expect(config.devices?.[0]).toMatchObject({ name: "Fireplace Candles", room: "Living Room" });
    expect(config.rooms).toEqual(["Living Room"]);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(reloads).toBe(2);
  });
});

describe("device enabled flag", () => {
  const inventory = 'schemaVersion: 2\ndevices:\n  - id: candles\n    name: Candles # keep this\n    model: optimistic-switch\n    config: { onButton: on, offButton: off }\n';

  test("disables a device, keeping it in the inventory, and re-enabling clears the field", () => {
    let text = setDeviceEnabledEntry(inventory, "candles", false);
    expect(parseDevicesConfig(text).devices?.[0]?.enabled).toBe(false);
    expect(text).toContain("name: Candles # keep this");
    text = setDeviceEnabledEntry(text, "candles", true);
    expect(parseDevicesConfig(text).devices).toEqual(parseDevicesConfig(inventory).devices);
  });

  test("persists across a file reload through the writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-enabled-"));
    directories.push(directory);
    const path = join(directory, "devices.yml");
    await writeFile(path, inventory, "utf8");
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads += 1; });
    await writer.setEnabled("candles", false);
    expect(parseDevicesConfig(await readFile(path, "utf8")).devices?.[0]?.enabled).toBe(false);
    expect(reloads).toBe(1);
  });
});
