/** A user-defined binary switch whose two states are scenes of other switch-like capabilities. */
import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import type { Capability, CapabilityKind } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { binarySwitchSchema, capabilityKindSchema } from "../../../schemas";

export const SYNTHETIC_SWITCH_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/synthetic-switch/config",
  title: "Synthetic switch config",
  type: "object",
  additionalProperties: false,
  properties: {
    members: {
      type: "array",
      minItems: 2,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
          /** Optional when exactly one capability on the device is switch-like. */
          capability: capabilityKindSchema,
          /** State this member should have when the synthetic switch is on. */
          on: { enum: ["on", "off"] },
          /** State this member should have when the synthetic switch is off. */
          off: { enum: ["on", "off"] },
        },
        required: ["device", "on", "off"],
      },
    },
  },
  required: ["members"],
} as const;

export type SyntheticSwitchConfig = FromSchema<typeof SYNTHETIC_SWITCH_CONFIG_SCHEMA>;
type SyntheticMemberConfig = SyntheticSwitchConfig["members"][number];

interface SyntheticMember {
  readonly label: string;
  readonly capability: Capability<unknown>;
  readonly on: BinarySwitchState;
  readonly off: BinarySwitchState;
}

const SWITCH_METHODS = ["turnOn", "turnOff", "getState"] as const;

export class SyntheticSwitchCapability extends BinarySwitch {
  readonly members: readonly SyntheticMember[];

  constructor(id: string, configs: readonly SyntheticMemberConfig[], context: DeviceCreationContext) {
    super(id);
    if (configs.length < 2) throw new BinarySwitchError("A synthetic switch needs at least two member states", "protocol");
    const seen = new Set<string>();
    this.members = Object.freeze(configs.map((config, index) => {
      const device = context.device(config.device, { relation: "members", label: `${index + 1}`, ...(config.capability ? { capability: config.capability as CapabilityKind } : {}) });
      const candidates = config.capability
        ? [[config.capability as CapabilityKind, device.capability(config.capability as CapabilityKind)] as const]
        : Object.entries(device.capabilities) as [CapabilityKind, Capability<unknown>][];
      const switchLike = candidates.filter((entry): entry is [CapabilityKind, Capability<unknown>] => {
        const capability = entry[1];
        return capability !== undefined && SWITCH_METHODS.every((method) => capability.methods.includes(method));
      });
      if (switchLike.length !== 1) {
        const detail = config.capability
          ? `its ${config.capability} capability is not switch-like`
          : switchLike.length === 0 ? "it has no switch-like capability" : "it has several switch-like capabilities; specify capability";
        throw new BinarySwitchError(`${device.name} (${config.device}) cannot be a synthetic-switch member: ${detail}`, "protocol");
      }
      const [kind, capability] = switchLike[0]!;
      const key = `${config.device}:${kind}`;
      if (seen.has(key)) throw new BinarySwitchError(`Synthetic switch member ${key} is listed more than once`, "protocol");
      seen.add(key);
      return { label: key, capability, on: config.on, off: config.off };
    }));
  }

  async turnOn(): Promise<void> { await this.apply("on"); }
  async turnOff(): Promise<void> { await this.apply("off"); }

  async toggle(): Promise<void> {
    if (await this.getState() === "on") await this.turnOff();
    else await this.turnOn();
  }

  async getState(): Promise<BinarySwitchState> {
    const states = await Promise.all(this.members.map(async (member) =>
      normalizeState(member.label, await member.capability.invoke("getState")),
    ));
    return states.every((state, index) => state === this.members[index]!.on) ? "on" : "off";
  }

  private async apply(scene: "on" | "off"): Promise<void> {
    await Promise.all(this.members.map(async (member) => {
      const desired = member[scene];
      await member.capability.invoke(desired === "on" ? "turnOn" : "turnOff");
    }));
  }
}

function normalizeState(label: string, value: unknown): BinarySwitchState {
  if (value === "on" || value === "off") return value;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value && typeof value === "object") {
    const state = value as { on?: unknown; value?: unknown };
    if (typeof state.on === "boolean") return state.on ? "on" : "off";
    if (state.value === "on" || state.value === "off") return state.value;
  }
  throw new BinarySwitchError(`${label} returned a state that is not on/off`, "protocol");
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SyntheticSwitchDevice extends CapabilityMethods<{ binarySwitch: SyntheticSwitchCapability }> {}

export class SyntheticSwitchDevice extends Device<SyntheticSwitchConfig> {
  readonly model = SYNTHETIC_SWITCH;
  readonly capabilities;
  readonly switch: SyntheticSwitchCapability;

  constructor(instance: DeviceInstance, config: SyntheticSwitchConfig, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    this.switch = new SyntheticSwitchCapability(instance.id, config.members, context);
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.switch.getState();
    return { model: SYNTHETIC_SWITCH.product };
  }

  override displayHost(): string {
    return `${this.config.members.length} composed states`;
  }
}

export const SYNTHETIC_SWITCH: DeviceModel<SyntheticSwitchConfig> = {
  id: "synthetic-switch",
  title: "Synthetic switch",
  manufacturer: "HomeTruth",
  product: "Synthetic switch",
  capabilities: ["binarySwitch"],
  connectionTypes: ["composed"],
  configSchema: SYNTHETIC_SWITCH_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance: DeviceInstance, config: SyntheticSwitchConfig, _services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): SyntheticSwitchDevice {
    if (!context) throw new BinarySwitchError("A synthetic switch must be provisioned as part of a site", "protocol");
    return new SyntheticSwitchDevice(instance, config, context);
  },
};
