import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceInstance, type DeviceModel, type CapabilityMethods } from "../../../models/device";
import { contactSensorSchema } from "../../../models/sensor-schemas";
import { AqaraContact } from "../../../vendors/aqara/sensors";
import { AqaraHubM2 } from "../../hubs/aqara-hub-m2";

export const AQARA_CONTACT_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/aqara-door-window-sensor/config", type: "object", additionalProperties: false,
  properties: { hub: { type: "string", minLength: 1, maxLength: 100 }, serialNumber: { type: "string", minLength: 1, maxLength: 100 } },
  required: ["hub", "serialNumber"],
} as const;
export type AqaraContactConfig = FromSchema<typeof AQARA_CONTACT_CONFIG>;
export interface AqaraDoorWindowSensor extends CapabilityMethods<{ contactSensor: AqaraContact }> {}
export class AqaraDoorWindowSensor extends Device<AqaraContactConfig> {
  readonly model = AQARA_DOOR_WINDOW_SENSOR;
  readonly capabilities;
  constructor(instance: DeviceInstance, config: AqaraContactConfig, readonly hub: AqaraHubM2) {
    super(instance.id, instance.name, config);
    this.capabilities = this.expose({ contactSensor: new AqaraContact(instance.id, hub.source, config.serialNumber) });
  }
  override displayHost(): string { return `Via ${this.hub.name}`; }
  protected override identity() { return { model: "AS006", serialNumber: this.config.serialNumber }; }
  async probe() {
    const state = await this.capabilities.contactSensor.getState();
    if (state.availability !== "online") throw new Error(state.detail ?? "Contact sensor unavailable");
    return this.identity();
  }
}
export const AQARA_DOOR_WINDOW_SENSOR: DeviceModel<AqaraContactConfig> = {
  id: "aqara-door-window-sensor", title: "Aqara Door and Window Sensor", manufacturer: "Aqara", product: "AS006",
  capabilities: ["contactSensor"], connectionTypes: ["local-hub"], configSchema: AQARA_CONTACT_CONFIG, objectSchemaId: contactSensorSchema.$id,
  create(instance, config, _services, _secrets, context) {
    const hub = context?.device(config.hub, { relation: "uses", capability: "hub" });
    if (!(hub instanceof AqaraHubM2)) throw new Error("Aqara contact sensor requires a configured Aqara Hub M2");
    return new AqaraDoorWindowSensor(instance, config, hub);
  },
};
