/** Persisted bridge configuration contains references and mappings, never pairing keys. */
export type BridgeProtocol = "matter" | "homekit";
export type Value = string | number | boolean | null;
export interface Transform {
  scale?: number;
  offset?: number;
  values?: Record<string, Value>;
  conversion?: "kelvin-mired" | "hex-hue" | "hex-saturation" | "battery-low" | "co2-high" | "pm25-quality";
}
export interface ReadBinding extends Transform { element: string; path: string; }
export interface ControlBinding extends Transform { element: string; value?: Value; }
export interface CharacteristicBinding {
  read?: ReadBinding;
  event?: { element: string };
  /** A button capability exposed as a self-resetting HomeKit switch, never appliance power. */
  trigger?: { element: string };
  write?: ControlBinding;
  /** A distinct control for each incoming value, for example separate on/off buttons. */
  commands?: Record<string, ControlBinding>;
  /** Fixed configuration, never a substitute for a required live measurement. */
  constant?: Value;
}
export interface AccessoryMapping {
  id: string;
  name: string;
  profile: string;
  camera?: string;
  characteristics: Record<string, CharacteristicBinding>;
}
/** How one automatic accessory appears in Apple Home; absent fields keep the automatic choice. */
export interface AccessoryOverride {
  name?: string;
  /** Another Apple accessory type that carries the same characteristics, for example Outlet for a Switch. */
  profile?: string;
  /** Left out of Apple Home while the item's other accessories stay shared. */
  hidden?: true;
}
export interface BridgeMembership {
  element: string;
  /** Empty means derive native accessory mappings from the element's capabilities. */
  mappings: AccessoryMapping[];
  /** Overrides for automatic accessories, keyed by accessory slot. Only for automatic settings. */
  accessories?: Record<string, AccessoryOverride>;
}
export interface BridgeDefinition {
  id: string;
  name: string;
  protocol: BridgeProtocol;
  enabled: boolean;
  port: number;
  revision: number;
  members: BridgeMembership[];
}
export interface BridgeStatus {
  running: boolean;
  paired: boolean;
  updatedAt: string;
  detail: string;
  accessories: number;
  reachable: number;
  pairing?: { code: string; uri: string };
  externalAccessories?: { id: string; name: string; paired: boolean; code?: string; uri?: string }[];
  /** Why the bridge is not running, when it stopped rather than is still starting. */
  fault?: string;
  /** Exported accessory IDs whose required state is currently unavailable. */
  unreachable?: string[];
}
/** One item shared by a bridge, resolved into what Apple Home receives. */
export interface SharedItem {
  element: string;
  name: string;
  room?: string;
  page?: string;
  /** The element no longer exists or cannot be resolved; the bridge stays stopped until it is removed. */
  missing: boolean;
  /** Why a missing item cannot be shared. */
  problem?: string;
  custom: boolean;
  accessories: SharedAccessory[];
}
export interface SharedAccessory {
  slot: string;
  /** The exported accessory ID, as reported in `BridgeStatus.unreachable`. */
  id: string;
  name: string;
  /** The name HomeTruth would choose with no override. */
  automaticName: string;
  profile: string;
  automaticProfile: string;
  /** Accessory types this accessory can appear as, including its current one. */
  profiles: string[];
  hidden: boolean;
}
export interface CharacteristicDefinition {
  key: string;
  name: string;
  format: string;
  readable: boolean;
  writable: boolean;
  event: boolean;
  required: boolean;
  unit?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  values?: number[];
  configuration?: boolean;
}
export interface AccessoryProfile {
  id: string;
  name: string;
  protocols: BridgeProtocol[];
  service: string;
  category: number;
  external?: boolean;
  characteristics: CharacteristicDefinition[];
}
export interface ExportAccessory extends AccessoryMapping {
  element: string;
  /** The accessory's stable place within its item: the mapping ID, or the automatic accessory's role. */
  slot: string;
  cameraDevice?: string;
  inputs?: { id: number; name: string }[];
}
export interface AccessorySnapshot {
  id: string;
  reachable: boolean;
  values: Record<string, Value>;
}
export class BridgeError extends Error {
  constructor(message: string, readonly code: "invalid" | "missing" | "conflict" | "unavailable" = "invalid") {
    super(message); this.name = "BridgeError";
  }
}

export function transform(value: unknown, spec: Transform, reverse = false): Value {
  if (spec.values) {
    const mapped = reverse ? Object.entries(spec.values).find(([, mapped]) => mapped === value)?.[0] : spec.values[String(value)];
    if (mapped === undefined) throw new BridgeError("The observed value has no configured mapping", "unavailable");
    value = mapped;
  }
  if (spec.conversion === "kelvin-mired") {
    if (typeof value !== "number" || value <= 0) throw new BridgeError("A positive colour temperature is required");
    value = Math.round(1_000_000 / value);
  } else if (spec.conversion?.startsWith("hex-")) {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new BridgeError("A reported RGB colour is required", "unavailable");
    const [r, g, b] = [1, 3, 5].map(i => parseInt((value as string).slice(i, i + 2), 16) / 255) as [number, number, number];
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
    value = spec.conversion === "hex-saturation" ? hi === 0 ? 0 : delta / hi * 100
      : delta === 0 ? 0 : ((hi === r ? (g - b) / delta : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  }
  if (["battery-low", "co2-high", "pm25-quality"].includes(spec.conversion ?? "")) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new BridgeError("A measurement is required", "unavailable");
    value = spec.conversion === "battery-low" ? (value <= 20 ? 1 : 0)
      : spec.conversion === "co2-high" ? (value >= 1000 ? 1 : 0)
      : value <= 12 ? 1 : value <= 35 ? 2 : value <= 55 ? 3 : value <= 150 ? 4 : 5;
  }
  if (spec.scale !== undefined || spec.offset !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new BridgeError("A numeric value is required");
    const scale = spec.scale ?? 1;
    if (scale === 0) throw new BridgeError("Scale cannot be zero");
    value = reverse ? (value - (spec.offset ?? 0)) / scale : value * scale + (spec.offset ?? 0);
  }
  if (value !== null && typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") throw new BridgeError("The value is unavailable", "unavailable");
  if (typeof value === "number" && !Number.isFinite(value)) throw new BridgeError("The value is not finite", "unavailable");
  return value as Value;
}
