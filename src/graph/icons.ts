/**
 * One icon for every node, resolved once on the server while the graph is
 * built, so nothing in the browser ever has to work out what an element looks
 * like and no page shows a placeholder that swaps to the real thing.
 *
 * Resolution is most-specific-first: an instance override, then the model's own
 * icon, then the dominant capability, then the element kind. Every step is
 * data in one of the two tables below rather than a literal scattered through
 * a renderer, and a test holds both tables complete against `ELEMENT_KINDS` and
 * `CAPABILITY_KINDS`.
 *
 * These are deliberately not the `ICON_SHAPES` glyphs in `src/ui/dashboard.ts`.
 * Those are *action* icons for the camera toolbar (play, pause, mic); these are
 * *entity* icons. Different jobs, different sets.
 */
import type { CapabilityKind } from "../models/capability";
import { ELEMENT_KINDS, type ElementKind } from "../tags/identity";
import type { Icon } from "./types";

export const emoji = (value: string): Icon => ({ kind: "emoji", value });

/** Never blank and never a broken image: what an unknown kind falls back to. */
export const FALLBACK_ICON: Icon = emoji("◻️");

export const KIND_ICONS: Readonly<Record<ElementKind, Icon>> = {
  site: emoji("🏠"),
  catalog: emoji("📚"),
  device: emoji("🔌"),
  group: emoji("🧺"),
  "group-switch": emoji("🎚️"),
  "speaker-group": emoji("🔊"),
  service: emoji("⚙️"),
  capability: emoji("🧩"),
  control: emoji("🎛️"),
  property: emoji("🔖"),
  sensor: emoji("🌡️"),
  scene: emoji("🎬"),
  show: emoji("✨"),
  preset: emoji("⭐"),
  signal: emoji("📡"),
  automation: emoji("🤖"),
  region: emoji("🗺️"),
  room: emoji("🚪"),
  widget: emoji("🧱"),
  dashboard: emoji("🖼️"),
  model: emoji("📦"),
  schema: emoji("📐"),
  "event-type": emoji("⚡"),
  tag: emoji("🏷️"),
  "tag-name": emoji("🗂️"),
};

export const CAPABILITY_ICONS: Readonly<Record<CapabilityKind, Icon>> = {
  light: emoji("💡"),
  stringLight: emoji("🎄"),
  binarySwitch: emoji("🔘"),
  button: emoji("🔲"),
  camera: emoji("📷"),
  treatDispenser: emoji("🦴"),
  speaker: emoji("🔊"),
  television: emoji("📺"),
  sensor: emoji("🌡️"),
  occupancySensor: emoji("🚶"),
  contactSensor: emoji("🚪"),
  motionSensor: emoji("👁️"),
  hub: emoji("🛜"),
  infraredBlaster: emoji("📶"),
  radioFrequencyBlaster: emoji("📻"),
  radioFrequencyReceiver: emoji("📻"),
  cooktop: emoji("🍳"),
};

/**
 * The capability an icon should speak for when a device has several. Same
 * precedence `deviceKindOf` uses to pick a page template, so the icon and the
 * page never disagree about what a device mainly is.
 */
export function dominantCapability(capabilities: readonly CapabilityKind[]): CapabilityKind | undefined {
  const has = (kind: CapabilityKind) => capabilities.includes(kind);
  if (has("cooktop")) return "cooktop";
  if (has("camera")) return has("treatDispenser") ? "treatDispenser" : "camera";
  if (has("stringLight")) return "stringLight";
  if (has("light")) return "light";
  if (has("infraredBlaster") || has("radioFrequencyBlaster")) return has("infraredBlaster") ? "infraredBlaster" : "radioFrequencyBlaster";
  if (has("radioFrequencyReceiver")) return "radioFrequencyReceiver";
  if (has("television")) return "television";
  if (has("speaker")) return "speaker";
  if (has("button")) return "button";
  if (has("sensor") || has("occupancySensor") || has("contactSensor")) return has("sensor") ? "sensor" : has("occupancySensor") ? "occupancySensor" : "contactSensor";
  if (has("motionSensor")) return "motionSensor";
  if (has("hub")) return "hub";
  if (has("binarySwitch")) return "binarySwitch";
  return capabilities[0];
}

export interface IconRequest {
  readonly kind: ElementKind;
  /** The capabilities a device node's model declares, in the model's own order. */
  readonly capabilities?: readonly CapabilityKind[];
  /** The model's own icon, when it ships one. */
  readonly modelIcon?: Icon;
  /** Per-instance override from config or the icon store. */
  readonly override?: Icon;
}

export function iconFor(request: IconRequest): Icon {
  if (request.override) return request.override;
  if (request.modelIcon) return request.modelIcon;
  if (request.kind === "device" && request.capabilities?.length) {
    const dominant = dominantCapability(request.capabilities);
    if (dominant) return CAPABILITY_ICONS[dominant];
  }
  if (request.kind === "capability") {
    const only = request.capabilities?.[0];
    if (only) return CAPABILITY_ICONS[only];
  }
  return KIND_ICONS[request.kind] ?? FALLBACK_ICON;
}

/** Where icon images are served from; a bare filename is resolved against it. */
export const ICON_ROUTE = "/icons/";

/**
 * An `icon:` value from config or a store: an emoji string, or `{ image }`.
 *
 * An image is always a local path. Anything with a scheme is refused, because
 * the CSP is nonce-only with no external origins and a remote icon would be a
 * request to an external service unrelated to the configured installation. A bare filename is resolved against
 * the icon route, so `relay.png` works from any page rather than resolving
 * against whatever path happens to be open.
 */
export function parseIcon(value: unknown): Icon | undefined {
  if (typeof value === "string" && value.trim()) return emoji(value.trim());
  if (value && typeof value === "object" && "image" in value) {
    const source = (value as { image?: unknown }).image;
    const alt = (value as { alt?: unknown }).alt;
    if (typeof source !== "string") return undefined;
    const trimmed = source.trim();
    if (!trimmed || /^[a-z]+:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.includes("..")) return undefined;
    const src = trimmed.startsWith("/") ? trimmed : `${ICON_ROUTE}${trimmed}`;
    return { kind: "image", src, ...(typeof alt === "string" && alt ? { alt } : {}) };
  }
  return undefined;
}

export const ALL_ELEMENT_KINDS: readonly ElementKind[] = ELEMENT_KINDS;
