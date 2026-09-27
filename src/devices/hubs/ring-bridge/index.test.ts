import { describe, expect, test } from "bun:test";
import { parseDevicesConfig } from "../../../config/devices";
import { RingError } from "../../../protocols/ring/client";
import { fakeRingSource } from "../../../protocols/ring/test-fixtures";
import { Site } from "../../../site";
import { RingBridge, RING_BRIDGE } from "./index";

const instance = { id: "ring-bridge", name: "Ring Bridge" };
const spotlight = { zid: "zid-1", name: "Garden Spotlight", deviceType: "switch.multilevel.beams", on: false, level: 0.4 };
const motion = { zid: "zid-2", name: "Garden Motion", deviceType: "motion-sensor.beams" };

describe("Ring Bridge", () => {
  test("lists the fixtures behind it as its accessories", async () => {
    const device = new RingBridge(instance, { locationId: "loc-1" }, fakeRingSource([spotlight, motion]));
    const document = await device.describe();
    expect(document.capabilities.hub?.state).toEqual({
      availability: "online",
      observedAt: "2026-09-18T12:00:00.000Z",
      accessories: [
        { id: "zid-1", name: "Garden Spotlight", model: "switch.multilevel.beams" },
        { id: "zid-2", name: "Garden Motion", model: "motion-sensor.beams" },
      ],
    });
  });

  test("a dropped connection is an outage, not a stale accessory list", async () => {
    const source = fakeRingSource([spotlight]);
    const device = new RingBridge(instance, { locationId: "loc-1" }, source);
    source.drop("The Ring connection closed");
    const state = await device.capabilities.hub.getState();
    expect(state).toEqual({ availability: "offline", detail: "The Ring connection closed" });
    await expect(device.probe()).rejects.toThrow("The Ring connection closed");
  });

  test("a rejected token is degraded rather than offline: the Bridge is fine, the account is not", async () => {
    const source = fakeRingSource([], { readyError: new RingError("Ring rejected the refresh token", "authentication") });
    const device = new RingBridge(instance, { locationId: "loc-1" }, source);
    expect(await device.capabilities.hub.getState()).toEqual({ availability: "degraded", detail: "Ring rejected the refresh token" });
  });

  test("a site with no Ring account reports unknown without inventing a reason", async () => {
    const device = new RingBridge(instance, { locationId: "loc-1" });
    const state = await device.capabilities.hub.getState();
    expect(state.availability).toBe("degraded");
    expect(state.detail).toContain("vendors.ring.refreshToken");
  });

  test("pushes a change through instead of waiting to be polled", () => {
    const source = fakeRingSource([spotlight]);
    const device = new RingBridge(instance, { locationId: "loc-1" }, source);
    let changes = 0;
    const stop = device.watch(() => { changes++; });
    source.push("zid-1", { on: true });
    expect(changes).toBe(1);
    stop();
    source.push("zid-1", { on: false });
    expect(changes).toBe(1);
  });

  test("says how it is reached, since there is no address to show", () => {
    expect(new RingBridge(instance, { locationId: "loc-1" }).displayHost()).toBe("Via Ring's cloud");
  });

  test("rejects a config with an unknown key or a missing location", () => {
    const provisioned = (config: unknown) => Site.fromConfig(
      parseDevicesConfig(`schemaVersion: 2\ndevices:\n  - id: b\n    model: ring-bridge\n    config: ${JSON.stringify(config)}\n`, "test"), {}, undefined, [RING_BRIDGE]);
    expect(provisioned({ locationId: "loc-1" }).devices).toHaveLength(1);
    // A Ring entry has no host; offering one means the operator expects a LAN path that does not exist.
    expect(() => provisioned({ locationId: "loc-1", host: "10.77.0.5" })).toThrow("must NOT have additional properties");
    expect(() => provisioned({})).toThrow("locationId");
  });
});
