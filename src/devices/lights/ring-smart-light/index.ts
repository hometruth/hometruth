/**
 * A Ring Smart Lighting fixture — the battery or solar Spotlight, Pathlight,
 * Steplight, or Floodlight — paired to a Ring Bridge.
 *
 * Every one of them is the same device to the API: a `switch.beams` that is
 * on or off, or a `switch.multilevel.beams` that also carries a `level`.
 * Which one a fixture is comes from the account, not from the entry, so one
 * model covers the family the way `hue-light` covers Hue's.
 *
 * The light is reached through its Bridge's websocket, and reports only what
 * that socket last said. When the connection is down the light reads as
 * offline rather than replaying its last known state: an unreachable light
 * is not a light that is still on.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { Light, LightError, type LightState } from "../../../models/light";
import { isBeamsLightType, RING_BEAMS_MULTILEVEL_SWITCH, type RingSource } from "../../../protocols/ring/asset-socket";
import { RingError } from "../../../protocols/ring/client";
import { lightSchema } from "../../../schemas";
import { RingBridge } from "../../hubs/ring-bridge";

export const RING_SMART_LIGHT_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/ring-smart-light/config",
  title: "Ring Smart Lighting fixture config",
  type: "object", additionalProperties: false,
  properties: {
    /** The `ring-bridge` entry this fixture is paired to. */
    bridge: { type: "string", minLength: 1, maxLength: 100 },
    /** Ring's own id for the fixture; `bun src/vendors/ring/discover.ts` prints it. */
    zid: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
  },
  required: ["bridge", "zid"],
} as const;
export type RingSmartLightConfig = FromSchema<typeof RING_SMART_LIGHT_CONFIG>;

/** Ring carries brightness as a 0..1 fraction; the capability speaks percent. */
function percentFromLevel(level: number): number {
  return Math.max(0, Math.min(100, Math.round(level * 100)));
}

export class RingBeamLight extends Light {
  constructor(id: string, private readonly source: RingSource, private readonly zid: string) { super(id); }

  /** Ring's lighting is fixed-white: there is no colour temperature to set. */
  override supportsColorTemperature(): boolean { return false; }

  private async read() {
    try { await this.source.ready(); } catch (error) {
      if (error instanceof RingError) throw new LightError(error.message, error.code === "authentication" ? "protocol" : "unreachable");
      throw error;
    }
    const device = this.source.device(this.zid);
    if (!device) throw new LightError(`Ring has no device ${this.zid} behind this Bridge`, "unreachable");
    if (!isBeamsLightType(device.deviceType)) throw new LightError(`Ring device ${this.zid} is a ${device.deviceType}, not a light`, "protocol");
    return device;
  }

  private async write(values: Record<string, unknown>): Promise<void> {
    try { await this.source.setDevice(this.zid, values); } catch (error) {
      if (error instanceof RingError) throw new LightError(error.message, error.code === "authentication" ? "protocol" : "unreachable");
      throw error;
    }
  }

  /**
   * Every write reads first. The read is a lookup in what the socket already
   * pushed, not a round trip, and it is what stops a mistyped `zid` sending
   * `on` to a motion sensor and reporting success.
   */
  override async turnOn(): Promise<void> { await this.read(); await this.write({ on: true }); }
  override async turnOff(): Promise<void> { await this.read(); await this.write({ on: false }); }

  override async toggle(): Promise<void> {
    const device = await this.read();
    await this.write({ on: !(device.on ?? false) });
  }

  override async setBrightness(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new LightError("Brightness must be a percentage from 0 to 100", "protocol");
    const device = await this.read();
    if (device.deviceType !== RING_BEAMS_MULTILEVEL_SWITCH) {
      // A plain `switch.beams` has one brightness. Treating 0 as off keeps the
      // advertised control truthful instead of silently doing nothing.
      await this.write({ on: percent > 0 });
      return;
    }
    await this.write({ level: Math.round(percent) / 100, ...(percent > 0 ? { on: true } : {}) });
  }

  override async setColorTemperature(): Promise<void> {
    throw new LightError("Ring Smart Lighting has no colour temperature control", "protocol");
  }

  override async getState(): Promise<LightState> {
    const device = await this.read();
    const on = device.on ?? false;
    return {
      on,
      // A non-dimmable fixture has exactly two brightnesses, and says so.
      brightnessPercent: device.level !== undefined ? percentFromLevel(device.level) : (on ? 100 : 0),
    };
  }
}

export interface RingSmartLight extends CapabilityMethods<{ light: RingBeamLight }> {}

export class RingSmartLight extends Device<RingSmartLightConfig> {
  readonly model = RING_SMART_LIGHT;
  readonly capabilities;
  readonly light: RingBeamLight;

  constructor(instance: DeviceInstance, config: RingSmartLightConfig, private readonly source: RingSource, readonly bridgeName: string) {
    super(instance.id, instance.name, config);
    this.light = new RingBeamLight(instance.id, source, config.zid);
    this.capabilities = this.expose({ light: this.light });
  }

  override watch(onChange: () => void): () => void {
    return this.source.subscribe(() => onChange());
  }

  override displayHost(): string { return `Via ${this.bridgeName}`; }

  protected override identity(): DeviceIdentity {
    return { model: RING_SMART_LIGHT.product, serialNumber: this.config.zid };
  }

  async probe(): Promise<DeviceIdentity> {
    // The account knows what this fixture actually is; report that over the family name.
    await this.light.getState();
    const device = this.source.device(this.config.zid);
    return { ...this.identity(), ...(device ? { model: device.deviceType } : {}) };
  }
}

export const RING_SMART_LIGHT: DeviceModel<RingSmartLightConfig> = {
  id: "ring-smart-light", title: "Ring Smart Lighting fixture", manufacturer: "Ring", product: "Smart Lighting",
  capabilities: ["light"], connectionTypes: ["cloud"], configSchema: RING_SMART_LIGHT_CONFIG, objectSchemaId: lightSchema.$id,
  create(instance, config, _services, _secrets, context) {
    const bridge = context?.device(config.bridge, { relation: "uses", capability: "hub" });
    if (!(bridge instanceof RingBridge)) throw new Error("A Ring Smart Lighting fixture requires a configured ring-bridge");
    return new RingSmartLight(instance, config, bridge.source, bridge.name);
  },
};
