import { describe, expect, test } from "bun:test";
import { Camera } from "../../../models/camera";
import { TreatDispenser } from "../../../models/treat-dispenser";
import type { CameraControlRequest, CameraPtzRequest } from "../../../schemas";
import type { CameraDashboardModel, CameraDeviceView } from "../../../ui/dashboard";
import { validators } from "../../../validation";
import { TkenproCamera, TkenproPet3T, TkenproTreatDispenser, type TkenproCameraLink } from "./index";

function link(view: CameraDeviceView | undefined) {
  const controls: CameraControlRequest[] = [];
  const ptz: CameraPtzRequest[] = [];
  const model: CameraDashboardModel = { setup: { configured: false, profile: null }, discovery: { status: "idle" }, devices: view ? [view] : [], selectedDeviceId: view?.id ?? null };
  const service: TkenproCameraLink = {
    state: () => model,
    async control(input) { controls.push(input); return undefined; },
    async ptz(input) { ptz.push(input); return undefined; },
    async rebootCamera() { return undefined; },
  };
  return { service, controls, ptz };
}

const online: CameraDeviceView = {
  id: "100000001",
  name: "100000001",
  host: "10.78.0.147",
  model: "Pet 3T",
  firmware: "5.7.3",
  status: "online",
  stream: "available",
  snapshot: "available",
  capabilities: [
    { id: "feed.portions", category: "feeding", label: "Dispense a treat", kind: "treat", availability: "available", min: 1, max: 1, step: 1, confirmation: "confirm" },
    { id: "feed.sound", category: "feeding", label: "Dispense sound", kind: "toggle", availability: "available", value: true },
    { id: "camera.ptz", category: "movement", label: "PTZ move", kind: "ptz", availability: "available" },
    { id: "device.statusLed", category: "privacy", label: "Status LED", kind: "toggle", availability: "available", value: true },
  ],
};

function camera(view: CameraDeviceView | undefined) {
  const wire = link(view);
  const device = new TkenproPet3T({ id: "kitchen", name: "Kitchen" }, { host: "10.78.0.147", serialNumber: "100000001" }, wire.service);
  return { device, ...wire };
}

describe("TkenproPet3T", () => {
  test("is composed of a Camera and a TreatDispenser subclass", async () => {
    const { device } = camera(online);
    expect(device.capabilities.camera).toBeInstanceOf(TkenproCamera);
    expect(device.capabilities.camera).toBeInstanceOf(Camera);
    expect(device.capabilities.treatDispenser).toBeInstanceOf(TkenproTreatDispenser);
    expect(device.capabilities.treatDispenser).toBeInstanceOf(TreatDispenser);
    const object = await device.describe();
    expect(validators.petTreatDispenserCamera(object)).toBe(true);
    expect(object.capabilities.camera?.actions?.pan).toBeDefined();
    expect(object.capabilities.treatDispenser?.actions.dispense).toEqual({ minimumPortions: 1, maximumPortions: 1, step: 1, confirmation: "confirm" });
    expect(object).toMatchObject({ status: "online", model: "Pet 3T", serialNumber: "100000001", firmwareVersion: "5.7.3" });
  });

  test("dispenses one treat per command through the firmware's feed control and passes other feeding controls through", async () => {
    const { device, controls } = camera(online);
    await device.invoke("treatDispenser", "dispense", undefined, { confirmed: true });
    await device.invoke("treatDispenser", "dispense", 1, { confirmed: true });
    await expect(device.invoke("treatDispenser", "dispense", 1)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(device.invoke("treatDispenser", "dispense", 2, { confirmed: true })).rejects.toMatchObject({ code: "invalid_value" });
    await device.invoke("treatDispenser", "feed.sound", false);
    await expect(device.invoke("treatDispenser", "device.statusLed", false)).rejects.toMatchObject({ code: "unknown_control" });
    expect(controls).toEqual([
      { deviceId: "100000001", capabilityId: "feed.portions", value: 1, confirmed: true },
      { deviceId: "100000001", capabilityId: "feed.portions", value: 1, confirmed: true },
      { deviceId: "100000001", capabilityId: "feed.sound", value: false, confirmed: false },
    ]);
  });

  test("moves through the service's leased PTZ and passes other camera controls through", async () => {
    const { device, controls, ptz } = camera(online);
    await device.invoke("camera", "pan.left", 500);
    await device.invoke("camera", "stopMovement");
    await device.invoke("camera", "device.statusLed", false);
    await expect(device.invoke("camera", "feed.sound", false)).rejects.toMatchObject({ code: "unknown_control" });
    expect(ptz.map((input) => [input.action, input.direction, input.leaseMs])).toEqual([["start", "left", 500], ["stop", undefined, undefined]]);
    expect(controls).toEqual([{ deviceId: "100000001", capabilityId: "device.statusLed", value: false, confirmed: false }]);
  });

  test("an unreached camera is offline, offers only snapshots, and refuses writes", async () => {
    const { device } = camera(undefined);
    const object = await device.describe();
    expect(object.status).toBe("offline");
    expect(Object.keys(object.capabilities.camera?.actions ?? {})).toEqual(["snapshot"]);
    await expect(device.invoke("treatDispenser", "dispense", 1, { confirmed: true })).rejects.toMatchObject({ code: "not_supported" });
    await expect(device.probe()).rejects.toThrow(/not reachable/u);
  });
});
