/**
 * One Hue light as a `Light` capability, backed by:
 *  - the shared `HueEntertainmentSession` for fast color changes (streamed
 *    over DTLS to every light in the entertainment area at once, so this
 *    class only ever sends this light's own channel and leaves the others
 *    to whatever last set them — see `entertainment-session.ts`), and
 *  - plain CLIP v2 calls for on/off/brightness/reading state, since
 *    Entertainment streaming only changes color and brightness of a light
 *    that is already on.
 *
 * Several `HueEntertainmentLight` devices share one `HueEntertainmentSession`
 * (one physical bridge + one entertainment area), injected via `SiteServices`
 * — see `models/device.ts` and `vendors/hue/site-service.ts`.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { LightError, type LightState } from "../../../models/light";
import { GROUP_INVOKE, type GroupInvocationResult, type MethodPublisher } from "../../../models/method-group";
import { lightSchema } from "../../../schemas";
import { HueLightCapability } from "../hue-light";
import { HueClipClient } from "../../../vendors/hue/clip-client";
import type { HueEntertainmentSession } from "../../../vendors/hue/entertainment-session";

export interface HueEntertainmentLightOptions {
  readonly id: string;
  readonly lightId: string;
  readonly channel: number;
  readonly clip: HueClipClient;
  readonly session: HueEntertainmentSession;
}

/**
 * A Hue light. Colors set while the shared session is streaming go out over
 * DTLS immediately; every other change (on/off/brightness, and color when
 * the session is not currently streaming) goes over plain CLIP.
 */
export class HueEntertainmentLightCapability extends HueLightCapability {
  readonly channel: number;
  private readonly session: HueEntertainmentSession;
  private lastColor: string | undefined;

  constructor(options: HueEntertainmentLightOptions) {
    super(options);
    if (!Number.isInteger(options.channel) || options.channel < 0 || options.channel > 255) {
      throw new LightError("Hue entertainment channel must be an integer from 0 to 255", "protocol");
    }
    this.channel = options.channel;
    this.session = options.session;
  }

  override async setColorTemperature(kelvin: number): Promise<void> {
    if (this.session.isConnected) throw new LightError("Stop light sync before changing color temperature", "protocol");
    await super.setColorTemperature(kelvin);
  }

  override async setColor(hex: string): Promise<void> {
    const [r, g, b] = hexToRgbBytes(hex);
    if (this.session.isConnected) {
      this.session.setColors([{ channel: this.channel, r, g, b }]);
      this.lastColor = hex;
      return;
    }
    await this.clip.setColorHex(this.lightId, hex);
  }

  /** A group of lights on this session can share one HueStream frame. */
  async [GROUP_INVOKE](members: readonly MethodPublisher[], name: string, args: readonly unknown[]): Promise<GroupInvocationResult | undefined> {
    if (name !== "setColor" || !this.session.isConnected) return undefined;
    const hueMembers = members.every((member) => member instanceof HueEntertainmentLightCapability && member.session === this.session)
      ? members as readonly HueEntertainmentLightCapability[]
      : undefined;
    if (!hueMembers) return undefined;
    const hex = args[0];
    if (typeof hex !== "string") return undefined;
    const [r, g, b] = hexToRgbBytes(hex);
    this.session.setColors(hueMembers.map((member) => ({ channel: member.channel, r, g, b })));
    for (const member of hueMembers) member.lastColor = hex;
    return { results: hueMembers.map(() => undefined) };
  }

  override async getState(): Promise<LightState> {
    const state = await this.clip.getLightState(this.lightId);
    if (this.session.isConnected && this.lastColor) {
      return { on: state.on, brightnessPercent: state.brightnessPercent, color: this.lastColor };
    }
    return state;
  }
}

function hexToRgbBytes(hex: string): [number, number, number] {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/u.exec(hex);
  if (!match) throw new LightError(`Invalid hex color "${hex}"`, "protocol");
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

export const HUE_ENTERTAINMENT_LIGHT_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/hue-entertainment-light/config",
  title: "Hue entertainment light config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The light's CLIP v2 resource id (a UUID), for on/off/brightness/reads. */
    lightId: { type: "string", minLength: 1, maxLength: 100 },
    /** This light's channel id within the shared entertainment area's HueStream frames. */
    channel: { type: "integer", minimum: 0, maximum: 255 },
  },
  required: ["lightId", "channel"],
} as const;

export type HueEntertainmentLightConfig = FromSchema<typeof HUE_ENTERTAINMENT_LIGHT_CONFIG_SCHEMA>;

declare module "../../../models/device" {
  interface SiteServices {
    /** One shared DTLS session per bridge; every `HueEntertainmentLight` in the same entertainment area uses the same session. */
    hue?: { readonly clip: HueClipClient; readonly session: HueEntertainmentSession };
  }
}

/** `lamp.turnOn()`, `lamp.setColor("#ff0000")`… forwarded from the light. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HueEntertainmentLight extends CapabilityMethods<{ light: HueEntertainmentLightCapability }> {}

/** One Hue light, streamed to over the site's shared Entertainment session. */
export class HueEntertainmentLight extends Device<HueEntertainmentLightConfig> {
  readonly model = HUE_ENTERTAINMENT_LIGHT;
  readonly capabilities;
  readonly light: HueEntertainmentLightCapability;

  constructor(instance: DeviceInstance, config: HueEntertainmentLightConfig, services: SiteServices) {
    super(instance.id, instance.name, config);
    if (!services.hue) {
      throw new LightError("No Hue bridge is configured; see vendors.hue in .hometruth/secrets.yml", "protocol");
    }
    this.light = new HueEntertainmentLightCapability({
      id: instance.id,
      lightId: config.lightId,
      channel: config.channel,
      clip: services.hue.clip,
      session: services.hue.session,
    });
    this.capabilities = this.expose({ light: this.light });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.light.getState();
    return { model: HUE_ENTERTAINMENT_LIGHT.product };
  }

  /** This light has no LAN address of its own; report the bridge it streams through. */
  override displayHost(): string {
    return `${this.light.host} (Hue bridge, channel ${this.light.channel})`;
  }
}

export const HUE_ENTERTAINMENT_LIGHT: DeviceModel<HueEntertainmentLightConfig> = {
  id: "hue-entertainment-light",
  title: "Hue light (Entertainment)",
  manufacturer: "Signify",
  product: "Hue color light",
  capabilities: ["light"],
  connectionTypes: ["local-hub"],
  configSchema: HUE_ENTERTAINMENT_LIGHT_CONFIG_SCHEMA,
  objectSchemaId: lightSchema.$id,
  create(instance: DeviceInstance, config: HueEntertainmentLightConfig, services: SiteServices, _secrets: SecretsBag): HueEntertainmentLight {
    return new HueEntertainmentLight(instance, config, services);
  },
};
