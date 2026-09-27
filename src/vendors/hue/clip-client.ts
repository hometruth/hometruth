/**
 * The minimal Hue CLIP v2 client this vendor needs: starting and stopping an
 * entertainment streaming session, and reading/writing a light's plain
 * on/off/brightness/color state outside of the fast DTLS stream (Entertainment
 * streaming only ever changes color and brightness of a light that is already
 * on; turning a light on or off is always a normal CLIP call).
 *
 * The bridge's certificate is self-signed and rotates with firmware; like the
 * rest of this project's LAN clients, verification is skipped for a bridge
 * address the caller already trusts (it must be a private LAN host).
 */
import type { HueResource } from "./resources";
import { isSafeCameraUri } from "../../camera-media";

export type HueClipFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class HueClipError extends Error {
  constructor(message: string, readonly code: "invalid_host" | "unreachable" | "protocol" | "not_found") {
    super(message);
    this.name = "HueClipError";
  }
}

export interface HueClipClientOptions {
  readonly host: string;
  readonly applicationKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: HueClipFetch;
}

export interface HueLightState {
  readonly on: boolean;
  readonly brightnessPercent: number;
  readonly color?: string;
  readonly colorTemperatureKelvin?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** A fetch that trusts the bridge's self-signed certificate; Bun's `tls.rejectUnauthorized` fetch option. */
function insecureFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
}

export class HueClipClient {
  readonly host: string;
  private readonly applicationKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: HueClipFetch;
  private inventoryCache: { at: number; pending: Promise<HueResource[]> } | undefined;

