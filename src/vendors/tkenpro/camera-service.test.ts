import { describe, expect, test } from "bun:test";
import { CameraService, CameraServiceError, type CameraController } from "./camera-service";
import type { CameraSetupStore, SavedCameraConfiguration } from "./setup-store";

function fixture(controlError?: unknown, setupStore?: CameraSetupStore) {
  const calls: string[] = [];
  const controller: CameraController = {
    async control(id, value) {
      calls.push(`control:${id}:${String(value)}`);
      if (controlError) throw controlError;
    },
    async ptzStart(direction) { calls.push(`start:${direction}`); },
    async ptzStop() { calls.push("stop"); },
  };
  const service = new CameraService({
    async connectCloud() { return { async discover() { return []; } }; },
    async discoverLocal() {
      return [{
        view: {
          id: "pet3t-1",
          name: "Treat Cam",
          model: "PET3T",
          status: "online",
          stream: "available",
          snapshot: "available",
          capabilities: [
            {
              id: "video.led",
              category: "video",
              label: "Status light",
              kind: "toggle",
              availability: "available",
              value: true,
              confirmation: "none",
            },
            {
              id: "feed.portions",
              category: "feeding",
              label: "Dispense treats",
              kind: "treat",
              availability: "available",
              min: 1,
              max: 10,
              confirmation: "confirm",
            },
            {
              id: "video.brightness",
              category: "video",
              label: "Brightness",
              kind: "range",
              availability: "available",
              min: 0,
              max: 100,
              step: 5,
              confirmation: "none",
            },
            {
              id: "video.mode",
              category: "video",
              label: "Video mode",
              kind: "select",
              availability: "available",
              options: [
                { value: "day", label: "Day" },
                { value: "night", label: "Night" },
              ],
              confirmation: "none",
            },
            {
              id: "camera.ptz",
              category: "movement",
              label: "Move camera",
              kind: "ptz",
              availability: "available",
              confirmation: "none",
            },
            {
              id: "device.wake",
              category: "advanced",
              label: "Wake camera",
              kind: "action",
              availability: "available",
              confirmation: "none",
            },
            {
              id: "audio.talk",
              category: "audio",
              label: "Talk",
              kind: "momentary",
              availability: "available",
              confirmation: "none",
            },
            {
              id: "storage.playback",
              category: "storage",
              label: "Local recordings",
              kind: "status",
              availability: "available",
              readOnly: true,
            },
          ],
        },
        controller,
        talkback: {
          async start() { calls.push("talk:start"); },
          sendPcm(pcm) { calls.push(`talk:audio:${pcm.length}`); },
          async stop() { calls.push("talk:stop"); },
        },
        playback: {
          async start(timestamp) {
            calls.push(`playback:start:${timestamp}`);
            return new ReadableStream();
          },
          pause() { calls.push("playback:pause"); },
          resume() { calls.push("playback:resume"); },
          seek(timestamp) { calls.push(`playback:seek:${timestamp}`); },
          async stop() { calls.push("playback:stop"); },
        },
        media: { streamUri: "rtsp://10.78.0.88/live" },
      }];
    },
    ...(setupStore ? { setupStore } : {}),
  });
  return { calls, service };
}

function memorySetupStore(initial?: SavedCameraConfiguration) {
  let current = initial ? structuredClone(initial) : undefined;
  let clearCount = 0;
  let failSave = false;
  const store: CameraSetupStore = {
    async load() { return current ? structuredClone(current) : undefined; },
    async save(configuration) {
      if (failSave) throw new Error("test store failure");
      current = structuredClone(configuration);
    },
    async clear() {
      current = undefined;
      clearCount += 1;
    },
  };
  return {
    store,
    current: () => current,
    clearCount: () => clearCount,
    setFailSave(value: boolean) { failSave = value; },
  };
}

