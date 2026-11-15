import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError } from "../../../models/binary-switch";
import { Device, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SiteServices } from "../../../models/device";
import { NetworkAdapterError, type NetworkAdapter, type InternetGroupAdapter, type InternetGroupTarget } from "../../../network/adapter";
import { binarySwitchSchema } from "../../../schemas";

declare module "../../../models/device" {
  interface SiteServices {
    networkAdapter?: () => NetworkAdapter;
  }
}

export const INTERNET_ACCESS_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/internet-access-switch/config",
  title: "Internet access switch config", type: "object", additionalProperties: false,
  properties: {
    macs: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true,
      items: { type: "string", pattern: "^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$" } },
  },
  required: ["macs"],
} as const;
export type InternetAccessConfig = FromSchema<typeof INTERNET_ACCESS_CONFIG_SCHEMA>;

export class InternetAccessSwitch extends BinarySwitch {
  private pending: Promise<void> = Promise.resolve();
  constructor(id: string, private readonly target: InternetGroupTarget, private readonly network: () => InternetGroupAdapter) { super(id); }
  private change(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }
  async getState() { return this.network().describe(this.target); }
  async turnOn() { return this.change(() => this.network().setAccess(this.target, true)); }
  async turnOff() { return this.change(() => this.network().setAccess(this.target, false)); }
  async toggle() {
    return this.change(async () => {
      const allowed = await this.network().describe(this.target) === "off";
      await this.network().setAccess(this.target, allowed);
    });
  }
}

export class InternetAccessDevice extends Device<InternetAccessConfig> {
  readonly model = INTERNET_ACCESS_SWITCH;
  readonly capabilities;
  readonly switch: InternetAccessSwitch;
  constructor(instance: DeviceInstance, config: InternetAccessConfig, services: SiteServices) {
    super(instance.id, instance.name, config);
    if (new Set(config.macs.map(mac => mac.toLowerCase())).size !== config.macs.length) {
      throw new BinarySwitchError("Internet access switch MAC addresses must be unique", "protocol");
    }
    this.switch = new InternetAccessSwitch(instance.id, { id: instance.id, macs: config.macs }, () => {
      const adapter = services.networkAdapter?.().internetGroups;
      if (!adapter) throw new NetworkAdapterError("This network provider does not support internet access switches", "not_supported");
      return adapter;
    });
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }
  async probe(): Promise<DeviceIdentity> {
    await this.switch.getState();
    return { model: this.model.product };
  }
  override displayHost() { return `${this.config.macs.length} network clients`; }
}

export const INTERNET_ACCESS_SWITCH: DeviceModel<InternetAccessConfig> = {
  id: "internet-access-switch", title: "Internet access switch", manufacturer: "HomeTruth", product: "Internet access switch",
  icon: "🌐", capabilities: ["binarySwitch"], connectionTypes: ["local-hub"],
  configSchema: INTERNET_ACCESS_CONFIG_SCHEMA, objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, services) { return new InternetAccessDevice(instance, config, services); },
};
