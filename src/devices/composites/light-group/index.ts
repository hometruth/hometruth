/** A logical light whose controls fan out to two or more configured lights. */
import type { FromSchema } from "json-schema-to-ts";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Light, LightError, type LightState } from "../../../models/light";
import { MethodGroup } from "../../../models/method-group";
import { lightSchema } from "../../../schemas";

export class LightGroupCapability extends Light {
  readonly members: readonly Light[];
  private readonly group: MethodGroup;

  constructor(id: string, members: readonly Light[]) {
    super(id);
    if (members.length < 2) throw new LightError("A light group needs at least two lights", "protocol");
    this.members = Object.freeze([...members]);
    this.group = new MethodGroup(members);
  }

  override supportsColor(): boolean {
    return this.group.methods.includes("setColor");
  }

  override supportsColorTemperature(): boolean { return this.members.every(member => member.supportsColorTemperature()); }

  async turnOn(): Promise<void> { await this.group.invoke("turnOn"); }
  async turnOff(): Promise<void> { await this.group.invoke("turnOff"); }

  /** Toggle converges a mixed group: fully on becomes off; anything else becomes on. */
  async toggle(): Promise<void> {
    if ((await this.getState()).on) await this.turnOff();
    else await this.turnOn();
  }

  async setBrightness(percent: number): Promise<void> { await this.group.invoke("setBrightness", percent); }
  async setColorTemperature(kelvin: number): Promise<void> { await this.group.invoke("setColorTemperature", kelvin); }
  override async setColor(hex: string): Promise<void> {
    if (!this.supportsColor()) throw new LightError("Not every light in this group has a color control", "protocol");
    await this.group.invoke("setColor", hex);
  }

  async getState(): Promise<LightState> {
    const states = await Promise.all(this.members.map((member) => member.getState()));
    const color = states[0]?.color;
    const sharedColor = color !== undefined && states.every((state) => state.color === color) ? color : undefined;
    const temperatures = states.map(state => state.colorTemperatureKelvin).filter((value): value is number => value !== undefined);
    return {
      on: states.every((state) => state.on),
      brightnessPercent: average(states.map((state) => state.brightnessPercent)),
      ...(temperatures.length === states.length ? { colorTemperatureKelvin: Math.round(average(temperatures)) } : {}),
      ...(sharedColor ? { color: sharedColor } : {}),
    };
  }
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export const LIGHT_GROUP_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/light-group/config",
  title: "Light group config",
  type: "object",
  additionalProperties: false,
  properties: {
    members: {
      type: "array",
      minItems: 2,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    },
  },
  required: ["members"],
} as const;

export type LightGroupConfig = FromSchema<typeof LIGHT_GROUP_CONFIG_SCHEMA>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LightGroupDevice extends CapabilityMethods<{ light: LightGroupCapability }> {}

export class LightGroupDevice extends Device<LightGroupConfig> {
  readonly model = LIGHT_GROUP;
  readonly capabilities;
  readonly light: LightGroupCapability;

  constructor(instance: DeviceInstance, config: LightGroupConfig, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    const members = config.members.map((id, index) => {
      const device = context.device(id, { relation: "members", label: `${index + 1}`, capability: "light" });
      const light = device.capability("light");
      if (!(light instanceof Light)) throw new LightError(`${device.name} (${id}) is not a light`, "protocol");
      return light;
    });
    this.light = new LightGroupCapability(instance.id, members);
    this.capabilities = this.expose({ light: this.light });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.light.getState();
    return { model: LIGHT_GROUP.product };
  }

  override displayHost(): string {
    return `${this.config.members.length} grouped lights`;
  }
}

export const LIGHT_GROUP: DeviceModel<LightGroupConfig> = {
  id: "light-group",
  title: "Light group",
  manufacturer: "HomeTruth",
  product: "Light group",
  capabilities: ["light"],
  connectionTypes: ["composed"],
  configSchema: LIGHT_GROUP_CONFIG_SCHEMA,
  objectSchemaId: lightSchema.$id,
  create(instance: DeviceInstance, config: LightGroupConfig, _services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): LightGroupDevice {
    if (!context) throw new LightError("A light group must be provisioned as part of a site", "protocol");
    return new LightGroupDevice(instance, config, context);
  },
};
