import { describe, expect, test } from "bun:test";
import {
  MeariCameraController,
  MeariCloudSession,
  MeariLocalCameraController,
  MeariLocalControlAdapter,
  OnvifCameraController,
  manageLocalCamera,
} from "./camera-adapters";
import { CameraServiceError } from "./camera-service";
import {
  PET3T_CONTROL_CATALOG,
  type FeedSchedule,
  type MeariClient,
  type MeariLocalCloudRuntime,
  type OnvifClient,
} from "../../protocols/tkenpro";
import type { DiscoveredCamera } from "../../protocols/tkenpro/discovery";

describe("local vendor discovery adapter", () => {
  test("does not imply media access from an unverified open RTSP port", async () => {
    const camera: DiscoveredCamera = {
      id: "uuid:v3-1000000010000111a",
      host: "10.78.0.147",
      sources: ["meari-lan"],
      endpointReference: "urn:uuid:v3-1000000010000111A",
      server: "Pet 3T",
      model: "Pet 3T",
      firmware: "5.7.3",
      serialNumber: "100000001",
      deviceName: "100000001",
      onvifAdvertised: true,
      types: ["meari:camera"],
      scopes: ["meari://device/serial/100000001"],
      locations: [],
      onvifEndpoints: [],
      openPorts: [8554],
    };

    const managed = await manageLocalCamera(camera, {});

    expect(managed?.view).toMatchObject({
      id: "100000001",
      name: "Pet 3T · 100000001",
      model: "Pet 3T",
      firmware: "5.7.3",
      status: "online",
      stream: "unknown",
      snapshot: "unknown",
    });
    expect(managed?.media).toBeUndefined();
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "local.discovery",
      availability: "available",
      value: "Found at 10.78.0.147",
      readOnly: true,
    }));
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "onvif.enabled",
      availability: "unknown",
      value: "Supported; not connected",
      readOnly: true,
    }));
    expect(managed?.view.capabilities.some((capability) => capability.kind === "ptz" || capability.kind === "action")).toBeFalse();
  });
});

