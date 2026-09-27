import { xyToHex } from "../../vendors/hue/clip-client";
import type { HueEvent, LightPatch } from "./config";

export type Resource = Record<string, any>;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** CLIP state is a patch: absent fields never mean off, black, or zero. */
export function lightPatch(resource: Resource): LightPatch {
  const patch: LightPatch = {};
  if (typeof resource.on?.on === "boolean") patch.on = resource.on.on;
  if (finite(resource.dimming?.brightness)) patch.brightnessPercent = clamp(resource.dimming.brightness, 0, 100);
  if (finite(resource.color_temperature?.mirek) && resource.color_temperature.mirek > 0 && resource.color_temperature.mirek_valid !== false) {
    patch.colorTemperatureKelvin = Math.round(1_000_000 / resource.color_temperature.mirek);
  } else if (finite(resource.color?.xy?.x) && finite(resource.color?.xy?.y)) {
    patch.color = xyToHex(resource.color.xy.x, resource.color.xy.y, 100);
  }
  if (finite(resource.dynamics?.duration)) patch.transitionMs = Math.max(0, Math.round(resource.dynamics.duration));
  return patch;
}

export class LightStateTracker {
  readonly resources = new Map<string, Resource>();
  readonly states = new Map<string, LightPatch>();
  private sequence = 0;
  constructor(private readonly emit: (event: HueEvent) => void) {}

  event(type: HueEvent["type"], origin: HueEvent["origin"], source: string, details: Partial<HueEvent> = {}): HueEvent {
    return { id: `${Date.now()}-${++this.sequence}`, at: new Date().toISOString(), type, origin, source, ...details };
  }

  ingest(resource: Resource, publish = true): void {
    if (typeof resource.id !== "string" || typeof resource.type !== "string") return;
    const previous = this.resources.get(resource.id);
    const merged = mergeResource(previous ?? {}, resource);
    this.resources.set(resource.id, merged);
    if (resource.type !== "light") return;
    // Use the incoming patch, not stale xy from a previous temperature mode.
    this.change(`light/${resource.id}`, lightPatch(resource), "bridge", publish);
  }

  change(source: string, patch: LightPatch, origin: HueEvent["origin"], publish = true): void {
    if (!Object.keys(patch).length) return;
    const previous = this.states.get(source) ?? {};
    const next = { ...previous, ...patch };
    if (patch.color !== undefined) delete next.colorTemperatureKelvin;
    if (patch.colorTemperatureKelvin !== undefined) delete next.color;
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => previous[key as keyof LightPatch] !== value)) as LightPatch;
    this.states.set(source, next);
    if (publish && Object.keys(changed).length) this.emit(this.event("light", origin, source, { state: next, changed }));
  }

  snapshot(resources: Resource[], publish: boolean): void {
    const seen = new Set(resources.map(r => r.id));
    for (const [id, resource] of this.resources) if (!seen.has(id)) {
      this.resources.delete(id);
      this.states.delete(`light/${resource.id}`);
    }
    for (const resource of resources) this.ingest(resource, publish);
  }

  aliases(source: string): string[] {
    const resource = source.startsWith("light/") ? this.resources.get(source.slice(6)) : undefined;
    return resource?.id_v1 ? [`light-v1/${String(resource.id_v1).split("/").at(-1)}`] : [];
  }
}

function mergeResource(base: Resource, patch: Resource): Resource {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    merged[key] = value && typeof value === "object" && !Array.isArray(value) ? mergeResource(base[key] ?? {}, value) : value;
  }
  return merged;
}

export interface StreamChannel { channel: number; state: LightPatch }
/** One authenticated DTLS application record, with its original boundaries. */
export function parseHueStream(frame: Uint8Array): { version: number; area: string; channels: StreamChannel[] } {
  const b = Buffer.from(frame);
  if (b.length < 16 || b.subarray(0, 9).toString() !== "HueStream" || ![1, 2].includes(b[9]!) || b[10] !== 0 || ![0, 1].includes(b[14]!)) throw new Error("Invalid HueStream header");
  const version = b[9]!;
  const start = version === 2 ? 52 : 16;
  const width = version === 2 ? 7 : 9;
  const area = version === 2 ? b.subarray(16, 52).toString() : "v1";
  if (version === 2 && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(area)) throw new Error("Invalid HueStream area");
  if (b.length <= start || (b.length - start) % width) throw new Error("Truncated HueStream record");
  const channels: StreamChannel[] = [];
  for (let i = start; i < b.length; i += width) {
    if (version === 1 && b[i] !== 0) continue; // v1 light address only
    const channel = version === 2 ? b[i]! : b.readUInt16BE(i + 1);
    const offset = i + (version === 2 ? 1 : 3);
    const values = [0, 2, 4].map(n => b.readUInt16BE(offset + n) / 65535);
    let color: string;
    let brightness: number;
    if (b[14] === 1) {
      color = xyToHex(values[0]!, values[1]!, 100);
      brightness = values[2]!;
    } else {
      brightness = Math.max(...values);
      // HueStream RGB includes brightness; separate it before using a dimmer.
      color = `#${values.map(v => Math.round(brightness ? v / brightness * 255 : 0).toString(16).padStart(2, "0")).join("")}`;
    }
    channels.push({ channel, state: { color, brightnessPercent: Math.round(brightness * 10000) / 100, on: brightness > 0 } });
  }
  return { version, area, channels };
}