describe("CameraService", () => {
  test("discovers, selects, and controls a local camera", async () => {
    const { calls, service } = fixture();
    const state = await service.discover();
    expect(state.selectedDeviceId).toBe("pet3t-1");
    await service.control({ deviceId: "pet3t-1", capabilityId: "video.led", value: false });
    expect(calls).toContain("control:video.led:false");
    expect(service.media("pet3t-1").streamUri).toContain("10.78.0.88");
  });

  test("requires confirmation before dispensing treats", async () => {
    const { calls, service } = fixture();
    await service.discover();
    await expect(service.control({ deviceId: "pet3t-1", capabilityId: "feed.portions", value: 1 }))
      .rejects.toBeInstanceOf(CameraServiceError);
    expect(calls).toHaveLength(0);
    await service.control({
      deviceId: "pet3t-1",
      capabilityId: "feed.portions",
      value: 1,
      confirmed: true,
    });
    expect(calls).toContain("control:feed.portions:1");
  });

  test("validates control values against the advertised capability", async () => {
    const { calls, service } = fixture();
    await service.discover();

    await expect(service.control({
      deviceId: "pet3t-1",
      capabilityId: "video.brightness",
      value: 101,
    })).rejects.toMatchObject({ code: "invalid_control" });
    await expect(service.control({
      deviceId: "pet3t-1",
      capabilityId: "video.brightness",
      value: 12,
    })).rejects.toMatchObject({ code: "invalid_control" });
    await expect(service.control({
      deviceId: "pet3t-1",
      capabilityId: "video.mode",
      value: "infrared",
    })).rejects.toMatchObject({ code: "invalid_control" });
    expect(calls).toHaveLength(0);

    await service.control({
      deviceId: "pet3t-1",
      capabilityId: "video.brightness",
      value: 15,
    });
    await service.control({
      deviceId: "pet3t-1",
      capabilityId: "video.mode",
      value: "night",
    });
    expect(calls).toEqual([
      "control:video.brightness:15",
      "control:video.mode:night",
    ]);
  });

  test("rejects raw PTZ writes so movement always uses an automatic stop lease", async () => {
    const { calls, service } = fixture();
    await service.discover();

    await expect(service.control({
      deviceId: "pet3t-1",
      capabilityId: "camera.ptz",
      value: { ps: 80, ts: 0, zs: 0 },
    })).rejects.toMatchObject({ code: "invalid_control" });
    expect(calls).toHaveLength(0);
  });

  test("exposes wake as an explicit action rather than a toggle", async () => {
    const { calls, service } = fixture();
    await service.discover();

    await expect(service.control({
      deviceId: "pet3t-1",
      capabilityId: "device.wake",
      value: false,
    })).rejects.toMatchObject({ code: "invalid_control" });
    await service.control({
      deviceId: "pet3t-1",
      capabilityId: "device.wake",
      value: true,
    });
    expect(calls).toEqual(["control:device.wake:true"]);
  });

  test("bounds movement with an automatic stop lease", async () => {
    const { calls, service } = fixture();
    await service.discover();
    await service.ptz({
      deviceId: "pet3t-1",
      action: "start",
      direction: "left",
      leaseMs: 100,
      commandId: "test-command",
    });
    expect(calls).toContain("start:left");
    await Bun.sleep(140);
    expect(calls).toContain("stop");
  });

  test("opens, streams, and closes local talkback only through its bounded session", async () => {
    const { calls, service } = fixture();
    await service.discover();

    await expect(service.sendTalkbackPcm("pet3t-1", new Int16Array([1])))
      .rejects.toMatchObject({ code: "invalid_control" });
    await service.startTalkback("pet3t-1");
    await service.sendTalkbackPcm("pet3t-1", new Int16Array([1, -2, 3]));
    await service.stopTalkback("pet3t-1");

    expect(calls).toEqual(["talk:start", "talk:audio:3", "talk:stop"]);
  });

  test("starts and controls authenticated local SD playback", async () => {
    const { calls, service } = fixture();
    await service.discover();
    await expect(service.startPlayback("pet3t-1", "not-a-time"))
      .rejects.toMatchObject({ code: "invalid_control" });

    const stream = await service.startPlayback("pet3t-1", "20260902093000");
    expect(stream).toBeInstanceOf(ReadableStream);
    await service.controlPlayback("pet3t-1", "pause");
    await service.controlPlayback("pet3t-1", "seek", "20260902094530");
    await service.controlPlayback("pet3t-1", "resume");
    await service.stopPlayback("pet3t-1");

    expect(calls).toEqual([
      "playback:start:20260902093000",
      "playback:pause",
      "playback:seek:20260902094530",
      "playback:resume",
      "playback:stop",
    ]);
  });

  test("turns vendor failures into actionable camera errors", async () => {
    const vendorError = Object.assign(new Error("IoT set failed"), { resultCode: "1109" });
    const { service } = fixture(vendorError);
    await service.discover();

    await expect(service.control({ deviceId: "pet3t-1", capabilityId: "video.led", value: false }))
      .rejects.toMatchObject({
        name: CameraServiceError.name,
        code: "camera_error",
        message: expect.stringContaining("TKENPRO code 1109"),
      });
  });

  test("translates PTZ vendor failures into camera errors", async () => {
    const vendorError = Object.assign(new Error("PTZ failed"), { resultCode: "1109" });
    const calls: string[] = [];
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() {
        return [{
          view: {
            id: "pet3t-ptz",
            name: "Treat Cam",
            status: "online" as const,
            stream: "unknown" as const,
            snapshot: "unknown" as const,
            capabilities: [{
              id: "camera.ptz",
              category: "movement" as const,
              label: "Move camera",
              kind: "ptz" as const,
              availability: "available" as const,
            }],
          },
          controller: {
            async control() {},
            async ptzStart() { calls.push("start"); throw vendorError; },
            async ptzStop() { calls.push("stop"); throw vendorError; },
          },
        }];
      },
    });
    await service.discover();

    await expect(service.ptz({
      deviceId: "pet3t-ptz",
      action: "start",
      direction: "left",
      commandId: "ptz-start",
    })).rejects.toMatchObject({ code: "camera_error", message: expect.stringContaining("1109") });
    await expect(service.ptz({
      deviceId: "pet3t-ptz",
      action: "stop",
      commandId: "ptz-stop",
    })).rejects.toMatchObject({ code: "camera_error", message: expect.stringContaining("1109") });
    expect(calls).toEqual(["start", "stop"]);
  });

  test("merges LAN with numeric and opaque CloudEdge identities while routing controls to cloud", async () => {
    const calls: string[] = [];
    const controller = (source: string): CameraController => ({
      async control(id, value) { calls.push(`${source}:${id}:${String(value)}`); },
      async ptzStart(direction) { calls.push(`${source}:start:${direction}`); },
      async ptzStop() { calls.push(`${source}:stop`); },
    });
    const camera = (
      id: string,
      source: "local" | "cloud",
      name: string,
    ) => ({
      view: {
        id,
        name,
        model: "PET3T",
        status: "online" as const,
        stream: "unknown" as const,
        snapshot: "unknown" as const,
        capabilities: source === "local"
          ? [{
            id: "local.discovery",
            category: "advanced" as const,
            label: "Local discovery",
            kind: "status" as const,
            availability: "available" as const,
            value: "Found locally",
            readOnly: true,
          }]
          : [{
            id: "onvif.enabled",
            category: "onvif" as const,
            label: "ONVIF",
            kind: "toggle" as const,
            availability: "available" as const,
            value: false,
            confirmation: "confirm" as const,
          }],
      },
      controller: controller(source),
    });
    const service = new CameraService({
      async connectCloud() {
        return {
          async discover() {
            return [
              camera("ppsc708dc5f1b76b4d2b", "cloud", "100000001"),
              camera("ppsc2f9d15a6f3f24d09", "cloud", "100000002"),
            ];
          },
        };
      },
      async discoverLocal() {
        return [camera("100000001", "local", "Pet 3T · 100000001")];
      },
    });

    await service.setup({
      profile: "tkenpro",
      email: "owner@example.com",
      password: "app-password",
    });
    const state = await service.discover();

    expect(state.devices).toHaveLength(2);
    const merged = state.devices.find((device) => device.name === "100000001");
    expect(merged?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local.discovery" }),
      expect.objectContaining({ id: "onvif.enabled", kind: "toggle" }),
    ]));
    if (!merged) throw new Error("expected merged camera");
    await service.control({
      deviceId: merged.id,
      capabilityId: "onvif.enabled",
      value: true,
      confirmed: true,
    });
    expect(calls).toEqual(["cloud:onvif.enabled:true"]);
  });

  test("does not contact the app account when native local control is active", async () => {
    let cloudConnections = 0;
    const service = new CameraService({
      localControlAvailable: true,
      async connectCloud() {
        cloudConnections += 1;
        return { async discover() { return []; } };
      },
      async discoverLocal() { return []; },
    });

    const state = await service.setup({
      profile: "cloudedge",
      email: "owner@example.com",
      password: "app-password",
    });
    expect(state.setup.configured).toBeTrue();
    expect(cloudConnections).toBe(0);
  });

  test("persists setup, retains omitted secrets, and restores the camera unattended", async () => {
    const memory = memorySetupStore();
    const first = fixture(undefined, memory.store).service;
    await first.setup({
      profile: "cloudedge",
      countryCode: "US",
      email: "owner@example.com",
      password: "app-secret",
      onvifUsername: "admin",
      onvifPassword: "camera-secret",
    });
    await first.setup({ profile: "cloudedge", countryCode: "CA" });
    await first.discover();

    expect(memory.current()).toEqual({
      setup: {
        profile: "cloudedge",
        countryCode: "CA",
        email: "owner@example.com",
        password: "app-secret",
        onvifUsername: "admin",
        onvifPassword: "camera-secret",
      },
      // A camera's address is per-camera state (devices.yml/inventory),
      // never a saved global setting.
      selectedDeviceId: "pet3t-1",
    });

    await first.close();
    expect(memory.current()?.setup.password).toBe("app-secret");

    const restored = fixture(undefined, memory.store).service;
    const state = await restored.restore();
    expect(state.setup).toEqual({
      configured: true,
      profile: "cloudedge",
      accountHint: "ow•••@example.com",
    });
    expect(state.discovery).toMatchObject({ status: "ready" });
    expect(state.selectedDeviceId).toBe("pet3t-1");
    expect(state.devices).toHaveLength(1);

    await restored.disconnect();
    expect(memory.current()).toBeUndefined();
    expect(memory.clearCount()).toBe(1);
  });

  test("keeps the previous saved setup when a replacement cannot be persisted", async () => {
    const memory = memorySetupStore();
    const service = fixture(undefined, memory.store).service;
    await service.setup({
      profile: "tkenpro",
      email: "owner@example.com",
      password: "original-secret",
    });
    memory.setFailSave(true);
    await expect(service.setup({
      profile: "cloudedge",
      email: "replacement@example.com",
      password: "replacement-secret",
    })).rejects.toThrow("test store failure");
    memory.setFailSave(false);

    await service.setup({ profile: "tkenpro", countryCode: "US" });
    expect(memory.current()?.setup).toMatchObject({
      profile: "tkenpro",
      email: "owner@example.com",
      password: "original-secret",
      countryCode: "US",
    });
  });
});

