import { describe, expect, test } from "bun:test";
import { Device, type DeviceModel } from "./device";
import { Sensor, TemperatureSensor, type SensorState } from "./sensor";
import { temperatureSensorSchema, humiditySensorSchema, batterySensorSchema, sensorDeviceSchema } from "../schemas";
import { validators } from "../validation";

const observedAt = "2026-09-12T12:00:00.000Z";
const observation = (value: number) => ({ availability: "online" as const, value, observedAt });
const sensor = (schema: typeof temperatureSensorSchema | typeof humiditySensorSchema | typeof batterySensorSchema, value: number) => ({
  id: "reading", name: "Reading", schemaId: schema.$id, kind: schema.properties.kind.const, unit: schema.properties.unit.const, state: observation(value),
});

class TestTemperature extends TemperatureSensor {
  constructor(id: string, private readonly state: SensorState = observation(22)) { super(id, id); }
  async getState() { return this.state; }
}

class TestDevice extends Device {
  readonly model: DeviceModel = {
    id: "test-device", title: "Test device", manufacturer: "Test", product: "Test",
    capabilities: [], objectSchemaId: sensorDeviceSchema.$id,
    connectionTypes: ["direct-local"],
    configSchema: { $id: "https://hometruth.ai/schemas/models/test-device/config", type: "object" },
    create: () => { throw new Error("Not used"); },
  };
  readonly capabilities = {};
  constructor(override readonly sensors: readonly Sensor[]) { super("test", "Test device", {}); }
  async probe() { return {}; }
}

describe("individual sensor schemas", () => {
  test("each type enforces its own identity, unit, and measurement bounds", () => {
    for (const [schema, validate, values, invalid] of [
      [temperatureSensorSchema, validators.temperatureSensor, [-273.15, -5, 0, 22.5], [-273.16]],
      [humiditySensorSchema, validators.humiditySensor, [0, 47.3, 100], [-0.1, 100.1]],
      [batterySensorSchema, validators.batterySensor, [0, 75.5, 100], [-0.1, 100.1]],
    ] as const) {
      for (const value of values) expect(validate(sensor(schema, value))).toBe(true);
      for (const value of [...invalid, NaN, Infinity]) expect(validate(sensor(schema, value))).toBe(false);
      const valid = sensor(schema, 22);
      expect(validators.sensor(valid)).toBe(true);
      expect(validate({ ...valid, schemaId: "https://example.com/wrong-schema" })).toBe(false);
      expect(validate({ ...valid, unit: "wrong" })).toBe(false);
      expect(validate({ ...valid, extra: true })).toBe(false);
      expect(validate({ ...valid, state: { availability: "online", value: 22 } })).toBe(false);
      expect(validate({ ...valid, state: { availability: "online", observedAt } })).toBe(false);
      expect(validate({ ...valid, state: { ...observation(22), observedAt: "yesterday" } })).toBe(false);
      for (const availability of ["offline", "unknown"]) {
        expect(validate({ ...valid, state: { availability } })).toBe(true);
        expect(validate({ ...valid, state: { ...observation(22), availability } })).toBe(false);
      }
      expect(validate({ ...valid, state: { availability: "degraded", detail: "Sensor fault", observedAt } })).toBe(true);
    }
    expect(validators.humiditySensor(sensor(batterySensorSchema, 50))).toBe(false);
    expect(validators.batterySensor(sensor(temperatureSensorSchema, 50))).toBe(false);
  });

  test("a device accepts N sensors, including several of one type, and aggregates their availability", async () => {
    const device = new TestDevice([new TestTemperature("inside"), new TestTemperature("outside", { availability: "offline" })]);
    const document = await device.describe();
    expect(validators.sensorDevice(document)).toBe(true);
    expect(document.sensors!.map(sensor => sensor.id)).toEqual(["inside", "outside"]);
    expect(document.status).toBe("degraded");
    expect(document.capabilities).toEqual({});
    const one = await new TestDevice([new TestTemperature("one")]).describe();
    expect(one.status).toBe("online");
    expect(validators.sensorDevice(one)).toBe(true);
    const mixed = { ...document, capabilities: { binarySwitch: { id: "switch", state: { availability: "online", value: "off", observedAt }, actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } } } };
    expect(validators.homeTruthObject(mixed)).toBe(true);
    expect(validators.sensorDevice(mixed)).toBe(true);
    expect(validators.homeTruthObject({ ...document, sensors: [] })).toBe(false);
    expect(validators.sensorDevice({ schemaVersion: 1, id: "empty", name: "Empty", capabilities: {} })).toBe(false);
    expect(validators.homeTruthObject({ schemaVersion: 1, id: "empty", name: "Empty", capabilities: {} })).toBe(false);
  });

  test("device composition rejects duplicate ids and invalid child observations", async () => {
    await expect(new TestDevice([new TestTemperature("same"), new TestTemperature("same")]).describe()).rejects.toThrow("Duplicate sensor id");
    await expect(new TestDevice([new TestTemperature("invalid", observation(-300))]).describe()).rejects.toThrow("Invalid sensor invalid");
  });
});
