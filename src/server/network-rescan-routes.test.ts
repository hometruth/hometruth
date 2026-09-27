import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveSite } from "../live-site";
import { FileDeviceConfigWriter } from "../config/device-writer";
import { DeviceNetworkRecovery } from "../network/recovery";
import { createApp } from "./app";

const mac = "02:00:00:00:10:30";
const yaml = [
  "schemaVersion: 2",
  "devices:",
  "  - id: blaster",
  `    mac: ${mac}`,
  "    model: broadlink-rm4-pro",
  "    config: { host: 10.78.0.30, timeoutMs: 100 }",
  "  - id: blaster-two",
  "    mac: aa:bb:cc:dd:ee:ff",
  "    model: broadlink-rm4-pro",
  "    config: { host: 10.78.0.31, timeoutMs: 100 }",
  "  - id: blaster-three",
  "    model: broadlink-rm4-pro",
  "    config: { host: 10.78.0.32, timeoutMs: 100 }",
  "",
].join("\n");

test("rescan follows a saved MAC to a new subnet, rewrites only that host, and never reserves an address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-rescan-route-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, yaml);
    const live = createLiveSite({ path, services: {}, secrets: undefined });
    await live.reload();
    const reservations: string[] = [];
    const network = new DeviceNetworkRecovery({ logger() {}, adapter: () => ({
      name: "test",
      addresses: {
        async list() {
          return [
            { mac, address: "10.77.0.77", lastAddress: "10.78.0.30", network: "Default" },
            { mac: "00:11:22:33:44:55", address: "10.78.0.32", network: "example-iot" },
          ];
        },
        async reserve(selectedMac, address) { reservations.push(`${selectedMac} ${address}`); return async () => {}; },
      },
    }) });
    const writer = new FileDeviceConfigWriter(path, () => live.reload());
    const app = createApp(undefined, live.site, undefined, undefined, undefined, network, undefined, writer);
    const response = await app.request("/api/network/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    const body = await response.json() as { message: string; results: { deviceId: string; outcome: string; currentAddress?: string; mac?: string }[] };
    expect(body.message).toBe("Rescanned 3 devices: 1 moved, 0 identified, 1 missing, 1 without a usable MAC");
    expect(body.results.map((result) => [result.deviceId, result.outcome])).toEqual([
      ["blaster", "moved"],
      ["blaster-two", "missing"],
      ["blaster-three", "unidentified"],
    ]);
    expect(body.results[0]).toMatchObject({ currentAddress: "10.77.0.77", mac });
    expect(reservations).toEqual([]);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("10.78.0.31");
    expect(saved).toContain("10.78.0.32");
    expect(live.site.get("blaster")?.config).toEqual({ host: "10.77.0.77", timeoutMs: 100 });
    expect(live.site.macAddressOf("blaster")).toBe(mac);
    expect((await app.request("/api/network/rescan", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    const one = await app.request("/api/devices/blaster-two/network/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ message: expect.stringContaining("not on the network"), result: { deviceId: "blaster-two", outcome: "missing" } });
    expect((await app.request("/api/devices/nope/network/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a device that does not answer is a 502 on its detail route, not a server error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-rescan-route-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, "schemaVersion: 2\ndevices:\n  - id: speaker\n    name: Hall speaker\n    model: sonos\n    config: { host: 192.168.250.1 }\n");
    const live = createLiveSite({ path, services: {}, secrets: undefined });
    await live.reload();
    const device = live.site.get("speaker")!;
    // A host on a subnet nobody answers on: the read hangs past the route's own deadline.
    Object.defineProperty(device, "describe", { value: () => new Promise(() => {}) });
    const app = createApp(undefined, live.site);
    const response = await app.request("/api/devices/speaker");
    expect(response.status).toBe(502);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unreachable");
    expect(body.error.message).toContain("Hall speaker did not answer at 192.168.250.1");
    expect(body.error.message).toContain("Find on network");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("rescan is refused without a managed network or a writable configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-rescan-route-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, yaml);
    const live = createLiveSite({ path, services: {}, secrets: undefined });
    await live.reload();
    const app = createApp(undefined, live.site);
    const response = await app.request("/api/network/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(409);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
