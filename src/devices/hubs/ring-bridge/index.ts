/**
 * The Ring Smart Lighting Bridge: the plug-in box that speaks 900 MHz to
 * Ring's battery and solar lights and HTTPS to Amazon. It is a hub in the
 * same sense as the Aqara M2 — the lights behind it are only reachable
 * through it — but where the M2 answers on the LAN, this one answers only
 * from Ring's cloud, so "the Bridge is online" here means the account can
 * see it, not that anything on this network can.
 *
 * One entry per Ring location. The lights pair to the Bridge in the Ring
 * app; this model does not provision them, it reads what the account
 * already has.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SiteServices } from "../../../models/device";
import { hubSchema } from "../../../models/sensor-schemas";
import { Hub, type HubDocument } from "../../../models/sensors";
import { isBeamsLightType, type RingConnectionState, type RingSource } from "../../../protocols/ring/asset-socket";
import { RingError } from "../../../protocols/ring/client";
import type { RingSiteService } from "../../../vendors/ring/site-service";

declare module "../../../models/device" {
  interface SiteServices {
    /** Absent when `vendors.ring.refreshToken` is not configured for this site. */
    ring?: RingSiteService;
  }
}

/**
 * A site built without a Ring account. Reads report `unknown` with no
 * `detail`: nothing here knows anything about this Bridge, which is not the
 * same as knowing it is unreachable, and a bare "unknown" leaves whatever
 * the graph last confirmed on screen. Writes say plainly what is missing.
 */
export function dormantRingSource(): RingSource {
  const missing = () => new RingError("This site has no Ring account configured; store one with `ht secrets set vendors.ring.refreshToken`", "authentication");
  return {
    state: () => DORMANT,
    ready: async () => { throw missing(); },
    device: () => undefined,
    setDevice: async () => { throw missing(); },
    subscribe: () => () => {},
  };
}

export const RING_BRIDGE_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/ring-bridge/config",
  title: "Ring Smart Lighting Bridge config",
  type: "object", additionalProperties: false,
  properties: {
    /** The Ring location this Bridge belongs to; `bun src/vendors/ring/discover.ts` prints it. */
    locationId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$" },
  },
  required: ["locationId"],
} as const;
export type RingBridgeConfig = FromSchema<typeof RING_BRIDGE_CONFIG>;

/** A site with no Ring account configured: unknown, without inventing a reason. */
const DORMANT: RingConnectionState = { availability: "unknown", detail: "", devices: new Map(), bridges: [] };

export class RingBridgeStatus extends Hub {
  constructor(id: string, private readonly source: RingSource) { super(id); }

  async getState(): Promise<HubDocument["state"]> {
    // Opening the socket is what discovers the lights; a read has to try.
    try { await this.source.ready(); } catch (error) {
      if (!(error instanceof RingError)) throw error;
      return { availability: error.code === "authentication" ? "degraded" : "offline", detail: error.message };
    }
    const state = this.source.state();
    if (state.availability !== "online") return { availability: state.availability, ...(state.detail ? { detail: state.detail } : {}) };
    const accessories = [...state.devices.values()]
      .filter(device => isBeamsLightType(device.deviceType) || device.deviceType.endsWith(".beams"))
      .map(device => ({ id: device.zid, name: device.name, model: device.deviceType }));
    return { availability: "online", observedAt: state.observedAt ?? new Date().toISOString(), accessories };
  }
}

export interface RingBridge extends CapabilityMethods<{ hub: RingBridgeStatus }> {}

export class RingBridge extends Device<RingBridgeConfig> {
  readonly model = RING_BRIDGE;
  readonly capabilities;
  readonly source: RingSource;

  constructor(instance: DeviceInstance, config: RingBridgeConfig, source: RingSource = dormantRingSource()) {
    super(instance.id, instance.name, config);
    this.source = source;
    this.capabilities = this.expose({ hub: new RingBridgeStatus(instance.id, this.source) });
  }

  /** The cloud pushes a frame whenever a light changes, so nothing here polls. */
  override watch(onChange: () => void): () => void {
    return this.source.subscribe(() => onChange());
  }

  override displayHost(): string { return "Via Ring's cloud"; }

  /** Only the account knows this Bridge; there is no address to reach it at. */
  async probe(): Promise<DeviceIdentity> {
    const state = await this.capabilities.hub.getState();
    if (state.availability !== "online") throw new Error(state.detail ?? "The Ring Bridge is unreachable");
    return { model: RING_BRIDGE.product };
  }
}

export const RING_BRIDGE: DeviceModel<RingBridgeConfig> = {
  id: "ring-bridge", title: "Ring Smart Lighting Bridge", manufacturer: "Ring", product: "Smart Lighting Bridge",
  capabilities: ["hub"], connectionTypes: ["cloud"], configSchema: RING_BRIDGE_CONFIG, objectSchemaId: hubSchema.$id,
  create(instance: DeviceInstance, config: RingBridgeConfig, services: SiteServices): RingBridge {
    return new RingBridge(instance, config, services.ring?.connectionFor(config.locationId));
  },
};
