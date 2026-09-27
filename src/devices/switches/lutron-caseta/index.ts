import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Light, LightError, type LightState } from "../../../models/light";
import { binarySwitchSchema, lightSchema } from "../../../schemas";
import { LutronLeapClient, LutronLeapError } from "../../../vendors/lutron/leap";

export const LUTRON_CASETA_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/lutron-caseta/config",
  type: "object",
  additionalProperties: false,
  properties: {
    host: lanHostSchema,
    zone: { type: "integer", minimum: 1, maximum: 10000 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  },
  required: ["host", "zone"],
} as const;

export type LutronCasetaConfig = FromSchema<typeof LUTRON_CASETA_CONFIG_SCHEMA>;

function mapError(error: unknown, kind: "switch" | "light"): BinarySwitchError | LightError {
  if (error instanceof BinarySwitchError || error instanceof LightError) return error;
  const code = error instanceof LutronLeapError ? error.code : "protocol";
  const message = error instanceof Error ? error.message : String(error);
  return kind === "switch" ? new BinarySwitchError(message, code) : new LightError(message, code);
}

interface LutronZoneOptions {
  id: string;
  host: string;
  zone: number;
  timeoutMs?: number;
  client?: LutronLeapClient;
}

export class LutronCasetaSwitch extends BinarySwitch {
  private readonly client: LutronLeapClient;
  constructor(private readonly options: LutronZoneOptions) {
    super(options.id);
    this.client = options.client ?? new LutronLeapClient(undefined, options.timeoutMs);
  }
  async turnOn(): Promise<void> { await this.set(100); }
  async turnOff(): Promise<void> { await this.set(0); }
  async toggle(): Promise<void> { await this.set((await this.getState()) === "on" ? 0 : 100); }
  async getState(): Promise<BinarySwitchState> {
    try {
      const status = await this.client.readZone(this.options.host, this.options.zone);
      return status.switchedOn === undefined ? (status.level > 0 ? "on" : "off") : status.switchedOn ? "on" : "off";
    } catch (error) { throw mapError(error, "switch"); }
  }
  private async set(level: number): Promise<void> {
    try { await this.client.setLevel(this.options.host, this.options.zone, "switched", level); }
    catch (error) { throw mapError(error, "switch"); }
  }
}

export class LutronCasetaDimmer extends Light {
  private readonly client: LutronLeapClient;
  constructor(private readonly options: LutronZoneOptions) {
    super(options.id);
    this.client = options.client ?? new LutronLeapClient(undefined, options.timeoutMs);
  }
  override supportsColorTemperature(): boolean { return false; }
  async setColorTemperature(_kelvin: number): Promise<void> { throw new LightError("Lutron Caséta dimmers have no color-temperature control", "protocol"); }
  async turnOn(): Promise<void> { await this.set(100); }
  async turnOff(): Promise<void> { await this.set(0); }
  async toggle(): Promise<void> { await this.set((await this.getState()).on ? 0 : 100); }
  async setBrightness(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new LightError("Brightness must be between 0 and 100", "protocol");
    await this.set(percent);
  }
  async getState(): Promise<LightState> {
    try {
      const status = await this.client.readZone(this.options.host, this.options.zone);
      return { on: status.level > 0, brightnessPercent: status.level };
    } catch (error) { throw mapError(error, "light"); }
  }
  private async set(level: number): Promise<void> {
    try { await this.client.setLevel(this.options.host, this.options.zone, "dimmed", level); }
    catch (error) { throw mapError(error, "light"); }
  }
}

export interface LutronCasetaSwitchDevice extends CapabilityMethods<{ binarySwitch: LutronCasetaSwitch }> {}
export class LutronCasetaSwitchDevice extends Device<LutronCasetaConfig> {
  readonly model = LUTRON_CASETA_SWITCH;
  readonly capabilities;
  readonly switch: LutronCasetaSwitch;
  constructor(instance: DeviceInstance, config: LutronCasetaConfig) {
    super(instance.id, instance.name, config);
    this.switch = new LutronCasetaSwitch({ id: instance.id, host: config.host, zone: config.zone, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) });
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }
  async probe(): Promise<DeviceIdentity> { await this.switch.getState(); return { model: LUTRON_CASETA_SWITCH.product }; }
  override displayHost(): string { return `${this.config.host} (Lutron bridge, zone ${this.config.zone})`; }
}

export interface LutronCasetaDimmerDevice extends CapabilityMethods<{ light: LutronCasetaDimmer }> {}
export class LutronCasetaDimmerDevice extends Device<LutronCasetaConfig> {
  readonly model = LUTRON_CASETA_DIMMER;
  readonly capabilities;
  readonly light: LutronCasetaDimmer;
  constructor(instance: DeviceInstance, config: LutronCasetaConfig) {
    super(instance.id, instance.name, config);
    this.light = new LutronCasetaDimmer({ id: instance.id, host: config.host, zone: config.zone, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) });
    this.capabilities = this.expose({ light: this.light });
  }
  async probe(): Promise<DeviceIdentity> { await this.light.getState(); return { model: LUTRON_CASETA_DIMMER.product }; }
  override displayHost(): string { return `${this.config.host} (Lutron bridge, zone ${this.config.zone})`; }
}

export const LUTRON_CASETA_SWITCH: DeviceModel<LutronCasetaConfig> = {
  id: "lutron-caseta-switch",
  title: "Lutron Caséta switch",
  manufacturer: "Lutron",
  product: "Caséta switch",
  capabilities: ["binarySwitch"],
  connectionTypes: ["direct-local"],
  configSchema: LUTRON_CASETA_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, _services: SiteServices, _secrets: SecretsBag): LutronCasetaSwitchDevice { return new LutronCasetaSwitchDevice(instance, config); },
};

export const LUTRON_CASETA_DIMMER: DeviceModel<LutronCasetaConfig> = {
  id: "lutron-caseta-dimmer",
  title: "Lutron Caséta dimmer",
  manufacturer: "Lutron",
  product: "Caséta dimmer",
  capabilities: ["light"],
  connectionTypes: ["direct-local"],
  configSchema: LUTRON_CASETA_CONFIG_SCHEMA,
  objectSchemaId: lightSchema.$id,
  create(instance, config, _services: SiteServices, _secrets: SecretsBag): LutronCasetaDimmerDevice { return new LutronCasetaDimmerDevice(instance, config); },
};
