/**
 * One watering zone of a Rachio controller: a valve, shown as a switch.
 *
 * On means Rachio says this zone is watering right now — read from the
 * controller's current schedule, whoever started it (HomeTruth, the Rachio
 * app, or a schedule). It is never assumed from a command: after `turnOn`
 * the switch reads off until Rachio confirms the valve opened, which the
 * shared cache re-checks every 15 s for a minute after each command.
 *
 * Turning a zone on is a physical action: it opens a valve and puts water
 * on the ground for the requested minutes (1..180, Rachio's three-hour
 * ceiling), or the entry's `defaultMinutes`. Turning it off stops watering.
 * Rachio has no per-zone stop, so off stops the whole controller, and only
 * when Rachio says this zone is the one watering; turning off a zone that is
 * not running never stops a different one.
 */
import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { CapabilityError, type InvokeOptions } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import type { RachioZone } from "../../../protocols/rachio/client";
import { binarySwitchSchema } from "../../../schemas";
import type { RachioControllerSource, RachioWateringReading } from "../../../vendors/rachio/site-service";
import { RachioControllerDevice, rachioSwitchError } from "../rachio-controller";

export const RACHIO_ZONE_MINUTES = { minimum: 1, maximum: 180, default: 10 } as const;

/**
 * What each control does, for a caller deciding whether to send it. The
 * binary-switch document has no field for this, so it is published here.
 */
export const RACHIO_ZONE_CONTROLS = {
  turnOn: { physical: true, effect: "Opens the zone valve and waters", argument: { name: "minutes", type: "integer", ...RACHIO_ZONE_MINUTES } },
  turnOff: { physical: true, effect: "Stops watering on the controller when this zone is the one running" },
  toggle: { physical: true, effect: "Stops this zone when it is watering, otherwise waters for the default minutes" },
  getState: { physical: false, effect: "Reads whether Rachio reports this zone watering" },
} as const;

export const RACHIO_ZONE_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/rachio-zone/config",
  title: "Rachio zone config",
  type: "object", additionalProperties: false,
  properties: {
    /** The `rachio-controller` entry this zone is wired to. */
    controller: { type: "string", minLength: 1, maxLength: 100 },
    /** The terminal number on the controller, as the Rachio app numbers zones. */
    zoneNumber: { type: "integer", minimum: 1, maximum: 16 },
    /** How long `turnOn` and `toggle` water when no minutes are given. */
    defaultMinutes: { type: "integer", minimum: RACHIO_ZONE_MINUTES.minimum, maximum: RACHIO_ZONE_MINUTES.maximum },
  },
  required: ["controller", "zoneNumber"],
} as const;
export type RachioZoneConfig = FromSchema<typeof RACHIO_ZONE_CONFIG>;

/** `turnOn`'s argument: nothing, a number of minutes, or `{ minutes }`. */
export function zoneMinutes(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const minutes = typeof value === "object" && !Array.isArray(value)
    ? (() => {
      if (Object.keys(value).some(key => key !== "minutes")) throw new CapabilityError("turnOn takes only an optional minutes", "invalid_value");
      return (value as { minutes?: unknown }).minutes ?? fallback;
    })()
    : value;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < RACHIO_ZONE_MINUTES.minimum || minutes > RACHIO_ZONE_MINUTES.maximum) {
    throw new CapabilityError(`Watering time must be a whole number of minutes from ${RACHIO_ZONE_MINUTES.minimum} to ${RACHIO_ZONE_MINUTES.maximum}`, "invalid_value");
  }
  return minutes;
}

export class RachioZoneValve extends BinarySwitch {
  constructor(id: string, private readonly source: RachioControllerSource, readonly zoneNumber: number, readonly defaultMinutes: number) { super(id); }

  override async getState(): Promise<BinarySwitchState> {
    return this.stateOf(await this.read());
  }