describe("cloud ONVIF adapter", () => {
  test("passes the setup password through the cloud session to the atomic ONVIF write", async () => {
    const writes: Array<{ serialNumber: string; enabled: boolean; password: string }> = [];
    const client = {
      devices: [{
        snNum: "ppsl1234567890123456",
        deviceName: "PET3T",
        capability: JSON.stringify({ caps: { ovf: 1 } }),
      }],
      async getAllIotValues() { return { "121": 0 }; },
      async getDeviceStatus() { return "online"; },
      async configureOnvif(
        serialNumber: string,
        configuration: { enabled: boolean; password: string },
      ) {
        writes.push({ serialNumber, ...configuration });
        return {};
      },
    } as unknown as MeariClient;
    const session = new MeariCloudSession(client, "PetCam-2026!");

    const cameras = await session.discover();
    const camera = cameras[0];
    if (!camera) throw new Error("expected a camera");
    expect(camera.view.capabilities).toContainEqual(expect.objectContaining({
      id: "onvif.enabled",
      confirmation: "confirm",
      description: expect.stringContaining("disable cloud recording"),
    }));
    expect(camera.view).toMatchObject({ stream: "unknown", snapshot: "unknown" });
    expect(camera.media).toBeUndefined();

    await camera.controller.control("onvif.enabled", true, true);
    expect(writes).toEqual([{
      serialNumber: "ppsl1234567890123456",
      enabled: true,
      password: "PetCam-2026!",
    }]);
  });

  test("returns a clear service error when first enable has no setup password", async () => {
    const controller = new MeariCameraController({} as MeariClient, "100000001");

    await expect(controller.control("onvif.enabled", true, true)).rejects.toMatchObject({
      name: CameraServiceError.name,
      code: "not_configured",
      message: expect.stringContaining("ONVIF password"),
    });
  });

  test("can disable an already configured camera through the compatibility flag write", async () => {
    const writes: boolean[] = [];
    const client = {
      async setOnvif(_serialNumber: string, enabled: boolean) {
        writes.push(enabled);
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001");

    await controller.control("onvif.enabled", false, true);
    expect(writes).toEqual([false]);
  });

  test("marks RTSP-backed snapshots available and decodes the legacy ONVIF password", async () => {
    const client = {
      devices: [{
        snNum: "ppsl1234567890123456",
        deviceName: "PET3T",
        capability: JSON.stringify({ caps: { ovf: 1 } }),
      }],
      async getAllIotValues() {
        return {
          "121": 1,
          "122": "YWRtaW4=",
          "123": "rtsp://10.78.0.147:8554/live",
        };
      },
      async getDeviceStatus() { return "online"; },
    } as unknown as MeariClient;

    const camera = (await new MeariCloudSession(client).discover())[0];
    expect(camera?.view).toMatchObject({ stream: "available", snapshot: "available" });
    expect(camera?.media).toEqual({
      streamUri: "rtsp://10.78.0.147:8554/live",
      username: "admin",
      password: "admin",
    });
  });

  test("does not advertise cloud media URLs outside the local network", async () => {
    const client = {
      devices: [{
        snNum: "ppsl1234567890123456",
        deviceName: "PET3T",
        capability: JSON.stringify({ caps: { ovf: 1 } }),
      }],
      async getAllIotValues() { return { "123": "rtsp://example.com/live" }; },
      async getDeviceStatus() { return "online"; },
    } as unknown as MeariClient;

    const camera = (await new MeariCloudSession(client).discover())[0];
    expect(camera?.view).toMatchObject({ stream: "unknown", snapshot: "unknown" });
    expect(camera?.media).toBeUndefined();
  });
});

describe("cloud control adapter", () => {
  test("publishes every observed PET3T catalog control through the generic API model", async () => {
    const values = Object.fromEntries(PET3T_CONTROL_CATALOG.map((definition) => [definition.code, 0]));
    const client = {
      devices: [{ snNum: "ppsl1234567890123456", deviceName: "PET3T", capability: "{}" }],
      async getAllIotValues() { return values; },
      async getDeviceStatus() { return "online"; },
    } as unknown as MeariClient;

    const cameras = await new MeariCloudSession(client).discover();
    const capabilities = cameras[0]?.view.capabilities ?? [];

    expect(capabilities).toHaveLength(PET3T_CONTROL_CATALOG.length + 1);
    expect(capabilities).toContainEqual(expect.objectContaining({
      id: "device.wake",
      kind: "action",
      availability: "available",
      confirmation: "none",
    }));
    for (const definition of PET3T_CONTROL_CATALOG) {
      const capability = capabilities.find((candidate) => candidate.label === definition.label);
      expect(capability).toEqual(expect.objectContaining({
        label: definition.label,
        availability: "available",
      }));
      if (definition.access === "read" || definition.kind === "status") {
        expect(capability?.readOnly).toBeTrue();
      } else {
        expect(capability?.readOnly).not.toBeTrue();
      }
    }
  });

  test("converts dashboard select strings back to numeric vendor values", async () => {
    const writes: Array<{ id: string; value: unknown }> = [];
    const client = {
      async setControl(_serialNumber: string, id: string, value: unknown) {
        writes.push({ id, value });
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001");

    await controller.control("video.nightVision", "auto", false);
    await controller.control("storage.mode", "events", false);
    await controller.control("meari.fullColorMode", "1", false);

    expect(writes).toEqual([
      { id: "dayNightMode", value: 2 },
      { id: "recordType", value: 1 },
      { id: "fullColorMode", value: 1 },
    ]);
    await expect(controller.control("meari.fullColorMode", "sepia", false)).rejects.toMatchObject({
      code: "invalid_control",
    });
  });

  test("preserves portions and validates weekdays in complete feeding schedules", async () => {
    const schedules: FeedSchedule[] = [];
    const client = {
      async setFeedSchedule(_serialNumber: string, schedule: FeedSchedule) {
        schedules.push(schedule);
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001");

    await controller.control("feed.schedule", [
      { time: "07:15", enabled: true, parts: 2, days: ["mon", "fri"] },
      { time: "18:45", enabled: false, parts: 3, days: [0, 6] },
    ], false);
    expect(schedules).toEqual([[
      { time: "07:15", enabled: true, parts: 2, days: [1, 5] },
      { time: "18:45", enabled: false, parts: 3, days: [0, 6] },
    ]]);

    await expect(controller.control("feed.schedule", {
      time: "25:00",
      enabled: true,
      parts: 1,
      days: ["mon"],
    }, false)).rejects.toMatchObject({ code: "invalid_control" });
    await expect(controller.control("feed.schedule", {
      time: "09:00",
      enabled: true,
      parts: 11,
      days: ["mon"],
    }, false)).rejects.toMatchObject({ code: "invalid_control" });
  });

  test("supports deleting a numeric cloud PTZ preset", async () => {
    const deleted: number[] = [];
    const client = {
      async deletePtzPreset(_serialNumber: string, id: number) {
        deleted.push(id);
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001");

    await controller.control("camera.presets", { action: "delete", presetId: "7" }, true);
    expect(deleted).toEqual([7]);
    await expect(controller.control("camera.presets", { action: "delete", presetId: "home" }, true))
      .rejects.toMatchObject({ code: "invalid_control" });
  });

  test("saves cloud PTZ presets into the first free slot instead of overwriting slot one", async () => {
    const saved: Array<{ id: number; name?: string }> = [];
    const client = {
      async setPtzPreset(_serialNumber: string, preset: { id: number; name?: string }) {
        saved.push(preset);
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001", undefined, [1, 3]);

    await controller.control("camera.presets", { action: "save", name: "Food bowl" }, true);
    await controller.control("camera.presets", { action: "save", name: "Door" }, true);
    expect(saved).toEqual([
      { id: 2, name: "Food bowl" },
      { id: 4, name: "Door" },
    ]);
  });

  test("exposes cloud wake as a strict safe action", async () => {
    const woke: string[] = [];
    const client = {
      async wakeDevice(serialNumber: string) {
        woke.push(serialNumber);
        return {};
      },
    } as unknown as MeariClient;
    const controller = new MeariCameraController(client, "100000001");

    await controller.control("device.wake", true, false);
    expect(woke).toEqual(["100000001"]);
    await expect(controller.control("device.wake", false, false))
      .rejects.toMatchObject({ code: "invalid_control" });
  });
});

describe("native local control adapter", () => {
  test("retains an authenticated camera when ONVIF discovery is temporarily unavailable", () => {
    const runtime = {
      authorization: {
        version: 2,
        devices: [{
          uuid: "0000000123456789",
          registrationPasswordSha256: "0".repeat(64),
          sourceAddress: "192.168.40.77",
          clientId: "Pet 3T",
          peer: {
            hostKey: "0123456789abcdef",
            protocolVersion: 6,
            licenceId: "testlicence",
          },
          capabilityFlags: { ovf: 1, pet: 1 },
        }],
      },
      emulator: {
        connectedDeviceUuids: ["0000000123456789"],
        getDeviceState() { return { "103": 1, "121": 0, "140": 1 }; },
        async setIot() { return {}; },
      },
    } as unknown as MeariLocalCloudRuntime;
    const adapter = new MeariLocalControlAdapter(runtime);

    const cameras = adapter.attachRegisteredCameras({});
    expect(cameras).toHaveLength(1);
    expect(cameras[0]?.view).toMatchObject({
      id: "123456789",
      status: "online",
      stream: "unknown",
      snapshot: "unknown",
    });
    expect(cameras[0]?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "local.nativeControl",
      value: "Connected locally",
    }));
    expect(cameras[0]?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "feed.portions",
      kind: "treat",
      availability: "available",
    }));
    expect(adapter.attachRegisteredCameras({}, new Set(["192.168.40.77"]))).toEqual([]);
  });

  test("keeps the discovered camera identity stable while ONVIF is toggled off", () => {
    const runtime = {
      authorization: {
        version: 2,
        devices: [{
          uuid: "708d0123456789ab",
          registrationPasswordSha256: "0".repeat(64),
          sourceAddress: "192.168.40.77",
        }],
      },
      emulator: {
        connectedDeviceUuids: ["708d0123456789ab"],
        getDeviceState() { return { "103": 1, "121": 0 }; },
        async setIot() { return {}; },
      },
    } as unknown as MeariLocalCloudRuntime;
    const adapter = new MeariLocalControlAdapter(runtime);
    const discovered: DiscoveredCamera = {
      id: "onvif-discovery-id",
      host: "192.168.40.77",
      sources: ["ws-discovery"],
      deviceName: "Treat camera",
      types: [],
      scopes: [],
      locations: [],
      onvifEndpoints: [],
      openPorts: [],
    };
    const onvifCamera = {
      view: {
        id: "123456789",
        name: "ONVIF Pet 3T",
        status: "online" as const,
        stream: "available" as const,
        snapshot: "available" as const,
        capabilities: [],
      },
      controller: {
        async control() {},
        async ptzStart() {},
        async ptzStop() {},
      },
    };

    expect(adapter.attach(discovered, onvifCamera, {})?.view.id).toBe("123456789");
    expect(adapter.attachRegisteredCameras({})[0]?.view.id).toBe("123456789");
  });

  test("encodes settings, feeding, PTZ, and ONVIF writes directly to MsgSvr", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = {
      emulator: {
        connectedDeviceUuids: ["camera-uuid"],
        getDeviceState() { return { "109": 0, "110": 0 }; },
        async setIot(_uuid: string, values: Record<string, unknown>) {
          writes.push(values);
          return {};
        },
      },
    } as unknown as MeariLocalCloudRuntime;
    const controller = new MeariLocalCameraController(
      runtime,
      "camera-uuid",
      "local-pass",
      [],
      async (values) => { writes.push({ ...values }); },
    );

    await controller.control("video.nightVision", "auto", false);
    await controller.control("feed.portions", 1, true);
    await expect(controller.control("feed.portions", 3, true)).rejects.toMatchObject({ code: "invalid_control" });
    await controller.control("meari.feedSound", "http://192.168.40.2/feed.wav", false);
    await controller.control("meari.petCallSound", "http://192.168.40.2/call.wav", false);
    await controller.control("meari.feedCall", true, false);
    await controller.control("meari.watchBowl", true, true);
    await controller.ptzStart("left");
    await controller.ptzStop();
    await controller.control("onvif.enabled", true, true);

    expect(writes).toEqual([
      { "113": 2 },
      { "845": 1 },
      { "843": JSON.stringify({ url: "http://192.168.40.2/feed.wav" }) },
      { "860": JSON.stringify({ url: "http://192.168.40.2/call.wav" }) },
      { "844": 1 },
      { "868": 1 },
      { "841": JSON.stringify({ ps: -80, ts: 0, zs: 0 }) },
      { "842": "{}" },
      { "121": 1, "122": Buffer.from("local-pass").toString("base64") },
    ]);
  });

  test("uses the PET3T wire codecs for duration, environment, RGB, patrol, calibration, and restart", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = {
      emulator: {
        connectedDeviceUuids: ["camera-uuid"],
        async setIot(_uuid: string, values: Record<string, unknown>) {
          writes.push(values);
          return {};
        },
      },
    } as unknown as MeariLocalCloudRuntime;
    const controller = new MeariLocalCameraController(
      runtime,
      "camera-uuid",
      undefined,
      [],
      async (values) => { writes.push({ ...values }); },
    );

    await controller.control("meari.recordDuration", "0", false);
    await controller.control("meari.temperatureMaximum", 30, false);
    await controller.control("meari.humidityMinimum", 45, false);
    await controller.control("meari.rgbColor", "#ff8001", false);
    await controller.control("camera.patrol", true, true);
    await controller.control("camera.calibrate", true, true);
    await controller.control("device.restart", true, true);
    await controller.control("meari.ptzPreset", { action: "recall", presetId: 4 }, true);

    expect(writes).toEqual([
      { "105": 0 },
      { "242": 30_000 },
      { "245": 45_000 },
      { "198": JSON.stringify([255, 128, 1]) },
      { "822": "{}" },
      { "847": 1 },
      { "800": "1" },
      { "848": JSON.stringify({ idx: 4 }) },
    ]);
  });

  test("promotes observed local firmware features without an app account", async () => {
    const camera: DiscoveredCamera = {
      id: "camera-discovery-id",
      host: "192.168.40.77",
      sources: ["meari-lan"],
      server: "Pet 3T",
      model: "Pet 3T",
      deviceName: "Treat camera",
      onvifAdvertised: false,
      types: ["meari:camera"],
      scopes: [],
      locations: [],
      onvifEndpoints: [],
      openPorts: [],
    };
    const runtime = {
      authorization: {
        version: 2,
        devices: [{
          uuid: "camera-uuid",
          registrationPasswordSha256: "0".repeat(64),
          sourceAddress: camera.host,
          peer: {
            hostKey: "0123456789abcdef",
            protocolVersion: 6,
            licenceId: "testlicence",
          },
          capabilityFlags: {
            bowl: 0,
            pet: 1,
            pfp: 1,
            pms: 1,
            ptc: 1,
            ptz2: 3,
            sd: 1,
          },
        }],
      },
      emulator: {
        connectedDeviceUuids: ["camera-uuid"],
        getDeviceState() {
          return { "103": 1, "112": 1, "843": 4, "114": 1, "52": "5.7.3" };
        },
        async setIot() { return {}; },
      },
    } as unknown as MeariLocalCloudRuntime;

    const managed = new MeariLocalControlAdapter(runtime).attach(camera, undefined, {});
    expect(managed?.view).toMatchObject({ status: "online", firmware: "5.7.3" });
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "local.nativeControl",
      value: "Connected locally",
      readOnly: true,
    }));
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "feed.portions",
      kind: "treat",
      availability: "available",
    }));
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "camera.ptz",
      kind: "ptz",
      availability: "available",
    }));
    expect(managed?.view.capabilities).toContainEqual(expect.objectContaining({
      id: "audio.talk",
      kind: "momentary",
      availability: "available",
    }));
    expect(managed?.view.capabilities.some((capability) => capability.id === "meari.h265")).toBeFalse();
    expect(managed?.view.capabilities.some((capability) => capability.id === "meari.cameraLensControl")).toBeFalse();
    expect(managed?.view.capabilities.some((capability) => capability.id === "feed.schedule")).toBeTrue();
    expect(managed?.view.capabilities.some((capability) => capability.id === "meari.watchBowl")).toBeFalse();
  });

  test("routes every writable PET3T catalog command through the local MsgSvr session", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = {
      emulator: {
        connectedDeviceUuids: ["camera-uuid"],
        getDeviceState() { return { "109": 0, "110": 0 }; },
        async setIot(_uuid: string, values: Record<string, unknown>) {
          writes.push(values);
          return {};
        },
      },
    } as unknown as MeariLocalCloudRuntime;
    const controller = new MeariLocalCameraController(
      runtime,
      "camera-uuid",
      undefined,
      [],
      async (values) => { writes.push({ ...values }); },
    );

    for (const definition of PET3T_CONTROL_CATALOG) {
      if (definition.access === "read" || definition.id === "ptzMove") continue;
      const value: unknown = definition.id === "feed"
        ? 1
        : definition.scheduleCodec === "weekly-intervals"
          ? [{ enabled: true, startTime: "08:00", endTime: "09:00", days: ["mon"] }]
          : definition.scheduleCodec === "deployment-intervals"
            ? [{ startTime: "08:00", endTime: "09:00" }]
            : definition.scheduleCodec === "daily-window"
              ? { enabled: true, startTime: "08:00", endTime: "09:00" }
              : definition.scheduleCodec === "patrol-times"
                ? [{ enabled: true, time: "08:00" }]
                : definition.scheduleCodec === "feed-times"
                  ? [{ time: "12:00", parts: 1, enabled: true, days: ["mon"] }]
                  : definition.scheduleCodec === "tease-times"
                    ? [{ time: "12:00", mode: 0, enabled: true, days: ["mon"] }]
          : definition.regionCodec === "grid-16x9"
            ? { selectedCells: [0, 143] }
          : definition.polygonRegionCodec === "property-232"
            ? { polygons: [{ type: 1, points: [{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 50 }, { x: 60, y: 60 }, { x: 50, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 50 }] }] }
          : definition.id === "ptzPreset"
            ? { action: "recall", presetId: 1 }
            : definition.id === "onvif"
              ? false
              : definition.kind === "switch"
                ? true
                : definition.kind === "color"
                  ? "#000000"
                  : definition.kind === "number"
                  ? definition.min ?? 0
                  : definition.kind === "text"
                    ? "http://192.168.40.2/audio.wav"
                  : definition.kind === "select"
                    ? definition.options?.[0]?.value
                    : definition.kind === "action"
                      ? true
                      : {};
      const before = writes.length;
      await controller.control(`meari.${definition.id}`, value, true);
      expect(writes.length, definition.id).toBe(before + 1);
      expect(Object.keys(writes.at(-1) ?? {}), definition.id).toContain(definition.code);
    }

    await controller.ptzStart("right");
    expect(Object.keys(writes.at(-1) ?? {})).toContain("841");
    await controller.ptzStop();
    expect(Object.keys(writes.at(-1) ?? {})).toContain("842");
  });

  test("recalls native saved views locally instead of requiring the fallback controller", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const fallbackCalls: string[] = [];
    const camera: DiscoveredCamera = {
      id: "camera-discovery-id",
      host: "192.168.40.77",
      sources: ["meari-lan"],
      model: "Pet 3T",
      deviceName: "Treat camera",
      types: ["meari:camera"],
      scopes: [],
      locations: [],
      onvifEndpoints: [],
      openPorts: [],
    };
    const runtime = {
      authorization: {
        version: 2,
        devices: [{
          uuid: "camera-uuid",
          registrationPasswordSha256: "0".repeat(64),
          sourceAddress: camera.host,
          capabilityFlags: { ptz2: 3 },
        }],
      },
      emulator: {
        connectedDeviceUuids: ["camera-uuid"],
        getDeviceState() { return { "848": [{ id: 1, name: "Door" }] }; },
        async setIot(_uuid: string, values: Record<string, unknown>) {
          writes.push(values);
          return {};
        },
      },
    } as unknown as MeariLocalCloudRuntime;
    const managed = new MeariLocalControlAdapter(runtime).attach(camera, {
      view: {
        id: "camera-uuid",
        name: "Treat camera",
        status: "online",
        stream: "unknown",
        snapshot: "unknown",
        capabilities: [],
      },
      controller: {
        async control(capabilityId: string) { fallbackCalls.push(capabilityId); },
        async ptzStart() {},
        async ptzStop() {},
      },
    }, {});

    await managed?.controller.control("camera.presets", { action: "recall", presetId: 1 }, true);

    expect(writes).toEqual([{ "848": JSON.stringify({ idx: 1 }) }]);
    expect(fallbackCalls).toEqual([]);
  });
});

describe("local ONVIF saved-view adapter", () => {
  test("supports recall, save, and delete with validated tokens and names", async () => {
    const calls: string[] = [];
    const client = {
      async gotoPreset(profileToken: string, presetToken: string) {
        calls.push(`recall:${profileToken}:${presetToken}`);
      },
      async setPreset(profileToken: string, name: string) {
        calls.push(`save:${profileToken}:${name}`);
        return "new-preset";
      },
      async removePreset(profileToken: string, presetToken: string) {
        calls.push(`delete:${profileToken}:${presetToken}`);
      },
    } as unknown as OnvifClient;
    const controller = new OnvifCameraController(client, {
      token: "profile-1",
      rawXml: "<Profile/>",
    });

    await controller.control("camera.presets", { action: "recall", presetId: "door" });
    await controller.control("camera.presets", { action: "save", name: "Food bowl" });
    await controller.control("camera.presets", { action: "delete", presetId: "door" });
    expect(calls).toEqual([
      "recall:profile-1:door",
      "save:profile-1:Food bowl",
      "delete:profile-1:door",
    ]);
    await expect(controller.control("camera.presets", { action: "delete", presetId: "" }))
      .rejects.toMatchObject({ code: "invalid_control" });
  });
});
