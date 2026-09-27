import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { TemperatureSensor, HumiditySensor, BatterySensor, type SensorState } from "../../../models/sensor";
import { temperatureSensorSchema, humiditySensorSchema, batterySensorSchema } from "../../../models/sensor-schemas";
import { sensorDeviceSchema } from "../../../schemas";
import { H5075_NAME_PATTERN, PERIPHERAL_ID_PATTERN } from "../../../protocols/govee/advertisement";
import type { GoveeReader } from "../../../vendors/govee/receiver";

export const GOVEE_H5075_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/govee-h5075/config",
  title: "Govee H5075 config", type: "object", additionalProperties: false,
  properties: {
    peripheralId: { type: "string", pattern: PERIPHERAL_ID_PATTERN, description: "Bluetooth peripheral UUID reported by discovery on this Mac" },
    bluetoothName: { type: "string", pattern: H5075_NAME_PATTERN },
    staleAfterMs: { type: "integer", minimum: 5000, maximum: 3600000, description: "Maximum reading age in milliseconds (default 120000)" },
  }, required: ["peripheralId"],
} as const;
export type GoveeH5075Config = FromSchema<typeof GOVEE_H5075_CONFIG_SCHEMA>;

const SENSORS = [
  { id: "temperature", name: "Temperature", schemaId: temperatureSensorSchema.$id },
  { id: "humidity", name: "Humidity", schemaId: humiditySensorSchema.$id },
  { id: "battery", name: "Battery", schemaId: batterySensorSchema.$id },
] as const;

type MeasurementField = "temperatureC" | "humidityPercent" | "batteryPercent";

/** All three sensors read the same receiver cache; no extra Bluetooth requests are made. */
class GoveeObservations {
  constructor(private readonly config: GoveeH5075Config, private readonly reader: GoveeReader | undefined,
    private readonly now: () => number) {}

  state(field: MeasurementField): SensorState {
    const snapshot = this.reader?.snapshot(this.config.peripheralId);
    const sample = snapshot?.reading;
    const age = sample ? this.now() - sample.receivedAt : Infinity;
    const fresh = !!sample && !!snapshot?.scanning && age >= 0 && age <= (this.config.staleAfterMs ?? 120_000)
      && sample.peripheralId.toUpperCase() === this.config.peripheralId.toUpperCase();
    if (!fresh) return { availability: "offline", detail: !snapshot ? "Govee Bluetooth receiver is not configured"
      : !snapshot.scanning ? snapshot.detail : sample ? "No recent Bluetooth reading; move the thermometer within range and check its batteries"
      : "Waiting for this thermometer's Bluetooth broadcast; keep it near the HomeTruth Mac" };
    const observedAt = new Date(sample.receivedAt).toISOString();
    if (sample.sensorError && field !== "batteryPercent") {
      return { availability: "degraded", observedAt, detail: "The thermometer reports a sensor error" };
    }
    const value = sample[field];
    if (value === undefined) return { availability: "degraded", observedAt, detail: "No reading for this sensor" };
    return { availability: "online", value, observedAt, source: "Bluetooth advertisement" };
  }
}

class GoveeTemperatureSensor extends TemperatureSensor {
  constructor(private readonly observations: GoveeObservations) { super(SENSORS[0].id, SENSORS[0].name); }
  async getState() { return this.observations.state("temperatureC"); }
}
class GoveeHumiditySensor extends HumiditySensor {
  constructor(private readonly observations: GoveeObservations) { super(SENSORS[1].id, SENSORS[1].name); }
  async getState() { return this.observations.state("humidityPercent"); }
}
class GoveeBatterySensor extends BatterySensor {
  constructor(private readonly observations: GoveeObservations) { super(SENSORS[2].id, SENSORS[2].name); }
  async getState() { return this.observations.state("batteryPercent"); }
}

export class GoveeH5075 extends Device<GoveeH5075Config> {
  readonly model = GOVEE_H5075;
  readonly capabilities;
  override readonly sensors;
  readonly temperature: GoveeTemperatureSensor;
  readonly humidity: GoveeHumiditySensor;
  readonly battery: GoveeBatterySensor;

  constructor(instance: DeviceInstance, config: GoveeH5075Config, options: { reader?: GoveeReader; now?: () => number } = {}) {
    super(instance.id, instance.name, config);
    if (!new RegExp(PERIPHERAL_ID_PATTERN).test(config.peripheralId)) throw new Error("Govee peripheralId must be the UUID returned by Bluetooth discovery");
    const observations = new GoveeObservations(config, options.reader, options.now ?? Date.now);
    this.temperature = new GoveeTemperatureSensor(observations);
    this.humidity = new GoveeHumiditySensor(observations);
    this.battery = new GoveeBatterySensor(observations);
    this.sensors = [this.temperature, this.humidity, this.battery] as const;
    this.capabilities = this.expose({});
  }

  override displayHost(): string { return this.config.bluetoothName ?? "Bluetooth"; }
  protected override identity(): DeviceIdentity { return { model: "H5075" }; }
  async probe(): Promise<DeviceIdentity> {
    const state = await this.battery.getState();
    if (state.availability === "offline") throw new Error(state.detail);
    return this.identity();
  }
}

export const GOVEE_H5075: DeviceModel<GoveeH5075Config> = {
  id: "govee-h5075", title: "Govee H5075 Thermo-Hygrometer", manufacturer: "Govee", product: "H5075",
  capabilities: [], connectionTypes: ["bluetooth"], sensors: SENSORS, configSchema: GOVEE_H5075_CONFIG_SCHEMA, objectSchemaId: sensorDeviceSchema.$id,
  create: (instance, config, services) => new GoveeH5075(instance, config, services.govee ? { reader: services.govee } : {}),
};
