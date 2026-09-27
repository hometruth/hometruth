import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceInstance, type DeviceModel, type SiteServices, type CapabilityMethods } from "../../../models/device";
import { Light, LightError, type LightState } from "../../../models/light";
import { lightSchema } from "../../../schemas";
import type { HueClipClient } from "../../../vendors/hue/clip-client";

export interface HueLightOptions {
  id: string;
  lightId: string;
  clip: HueClipClient;
  color?: boolean;
  colorTemperature?: boolean;
  minimumKelvin?: number;
  maximumKelvin?: number;
}

export class HueLightCapability extends Light {
  readonly lightId: string;
  readonly host: string;
  protected readonly clip: HueClipClient;
  constructor(protected readonly options: HueLightOptions) {
    super(options.id);
    this.lightId = options.lightId;
    this.clip = options.clip;
    this.host = options.clip.host;
  }
  override supportsColor() { return this.options.color ?? true; }
  override supportsColorTemperature() { return this.options.colorTemperature ?? true; }
  protected override bounds() {
    return { minimumPercent: 0, maximumPercent: 100, minimumKelvin: this.options.minimumKelvin ?? 2000, maximumKelvin: this.options.maximumKelvin ?? 6535 };
  }
  async turnOn() { await this.clip.turnOn(this.lightId); }
  async turnOff() { await this.clip.turnOff(this.lightId); }
  async toggle() { if ((await this.getState()).on) await this.turnOff(); else await this.turnOn(); }
  async setBrightness(percent: number) { await this.clip.setBrightness(this.lightId, percent); }
  async setColorTemperature(kelvin: number) {
    if (!this.supportsColorTemperature()) throw new LightError("This light has no color temperature control", "protocol");
    await this.clip.setColorTemperature(this.lightId, kelvin);
  }
  override async setColor(hex: string) {
    if (!this.supportsColor()) throw new LightError("This light has no color control", "protocol");
    await this.clip.setColorHex(this.lightId, hex);
  }
  async getState(): Promise<LightState> { return this.clip.getLightState(this.lightId); }
}

export const HUE_LIGHT_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/hue-light/config", type: "object", additionalProperties: false,
  properties: {
    lightId: { type: "string", minLength: 1, maxLength: 100 },
    color: { type: "boolean" }, colorTemperature: { type: "boolean" },
    minimumKelvin: { type: "integer", minimum: 1000, maximum: 40000 },
    maximumKelvin: { type: "integer", minimum: 1000, maximum: 40000 },
  }, required: ["lightId", "color", "colorTemperature"],
} as const;
export type HueLightConfig = FromSchema<typeof HUE_LIGHT_CONFIG>;
export interface HueLight extends CapabilityMethods<{ light: HueLightCapability }> {}
export class HueLight extends Device<HueLightConfig> {
  readonly model = HUE_LIGHT;
  readonly capabilities;
  constructor(instance: DeviceInstance, config: HueLightConfig, services: SiteServices) {
    super(instance.id, instance.name, config);
    if (!services.hue) throw new LightError("No Hue bridge configured", "protocol");
    this.capabilities = this.expose({ light: new HueLightCapability({ ...config, id: instance.id, clip: services.hue.clip }) });
  }
  override displayHost() { return `${this.capabilities.light.host} (Hue bridge)`; }
  async probe() { await this.capabilities.light.getState(); return { model: "Hue light" }; }
}
export const HUE_LIGHT: DeviceModel<HueLightConfig> = {
  id: "hue-light", title: "Hue light", manufacturer: "Signify", product: "Hue light",
  capabilities: ["light"], connectionTypes: ["local-hub"], configSchema: HUE_LIGHT_CONFIG, objectSchemaId: lightSchema.$id,
  create(instance, config, services) { return new HueLight(instance, config, services); },
};
