import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveSite } from "../live-site";
import { FileDeviceConfigWriter } from "../config/device-writer";
import { DeviceNetworkRecovery } from "../network/recovery";
import { createApp } from "./app";

const mac = "02:00:00:00:10:30";
test("settings save persists both addresses and MAC, reloads the device, then reconnects by MAC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-ip-route-"));
  try {
    const path = join(directory, "devices.yml");
    await writeFile(path, 'schemaVersion: 2\ndevices:\n  - {id: blaster, model: broadlink-rm4-pro, config: {host: 10.78.0.30}} # compact entry\n');
    const live = createLiveSite({ path, services: {}, secrets: undefined });
    await live.reload();
    const calls: string[] = [];
    const client = { mac, address: "10.78.0.31", fixedAddress: "10.77.0.30", subnet: "10.78.0.1/24" };
    let kickFails = false;
    const network = new DeviceNetworkRecovery({ logger() {}, adapter: () => ({
      name: "test",
      addresses: {
        async list() { return [client]; },
        async reserve(selectedMac, address) { calls.push(`reserve ${selectedMac} ${address}`); return async () => {}; },
      },
      wifi: {
        async findClientByAddress() { throw new Error("must use saved MAC"); },
        async findClientByMac(selectedMac) { expect(selectedMac).toBe(mac); return client; },
        async kickClient() {
          expect(live.site.macAddressOf("blaster")).toBe(mac);
          expect(live.site.get("blaster")?.config).toEqual({ host: "10.78.0.30" });
          calls.push("kick");
          if (kickFails) throw new Error("AP unavailable");
        },
      },
    }) });
    const writer = new FileDeviceConfigWriter(path, () => live.reload());
    const app = createApp(undefined, live.site, undefined, undefined, undefined, network, undefined, writer);
    const url = "/api/devices/blaster/network/settings";
    const settings = await (await app.request(url)).json();
    expect(settings.mac).toBeNull();
    expect(settings.clients[0].fixedAddress).toBe("10.77.0.30");
    const save = (body: unknown, origin?: string) => app.request(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    expect((await save({ mac, address: "10.78.0.30" }, "https://evil.example")).status).toBe(403);
    expect((await save({ mac, address: "garbage" })).status).toBe(400);
    expect(calls).toEqual([]);
    const response = await save({ mac, address: "10.78.0.30" });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toContain("Reconnect requested");
    expect(calls).toEqual([`reserve ${mac} 10.78.0.30`, "kick"]);
    expect(await readFile(path, "utf8")).toContain(mac);
    expect((await (await app.request(url)).json()).mac).toBe(mac);
    expect((await save({ mac: "aa:bb:cc:dd:ee:ff", address: "10.78.0.30" })).status).toBe(409);
    kickFails = true;
    const saved = await save({ mac, address: "10.78.0.30" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).message).toContain("Power-cycle");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