  /** Water this zone for `minutes` (1..180), or the entry's default. A physical action. */
  override async turnOn(minutes: number = this.defaultMinutes): Promise<void> {
    const duration = zoneMinutes(minutes, this.defaultMinutes);
    let zone: RachioZone;
    try { zone = this.zoneOf((await this.source.controller()).controller.zones); } catch (error) { throw rachioSwitchError(error); }
    if (!zone.enabled) throw new CapabilityError(`Zone ${this.zoneNumber} is disabled in the Rachio app; enable it there first`, "not_supported");
    if (zone.maxRuntime !== undefined && duration * 60 > zone.maxRuntime) {
      throw new CapabilityError(`Zone ${this.zoneNumber} is limited to ${Math.floor(zone.maxRuntime / 60)} minutes in the Rachio app`, "invalid_value");
    }
    try { await this.source.startZone(zone.id, duration * 60); } catch (error) { throw rachioSwitchError(error); }
  }

  /** Stop watering, but only when Rachio says this zone is the one running. */
  override async turnOff(): Promise<void> {
    if (this.stateOf(await this.read({ fresh: true })) !== "on") return;
    try { await this.source.stopWatering(); } catch (error) { throw rachioSwitchError(error); }
  }

  override async toggle(): Promise<void> {
    if (this.stateOf(await this.read({ fresh: true })) === "on") {
      try { await this.source.stopWatering(); } catch (error) { throw rachioSwitchError(error); }
      return;
    }
    await this.turnOn();
  }

  /** As every switch, plus `turnOn`'s optional watering time. */
  override async invoke(controlId: string, value?: unknown, options?: InvokeOptions): Promise<unknown> {
    if (controlId === "turnOn") return await this.turnOn(zoneMinutes(value, this.defaultMinutes));
    return await super.invoke(controlId, value, options);
  }

  private async read(options: { fresh?: boolean } = {}): Promise<RachioWateringReading> {
    try { return await this.source.watering(options); } catch (error) { throw rachioSwitchError(error); }
  }

  private zoneOf(zones: readonly RachioZone[]): RachioZone {
    const zone = zones.find(candidate => candidate.zoneNumber === this.zoneNumber);
    if (!zone) throw new BinarySwitchError(`The Rachio controller has no zone ${this.zoneNumber}`, "unreachable");
    return zone;
  }

  private stateOf(reading: RachioWateringReading): BinarySwitchState {
    const zone = this.zoneOf(reading.controller.zones);
    const schedule = reading.schedule;
    if (!schedule) return "off";
    return schedule.zoneId === zone.id || (schedule.zoneId === undefined && schedule.zoneNumber === zone.zoneNumber) ? "on" : "off";
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RachioZoneDevice extends CapabilityMethods<{ binarySwitch: RachioZoneValve }> {}

export class RachioZoneDevice extends Device<RachioZoneConfig> {
  readonly model = RACHIO_ZONE;
  readonly capabilities;
  override readonly parent;
  readonly valve: RachioZoneValve;

  constructor(instance: DeviceInstance, config: RachioZoneConfig, private readonly controller: RachioControllerDevice) {
    super(instance.id, instance.name, config);
    this.parent = { id: controller.id, index: config.zoneNumber - 1 };
    this.valve = new RachioZoneValve(instance.id, controller.source, config.zoneNumber, config.defaultMinutes ?? RACHIO_ZONE_MINUTES.default);
    this.capabilities = this.expose({ binarySwitch: this.valve });
  }

  override displayHost(): string { return `Via ${this.controller.name}`; }

  async probe(): Promise<DeviceIdentity> {
    await this.valve.getState();
    return { model: `${RACHIO_ZONE.product} ${this.config.zoneNumber}` };
  }
}

export const RACHIO_ZONE: DeviceModel<RachioZoneConfig> = {
  id: "rachio-zone", title: "Rachio sprinkler zone", manufacturer: "Rachio", product: "Zone",
  capabilities: ["binarySwitch"], connectionTypes: ["cloud"], configSchema: RACHIO_ZONE_CONFIG, objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, _services, _secrets, context?: DeviceCreationContext) {
    // No reference intent: the zone declares containment through `parent`.
    const controller = context?.device(config.controller);
    if (!(controller instanceof RachioControllerDevice)) throw new Error(`Rachio zone "${instance.id}" must name a configured rachio-controller in controller`);
    return new RachioZoneDevice(instance, config, controller);
  },
};
