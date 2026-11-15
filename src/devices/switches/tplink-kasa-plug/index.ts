import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { sensorCollectionSchema } from "../../../models/sensor-schemas";
import { SensorCollection, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { KasaClient, type KasaRealtime, type KasaSysinfo, type KasaTransport } from "../../../protocols/tplink-kasa/client";
import { KasaError } from "../../../protocols/tplink-kasa/codec";
import { binarySwitchSchema } from "../../../schemas";

/** Products on the legacy unauthenticated local protocol, with their outlet count and whether they meter energy. */
export const KASA_PLUG_PRODUCTS = {
  EP10: { outlets: 1, energyMeter: false },
  EP40: { outlets: 2, energyMeter: false },
  KP115: { outlets: 1, energyMeter: true },
  HS300: { outlets: 6, energyMeter: true },
} as const;
export type KasaPlugProduct = keyof typeof KASA_PLUG_PRODUCTS;

/** Does the model string the device reports (`EP40(US)`) name this product? */
export function reportsProduct(reported: string, product: KasaPlugProduct): boolean {
  return reported === product || reported.startsWith(`${product}(`);
}

export const TPLINK_KASA_PLUG_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tplink-kasa-plug/config",
  title: "TP-Link Kasa plug config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of the plug or strip. */
    host: lanHostSchema,
    /** The product, as printed on the label without the region suffix. The device must report the same model. */
    model: { enum: ["EP10", "EP40", "KP115", "HS300"] },
    /** Zero-based outlet on a multi-outlet device (EP40: 0–1, HS300: 0–5); omit on single-outlet plugs. */
    outlet: { type: "integer", minimum: 0, maximum: 5 },
    timeoutMs: { type: "integer", minimum: 500, maximum: 10000 },
  },
  required: ["host", "model"],
} as const;
export type TplinkKasaPlugConfig = FromSchema<typeof TPLINK_KASA_PLUG_CONFIG_SCHEMA>;

