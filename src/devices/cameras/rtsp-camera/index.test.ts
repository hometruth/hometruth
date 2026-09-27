import { describe, expect, test } from "bun:test";
import { provisionDevice } from "../../../config/provision";
import type { RtspProbe, RtspProbeOptions } from "../../../protocols/rtsp/probe";
import { MODELS } from "../../../registry";
import { RTSP_CAMERA, RtspCamera } from "./index";

const instance = { id: "yard-camera", name: "Yard camera" };
const config = { host: "192.168.50.170", port: 8554, path: "/live" };
const online: RtspProbe = async () => ({ statusCode: 200, methods: ["OPTIONS", "DESCRIBE"], authRequired: false });
const entry = { ...instance, model: "rtsp-camera", config };

describe("RTSP camera", () => {
  test("registered model provisions a camera with the configured media source", () => {
    const device = provisionDevice(entry, MODELS, {}) as RtspCamera;
    expect(device).toBeInstanceOf(RtspCamera);
    expect(device.camera.mediaSource()).toEqual({ streamUri: "rtsp://192.168.50.170:8554/live" });
    expect(device.controls()).toEqual([]);
    expect(device.reboot).toBeUndefined();
  });

  test("online endpoint offers browser video and JPEG snapshots without physical controls", async () => {
    const probes: RtspProbeOptions[] = [];
    const device = new RtspCamera(instance, { ...config, path: "/live?channel=2", timeoutMs: 1200 }, {}, {
      probe: async options => { probes.push(options); return online(options); },
    });
    const document = await device.describe();
    expect(document.status).toBe("online");
    expect(document.capabilities.camera).toEqual({
      id: "camera",
      state: { availability: "online", streamAvailable: true, snapshotAvailable: true },
      actions: { snapshot: { mediaTypes: ["image/jpeg"] } },
    });
    expect(probes).toEqual([{ host: config.host, port: 8554, path: "/live?channel=2", timeoutMs: 1200 }]);
    expect(await device.probe()).toEqual({});
    await expect(device.camera.invoke("pan.left")).rejects.toMatchObject({ code: "not_supported" });
    await expect(device.camera.invoke("setPrivacy", true)).rejects.toMatchObject({ code: "not_supported" });
  });

  test("connection failures stay offline and explicit probes reject", async () => {
    const device = new RtspCamera(instance, config, {}, { probe: async () => { throw new Error("Connection refused"); } });
    expect((await device.describe()).capabilities.camera?.state).toEqual({
      availability: "offline", streamAvailable: false, snapshotAvailable: false,
    });
    await expect(device.probe()).rejects.toThrow("Connection refused");
  });

  test("authentication challenge requires stored credentials and never sends them in a probe", async () => {
    const probe: RtspProbe = async options => {
      expect(Object.keys(options).sort()).toEqual(["host", "path", "port", "timeoutMs"]);
      return { statusCode: 401, methods: [], authRequired: true };
    };
    const locked = new RtspCamera(instance, config, {}, { probe });
    expect((await locked.state()).availability).toBe("degraded");
    expect((await locked.state()).streamAvailable).toBe(false);
    const secrets = { rtsp: { username: "viewer", password: "synthetic-example" } };
    const device = new RtspCamera(instance, config, secrets, { probe });
    expect(device.mediaSource()).toEqual({ streamUri: "rtsp://192.168.50.170:8554/live", ...secrets.rtsp });
    const document = await device.describe();
    expect(document.capabilities.camera?.state.streamAvailable).toBe(true);
    expect(JSON.stringify(document)).not.toContain("synthetic-example");
  });

  test("RTSP errors do not advertise usable video", async () => {
    for (const statusCode of [404, 500]) {
      const device = new RtspCamera(instance, config, {}, {
        probe: async () => ({ statusCode, methods: [], authRequired: false }),
      });
      expect(await device.state()).toEqual({ availability: "degraded", streamAvailable: false, snapshotAvailable: false });
    }
  });

  test("default RTSP port and timeout are used", async () => {
    const device = new RtspCamera(instance, { host: "camera.local", path: "/" }, {}, {
      probe: async options => {
        expect(options).toEqual({ host: "camera.local", port: 554, path: "/", timeoutMs: 3000 });
        return online(options);
      },
    });
    expect(device.mediaSource().streamUri).toBe("rtsp://camera.local:554/");
    await device.probe();
  });

  test("provisioning rejects public hosts, malformed paths, credentials and unknown config", () => {
    for (const invalid of [
      { ...config, host: "8.8.8.8" },
      { ...config, host: "example.com" },
      { ...config, host: "viewer@192.168.50.170" },
      { ...config, path: "live" },
      { ...config, path: "/live\r\nCSeq: 2" },
      { ...config, path: "/live#fragment" },
      { ...config, path: "/live?token=synthetic" },
      { ...config, port: 0 },
      { ...config, port: 65536 },
      { ...config, password: "synthetic" },
      { ...config, timeoutMs: 0 },
    ]) expect(() => provisionDevice({ ...entry, config: invalid }, [RTSP_CAMERA], {})).toThrow();
  });

  test("provisioning validates optional credentials", () => {
    expect(() => provisionDevice(entry, [RTSP_CAMERA], {}, {
      schemaVersion: 1,
      devices: { [instance.id]: { rtsp: { username: "viewer" } } },
    })).toThrow(/secrets/u);
    const device = provisionDevice(entry, [RTSP_CAMERA], {}, {
      schemaVersion: 1,
      devices: { [instance.id]: { rtsp: { username: "viewer", password: "synthetic-example" } } },
    }) as RtspCamera;
    expect(device.mediaSource().username).toBe("viewer");
  });
});
