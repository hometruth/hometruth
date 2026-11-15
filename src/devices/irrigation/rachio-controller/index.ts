/**
 * A Rachio smart sprinkler controller (Generation 3 8- and 16-zone, and the
 * earlier generations the same public API serves).
 *
 * Rachio has no local API: the controller is reached only through Rachio's
 * cloud with the account's API key, so "online" here means the cloud last
 * heard from the controller, not that anything on this network can reach it.
 * Every read comes from the shared account cache in `src/vendors/rachio`,
 * which is what keeps a whole yard of zones inside Rachio's daily allowance.
 *
 * The controller entry carries what belongs to the controller as a whole:
 *
 *   - `hub`: online/offline and the zone list;
 *   - `binarySwitch`: standby. On means standby is on and schedules are
 *     suspended, as the Rachio app and Home Assistant present it;
 *   - `button`: stop all watering, on every zone;
 *   - `sensor`: rain sensor, rain delay remaining, and which zone is watering.
 *
 * Each zone is its own `rachio-zone` entry, and the rain delay its own
 * `rachio-rain-delay` entry, because a device has one capability per kind
 * and both are switches with an observed state.
 */
import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Button } from "../../../models/button";
import type { Availability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SiteServices } from "../../../models/device";
import { hubSchema } from "../../../models/sensor-schemas";
import { Hub, SensorCollection, type HubDocument, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { RachioError } from "../../../protocols/rachio/client";
import { dormantRachioSource, type RachioControllerSource, type RachioSiteService } from "../../../vendors/rachio/site-service";

declare module "../../../models/device" {
  interface SiteServices {
    /** Absent when `vendors.rachio.apiKey` is not configured for this site. */
    rachio?: RachioSiteService;
  }
}

export const RACHIO_CONTROLLER_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/rachio-controller/config",
  title: "Rachio controller config",
  type: "object", additionalProperties: false,
  properties: {
    /** Rachio's id for the controller; `bun src/vendors/rachio/discover.ts` prints it. */
    deviceId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$" },
    /**
     * How often to ask Rachio what is watering. Every controller on the
     * account spends about 86,400,000 / pollIntervalMs calls a day on this,
     * against an allowance of about 1,700.
     */
    pollIntervalMs: { type: "integer", minimum: 120_000, maximum: 3_600_000 },
  },
  required: ["deviceId"],
} as const;
export type RachioControllerConfig = FromSchema<typeof RACHIO_CONTROLLER_CONFIG>;

/** Rachio's error codes as capability availability: a refused key or a spent allowance is a fault here, not an outage there. */
export function rachioAvailability(error: RachioError): Availability {
  if (error.code === "not_configured") return "unknown";
  if (error.code === "authentication" || error.code === "rate_limited") return "degraded";
  return "offline";
}

/** A Rachio failure as a switch failure, keeping "nothing configured" distinct from "unreachable". */
export function rachioSwitchError(error: unknown): unknown {
  if (!(error instanceof RachioError)) return error;
  if (error.code === "not_configured") return new BinarySwitchError(error.message, "unknown_state");
  if (error.code === "protocol") return new BinarySwitchError(error.message, "protocol");
  return new BinarySwitchError(error.message, "unreachable");
}

export class RachioControllerStatus extends Hub {
  constructor(id: string, private readonly source: RachioControllerSource) { super(id); }

  async getState(): Promise<HubDocument["state"]> {
    let reading;
    try { reading = await this.source.controller(); } catch (error) {
      if (!(error instanceof RachioError)) throw error;
      const availability = rachioAvailability(error);
      return { availability, ...(availability === "unknown" ? {} : { detail: error.message }) };
    }
    const { controller, observedAt } = reading;
    if (controller.status !== "ONLINE") return { availability: "offline", detail: `Rachio reports the controller ${controller.status.toLowerCase()}` };
    return {
      availability: "online", observedAt,
      accessories: controller.zones.map(zone => ({ id: zone.id, name: zone.name, model: `Zone ${zone.zoneNumber}${zone.enabled ? "" : " (disabled)"}` })),
    };
  }
}

/** Standby: on suspends every schedule. Read from the account, never assumed from the last command. */
export class RachioStandbySwitch extends BinarySwitch {
  constructor(id: string, private readonly source: RachioControllerSource) { super(id); }

  override async getState(): Promise<BinarySwitchState> {
    try { return (await this.source.controller()).controller.on ? "off" : "on"; } catch (error) { throw rachioSwitchError(error); }
  }
  override async turnOn(): Promise<void> { await this.set(true); }
  override async turnOff(): Promise<void> { await this.set(false); }
  override async toggle(): Promise<void> { await this.set(await this.getState() === "off"); }

  private async set(standby: boolean): Promise<void> {
    try { await this.source.setStandby(standby); } catch (error) { throw rachioSwitchError(error); }
  }
}

/** Stop every zone on the controller. Momentary: success says Rachio accepted it, the zones say whether water stopped. */
export class RachioStopWatering extends Button {
  constructor(id: string, private readonly source: RachioControllerSource) { super(id); }

  protected override async availability(): Promise<Availability> {
    try { return (await this.source.controller()).controller.status === "ONLINE" ? "online" : "offline"; } catch (error) {
      if (error instanceof RachioError) return rachioAvailability(error);
      throw error;
    }
  }

  protected override async performPress(): Promise<void> {
    await this.source.stopWatering();
  }
}