function switchError(error: unknown): BinarySwitchError {
  if (error instanceof BinarySwitchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BinarySwitchError(message, error instanceof KasaError && error.code === "unreachable" ? "unreachable" : "protocol");
}

/** One outlet of a Kasa plug or strip. Every operation is one request on the device's shared queue. */
export class KasaOutletSwitch extends BinarySwitch {
  constructor(id: string, private readonly plug: TplinkKasaPlug) { super(id); }

  override async getState(): Promise<BinarySwitchState> {
    return (await this.plug.readOutlet()).on ? "on" : "off";
  }
  override async turnOn(): Promise<void> { await this.plug.setOutlet(true); }
  override async turnOff(): Promise<void> { await this.plug.setOutlet(false); }
  override async toggle(): Promise<void> {
    const { on } = await this.plug.readOutlet();
    await this.plug.setOutlet(!on);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TplinkKasaPlug extends CapabilityMethods<{ binarySwitch: KasaOutletSwitch }> {}

/**
 * One outlet of a TP-Link Kasa plug (EP10, KP115) or of a multi-outlet device
 * (EP40, HS300), as a binary switch over the legacy local protocol. Configure
 * one instance per outlet; instances on the same host share one request queue.
 */
export class TplinkKasaPlug extends Device<TplinkKasaPlugConfig> {
  readonly model = TPLINK_KASA_PLUG;
  readonly capabilities;
  readonly switch: KasaOutletSwitch;
  readonly client: KasaClient;
  readonly product: KasaPlugProduct;
  private knownIdentity: DeviceIdentity | undefined;
  private childId: string | undefined;
  private pending: Promise<KasaSysinfo> | undefined;

  constructor(instance: DeviceInstance, config: TplinkKasaPlugConfig, options: { transport?: KasaTransport } = {}) {
    super(instance.id, instance.name, config);
    const host = config.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new BinarySwitchError("Kasa plug host must be a private LAN address", "invalid_host");
    }
    this.product = config.model;
    const { outlets } = KASA_PLUG_PRODUCTS[this.product];
    if (outlets === 1 && config.outlet !== undefined) throw new Error(`${instance.id}: ${this.product} has one outlet; remove outlet`);
    if (outlets > 1 && (config.outlet === undefined || config.outlet >= outlets)) {
      throw new Error(`${instance.id}: ${this.product} needs outlet from 0 to ${outlets - 1}`);
    }
    this.client = new KasaClient(host, {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    this.switch = new KasaOutletSwitch(instance.id, this);
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  /** Whether this outlet has its own realtime energy meter. */
  get metered(): boolean { return KASA_PLUG_PRODUCTS[this.product].energyMeter; }

  protected override identity(): DeviceIdentity | undefined { return this.knownIdentity; }

  /** The model string from the last successful sysinfo, e.g. `HS300(US)`. */
  reportedModel(): string | undefined { return this.knownIdentity?.model; }

  override async probe(): Promise<DeviceIdentity> {
    await this.sysinfo();
    return this.knownIdentity!;
  }

  /**
   * Fresh sysinfo, checked to be the configured product with the expected
   * outlets. Concurrent reads from the same instance share one request.
   */
  async sysinfo(): Promise<KasaSysinfo> {
    this.pending ??= this.fetchSysinfo().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** The current state of this instance's outlet. */
  async readOutlet(): Promise<{ on: boolean }> {
    let info: KasaSysinfo;
    try { info = await this.sysinfo(); }
    catch (error) { throw switchError(error); }
    if (this.config.outlet === undefined) return { on: info.on! };
    return { on: info.children![this.config.outlet]!.on };
  }

  async setOutlet(on: boolean): Promise<void> {
    try { await this.client.setRelayState(on, await this.outletAddress()); }
    catch (error) { throw switchError(error); }
  }

  async realtime(): Promise<KasaRealtime> {
    if (!this.metered) throw new KasaError(`${this.product} has no energy meter`, "protocol");
    return await this.client.getRealtime(await this.outletAddress());
  }

  /** The child id that addresses this outlet, or `undefined` on a single-outlet plug. */
  private async outletAddress(): Promise<string | undefined> {
    if (this.config.outlet === undefined) return undefined;
    if (this.childId === undefined) await this.sysinfo();
    return this.childId;
  }

  private async fetchSysinfo(): Promise<KasaSysinfo> {
    const info = await this.client.getSysinfo();
    if (!reportsProduct(info.model, this.product)) {
      throw new KasaError(`Device at ${this.client.host} reports ${info.model.slice(0, 40)}, not ${this.product}`, "protocol");
    }
    const { outlets } = KASA_PLUG_PRODUCTS[this.product];
    if (outlets === 1 ? info.on === undefined : info.children?.length !== outlets) {
      throw new KasaError(`${this.product} at ${this.client.host} did not report ${outlets === 1 ? "its relay state" : `${outlets} outlets`}`, "protocol");
    }
    if (this.config.outlet !== undefined) this.childId = info.children![this.config.outlet]!.id;
    this.knownIdentity = { model: info.model, firmwareVersion: info.softwareVersion };
    return info;
  }
}

export const TPLINK_KASA_PLUG: DeviceModel<TplinkKasaPlugConfig> = {
  id: "tplink-kasa-plug",
  title: "TP-Link Kasa plug",
  manufacturer: "TP-Link",
  product: "Kasa plug",
  capabilities: ["binarySwitch"],
  connectionTypes: ["direct-local"],
  configSchema: TPLINK_KASA_PLUG_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance: DeviceInstance, config: TplinkKasaPlugConfig, _services: SiteServices, _secrets: SecretsBag): TplinkKasaPlug {
    return new TplinkKasaPlug(instance, config);
  },
};

interface Measurement {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  readonly field: keyof KasaRealtime;
  readonly max: number;
}

const MEASUREMENTS: readonly Measurement[] = [
  { id: "power", name: "Power", quantity: "power", unit: "W", field: "powerW", max: 20_000 },
  { id: "voltage", name: "Voltage", quantity: "voltage", unit: "V", field: "voltageV", max: 500 },
  { id: "current", name: "Current", quantity: "current", unit: "A", field: "currentA", max: 100 },
  { id: "energy", name: "Energy", quantity: "energy", unit: "kWh", field: "energyKWh", max: 10_000_000 },
];

function readings(realtime?: KasaRealtime, observedAt?: string): SensorCollectionReading[] {
  return MEASUREMENTS.map(({ id, name, quantity, unit, field, max }) => {
    const value = realtime?.[field];
    const valid = value !== undefined && value >= 0 && value <= max;
    return {
      id, name, quantity, unit,
      ...(valid && observedAt
        ? { availability: "online" as const, value, observedAt }
        : { availability: realtime ? "unknown" as const : "offline" as const }),
    };
  });
}

/** Realtime power, voltage, current and cumulative energy of one metered outlet. */
export class KasaEnergyReadings extends SensorCollection {
  override readonly inventory = MEASUREMENTS.map(({ id, name }) => ({ id, name }));
  constructor(id: string, private readonly plug: TplinkKasaPlug) { super(id); }

  async getState(): Promise<SensorCollectionState> {
    let realtime: KasaRealtime;
    try { realtime = await this.plug.realtime(); }
    catch (error) {
      return { availability: "offline", detail: (error instanceof Error ? error.message : "Kasa energy meter is unreachable").slice(0, 500), sensors: readings() };
    }
    const observedAt = new Date().toISOString();
    const sensors = readings(realtime, observedAt);
    const complete = sensors.every((sensor) => sensor.availability === "online");
    return {
      availability: complete ? "online" : "degraded", observedAt, sensors,
      ...(!complete ? { detail: "The meter did not report every reading" } : {}),
    };
  }
}

const deviceIdSchema = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 } as const;
export const TPLINK_KASA_ENERGY_METER_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tplink-kasa-energy-meter/config",
  title: "TP-Link Kasa energy meter config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The `tplink-kasa-plug` device (a KP115, or one HS300 outlet) whose meter this reads. */
    plug: deviceIdSchema,
  },
  required: ["plug"],
} as const;
export type TplinkKasaEnergyMeterConfig = FromSchema<typeof TPLINK_KASA_ENERGY_METER_CONFIG_SCHEMA>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TplinkKasaEnergyMeter extends CapabilityMethods<{ sensor: KasaEnergyReadings }> {}

/**
 * The energy meter built into a KP115 or into one HS300 outlet, as its own
 * sensor device contained in the plug. It reads through the plug's client and
 * request queue; it has no address of its own.
 */
export class TplinkKasaEnergyMeter extends Device<TplinkKasaEnergyMeterConfig> {
  readonly model = TPLINK_KASA_ENERGY_METER;
  readonly capabilities;
  readonly readings: KasaEnergyReadings;
  override readonly parent;

  constructor(instance: DeviceInstance, config: TplinkKasaEnergyMeterConfig, readonly plug: TplinkKasaPlug) {
    super(instance.id, instance.name, config);
    if (!plug.metered) throw new Error(`${instance.id}: ${plug.id} is a ${plug.product}, which has no energy meter`);
    this.parent = { id: plug.id, index: 0 };
    this.readings = new KasaEnergyReadings(instance.id, plug);
    this.capabilities = this.expose({ sensor: this.readings });
  }

  override displayHost(): string { return this.plug.client.host; }

  protected override identity(): DeviceIdentity | undefined {
    const model = this.plug.reportedModel();
    return model ? { model: `${model} energy meter` } : undefined;
  }

  /** The plug must answer as the configured product, and its meter must answer too. */
  override async probe(): Promise<DeviceIdentity> {
    const identity = await this.plug.probe();
    await this.plug.realtime();
    return { model: `${identity.model ?? this.plug.product} energy meter`, ...(identity.firmwareVersion ? { firmwareVersion: identity.firmwareVersion } : {}) };
  }
}

export const TPLINK_KASA_ENERGY_METER: DeviceModel<TplinkKasaEnergyMeterConfig> = {
  id: "tplink-kasa-energy-meter",
  title: "TP-Link Kasa energy meter",
  manufacturer: "TP-Link",
  product: "Kasa energy meter",
  capabilities: ["sensor"],
  connectionTypes: ["composed"],
  configSchema: TPLINK_KASA_ENERGY_METER_CONFIG_SCHEMA,
  objectSchemaId: sensorCollectionSchema.$id,
  create(instance: DeviceInstance, config: TplinkKasaEnergyMeterConfig, _services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): TplinkKasaEnergyMeter {
    // Containment is declared through `parent`; no logical reference on top of it.
    const plug = context?.device(config.plug);
    if (!(plug instanceof TplinkKasaPlug)) throw new Error(`${instance.id}: plug must reference a tplink-kasa-plug device`);
    return new TplinkKasaEnergyMeter(instance, config, plug);
  },
};
