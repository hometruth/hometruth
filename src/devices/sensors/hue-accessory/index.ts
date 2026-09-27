import type { FromSchema } from "json-schema-to-ts";
import { Device, type DeviceInstance, type DeviceModel, type SiteServices } from "../../../models/device";
import { SensorCollection, type SensorCollectionState, type SensorCollectionReading } from "../../../models/sensors";
import { MotionSensor, type MotionSensorState } from "../../../models/motion-sensor";
import { sensorCollectionSchema } from "../../../models/sensor-schemas";
import { HueClipClient } from "../../../vendors/hue/clip-client";
import type { HueResource } from "../../../vendors/hue/resources";


export class HueAccessorySource {
  constructor(readonly clip: HueClipClient, readonly deviceId: string) {}
  async read() {
    const all = await this.clip.listResources(2000);
    const device = all.find(r => r.id === this.deviceId && r.type === "device");
    if (!device) throw new Error("Hue accessory no longer exists on the bridge");
    const owned = all.filter(r => r.owner?.rid === this.deviceId);
    const status = owned.find(r => r.type === "zigbee_connectivity")?.status;
    const availability = status === "connected" ? "online" as const : status ? "offline" as const : "unknown" as const;
    return { device, owned, availability, observedAt: new Date().toISOString() };
  }
}

export class HueAccessorySensor extends SensorCollection {
  constructor(id: string, readonly source: HueAccessorySource) { super(id); }
  async getState(): Promise<SensorCollectionState> {
    try {
      const { owned, availability, observedAt } = await this.source.read();
      const sensors: SensorCollectionReading[] = [];
      const add = (resource: HueResource, name: string, quantity: string, unit: string, value: number | undefined, valid = true, detail?: string, at = observedAt) => {
        sensors.push({ id: resource.id, name, quantity, unit,
          availability: availability === "online" && valid ? "online" : availability === "offline" ? "offline" : "unknown",
          ...(availability === "online" && valid ? { ...(value !== undefined ? { value } : {}), observedAt: at, ...(detail ? { detail } : {}) } : {}),
        });
      };
      for (const r of owned) {
        if (r.motion) add(r, "Motion", "motion", "", Number(r.motion.motion), r.enabled !== false && r.motion.motion_valid, r.motion.motion ? "Detected" : "Clear");
        if (r.temperature) add(r, "Temperature", "temperature", "°C", r.temperature.temperature, r.enabled !== false && r.temperature.temperature_valid);
        if (r.light) add(r, "Illuminance", "illuminance", "lux", r.light.light_level === 0 ? 0 : 10 ** ((r.light.light_level - 1) / 10000), r.enabled !== false && r.light.light_level_valid);
        if (r.power_state) add(r, "Battery", "battery", "%", r.power_state.battery_level);
        if (r.button) {
          const report = r.button.button_report;
          add(r, `Button ${r.metadata?.control_id ?? ""} · last event`, "button-event", "", undefined, !!report,
            report?.event.replaceAll("_", " "), report?.updated);
        }
        if (r.relative_rotary) {
          const report = r.relative_rotary.rotary_report;
          add(r, "Dial · last event", "rotation", "", undefined, !!report,
            report ? `${report.rotation.direction.replaceAll("_", " ")} · ${report.rotation.steps} steps` : undefined, report?.updated);
        }
      }
      return { availability, observedAt, sensors, ...(availability !== "online" ? { detail: "Hue bridge reports this accessory unreachable" } : {}) };
    } catch { return { availability: "offline", sensors: [], detail: "Could not read the Hue accessory" }; }
  }
}

export class HueMotionCapability extends MotionSensor {
  override readonly controlIds = [];
  constructor(id: string, readonly source: HueAccessorySource) { super(id); }
  async actions() { return {}; }
  async state(): Promise<MotionSensorState> {
    try {
      const { owned, availability, observedAt } = await this.source.read();
      if (availability !== "online") return { availability };
      const resource = owned.find(r => r.type === "motion");
      if (!resource?.motion?.motion_valid || resource.enabled === false) return { availability: "unknown" };
      const light = owned.find(r => r.type === "light_level");
      const battery = owned.find(r => r.type === "device_power")?.power_state?.battery_level;
      return { availability, observedAt, motion: resource.motion.motion,
        ...(light?.enabled !== false && light?.light?.light_level_valid ? { illuminanceLux: light.light.light_level === 0 ? 0 : 10 ** ((light.light.light_level - 1) / 10000) } : {}),
        ...(battery !== undefined ? { batteryPercent: battery } : {}),
      };
    } catch { return { availability: "offline" }; }
  }
}

export const HUE_ACCESSORY_CONFIG = {
  $id: "https://hometruth.ai/schemas/models/hue-accessory/config", type: "object", additionalProperties: false,
  properties: { deviceId: { type: "string", minLength: 1, maxLength: 100 } }, required: ["deviceId"],
} as const;
export type HueAccessoryConfig = FromSchema<typeof HUE_ACCESSORY_CONFIG>;
export class HueAccessory extends Device<HueAccessoryConfig> {
  readonly capabilities;
  readonly source: HueAccessorySource;
  constructor(instance: DeviceInstance, config: HueAccessoryConfig, services: SiteServices, readonly model: DeviceModel<HueAccessoryConfig>) {
    super(instance.id, instance.name, config);
    if (!services.hue) throw new Error("No Hue bridge configured");
    this.source = new HueAccessorySource(services.hue.clip, config.deviceId);
    this.capabilities = this.expose({ sensor: new HueAccessorySensor(instance.id, this.source),
      ...(model.id === "hue-motion-sensor" ? { motionSensor: new HueMotionCapability(instance.id, this.source) } : {}),
    });
  }
  override displayHost() { return `${this.source.clip.host} (Hue bridge)`; }
  async probe() {
    const { device, availability } = await this.source.read();
    if (availability !== "online") throw new Error("Hue accessory unreachable");
    return { model: device.product_data?.product_name ?? this.model.product };
  }
}
export const HUE_MOTION_SENSOR: DeviceModel<HueAccessoryConfig> = {
  id: "hue-motion-sensor", title: "Hue motion sensor", manufacturer: "Signify", product: "Hue motion sensor",
  capabilities: ["sensor", "motionSensor"], connectionTypes: ["local-hub"], configSchema: HUE_ACCESSORY_CONFIG, objectSchemaId: sensorCollectionSchema.$id,
  create(instance, config, services) { return new HueAccessory(instance, config, services, HUE_MOTION_SENSOR); },
};
export const HUE_SWITCH: DeviceModel<HueAccessoryConfig> = {
  id: "hue-switch", title: "Hue switch / tap dial", manufacturer: "Signify", product: "Hue switch",
  capabilities: ["sensor"], connectionTypes: ["local-hub"], configSchema: { ...HUE_ACCESSORY_CONFIG, $id: "https://hometruth.ai/schemas/models/hue-switch/config" }, objectSchemaId: sensorCollectionSchema.$id,
  create(instance, config, services) { return new HueAccessory(instance, config, services, HUE_SWITCH); },
};