export const RACHIO_CONTROLLER_SENSORS = [
  { id: "rain-sensor", name: "Rain sensor" },
  { id: "rain-delay", name: "Rain delay remaining" },
  { id: "watering-zone", name: "Watering zone" },
] as const;

export class RachioControllerSensors extends SensorCollection {
  override readonly inventory = RACHIO_CONTROLLER_SENSORS;

  constructor(id: string, private readonly source: RachioControllerSource, private readonly now: () => number = Date.now) { super(id); }

  async getState(): Promise<SensorCollectionState> {
    let reading;
    try { reading = await this.source.controller(); } catch (error) {
      if (!(error instanceof RachioError)) throw error;
      const availability = rachioAvailability(error);
      return { availability, sensors: [], ...(availability === "unknown" ? {} : { detail: error.message }) };
    }
    const { controller, observedAt } = reading;
    const sensors: SensorCollectionReading[] = [];
    if (controller.rainSensorTripped !== undefined) {
      sensors.push({ id: "rain-sensor", name: "Rain sensor", quantity: "rain", unit: "", availability: "online", value: controller.rainSensorTripped ? 1 : 0, observedAt, detail: controller.rainSensorTripped ? "Tripped" : "Dry" });
    }
    const delayMs = Math.max(0, (controller.rainDelayExpirationDate ?? 0) - this.now());
    sensors.push({
      id: "rain-delay", name: "Rain delay remaining", quantity: "duration", unit: "min", availability: "online", value: Math.ceil(delayMs / 60_000), observedAt,
      ...(delayMs > 0 && controller.rainDelayExpirationDate ? { detail: `Until ${new Date(controller.rainDelayExpirationDate).toISOString()}` } : {}),
    });
    if (controller.status !== "ONLINE") {
      sensors.push({ id: "watering-zone", name: "Watering zone", quantity: "zone", unit: "", availability: "offline" });
      return { availability: "offline", observedAt, sensors, detail: "Rachio reports the controller offline" };
    }
    try {
      const watering = await this.source.watering();
      const zone = watering.schedule && controller.zones.find(candidate => candidate.id === watering.schedule?.zoneId || candidate.zoneNumber === watering.schedule?.zoneNumber);
      sensors.push({ id: "watering-zone", name: "Watering zone", quantity: "zone", unit: "", availability: "online", value: zone?.zoneNumber ?? 0, observedAt: watering.scheduleObservedAt, detail: zone ? zone.name : "Not watering" });
    } catch (error) {
      if (!(error instanceof RachioError)) throw error;
      sensors.push({ id: "watering-zone", name: "Watering zone", quantity: "zone", unit: "", availability: rachioAvailability(error), detail: error.message });
    }
    return { availability: "online", observedAt, sensors };
  }
}

type RachioControllerCapabilities = { hub: RachioControllerStatus; binarySwitch: RachioStandbySwitch; button: RachioStopWatering; sensor: RachioControllerSensors };

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RachioControllerDevice extends CapabilityMethods<RachioControllerCapabilities> {}

export class RachioControllerDevice extends Device<RachioControllerConfig> {
  readonly model = RACHIO_CONTROLLER;
  readonly capabilities: RachioControllerCapabilities;
  private lastIdentity: DeviceIdentity | undefined;

  constructor(instance: DeviceInstance, config: RachioControllerConfig, readonly source: RachioControllerSource = dormantRachioSource(config.deviceId), options: { now?: () => number } = {}) {
    super(instance.id, instance.name, config);
    this.capabilities = this.expose({
      hub: new RachioControllerStatus(instance.id, source),
      binarySwitch: new RachioStandbySwitch(`${instance.id}-standby`, source),
      button: new RachioStopWatering(`${instance.id}-stop-watering`, source),
      sensor: new RachioControllerSensors(instance.id, source, options.now),
    });
  }

  override displayHost(): string { return "Via Rachio's cloud"; }

  protected override identity(): DeviceIdentity | undefined { return this.lastIdentity; }

  /** Only the account knows this controller: proves it is on the account and the cloud hears from it. */
  async probe(): Promise<DeviceIdentity> {
    let reading;
    try { reading = await this.source.controller(); } catch (error) { throw rachioSwitchError(error); }
    const { controller } = reading;
    if (controller.status !== "ONLINE") throw new BinarySwitchError(`Rachio reports ${controller.name} ${controller.status.toLowerCase()}`, "unreachable");
    this.lastIdentity = { model: controller.model ?? RACHIO_CONTROLLER.product, ...(controller.serialNumber ? { serialNumber: controller.serialNumber } : {}) };
    return this.lastIdentity;
  }
}

export const RACHIO_CONTROLLER: DeviceModel<RachioControllerConfig> = {
  id: "rachio-controller", title: "Rachio smart sprinkler controller", manufacturer: "Rachio", product: "Smart Sprinkler Controller",
  capabilities: ["hub", "binarySwitch", "button", "sensor"], connectionTypes: ["cloud"],
  configSchema: RACHIO_CONTROLLER_CONFIG, objectSchemaId: hubSchema.$id,
  create(instance: DeviceInstance, config: RachioControllerConfig, services: SiteServices): RachioControllerDevice {
    const source = services.rachio?.controller(config.deviceId, config.pollIntervalMs !== undefined ? { scheduleIntervalMs: config.pollIntervalMs } : {});
    return new RachioControllerDevice(instance, config, source);
  },
};
