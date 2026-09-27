import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDeviceConfigWriter, setDeviceNetworkEntry } from "./device-writer";
import { parseDevicesConfig } from "./devices";

const mac = "02:00:00:00:10:30";
const before = "# Home\nschemaVersion: 2\ndevices:\n  - id: blaster\n    model: broadlink-rm4-pro\n    config:\n      host: 10.78.0.31 # blaster\n  - id: lamp\n    model: elgato-key-light-air\n    config: { host: 10.77.0.2 }\n";

test("network edits preserve unrelated devices, comments, and other config values", () => {
  const result = setDeviceNetworkEntry(before, "blaster", "10.78.0.30", mac);
  expect(result).toContain('host: "10.78.0.30" # blaster');
  const devices = parseDevicesConfig(result).devices!;
  expect(devices[0]?.mac).toBe(mac);
  expect(devices[1]).toEqual(parseDevicesConfig(before).devices![1]);
  const compact = before.replace("    config:\n      host: 10.78.0.31 # blaster", "    config: { host: 10.78.0.31, timeoutMs: 1000 } # blaster");
  expect(parseDevicesConfig(setDeviceNetworkEntry(compact, "blaster", "10.78.0.30", mac)).devices![0]?.config).toEqual({ host: "10.78.0.30", timeoutMs: 1000 });
});

test("failed gateway write leaves the file intact; successful write reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-ip-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, before);
    let reloads = 0;
    const writer = new FileDeviceConfigWriter(path, async () => { reloads++; });
    await expect(writer.setNetwork("blaster", "10.78.0.30", mac, async () => { throw new Error("gateway failed"); })).rejects.toThrow("gateway failed");
    expect(await readFile(path, "utf8")).toBe(before);
    await writer.setNetwork("blaster", "10.78.0.30", mac, async () => async () => {});
    expect(reloads).toBe(1);
    expect(parseDevicesConfig(await readFile(path, "utf8")).devices![0]?.config.host).toBe("10.78.0.30");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rolls back the reservation if atomic file replacement fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-ip-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, before);
    let undos = 0;
    const writer = new FileDeviceConfigWriter(path);
    await expect(writer.setNetwork("blaster", "10.78.0.30", mac, async () => {
      await rm(path); await mkdir(path);
      return async () => { undos++; };
    })).rejects.toThrow();
    expect(undos).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [layout, text] of Object.entries({
  "compact entry": '# Site\nschemaVersion: 2\ndevices:\n  - {id: cooktop, model: bosch-nitp060uc, config: {host: 192.0.2.10}, name: "Kitchen #1"} # keep\n',
  "compact list": '# Site\nschemaVersion: 2\ndevices: [{id: cooktop, model: bosch-nitp060uc, config: {host: 192.0.2.10}}] # keep\n',
  "multiline flow": '# Site\nschemaVersion: 2\ndevices:\n  - {id: cooktop, # keep\n     model: bosch-nitp060uc, config: {host: 192.0.2.10}, mac: "02:00:00:00:10:30"}\n',
  "unindented list": '# Site\nschemaVersion: 2\ndevices:\n- id: cooktop # keep\n  model: bosch-nitp060uc\n  config: {host: 192.0.2.10}\n',
  "CRLF": '# Site\r\nschemaVersion: 2\r\ndevices:\r\n  - id: cooktop # keep\r\n    model: bosch-nitp060uc\r\n    config: {host: 192.0.2.10}\r\n',
})) {
  test(`network settings edit ${layout} without manual YAML expansion`, () => {
    const result = setDeviceNetworkEntry(text, "cooktop", "192.0.2.20", mac);
    expect(parseDevicesConfig(result)).toEqual({ ...parseDevicesConfig(text), devices: [{ ...parseDevicesConfig(text).devices![0]!, mac, config: {host: "192.0.2.20"} }] });
    expect(result).toContain("# Site");
    expect(result).toContain("# keep");
    expect(setDeviceNetworkEntry(result, "cooktop", "192.0.2.20", mac)).toBe(result);
  });
}
