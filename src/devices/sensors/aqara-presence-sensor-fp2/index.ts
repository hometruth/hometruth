import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceInstance, type DeviceModel, type CapabilityMethods } from "../../../models/device";
import { occupancySensorSchema } from "../../../models/sensor-schemas";
import { AqaraConnection, type AqaraSource } from "../../../vendors/aqara/connection";
import { AqaraOccupancy } from "../../../vendors/aqara/sensors";
import { homeKitConfigProperties } from "../../../vendors/aqara/config";

export const AQARA_FP2_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/aqara-presence-sensor-fp2/config", type: "object", additionalProperties: false,
  properties: homeKitConfigProperties, required: ["host", "port", "homekitId"],
} as const;
export type AqaraFp2Config = FromSchema<typeof AQARA_FP2_CONFIG>;
export interface AqaraPresenceSensorFP2 extends CapabilityMethods<{ occupancySensor: AqaraOccupancy }> {}
export class AqaraPresenceSensorFP2 extends Device<AqaraFp2Config> {
  readonly model = AQARA_PRESENCE_SENSOR_FP2;
  readonly capabilities;
  readonly source: AqaraSource;
  constructor(instance: DeviceInstance, config: AqaraFp2Config, source?: AqaraSource) {
    super(instance.id, instance.name, config);
    this.source = source ?? new AqaraConnection(instance.id, config);
    this.capabilities = this.expose({ occupancySensor: new AqaraOccupancy(instance.id, this.source) });
  }
  async probe() {
    const state = await this.source.read();
    if (state.availability !== "online") throw new Error(state.detail);
    return { model: "PS-S02E" };
  }
}
export const AQARA_PRESENCE_SENSOR_FP2: DeviceModel<AqaraFp2Config> = {
  id: "aqara-presence-sensor-fp2", title: "Aqara Presence Sensor FP2", manufacturer: "Aqara", product: "PS-S02E",
  capabilities: ["occupancySensor"], connectionTypes: ["direct-local"], configSchema: AQARA_FP2_CONFIG, objectSchemaId: occupancySensorSchema.$id,
  create: (instance, config) => new AqaraPresenceSensorFP2(instance, config),
};
