import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { TkenproPet3T } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { Site } from "../site";
import type { CameraRegionStore } from "../light-sync/region-store";
import type { SourceRegion } from "../light-sync/region";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off") {
    super(id);
  }
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string, relay: BinarySwitch) {
    super(id, name, { host: "10.77.0.228" });
    this.capabilities = { binarySwitch: relay };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

/** An in-memory double for `CameraRegionStore` so route tests never touch disk. */
class MemoryCameraRegionStore implements CameraRegionStore {
  private readonly regions = new Map<string, SourceRegion>();

  async load(): Promise<Readonly<Record<string, SourceRegion>>> {
    return Object.fromEntries(this.regions);
  }
  async get(cameraId: string): Promise<SourceRegion | undefined> {
    return this.regions.get(cameraId);
  }
  async set(cameraId: string, region: SourceRegion): Promise<void> {
    this.regions.set(cameraId, region);
  }
  async delete(cameraId: string): Promise<void> {
    this.regions.delete(cameraId);
  }
}

function fixture() {
  const service = new CameraService({
    cameraHosts: ["10.78.0.147"],
    async connectCloud() { return { async discover() { return []; } }; },
    async discoverLocal() { return []; },
  });
  const site = new Site([
    new TkenproPet3T({ id: "kitchen", name: "Kitchen pet camera" }, { host: "10.78.0.147" }, service),
    new SwitchDevice("relay", "Porch relay", new MemorySwitch("relay", "off")),
  ]);
  const regions = new MemoryCameraRegionStore();
  const app = createApp(service, site, undefined, regions);
  return { app, regions };
}

const square = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];

describe("light-sync region routes", () => {
  test("GET returns null for a camera with no saved region", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/kitchen/light-sync/region");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ region: null });
  });

  test("GET 404s for a device that has no camera capability", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/relay/light-sync/region");
    expect(response.status).toBe(404);
  });

  test("GET 404s for an id that is not a device at all", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/nope/light-sync/region");
    expect(response.status).toBe(404);
  });

  test("PUT saves a region, and GET returns it back", async () => {
    const { app } = fixture();
    const put = await app.request("/api/cameras/kitchen/light-sync/region", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: square }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { region: { points: unknown } };
    expect(putBody.region.points).toEqual(square);

    const get = await app.request("/api/cameras/kitchen/light-sync/region");
    const getBody = await get.json() as { region: { points: unknown } };
    expect(getBody.region.points).toEqual(square);
  });

  test("PUT rejects a region with too few points", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/kitchen/light-sync/region", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    });
    expect(response.status).toBe(400);
  });

  test("PUT rejects coordinates outside 0..1", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/kitchen/light-sync/region", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }),
    });
    expect(response.status).toBe(400);
  });

  test("PUT 404s for a device with no camera capability", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cameras/relay/light-sync/region", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: square }),
    });
    expect(response.status).toBe(404);
  });

  test("DELETE clears a saved region", async () => {
    const { app, regions } = fixture();
    await regions.set("kitchen", { points: square });
    const response = await app.request("/api/cameras/kitchen/light-sync/region", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await regions.get("kitchen")).toBeUndefined();
  });

  test("the device's Settings page links to the light-sync editor for a camera, not for a plain switch", async () => {
    const { app } = fixture();
    const cameraPage = await app.request("/cameras/kitchen-pet-camera/settings");
    expect(await cameraPage.text()).toContain('href="/cameras/kitchen-pet-camera/light-sync"');

    const switchPage = await app.request("/switches/porch-relay/settings");
    expect(await switchPage.text()).not.toContain("light-sync");
  });

  test("GET a typed element light-sync URL renders the editor page for a camera", async () => {
    const { app } = fixture();
    const response = await app.request("/cameras/kitchen-pet-camera/light-sync");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("data-light-sync-page");
    expect(html).toContain('data-device-id="kitchen"');
  });

  test("GET a typed element light-sync URL 404s for a device with no camera capability", async () => {
    const { app } = fixture();
    const response = await app.request("/switches/porch-relay/light-sync");
    expect(response.status).toBe(404);
  });
});
