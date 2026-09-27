import { describe, expect, test } from "bun:test";
import { AirGradientOne, type AirGradientFetch } from ".";
import { Site, registeredView, summaryDetail } from "../../../site";
import { validators } from "../../../validation";
import { createApp } from "../../../server/app";
import { CameraService } from "../../../vendors/tkenpro/camera-service";

// Captured from the local I-9PSL, firmware 3.7.0. No cloud credentials needed.
const sample = {
  pm01: 0, pm02: 0, pm10: 0, pm02Compensated: 3.1,
  atmp: 26.68, atmpCompensated: 26.68, rhum: 41.07, rhumCompensated: 41.07,
  rco2: 733.33, tvocIndex: 183.58, noxIndex: 1,
  serialno: "d83bda1f850c", firmware: "3.7.0", model: "I-9PSL",
};
const make = (fetch: AirGradientFetch) => new AirGradientOne({ id: "airgradient", name: "AirGradient ONE" }, { host: "10.77.0.80" }, { fetch });

describe("AirGradient ONE", () => {
  test("reads eight sensors from one local snapshot, preserving zeros and identity", async () => {
    let calls = 0;
    const device = make(async (url, init) => {
      calls++;
      expect(url.href).toBe("http://10.77.0.80/measures/current");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(sample);
    });
    const [object, identity] = await Promise.all([device.describe(), device.probe()]);
    expect(calls).toBe(1);
    expect(identity).toEqual({ model: "I-9PSL", firmwareVersion: "3.7.0", serialNumber: sample.serialno });
    expect(object).toMatchObject({ status: "online", ...identity });
    expect(validators.homeTruthObject(object)).toBe(true);
    const state = object.capabilities.sensor!.state;
    expect(state.sensors).toHaveLength(8);
    expect(new Set(state.sensors.map((s) => s.id)).size).toBe(8);
    expect(state.sensors.find((s) => s.id === "pm2-5")).toMatchObject({ value: 3.1, unit: "µg/m³", source: "pm02Compensated" });
    expect(state.sensors.find((s) => s.id === "pm1")).toMatchObject({ value: 0, availability: "online" });
    expect(state.sensors.every((s) => s.observedAt === state.observedAt)).toBe(true);
    expect(summaryDetail(object)).toContain("CO₂ 733.3 ppm");
    expect(registeredView(device).kind).toBe("sensor");
    expect(device.controls()).toEqual(["getState"]);
    expect((await device.invokeControl("sensor.getState") as { sensors: unknown[] }).sensors).toHaveLength(8);
    await expect(device.invoke("sensor", "calibrate")).rejects.toThrow("has no control");
  });

  test("falls back from invalid corrected fields and marks missing/warming sensors unavailable", async () => {
    const device = make(async () => Response.json({
      ...sample, atmpCompensated: -1000, atmp: -5, rhumCompensated: null,
      pm02Compensated: null, noxIndex: 0, tvocIndex: -1, rco2: "700",
    }));
    const state = await device.getState();
    expect(state.availability).toBe("degraded");
    expect(state.sensors.find((s) => s.id === "temperature")).toMatchObject({ value: -5, source: "atmp" });
    expect(state.sensors.find((s) => s.id === "humidity")).toMatchObject({ value: 41.07, source: "rhum" });
    expect(state.sensors.find((s) => s.id === "pm2-5")).toMatchObject({ value: 0, source: "pm02" });
    for (const id of ["nox", "voc", "co2"]) {
      const reading = state.sensors.find((s) => s.id === id)!;
      expect(reading.availability).toBe("unknown");
      expect(reading.value).toBeUndefined();
      expect(reading.observedAt).toBeUndefined();
    }
    expect(validators.homeTruthObject(await device.describe())).toBe(true);
  });

  test("clears readings after connection failure and recovers on the next request", async () => {
    let offline = false;
    const device = make(async () => { if (offline) throw new Error("Connection refused"); return Response.json(sample); });
    await device.getState();
    offline = true;
    const object = await device.describe();
    expect(object.status).toBe("offline");
    expect(object.capabilities.sensor!.state.sensors.every((s) => s.value === undefined && s.observedAt === undefined)).toBe(true);
    await expect(device.probe()).rejects.toThrow("Connection refused");
    offline = false;
    expect((await device.getState()).availability).toBe("online");
  });

  test("rejects failed HTTP, malformed responses, and a different device at the address", async () => {
    for (const response of [new Response("no", { status: 503 }), new Response("not json"), Response.json([]), Response.json({}), Response.json({ ...sample, model: "different-device" })]) {
      const device = make(async () => response.clone());
      expect((await device.getState()).availability).toBe("offline");
      await expect(device.probe()).rejects.toThrow();
    }
    for (const host of ["example.com", "8.8.8.8", "10.77.0.80@evil.test", "10.77.0.80/path"]) {
      expect(() => new AirGradientOne({ id: "air", name: "Air" }, { host })).toThrow("private LAN");
    }
  });

  test("provisions from config and serves the device page and validated API", async () => {
    const configured = Site.fromConfig({ schemaVersion: 2, devices: [{ id: "airgradient", name: "AirGradient ONE", model: "airgradient-one", config: { host: "10.77.0.80" } }] }, {});
    expect(configured.get("airgradient")).toBeInstanceOf(AirGradientOne);
    const device = make(async () => Response.json(sample));
    const app = createApp(new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() { return []; },
    }), new Site([device]));
    const response = await app.request("/api/devices/airgradient");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(validators.deviceDetailResponse(result)).toBe(true);
    expect(result.object.capabilities.sensor.state.sensors).toHaveLength(8);
    const html = await (await app.request("/sensors/airgradient-one")).text();
    expect(html).toContain("data-sensor-page");
    expect(html).not.toContain('id="pairing"');
    expect(html).not.toContain("Enter this accessory's HomeKit code");
  });
});
