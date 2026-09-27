import { describe, expect, test } from "bun:test";
import type { NetworkAddressClient } from "./adapter";
import { locateByMac, rescanDevices, summarizeRescan } from "./rescan";

const kitchen = { id: "sonos-kitchen", name: "Kitchen Sonos", address: "10.77.0.149", mac: "02:00:00:e9:b0:24" };
const blaster = { id: "blaster", name: "Blaster", address: "10.78.0.30" };
const clients: NetworkAddressClient[] = [
  { mac: "02:00:00:e9:b0:24", address: "10.78.0.148", lastAddress: "10.77.0.149", network: "example-iot" },
  { mac: "02:00:00:00:10:30", address: "10.78.0.30", ssid: "example-main" },
];

describe("locateByMac", () => {
  test("follows a saved MAC to its new address on another network, case-insensitively", () => {
    expect(locateByMac(kitchen, clients)).toEqual({
      deviceId: "sonos-kitchen", name: "Kitchen Sonos", address: "10.77.0.149", mac: "02:00:00:e9:b0:24",
      currentAddress: "10.78.0.148", network: "example-iot", outcome: "moved",
      detail: "Kitchen Sonos moved from 10.77.0.149 to 10.78.0.148 (example-iot)",
    });
  });
  test("reports an unchanged device and a device the gateway does not list", () => {
    expect(locateByMac({ ...kitchen, address: "10.78.0.148" }, clients)?.outcome).toBe("unchanged");
    expect(locateByMac({ ...kitchen, mac: "aa:bb:cc:dd:ee:ff" }, clients)).toMatchObject({ outcome: "missing", mac: "aa:bb:cc:dd:ee:ff" });
  });
  test("never moves a device onto a link-local address", () => {
    const result = locateByMac(kitchen, [{ mac: "02:00:00:e9:b0:24", address: "169.254.10.4" }]);
    expect(result?.outcome).toBe("missing");
    expect(result?.currentAddress).toBeUndefined();
  });
  test("defers a device without a saved MAC", () => {
    expect(locateByMac(blaster, clients)).toBeUndefined();
  });
});

describe("rescanDevices", () => {
  test("learns the MAC of a device that answers at an address one client occupies", async () => {
    const asked: string[] = [];
    const results = await rescanDevices([kitchen, blaster], clients, async (id) => { asked.push(id); return true; });
    expect(asked).toEqual(["blaster"]);
    expect(results.map((result) => result.outcome)).toEqual(["moved", "identified"]);
    expect(results[1]).toMatchObject({ mac: "02:00:00:00:10:30", address: "10.78.0.30", network: "example-main" });
    expect(results[1]?.currentAddress).toBeUndefined();
  });
  test("saves nothing when the device does not answer, nothing is listed, or several clients share the address", async () => {
    const silent = await rescanDevices([blaster], clients, async () => false);
    expect(silent[0]).toMatchObject({ outcome: "unidentified" });
    expect(silent[0]?.mac).toBeUndefined();
    const absent = await rescanDevices([blaster], [], async () => { throw new Error("must not probe"); });
    expect(absent[0]?.outcome).toBe("unidentified");
    const shared = await rescanDevices([blaster], [...clients, { mac: "00:11:22:33:44:55", address: "10.78.0.30" }], async () => { throw new Error("must not probe"); });
    expect(shared[0]?.outcome).toBe("ambiguous");
  });
});

test("summarizeRescan counts every outcome in one line", async () => {
  const results = await rescanDevices([kitchen, blaster, { ...kitchen, id: "gone", name: "Gone", mac: "aa:bb:cc:dd:ee:ff" }], clients, async () => false);
  expect(summarizeRescan(results)).toBe("Rescanned 3 devices: 1 moved, 0 identified, 1 missing, 1 without a usable MAC");
  expect(summarizeRescan([{ ...results[0]!, outcome: "failed", detail: "disk full" }])).toBe("Rescanned 1 device: 0 moved, 0 identified, 0 missing, 1 failed");
});
