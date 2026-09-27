import type { DeviceConfigEntry } from "../../config/devices";
import type { HueClipClient } from "./clip-client";
import type { HueResource } from "./resources";

export interface DiscoveredHueDevice {
  deviceId: string;
  name: string;
  product: string;
  room?: string;
  connectivity: string;
  entry?: DeviceConfigEntry;
  configured: boolean;
}

/** Inventory physical devices, joining their service ids; never pair/reset devices or alter Hue rooms. */
export function hueInventory(resources: HueResource[], existing: readonly DeviceConfigEntry[] = []): DiscoveredHueDevice[] {
  const ids = new Set(existing.map(entry => entry.id));
  return resources.filter(r => r.type === "device").map(device => {
    const owned = resources.filter(r => r.owner?.rid === device.id);
    const light = owned.find(r => r.type === "light");
    const motion = owned.some(r => r.type === "motion");
    const buttons = owned.some(r => r.type === "button" || r.type === "relative_rotary");
    const name = device.metadata?.name ?? device.product_data?.product_name ?? "Hue device";
    const product = device.product_data?.product_name ?? "Hue device";
    const room = resources.find(r => r.type === "room" && r.children?.some(child => child.rid === device.id))?.metadata?.name;
    const configured = existing.find(entry => entry.model.startsWith("hue-") && (light ? entry.config.lightId === light.id : entry.config.deviceId === device.id));
    let entry = configured;
    if (!entry && (light || motion || buttons)) {
      const base = `hue-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device"}`.slice(0, 80);
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      const range = light?.color_temperature?.mirek_schema;
      entry = { id, name, model: light ? "hue-light" : motion ? "hue-motion-sensor" : "hue-switch", config: light ? {
        lightId: light.id, color: !!light.color, colorTemperature: !!range,
        ...(range ? { minimumKelvin: Math.ceil(1_000_000 / range.mirek_maximum), maximumKelvin: Math.floor(1_000_000 / range.mirek_minimum) } : {}),
      } : { deviceId: device.id } };
    }
    return { deviceId: device.id, name, product, ...(room ? { room } : {}),
      connectivity: owned.find(r => r.type === "zigbee_connectivity")?.status ?? "unknown",
      ...(entry ? { entry } : {}), configured: !!configured,
    };
  });
}

export async function discoverHueDevices(clip: HueClipClient, existing: readonly DeviceConfigEntry[] = []) {
  return hueInventory(await clip.listResources(), existing);
}