  constructor(options: HueClipClientOptions) {
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`https://${host}/`)) {
      throw new HueClipError("Hue bridge host must be a private LAN address", "invalid_host");
    }
    this.host = host;
    this.applicationKey = options.applicationKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? insecureFetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ data: Array<Record<string, unknown>> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${this.host}${path}`, {
        method,
        signal: controller.signal,
        headers: { "hue-application-key": this.applicationKey, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new HueClipError(`Could not reach the Hue bridge at ${this.host}`, "unreachable");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) throw new HueClipError(`Not found: ${path}`, "not_found");
    if (!response.ok) throw new HueClipError(`Hue bridge returned HTTP ${response.status} for ${path}`, "protocol");
    const parsed = await response.json().catch(() => undefined) as { data?: unknown; errors?: unknown } | undefined;
    if (!parsed || !Array.isArray(parsed.data)) throw new HueClipError(`Hue bridge returned an unexpected response for ${path}`, "protocol");
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new HueClipError(`Hue bridge rejected the request: ${JSON.stringify(parsed.errors)}`, "protocol");
    }
    if (method === "PUT") this.inventoryCache = undefined;
    return parsed as { data: Array<Record<string, unknown>> };
  }

  /** Start entertainment streaming for one area; must be followed promptly by a DTLS handshake or the bridge drops the session. */
  async startEntertainment(areaId: string): Promise<void> {
    await this.request("PUT", `/clip/v2/resource/entertainment_configuration/${areaId}`, { action: "start" });
  }

  async stopEntertainment(areaId: string): Promise<void> {
    await this.request("PUT", `/clip/v2/resource/entertainment_configuration/${areaId}`, { action: "stop" });
  }

  async listResources(maxAgeMs = 0): Promise<HueResource[]> {
    if (maxAgeMs > 0 && this.inventoryCache && Date.now() - this.inventoryCache.at < maxAgeMs) return this.inventoryCache.pending;
    const pending = this.request("GET", "/clip/v2/resource").then(result => result.data as unknown as HueResource[]);
    this.inventoryCache = { at: Date.now(), pending };
    pending.catch(() => { if (this.inventoryCache?.pending === pending) this.inventoryCache = undefined; });
    return pending;
  }

  async getLightResource(lightId: string): Promise<HueResource> {
    const { data } = await this.request("GET", `/clip/v2/resource/light/${encodeURIComponent(lightId)}`);
    if (!data[0]) throw new HueClipError(`No light with id ${lightId}`, "not_found");
    return data[0] as unknown as HueResource;
  }

  async getLightState(lightId: string): Promise<HueLightState> {
    const resources = await this.listResources(2000);
    const light = resources.find(r => r.type === "light" && r.id === lightId);
    if (!light) throw new HueClipError(`No light with id ${lightId}`, "not_found");
    if (light.owner) {
      const connectivity = resources.find(r => r.type === "zigbee_connectivity" && r.owner?.rid === light.owner?.rid);
      if (connectivity?.status && connectivity.status !== "connected") throw new HueClipError("Hue bridge reports this light unreachable", "unreachable");
    }
    const on = light.on?.on === true;
    const brightnessPercent = light.dimming?.brightness ?? 0;
    const xy = light.color?.xy;
    const temperature = light.color_temperature;
    return { on, brightnessPercent,
      ...(xy ? { color: xyToHex(xy.x, xy.y, 100) } : {}),
      ...(temperature?.mirek_valid && temperature.mirek ? { colorTemperatureKelvin: Math.round(1_000_000 / temperature.mirek) } : {}),
    };
  }

  async setColorTemperature(lightId: string, kelvin: number): Promise<void> {
    if (!Number.isFinite(kelvin) || kelvin <= 0) throw new HueClipError("Color temperature must be a positive Kelvin value", "protocol");
    const light = await this.getLightResource(lightId);
    const range = light.color_temperature?.mirek_schema;
    if (!range) throw new HueClipError("This light has no color temperature control", "protocol");
    const mirek = Math.round(1_000_000 / kelvin);
    if (mirek < range.mirek_minimum || mirek > range.mirek_maximum) throw new HueClipError("Color temperature is outside this light's range", "protocol");
    await this.request("PUT", `/clip/v2/resource/light/${encodeURIComponent(lightId)}`, { color_temperature: { mirek } });
  }

  async turnOn(lightId: string): Promise<void> {
    await this.request("PUT", `/clip/v2/resource/light/${lightId}`, { on: { on: true } });
  }

  async turnOff(lightId: string): Promise<void> {
    await this.request("PUT", `/clip/v2/resource/light/${lightId}`, { on: { on: false } });
  }

  async setBrightness(lightId: string, percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new HueClipError("Brightness must be between 0 and 100", "protocol");
    await this.request("PUT", `/clip/v2/resource/light/${lightId}`, { dimming: { brightness: percent } });
  }

  /** Sets color via the normal CLIP call (xy space); the DTLS stream is for fast per-frame updates, this is for a one-off, non-streamed change. */
  async setColorHex(lightId: string, hex: string): Promise<void> {
    const [x, y] = hexToXy(hex);
    if (hex.toLowerCase() === "#000000") return this.turnOff(lightId);
    await this.request("PUT", `/clip/v2/resource/light/${lightId}`, { color: { xy: { x, y } } });
  }
}

/** sRGB (gamma-corrected) to CIE xy, the color space Hue's non-streamed API uses. Ignores the light's own gamut triangle (the bridge clips to it). */
export function hexToXy(hex: string): [number, number] {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/u.exec(hex);
  if (!match) throw new HueClipError(`Invalid hex color "${hex}"`, "protocol");
  const [, rHex, gHex, bHex] = match;
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = linear(parseInt(rHex!, 16));
  const g = linear(gHex ? parseInt(gHex, 16) : 0);
  const b = linear(bHex ? parseInt(bHex, 16) : 0);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3227, 0.329]; // sum==0 only for pure black; report Hue's own white point rather than divide by zero.
  return [X / sum, Y / sum];
}

/** CIE xy (+ perceived brightness, 0-100) back to an approximate sRGB hex, for reporting a light's current color. */
export function xyToHex(x: number, y: number, brightnessPercent: number): string {
  const Y = Math.max(1, brightnessPercent) / 100;
  const X = y === 0 ? 0 : (Y / y) * x;
  const Z = y === 0 ? 0 : (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  // Normalize together before gamma correction; clipping channels separately shifts the hue.
  const maximum = Math.max(r, g, b, 1);
  r = gamma(r / maximum); g = gamma(g / maximum); b = gamma(b / maximum);
  const toByte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255);
  const toHex = (c: number) => toByte(c).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
