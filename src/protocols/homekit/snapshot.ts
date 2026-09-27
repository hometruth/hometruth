/** The read-only subset of HAP used by sensors and hubs. */
export interface HapCharacteristic { iid: number; type: string; value?: unknown; status?: number }
export interface HapService { iid: number; type: string; characteristics: HapCharacteristic[] }
export interface HapAccessory { aid: number; services: HapService[] }
export interface HapSnapshot { accessories: HapAccessory[]; observedAt: string }

export function hapType(value: string): string {
  return value.toUpperCase().replace(/-0000-1000-8000-0026BB765291$/, "").replace(/^0+/, "");
}

export function characteristic(service: HapService, type: string): unknown {
  const c = service.characteristics.find((item) => hapType(item.type) === type);
  return c && (c.status === undefined || c.status === 0) ? c.value : undefined;
}

export function accessoryInfo(accessory: HapAccessory): { name?: string; serialNumber?: string; model?: string; firmwareVersion?: string } {
  const info = accessory.services.find((service) => hapType(service.type) === "3E");
  if (!info) return {};
  const fields = { name: "23", serialNumber: "30", model: "21", firmwareVersion: "52" };
  return Object.fromEntries(Object.entries(fields).flatMap(([key, type]) => {
    const value = characteristic(info, type);
    return typeof value === "string" ? [[key, value]] : [];
  }));
}

export function parseAccessories(value: unknown, observedAt = new Date().toISOString()): HapSnapshot {
  const object = value as { accessories?: unknown } | null;
  if (!object || !Array.isArray(object.accessories) || !object.accessories.length) throw new Error("Invalid HomeKit accessory database");
  const accessories: HapAccessory[] = object.accessories.map((a) => {
    if (!a || !Number.isSafeInteger(a.aid) || a.aid < 1 || !Array.isArray(a.services)) throw new Error("Invalid HomeKit accessory");
    return { aid: a.aid, services: a.services.map((s: HapService) => {
      if (!s || !Number.isSafeInteger(s.iid) || typeof s.type !== "string" || !Array.isArray(s.characteristics)) throw new Error("Invalid HomeKit service");
      if (s.characteristics.some((c) => !c || !Number.isSafeInteger(c.iid) || typeof c.type !== "string")) throw new Error("Invalid HomeKit characteristic");
      return s;
    }) };
  });
  if (new Set(accessories.map((a) => a.aid)).size !== accessories.length) throw new Error("Duplicate HomeKit accessory ids");
  return { accessories, observedAt };
}

export function sensorAvailable(service: HapService): boolean {
  const active = characteristic(service, "75");
  const fault = characteristic(service, "77");
  return active !== false && active !== 0 && (fault === undefined || fault === 0);
}

export function binary(value: unknown): boolean | undefined {
  return value === true || value === 1 ? true : value === false || value === 0 ? false : undefined;
}

export function batteryPercent(accessory: HapAccessory): number | undefined {
  const service = accessory.services.find((s) => hapType(s.type) === "96");
  const value = service ? characteristic(service, "68") : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
