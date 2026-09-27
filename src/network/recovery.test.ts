import { describe, expect, test } from "bun:test";
import type { DnsRecordState, NetworkAdapter, WifiClient } from "./adapter";
import { DeviceNetworkRecovery } from "./recovery";

function fixture(options: { hasClient?: boolean; internet?: NetworkAdapter["internet"]; dns?: NetworkAdapter["dns"] } = {}) {
  const kicked: string[] = [];
  const events: Record<string, unknown>[] = [];
  const client: WifiClient = {
    mac: "02:00:00:79:a4:08",
    address: "169.254.18.41",
    fixedAddress: "10.77.0.153",
  };
  const adapter: NetworkAdapter = {
    name: "fake",
    ...(options.internet ? { internet: options.internet } : {}),
    ...(options.dns ? { dns: options.dns } : {}),
    wifi: {
      async findClientByAddress(address) {
        return options.hasClient === false || address !== client.fixedAddress ? undefined : client;
      },
      async kickClient(found) { kicked.push(found.mac); },
    },
  };
  const recovery = new DeviceNetworkRecovery({
    adapter: () => adapter,
    logger: (event) => events.push(event),
  });
  const target = { id: "keylight", name: "Key Light", address: "10.77.0.153" };
  return { recovery, target, client, kicked, events };
}

