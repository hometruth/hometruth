import { observedKindleState } from "../../../kindle/test-fixture";
import { describe, expect, test } from "bun:test";
import { GoveeH5075 } from ".";
import { TemperatureSensor, HumiditySensor, BatterySensor } from "../../../models/sensor";
import { sensorDeviceSchema } from "../../../schemas";
import { buildKindleSnapshot } from "../../../kindle/presentation";
import { kindleElements } from "../../../kindle/elements";
import { DEFAULT_KINDLE_CONFIG } from "../../../kindle/config";
import { createTranslator } from "../../../ui/i18n";
import { Site, registeredView, summaryDetail } from "../../../site";
import { validators } from "../../../validation";
import type { GoveeSnapshot } from "../../../vendors/govee/receiver";
import { createApp } from "../../../server/app";
import { CameraService } from "../../../vendors/tkenpro/camera-service";

const peripheralId = "00000000-0000-0000-0000-000000000001";
const receivedAt = Date.parse("2026-01-01T12:00:00Z");
const reading = { peripheralId, name: "GVH5075_ABCD", receivedAt, temperatureC: 28, humidityPercent: 47.3, batteryPercent: 100, sensorError: false };

describe("Govee H5075 device", () => {
  test("one physical device exposes three timestamped sensors through the normal API and page", async () => {
    const reader = { snapshot: (): GoveeSnapshot => ({ scanning: true, detail: "Listening", reading }) };
    const device = new GoveeH5075({ id: "govee", name: "Thermometer" }, { peripheralId, bluetoothName: reading.name }, { reader, now: () => receivedAt + 2000 });
    const object = await device.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(object).toMatchObject({ status: "online", model: "H5075" });
    expect(object.sensors!.map(s => [s.id, s.state.value, s.unit])).toEqual([
      ["temperature", 28, "°C"], ["humidity", 47.3, "%"], ["battery", 100, "%"],
    ]);
    expect(object.sensors!.every(sensor => sensor.state.observedAt === "2026-01-01T12:00:00.000Z")).toBe(true);
    expect(object.capabilities).toEqual({});
    expect(device.sensors).toHaveLength(3);
    expect(device.temperature).toBeInstanceOf(TemperatureSensor);
    expect(device.humidity).toBeInstanceOf(HumiditySensor);
    expect(device.battery).toBeInstanceOf(BatterySensor);
    expect(validators.temperatureSensor(object.sensors![0])).toBe(true);
    expect(validators.humiditySensor(object.sensors![1])).toBe(true);
    expect(validators.batterySensor(object.sensors![2])).toBe(true);
    expect(validators.sensorDevice(object)).toBe(true);
    expect(device.model.objectSchemaId).toBe(sensorDeviceSchema.$id);
    expect(summaryDetail(object)).toContain("Humidity 47.3 %");
    expect(registeredView(device)).toMatchObject({ kind: "device", host: "GVH5075_ABCD" });
    expect(await device.probe()).toEqual({ model: "H5075" });
    expect(device.controls()).toEqual([]);
    expect(await device.temperature.getState()).toMatchObject({ value: 28, availability: "online" });
    await expect(device.invokeControl("calibrate")).rejects.toThrow();
    const app = createApp(new CameraService({
      async discoverLocal() { return []; },
      async connectCloud() { return { async discover() { return []; } }; },
    }), new Site([device]));
    const response = await app.request("/api/devices/govee");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validators.deviceDetailResponse(body)).toBe(true);
    expect(body.page).toBe("/devices/thermometer");
    expect(body.model.sensors.map((sensor: { schemaId: string }) => sensor.schemaId)).toEqual(object.sensors!.map(sensor => sensor.schemaId));
    const removed = await app.request("/sensors/thermometer");
    expect(removed.status).toBe(404);
    expect(removed.headers.get("location")).toBeNull();
    const html = await (await app.request(body.page)).text();
    expect(html).toContain('id="device-sensors"');
    expect(html).toContain('id="sensors-heading">Sensors');
    const list = await (await app.request("/api/devices")).json();
    expect(validators.deviceListResponse(list)).toBe(true);
    expect(list.devices[0]).toMatchObject({ kind: "device", page: "/devices/thermometer" });
    const models = await (await app.request("/api/models")).json();
    expect(validators.modelListResponse(models)).toBe(true);
    expect(models.models.find((model: { id: string }) => model.id === "govee-h5075").sensors).toHaveLength(3);
  });

  test("stale data, missing device, adapter failure, and wrong identity never look live; new broadcasts recover", async () => {
    let now = receivedAt + 120_001;
    let snapshot: GoveeSnapshot = { scanning: true, detail: "Listening", reading };
    const device = new GoveeH5075({ id: "govee", name: "Thermometer" }, { peripheralId }, { reader: { snapshot: () => snapshot }, now: () => now });
    for (const candidate of [snapshot, { scanning: true, detail: "Listening" }, { ...snapshot, scanning: false }, { ...snapshot, reading: { ...reading, peripheralId: "00000000-0000-0000-0000-000000000002", receivedAt: now } }]) {
      snapshot = candidate;
      const sensors = await device.getSensors();
      expect(sensors.every(sensor => sensor.state.availability === "offline")).toBe(true);
      expect(sensors.every(sensor => sensor.state.value === undefined && sensor.state.observedAt === undefined)).toBe(true);
      expect(validators.homeTruthObject(await device.describe())).toBe(true);
      await expect(device.probe()).rejects.toThrow();
    }
    now += 1000;
    snapshot = { scanning: true, detail: "Listening", reading: { ...reading, receivedAt: now } };
    expect((await device.describe()).status).toBe("online");
    snapshot = { ...snapshot, reading: { ...reading, receivedAt: now + 1000 } };
    expect((await device.describe()).status).toBe("offline");
  });

  test("sensor fault retains battery but does not show temperature or humidity", async () => {
    const device = new GoveeH5075({ id: "govee", name: "Thermometer" }, { peripheralId }, { now: () => receivedAt, reader: {
      snapshot: () => ({ scanning: true, detail: "Listening", reading: { peripheralId, receivedAt, name: reading.name, batteryPercent: 0, sensorError: true } }),
    } });
    const object = await device.describe();
    expect(object.status).toBe("degraded");
    expect(object.sensors![0]!.state).toMatchObject({ availability: "degraded" });
    expect(object.sensors![0]!.state.value).toBeUndefined();
    expect(object.sensors![1]!.state.value).toBeUndefined();
    expect(object.sensors![2]!.state).toMatchObject({ value: 0, availability: "online" });
    expect(validators.homeTruthObject(await device.describe())).toBe(true);
  });

  test("registry provisions valid config and rejects IP addresses, extra fields, and invalid freshness", async () => {
    const make = (config: Record<string, unknown>) => Site.fromConfig({ schemaVersion: 2, devices: [{ id: "govee", model: "govee-h5075", config }] });
    expect(make({ peripheralId }).get("govee")).toBeInstanceOf(GoveeH5075);
    expect((await make({ peripheralId }).get("govee")!.describe()).status).toBe("offline");
    for (const config of [{ peripheralId: "10.77.0.10" }, { peripheralId, host: "example.com" }, { peripheralId, staleAfterMs: 1 }, { peripheralId, bluetoothName: "other" }]) {
      expect(() => make(config)).toThrow();
    }
  });

  test("Kindle device widgets display component sensors and clear stale readings", async () => {
    let now = receivedAt;
    const device = new GoveeH5075({ id: "govee", name: "Thermometer" }, { peripheralId }, {
      reader: { snapshot: () => ({ scanning: true, detail: "Listening", reading }) }, now: () => now,
    });
    const site = new Site([device]);
    expect(kindleElements(site)[0]!.capabilities).toEqual([]);
    {
      const capability = "auto" as const;
      const config = { ...DEFAULT_KINDLE_CONFIG, selection: "custom" as const, items: [{ deviceId: device.id, capability, mode: "auto" as const, label: "" }] };
      now = receivedAt;
      const live = await buildKindleSnapshot(site, config, await observedKindleState(site), createTranslator("en"));
      expect(live.rows[0]!.missing).toBe(false);
      expect(live.rows[0]!.primitives.map(sensor => [sensor.label, sensor.detail, sensor.actions])).toEqual([
        ["Temperature", "28 °C", []], ["Humidity", "47.3 %", []], ["Battery", "100 %", []],
      ]);
      now += 120_001;
      const stale = await buildKindleSnapshot(site, config, await observedKindleState(site), createTranslator("en"));
      expect(stale.rows[0]!.primitives).toHaveLength(3);
      expect(stale.rows[0]!.primitives.every(sensor => sensor.availability === "offline" && !sensor.detail.includes("28"))).toBe(true);
    }
  });
});