describe("discovered compatible-camera inventory", () => {
  function inventoryFixture(seed: readonly import("./inventory-store").InventoryCamera[] = []) {
    let stored: import("./inventory-store").InventoryCamera[] = [...seed];
    const inventoryStore = {
      load: async () => stored,
      save: async (cameras: readonly import("./inventory-store").InventoryCamera[]) => { stored = [...cameras]; },
      merge: async (cameras: readonly import("./inventory-store").InventoryCamera[]) => {
        const byId = new Map(stored.map((c) => [c.id, c]));
        for (const c of cameras) byId.set(c.id, c);
        stored = [...byId.values()];
        return stored;
      },
      clear: async () => { stored = []; },
    };
    return { inventoryStore, get current() { return stored; } };
  }

  const managedWithInventory = {
    view: {
      id: "uuid:cam-1",
      name: "Pet 3T",
      model: "Pet 3T",
      status: "online" as const,
      stream: "available" as const,
      snapshot: "available" as const,
      capabilities: [],
    },
    controller: {
      async control() {}, async ptzStart() {}, async ptzStop() {},
    },
    inventory: {
      id: "uuid:cam-1",
      host: "10.78.0.147",
      sources: ["meari-lan"],
      model: "Pet 3T",
      onvifEndpoints: [],
      openPorts: [80],
      lastSeen: "2026-09-03T00:00:00.000Z",
    },
  };

  test("discovery persists every compatible camera's config", async () => {
    const inv = inventoryFixture();
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() { return [managedWithInventory]; },
      inventoryStore: inv.inventoryStore,
    });
    await service.discover({});
    expect(inv.current).toHaveLength(1);
    expect(inv.current[0]).toMatchObject({ id: "uuid:cam-1", host: "10.78.0.147" });
  });

  test("cameras without inventory metadata are not persisted", async () => {
    const inv = inventoryFixture([managedWithInventory.inventory]);
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() {
        return [{ view: { ...managedWithInventory.view, id: "onvif-only" }, controller: managedWithInventory.controller }];
      },
      inventoryStore: inv.inventoryStore,
    });
    await service.discover({});
    // no compatible cameras this run -> prior inventory left untouched
    expect(inv.current).toHaveLength(1);
    expect(inv.current[0]?.id).toBe("uuid:cam-1");
  });

  test("a camera silent this scan still appears as an offline device", async () => {
    // Camera A was saved before; this scan only finds camera B (live).
    const inv = inventoryFixture([{ ...managedWithInventory.inventory, id: "uuid:cam-A", host: "10.78.0.64" }]);
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() {
        return [{
          ...managedWithInventory,
          view: { ...managedWithInventory.view, id: "uuid:cam-B" },
          inventory: { ...managedWithInventory.inventory, id: "uuid:cam-B", host: "10.78.0.147" },
        }];
      },
      inventoryStore: inv.inventoryStore,
    });
    const model = await service.discover({});
    const ids = model.devices.map((d) => d.id).sort();
    expect(ids).toEqual(["uuid:cam-A", "uuid:cam-B"]);
    expect(model.devices.find((d) => d.id === "uuid:cam-A")?.status).toBe("offline");
    expect(model.devices.find((d) => d.id === "uuid:cam-B")?.status).toBe("online");
    expect(model.discovery.message).toContain("Found 2 cameras");
    expect(inv.current.map((c) => c.id).sort()).toEqual(["uuid:cam-A", "uuid:cam-B"]);
  });

  test("restore seeds the device list from the saved inventory", async () => {
    const inv = inventoryFixture([managedWithInventory.inventory]);
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() { return []; },
      inventoryStore: inv.inventoryStore,
    });
    const model = await service.restore();
    expect(model.devices).toHaveLength(1);
    expect(model.devices[0]).toMatchObject({ id: "uuid:cam-1", status: "offline" });
    expect(model.selectedDeviceId).toBe("uuid:cam-1");
  });
});


test("startup restores saved cameras and credentials without login or discovery", async () => {
  let networkCalls = 0;
  let savedWrites = 0;
  const service = new CameraService({
    async connectCloud() { networkCalls++; throw new Error("must not connect"); },
    async discoverLocal() { networkCalls++; throw new Error("must not probe"); },
    setupStore: {
      async load() { return { setup: { profile: "cloudedge", email: "owner@example.com", password: "secret", onvifUsername: "admin", onvifPassword: "local" } }; },
      async save() { savedWrites++; },
      async clear() {},
    },
  });
  const state = await service.restore({ connect: false });
  expect(state.setup.configured).toBe(true);
  expect(networkCalls).toBe(0);
  expect(savedWrites).toBe(0);
  await service.attachRegistered();
  expect(networkCalls).toBe(0);
  await service.close();
});
