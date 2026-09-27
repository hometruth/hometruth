import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { SensorCollection, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { sensorCollectionSchema } from "../../../models/sensor-schemas";

export const AIRGRADIENT_ONE_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/airgradient-one/config",
  title: "AirGradient ONE config", type: "object", additionalProperties: false,
  properties: {
    host: lanHostSchema,
    port: { type: "integer", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  }, required: ["host"],
} as const;
export type AirGradientOneConfig = FromSchema<typeof AIRGRADIENT_ONE_CONFIG_SCHEMA>;
export type AirGradientFetch = (url: URL, init?: RequestInit) => Promise<Response>;

interface Measurement {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  fields: readonly string[];
  min: number;
  max?: number;
}

// Field meanings: https://github.com/airgradienthq/arduino/blob/master/docs/local-server.md
// Prefer the firmware's corrected values; do not apply corrections a second time.
const MEASUREMENTS: readonly Measurement[] = [
  { id: "co2", name: "CO₂", quantity: "carbonDioxide", unit: "ppm", fields: ["rco2"], min: 1 },
  { id: "temperature", name: "Temperature", quantity: "temperature", unit: "°C", fields: ["atmpCompensated", "atmp"], min: -55, max: 125 },
  { id: "humidity", name: "Humidity", quantity: "relativeHumidity", unit: "%", fields: ["rhumCompensated", "rhum"], min: 0, max: 100 },
  { id: "pm1", name: "PM1", quantity: "particulateMatter1", unit: "µg/m³", fields: ["pm01"], min: 0 },
  { id: "pm2-5", name: "PM2.5", quantity: "particulateMatter2.5", unit: "µg/m³", fields: ["pm02Compensated", "pm02"], min: 0 },
  { id: "pm10", name: "PM10", quantity: "particulateMatter10", unit: "µg/m³", fields: ["pm10"], min: 0 },
  { id: "voc", name: "VOC", quantity: "vocIndex", unit: "index", fields: ["tvocIndex"], min: 1, max: 500 },
  { id: "nox", name: "NOx", quantity: "noxIndex", unit: "index", fields: ["noxIndex"], min: 1, max: 500 },
];

function readings(body?: Record<string, unknown>, observedAt?: string): SensorCollectionReading[] {
  return MEASUREMENTS.map(({ id, name, quantity, unit, fields, min, max }) => {
    const source = fields.find((field) => {
      const value = body?.[field];
      return typeof value === "number" && Number.isFinite(value) && value >= min && (max === undefined || value <= max);
    });
    return {
      id, name, quantity, unit,
      ...(source && observedAt
        ? { availability: "online" as const, value: body![source] as number, source, observedAt }
        : { availability: body ? "unknown" as const : "offline" as const }),
    };
  });
}

class AirGradientSensors extends SensorCollection {
  override readonly inventory = MEASUREMENTS.map(({ id, name }) => ({ id, name }));
  constructor(id: string, private readonly read: () => Promise<Record<string, unknown>>) { super(id); }

  async getState(): Promise<SensorCollectionState> {
    let body: Record<string, unknown>;
    try { body = await this.read(); }
    catch (error) {
      return { availability: "offline", detail: (error instanceof Error ? error.message : "AirGradient is unreachable").slice(0, 500), sensors: readings() };
    }
    const observedAt = new Date().toISOString();
    const sensors = readings(body, observedAt);
    const complete = sensors.every((sensor) => sensor.availability === "online");
    return {
      availability: complete ? "online" : "degraded", observedAt, sensors,
      ...(!complete ? { detail: "Some sensors are warming up or have no valid reading" } : {}),
    };
  }
}

export interface AirGradientOne extends CapabilityMethods<{ sensor: AirGradientSensors }> {}

/** One physical AirGradient, with several sensors sharing one local HTTP snapshot. */
export class AirGradientOne extends Device<AirGradientOneConfig> {
  readonly model = AIRGRADIENT_ONE;
  readonly capabilities;
  readonly measurements: AirGradientSensors;
  private readonly fetchImpl: AirGradientFetch;
  private readonly url: URL;
  private knownIdentity: DeviceIdentity | undefined;
  private pending: Promise<Record<string, unknown>> | undefined;

  constructor(instance: DeviceInstance, config: AirGradientOneConfig, options: { fetch?: AirGradientFetch } = {}) {
    super(instance.id, instance.name, config);
    if (!/^[A-Za-z0-9.-]+$/u.test(config.host) || !isSafeCameraUri(`http://${config.host}/`)) {
      throw new Error("AirGradient host must be a private LAN address");
    }
    const port = config.port ?? 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AirGradient port must be from 1 to 65535");
    this.url = new URL(`http://${config.host}:${port}/measures/current`);
    this.fetchImpl = options.fetch ?? fetch;
    this.measurements = new AirGradientSensors(instance.id, () => this.read());
    this.capabilities = this.expose({ sensor: this.measurements });
  }

  protected override identity(): DeviceIdentity | undefined { return this.knownIdentity; }

  async probe(): Promise<DeviceIdentity> {
    await this.read();
    return this.knownIdentity!;
  }

  private async read(): Promise<Record<string, unknown>> {
    // Concurrent page, summary, and probe requests share one device request.
    this.pending ??= this.request().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async request(): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(this.url, {
      method: "GET", redirect: "error", headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 2500),
    });
    if (!response.ok) throw new Error(`AirGradient returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid AirGradient response");
    const data = body as Record<string, unknown>;
    if (typeof data.serialno !== "string" || !/^[a-f0-9]{12}$/iu.test(data.serialno)
      || typeof data.model !== "string" || !/^I-9PSL(?:-|$)/u.test(data.model) || data.model.length > 100
      || typeof data.firmware !== "string" || !data.firmware || data.firmware.length > 100) {
      throw new Error("Response is not an AirGradient ONE");
    }
    this.knownIdentity = { serialNumber: data.serialno, model: data.model, firmwareVersion: data.firmware };
    return data;
  }
}

export const AIRGRADIENT_ONE: DeviceModel<AirGradientOneConfig> = {
  id: "airgradient-one", title: "AirGradient ONE", manufacturer: "AirGradient", product: "ONE",
  capabilities: ["sensor"], connectionTypes: ["direct-local"], configSchema: AIRGRADIENT_ONE_CONFIG_SCHEMA, objectSchemaId: sensorCollectionSchema.$id,
  create: (instance, config) => new AirGradientOne(instance, config),
};
