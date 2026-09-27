import { expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { Device } from "../models/device";
import type { NetworkAdapter } from "../network/adapter";
import { NetworkIsolation } from "../network/isolation";
import { DeviceNetworkRecovery } from "../network/recovery";
import { Site } from "../site";
import { createApp } from "./app";

class NetworkDevice extends Device<{ host: string }> {
  readonly model = { ...SHELLY_PLUS_1, cloudHostnames: ["vendor.example"] };
  readonly capabilities = {};
  constructor() { super("relay", "Example relay", { host: "192.0.2.20" }); }
  async probe() { return {}; }
}

test("network API reports fresh firewall and model-specific DNS states even when desired isolation is false", async () => {
  const device = new NetworkDevice();
  const client = { mac: "02:00:00:00:00:20", address: device.config.host };
  let blocked = true;
  let redirected = true;
  const adapter: NetworkAdapter = {
    name: "test-router",
    wifi: {
      async findClientByAddress() { return client; },
      async kickClient() { throw new Error("GET must not reconnect"); },
    },
    internet: {
      async describe({ mac }) { expect(mac).toBe(client.mac); return blocked ? "on" : "off"; },
      async set() { throw new Error("GET must not change firewall rules"); },
    },
    dns: {
      async describe({ overrideIp }) { expect(overrideIp).toBe("192.0.2.10"); return redirected ? "on" : "off"; },
      async set() { throw new Error("GET must not change DNS"); },
    },
  };
  // Construct the status reader only: never start listeners or reconcile rules.
  const isolation = new NetworkIsolation({
    devices: [
      { id: device.id, name: device.name, host: device.config.host, cloudHostnames: device.model.cloudHostnames },
      { id: "other", name: "Other device", host: "192.0.2.21", cloudHostnames: ["other.example"] },
    ],
    adapter: () => adapter, overrideIp: () => "192.0.2.10", resolve: async () => [],
  });
  const recovery = new DeviceNetworkRecovery({ adapter: () => adapter });
  const app = createApp(undefined, new Site([device]), undefined, undefined, isolation, recovery);
  const response = await app.request("/api/devices/relay/network");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    deviceId: "relay", associated: true, isolated: true,
    isolation: {
      scope: "hometruth", requested: false, internetBlock: "on", methods: ["internet-block", "dns-override"],
      dns: [{ domain: "vendor.example", overrideIp: "192.0.2.10", state: "on" }],
    },
  });
  blocked = false;
  redirected = false;
  const updated = await app.request("/api/devices/relay/network");
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    isolated: false,
    isolation: { internetBlock: "off", methods: [], dns: [{ domain: "vendor.example", state: "off" }] },
  });
});

test("network API still inspects internet blocking without the isolation service", async () => {
  const device = new NetworkDevice();
  const recovery = new DeviceNetworkRecovery({ adapter: () => ({
    name: "test-router",
    wifi: {
      async findClientByAddress() { return { mac: "02:00:00:00:00:20", address: device.config.host }; },
      async kickClient() { throw new Error("read only"); },
    },
    internet: { async describe() { return "missing"; }, async set() { throw new Error("read only"); } },
  }) });
  const app = createApp(undefined, new Site([device]), undefined, undefined, undefined, recovery);
  const response = await app.request("/api/devices/relay/network");
  expect(response.status).toBe(200);
  const status = await response.json();
  expect(status).toMatchObject({ isolated: false, isolation: { scope: "hometruth", internetBlock: "missing", methods: [], dns: [{ domain: "vendor.example", state: "unavailable" }] } });
  expect(status.isolation).not.toHaveProperty("requested");
});
