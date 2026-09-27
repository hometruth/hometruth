import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceInstance, type DeviceModel, type CapabilityMethods } from "../../../models/device";
import { hubSchema } from "../../../models/sensor-schemas";
import { AqaraConnection, type AqaraSource, type ConnectionState } from "../../../vendors/aqara/connection";
import { AqaraHubStatus } from "../../../vendors/aqara/sensors";
import { homeKitConfigProperties } from "../../../vendors/aqara/config";
import type { MatterService } from "../../../vendors/aqara/matter-service";

/**
 * The site-wide `MatterService` (`src/vendors/aqara/matter-service.ts`):
 * one continuous connection per configured peer, opened at server startup
 * and shared by every hub and sensor that reads through it. Absent for the
 * short-lived preview site that precedes the live one across a restart —
 * see the service's own doc comment for why only one site may ever hold a
 * peer's Matter connection open.
 */
declare module "../../../models/device" {
  interface SiteServices {
    matter?: MatterService;
  }
}

export const AQARA_M2_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/aqara-hub-m2/config", type: "object", additionalProperties: false,
  properties: { ...homeKitConfigProperties, matterPeerId: { type: "string", pattern: "^peer[1-9][0-9]*$" } },
  anyOf: [
    { properties: homeKitConfigProperties, required: ["host", "port", "homekitId"] },
    { properties: { matterPeerId: { type: "string", pattern: "^peer[1-9][0-9]*$" } }, required: ["matterPeerId"] },
  ],
} as const;
export type AqaraHubConfig = FromSchema<typeof AQARA_M2_CONFIG>;

/** A Matter-configured hub with no running `MatterService` to read from (the preview site, or a site built without one): never opens a connection of its own. */
function dormantMatterSource(): AqaraSource {
  // No `detail`: a site built without the Matter service knows nothing about this hub, which is
  // not the same as knowing it is unreachable. A bare "unknown" leaves whatever the graph last
  // confirmed on screen, where an error string would replace a good reading with a worse one.
  const state: ConnectionState = { availability: "unknown", detail: "" };
  return { async read() { return state; } };
}

export interface AqaraHubM2 extends CapabilityMethods<{ hub: AqaraHubStatus }> {}
export class AqaraHubM2 extends Device<AqaraHubConfig> {
  readonly model = AQARA_HUB_M2;
  readonly capabilities;
  readonly source: AqaraSource;
  constructor(instance: DeviceInstance, config: AqaraHubConfig, source?: AqaraSource, matter?: MatterService) {
    super(instance.id, instance.name, config);
    this.source = source ?? (config.matterPeerId
      ? matter?.connectionFor(config.matterPeerId) ?? dormantMatterSource()
      : new AqaraConnection(instance.id, { host: config.host!, port: config.port!, homekitId: config.homekitId! }));
    this.capabilities = this.expose({ hub: new AqaraHubStatus(instance.id, this.source) });
  }
  /**
   * A Matter-backed source holds a live subscription and reports an attribute
   * change as it happens. Handing that to the observer is what makes a door
   * opening visible immediately rather than on the next poll.
   */
  override watch(onChange: () => void): () => void {
    return this.source.subscribe?.(() => onChange()) ?? (() => {});
  }

  async probe() {
    const state = await this.source.read();
    if (state.availability !== "online") throw new Error(state.detail);
    return { model: "ZHWG12LM" };
  }
}
export const AQARA_HUB_M2: DeviceModel<AqaraHubConfig> = {
  id: "aqara-hub-m2", title: "Aqara Hub M2", manufacturer: "Aqara", product: "ZHWG12LM",
  capabilities: ["hub"], connectionTypes: ["direct-local"], configSchema: AQARA_M2_CONFIG, objectSchemaId: hubSchema.$id,
  create: (instance, config, services) => new AqaraHubM2(instance, config, undefined, services.matter),
};
