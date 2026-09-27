import { describe, expect, test } from "bun:test";
import { CameraNetworkMode } from "./network-mode";
import type { DnsAction, DnsRecordState, DnsTarget, NetworkAdapter, WifiClient } from "../../network";

const DOMAIN = "usce.mearicloud.com";
const OVERRIDE_IP = "10.78.0.231";
const target = (): DnsTarget => ({ domain: DOMAIN, overrideIp: OVERRIDE_IP });

interface FakeAdapter extends NetworkAdapter {
  record: DnsRecordState;
  kicked: string[];
}

/** A network adapter whose DNS record is a variable, optionally able to kick one known camera. */
function fakeAdapter(record: DnsRecordState, options: { wifi?: boolean } = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    name: "fake",
    record,
    kicked: [],
    dns: {
      async describe() { return adapter.record; },
      async set(_target: DnsTarget, action: DnsAction) {
        adapter.record = action;
        return `${action === "on" ? "enabled" : "disabled"} shared override`;
      },
    },
    ...(options.wifi ? {
      wifi: {
        async findClientByAddress(address: string): Promise<WifiClient | undefined> {
          return address === "10.78.0.64" ? { mac: "02:00:00:ce:20:d5", address, name: "pet-cam-white" } : undefined;
        },
        async kickClient(client: WifiClient) { adapter.kicked.push(client.mac); },
      },
    } : {}),
  };
  return adapter;
}

describe("CameraNetworkMode", () => {
  test("reports local mode when the resolver answers with HomeTruth and the record is on", async () => {
    const mode = new CameraNetworkMode({
      adapter: () => fakeAdapter("on"),
      target,
      resolve: async () => [OVERRIDE_IP],
      now: () => 1_700_000_000_000,
    });
    const status = await mode.refresh();
    expect(status.mode).toBe("local");
    expect(status.dnsOverride).toBe("on");
    expect(status.resolvedTo).toBe(OVERRIDE_IP);
    expect(status.canToggle).toBe(true);
    expect(status.detail).toBeUndefined();
    expect(status.checkedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  test("reports cloud mode from the live resolver even while the record is still on, and explains the mismatch", async () => {
    const mode = new CameraNetworkMode({ adapter: () => fakeAdapter("on"), target, resolve: async () => ["52.1.2.3"] });
    const status = await mode.refresh();
    expect(status.mode).toBe("cloud");
    expect(status.dnsOverride).toBe("on");
    expect(status.detail).toContain("still resolves to 52.1.2.3");
  });

  test("falls back to the record when DNS cannot be resolved", async () => {
    const mode = new CameraNetworkMode({
      adapter: () => fakeAdapter("off"),
      target,
      resolve: async () => { throw new Error("ENOTFOUND"); },
    });
    const status = await mode.refresh();
    expect(status.mode).toBe("cloud");
    expect(status.dnsOverride).toBe("off");
    expect(status.resolvedTo).toBeUndefined();
    expect(status.detail).toContain("could not be resolved: ENOTFOUND");
  });

  test("cannot toggle without an adapter but still reports the resolver answer", async () => {
    const mode = new CameraNetworkMode({
      adapter: () => { throw new Error("Missing required environment variable UNIFI_API_KEY"); },
      target,
      resolve: async () => [OVERRIDE_IP],
    });
    const status = await mode.refresh();
    expect(status.mode).toBe("local");
    expect(status.dnsOverride).toBe("unavailable");
    expect(status.canToggle).toBe(false);
    expect(status.detail).toContain("UNIFI_API_KEY");
  });

  test("reports an unknown server address without throwing", async () => {
    const mode = new CameraNetworkMode({
      adapter: () => fakeAdapter("on"),
      target: () => { throw new Error("The HomeTruth LAN address is unknown"); },
      resolve: async () => [OVERRIDE_IP],
    });
    const status = await mode.refresh();
    expect(status.mode).toBe("unknown");
    expect(status.canToggle).toBe(false);
    expect(status.detail).toContain("LAN address is unknown");
  });

  test("set() switches the record and re-checks", async () => {
    const adapter = fakeAdapter("on");
    let answer = OVERRIDE_IP;
    const mode = new CameraNetworkMode({ adapter: () => adapter, target, resolve: async () => [answer] });
    expect((await mode.refresh()).mode).toBe("local");
    answer = "52.1.2.3";
    const result = await mode.set("off");
    expect(result.message).toContain("disabled shared override");
    expect(result.status.dnsOverride).toBe("off");
    expect(result.status.mode).toBe("cloud");
    expect(adapter.record).toBe("off");
  });

  test("kick() drops the named cameras through the adapter's Wi-Fi control", async () => {
    const adapter = fakeAdapter("on", { wifi: true });
    const mode = new CameraNetworkMode({ adapter: () => adapter, target, resolve: async () => [OVERRIDE_IP] });
    expect(mode.canKick()).toBe(true);
    const results = await mode.kick(["10.78.0.64", "10.78.0.147"]);
    expect(adapter.kicked).toEqual(["02:00:00:ce:20:d5"]);
    expect(results.map((result) => [result.address, result.kicked])).toEqual([["10.78.0.64", true], ["10.78.0.147", false]]);
  });

  test("kick() fails clearly when the adapter cannot manage Wi-Fi clients", async () => {
    const mode = new CameraNetworkMode({ adapter: () => fakeAdapter("on"), target, resolve: async () => [OVERRIDE_IP] });
    expect(mode.canKick()).toBe(false);
    await expect(mode.kick(["10.78.0.64"])).rejects.toThrow("cannot kick Wi-Fi clients");
  });

  test("snapshot() serves the cached status and refreshes in the background once stale", async () => {
    let calls = 0;
    let clock = 0;
    const mode = new CameraNetworkMode({
      adapter: () => fakeAdapter("on"),
      target,
      resolve: async () => { calls += 1; return [OVERRIDE_IP]; },
      cacheMs: 1_000,
      now: () => clock,
    });
    expect(mode.snapshot()).toBeUndefined(); // first call triggers a refresh
    await mode.refresh();
    expect(calls).toBe(1);
    clock = 500;
    expect(mode.snapshot()?.mode).toBe("local");
    expect(calls).toBe(1);
    clock = 2_000;
    mode.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });
});
