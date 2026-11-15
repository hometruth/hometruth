/**
 * A Rachio controller's rain delay, shown as a switch: on while Rachio says
 * a delay is in force (its expiry is in the future), off otherwise.
 *
 * `turnOn` skips scheduled watering for the requested hours (1..168, Rachio's
 * seven-day ceiling) or the entry's `defaultHours`; `turnOff` cancels the
 * delay. Manual zone runs are not affected by a rain delay. The state is read
 * from the account after each command, never assumed from it.
 *
 * This is its own entry rather than part of `rachio-controller` because a
 * device has one capability per kind, and the controller's switch is standby.
 */
import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, type BinarySwitchState } from "../../../models/binary-switch";
import { CapabilityError, type InvokeOptions } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { binarySwitchSchema } from "../../../schemas";
import type { RachioControllerSource } from "../../../vendors/rachio/site-service";
import { RachioControllerDevice, rachioSwitchError } from "../rachio-controller";

export const RACHIO_RAIN_DELAY_HOURS = { minimum: 1, maximum: 168, default: 24 } as const;

export const RACHIO_RAIN_DELAY_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/rachio-rain-delay/config",
  title: "Rachio rain delay config",
  type: "object", additionalProperties: false,
  properties: {
    /** The `rachio-controller` entry whose schedules this delays. */
    controller: { type: "string", minLength: 1, maxLength: 100 },
    /** How long `turnOn` and `toggle` delay watering when no hours are given. */
    defaultHours: { type: "integer", minimum: RACHIO_RAIN_DELAY_HOURS.minimum, maximum: RACHIO_RAIN_DELAY_HOURS.maximum },
  },
  required: ["controller"],
} as const;
export type RachioRainDelayConfig = FromSchema<typeof RACHIO_RAIN_DELAY_CONFIG>;

/** `turnOn`'s argument: nothing, a number of hours, or `{ hours }`. */
export function rainDelayHours(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  let hours = value;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).some(key => key !== "hours")) throw new CapabilityError("turnOn takes only an optional hours", "invalid_value");
    hours = (value as { hours?: unknown }).hours ?? fallback;
  }
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < RACHIO_RAIN_DELAY_HOURS.minimum || hours > RACHIO_RAIN_DELAY_HOURS.maximum) {
    throw new CapabilityError(`Rain delay must be a whole number of hours from ${RACHIO_RAIN_DELAY_HOURS.minimum} to ${RACHIO_RAIN_DELAY_HOURS.maximum}`, "invalid_value");
  }
  return hours;
}

export class RachioRainDelaySwitch extends BinarySwitch {
  constructor(id: string, private readonly source: RachioControllerSource, readonly defaultHours: number, private readonly now: () => number = Date.now) { super(id); }

  override async getState(): Promise<BinarySwitchState> {
    try {
      const { controller } = await this.source.controller();
      return (controller.rainDelayExpirationDate ?? 0) > this.now() ? "on" : "off";
    } catch (error) { throw rachioSwitchError(error); }
  }

  override async turnOn(hours: number = this.defaultHours): Promise<void> {
    await this.delay(rainDelayHours(hours, this.defaultHours) * 3600);
  }

  override async turnOff(): Promise<void> { await this.delay(0); }

  override async toggle(): Promise<void> {
    if (await this.getState() === "on") await this.turnOff();
    else await this.turnOn();
  }

  override async invoke(controlId: string, value?: unknown, options?: InvokeOptions): Promise<unknown> {
    if (controlId === "turnOn") return await this.turnOn(rainDelayHours(value, this.defaultHours));
    return await super.invoke(controlId, value, options);
  }

  private async delay(seconds: number): Promise<void> {
    try { await this.source.setRainDelay(seconds); } catch (error) { throw rachioSwitchError(error); }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RachioRainDelayDevice extends CapabilityMethods<{ binarySwitch: RachioRainDelaySwitch }> {}

export class RachioRainDelayDevice extends Device<RachioRainDelayConfig> {
  readonly model = RACHIO_RAIN_DELAY;
  readonly capabilities;
  readonly delaySwitch: RachioRainDelaySwitch;

  constructor(instance: DeviceInstance, config: RachioRainDelayConfig, private readonly controller: RachioControllerDevice, options: { now?: () => number } = {}) {
    super(instance.id, instance.name, config);
    this.delaySwitch = new RachioRainDelaySwitch(instance.id, controller.source, config.defaultHours ?? RACHIO_RAIN_DELAY_HOURS.default, options.now);
    this.capabilities = this.expose({ binarySwitch: this.delaySwitch });
  }

  override displayHost(): string { return `Via ${this.controller.name}`; }

  async probe(): Promise<DeviceIdentity> {
    await this.delaySwitch.getState();
    return { model: RACHIO_RAIN_DELAY.product };
  }
}

export const RACHIO_RAIN_DELAY: DeviceModel<RachioRainDelayConfig> = {
  id: "rachio-rain-delay", title: "Rachio rain delay", manufacturer: "Rachio", product: "Rain delay",
  capabilities: ["binarySwitch"], connectionTypes: ["cloud"], configSchema: RACHIO_RAIN_DELAY_CONFIG, objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, _services, _secrets, context?: DeviceCreationContext) {
    const controller = context?.device(config.controller, { relation: "uses", capability: "hub" });
    if (!(controller instanceof RachioControllerDevice)) throw new Error(`Rachio rain delay "${instance.id}" must name a configured rachio-controller in controller`);
    return new RachioRainDelayDevice(instance, config, controller);
  },
};