describe("DeviceNetworkRecovery", () => {
  test("inspection never kicks an associated client", async () => {
    const { recovery, target, kicked, events } = fixture();
    for (let read = 0; read < 5; read++) expect((await recovery.inspect(target)).associated).toBe(true);
    expect(kicked).toEqual([]);
    expect(events).toEqual([]);
  });

  test("inspects and reconnects by MAC when the current address is wrong", async () => {
    const kicked: string[] = [];
    const lookedUp: string[] = [];
    const client = { mac: "02:00:00:79:a4:08", address: "169.254.18.41" };
    const recovery = new DeviceNetworkRecovery({
      adapter: () => ({
        name: "unifi",
        wifi: {
          async findClientByMac(mac) { lookedUp.push(mac); return mac.toLowerCase() === client.mac ? client : undefined; },
          async findClientByAddress() { throw new Error("address fallback must not run"); },
          async kickClient(found) { kicked.push(found.mac); },
        },
      }),
      logger: () => undefined,
    });
    const target = { id: "keylight", name: "Key Light", address: "10.77.0.153", mac: client.mac };
    expect(await recovery.inspect(target)).toEqual({
      deviceId: "keylight",
      adapter: "unifi",
      configuredAddress: "10.77.0.153",
      configuredMac: client.mac,
      associated: true,
      mac: client.mac,
      currentAddress: "169.254.18.41",
      addressMatches: false,
      isolated: null,
      isolation: {
        scope: "hometruth",
        internetBlock: "unavailable",
        methods: [],
        dns: [],
        detail: "This network adapter cannot inspect HomeTruth internet blocks",
      },
      message: `UniFi found ${client.mac} at 169.254.18.41; HomeTruth expects 10.77.0.153`,
    });
    await recovery.reconnect(target);
    expect(lookedUp).toEqual([client.mac, client.mac]);
    expect(kicked).toEqual([client.mac]);
  });

  test("concurrent reconnect actions share one kick; a later explicit action can retry", async () => {
    const { recovery, target, kicked } = fixture();
    await Promise.all([recovery.reconnect(target), recovery.reconnect(target)]);
    expect(kicked).toHaveLength(1);
    await recovery.reconnect(target);
    expect(kicked).toHaveLength(2);
  });

  test("an unassociated client is reported without kicking or logging until explicitly requested", async () => {
    const { recovery, target, kicked, events } = fixture({ hasClient: false });
    expect((await recovery.inspect(target)).associated).toBe(false);
    expect(kicked).toEqual([]);
    expect(events).toEqual([]);
    await expect(recovery.reconnect(target)).rejects.toThrow(/not associated/u);
  });

  test.each(["on", "off", "missing"] as const)("reports the observed %s rule independently of requested isolation", async (state) => {
    const inspected: unknown[] = [];
    const { recovery, target, client, kicked, events } = fixture({
      internet: {
        async describe(target) { inspected.push(target); return state; },
        async set() { throw new Error("inspection must not change rules"); },
      },
    });
    const status = await recovery.inspect(target, { isolationRequested: state !== "on" });
    expect(status.isolated).toBe(state === "on");
    expect(status.isolation).toEqual({
      scope: "hometruth", requested: state !== "on", internetBlock: state,
      methods: state === "on" ? ["internet-block"] : [], dns: [],
    });
    expect(inspected).toEqual([{ mac: client.mac, label: target.id }]);
    expect(kicked).toEqual([]);
    expect(events).toEqual([]);
  });

  test("reads a persistent block by configured MAC even when the device is offline", async () => {
    const inspected: string[] = [];
    const { recovery, target, client } = fixture({
      hasClient: false,
      internet: {
        async describe(target) { inspected.push(target.mac); return "on"; },
        async set() { throw new Error("inspection must not change rules"); },
      },
    });
    const status = await recovery.inspect({ ...target, mac: client.mac });
    expect(status).toMatchObject({ associated: false, isolated: true, isolation: { internetBlock: "on", methods: ["internet-block"] } });
    expect(inspected).toEqual([client.mac]);
  });

  test("unknown MAC and unsupported block inspection never claim the device is unisolated", async () => {
    const { recovery, target } = fixture({
      hasClient: false,
      internet: {
        async describe() { throw new Error("must not look up an unknown MAC"); },
        async set() { throw new Error("inspection must not change rules"); },
      },
    });
    const unknown = await recovery.inspect(target);
    expect(unknown.isolated).toBeNull();
    expect(unknown.isolation.internetBlock).toBe("unavailable");
    expect(unknown.isolation.detail).toContain("MAC is unknown");
    const unsupported = fixture();
    expect((await unsupported.recovery.inspect(unsupported.target)).isolated).toBeNull();
  });

  test("reports active DNS overrides separately; redirects alone are not an internet block", async () => {
    const inspected: unknown[] = [];
    const states: Record<string, DnsRecordState> = { "active.example": "on", "disabled.example": "off", "missing.example": "missing" };
    const { recovery, target } = fixture({
      internet: { async describe() { return "off"; }, async set() { throw new Error("read only"); } },
      dns: {
        async describe(target) { inspected.push(target); return states[target.domain]!; },
        async set() { throw new Error("read only"); },
      },
    });
    const dnsOverrides = Object.keys(states).map(domain => ({ domain, overrideIp: "192.0.2.10" }));
    const status = await recovery.inspect(target, { isolationRequested: false, dnsOverrides });
    expect(status.isolated).toBe(false);
    expect(status.isolation.methods).toEqual(["dns-override"]);
    expect(status.isolation.dns).toEqual(dnsOverrides.map(record => ({ ...record, state: states[record.domain]! })));
    expect(inspected).toEqual(dnsOverrides);
  });

  test("gateway failures retain association details and mark each failed check unavailable", async () => {
    const { recovery, target } = fixture({
      internet: { async describe() { throw new Error("firewall read failed"); }, async set() { throw new Error("read only"); } },
      dns: {
        async describe(target) { if (target.domain === "failed.example") throw new Error("DNS read failed"); return "on"; },
        async set() { throw new Error("read only"); },
      },
    });
    const status = await recovery.inspect(target, {
      dnsOverrides: ["failed.example", "active.example"].map(domain => ({ domain, overrideIp: "192.0.2.10" })),
    });
    expect(status).toMatchObject({ associated: true, isolated: null, isolation: { internetBlock: "unavailable", methods: ["dns-override"] } });
    expect(status.isolation.detail).toContain("firewall read failed");
    expect(status.isolation.dns).toEqual([
      { domain: "failed.example", overrideIp: "192.0.2.10", state: "unavailable", detail: "Could not inspect the DNS override: DNS read failed" },
      { domain: "active.example", overrideIp: "192.0.2.10", state: "on" },
    ]);
  });

  test("missing DNS capability or override destination is explicit", async () => {
    const unsupported = fixture();
    const status = await unsupported.recovery.inspect(unsupported.target, { dnsOverrides: [{ domain: "vendor.example", overrideIp: "192.0.2.10" }] });
    expect(status.isolation.dns[0]).toMatchObject({ state: "unavailable", detail: "This network adapter cannot inspect DNS overrides" });
    const { recovery, target } = fixture({ dns: {
      async describe() { throw new Error("must not inspect without a destination"); },
      async set() { throw new Error("read only"); },
    } });
    const unknown = await recovery.inspect(target, { dnsOverrides: [{ domain: "vendor.example" }] });
    expect(unknown.isolation.dns[0]).toEqual({ domain: "vendor.example", state: "unavailable", detail: "The HomeTruth DNS override address is unknown" });
  });
});
