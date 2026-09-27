import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Light, LightError, type LightState } from "../../../models/light";
import { lightSchema } from "../../../schemas";

/** The subset of `fetch` a Keylight Air needs; narrow enough to fake in tests. */
export type KeylightFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface ElgatoKeylightAirOptions {
  id: string;
  /** LAN IP address or `.local` hostname of the light. Public hosts are rejected. */
  host: string;
  /** HTTP port for the light's local API. Defaults to 9123. */
  port?: number;
  timeoutMs?: number;
  fetch?: KeylightFetch;
}

interface ElgatoLightsBody {
  numberOfLights: number;
  lights: Array<{ on: 0 | 1; brightness: number; temperature: number }>;
}

const MIN_MIREDS = 143;
const MAX_MIREDS = 344;

function kelvinToMireds(kelvin: number): number {
  const mireds = Math.round(1_000_000 / kelvin);
  return Math.min(MAX_MIREDS, Math.max(MIN_MIREDS, mireds));
}

function miredsToKelvin(mireds: number): number {
  return Math.round((1_000_000 / mireds) / 50) * 50;
}

/**
 * A light backed by an Elgato Key Light Air using its local HTTP API
 * (`GET`/`PUT /elgato/lights`, `GET /elgato/accessory-info`). No cloud
 * account is involved; this talks directly to the light over the LAN.
 */
export class ElgatoKeylightAir extends Light {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: KeylightFetch;

  constructor(options: ElgatoKeylightAirOptions) {
    super(options.id);
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new LightError("Keylight host must be a private LAN address", "invalid_host");
    }
    const port = options.port ?? 9123;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new LightError("Keylight port must be an integer from 1 to 65535", "protocol");
    }
    this.host = host;
    this.port = port;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  override async turnOn(): Promise<void> {
    await this.setLight({ on: 1 });
  }

  override async turnOff(): Promise<void> {
    await this.setLight({ on: 0 });
  }

  override async toggle(): Promise<void> {
    const state = await this.getState();
    await this.setLight({ on: state.on ? 0 : 1 });
  }

  override async setBrightness(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new LightError("Brightness must be a percentage from 0 to 100", "protocol");
    }
    await this.setLight({ brightness: Math.round(percent) });
  }

  override async setColorTemperature(kelvin: number): Promise<void> {
    if (!Number.isFinite(kelvin) || kelvin < 2900 || kelvin > 7000) {
      throw new LightError("Color temperature must be between 2900K and 7000K", "protocol");
    }
    await this.setLight({ temperature: kelvinToMireds(kelvin) });
  }

  override async getState(): Promise<LightState> {
    const body = await this.request("GET", "/elgato/lights");
    return this.stateFromBody(body);
  }

  private async setLight(
    change: Partial<{ on: 0 | 1; brightness: number; temperature: number }>,
  ): Promise<LightState> {
    const current = await this.request("GET", "/elgato/lights");
    const light = current.lights[0];
    if (!light) throw new LightError(`Keylight at ${this.host} reported no lights`, "protocol");
    const payload: ElgatoLightsBody = {
      numberOfLights: 1,
      lights: [{ ...light, ...change }],
    };
    const body = await this.request("PUT", "/elgato/lights", payload);
    return this.stateFromBody(body);
  }

  private stateFromBody(body: ElgatoLightsBody): LightState {
    const light = body.lights[0];
    if (!light) throw new LightError(`Keylight at ${this.host} reported no lights`, "protocol");
    return {
      on: light.on === 1,
      brightnessPercent: light.brightness,
      colorTemperatureKelvin: miredsToKelvin(light.temperature),
    };
  }

  private async request(method: "GET" | "PUT", path: string, payload?: ElgatoLightsBody): Promise<ElgatoLightsBody> {
    const url = new URL(`http://${this.host}:${this.port}${path}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new LightError(`Keylight at ${this.host} is unreachable: ${detail}`, "unreachable");
    }
    if (!response.ok) {
      throw new LightError(`Keylight ${method} ${path} failed with HTTP ${response.status}`, "protocol");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new LightError(`Keylight ${method} ${path} returned a non-JSON response`, "protocol");
    }
    if (
      typeof body !== "object" || body === null || Array.isArray(body)
      || !Array.isArray((body as Record<string, unknown>).lights)
    ) {
      throw new LightError(`Keylight ${method} ${path} returned an unexpected response`, "protocol");
    }
    return body as ElgatoLightsBody;
  }
}

export const ELGATO_KEY_LIGHT_AIR_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/elgato-key-light-air/config",
  title: "Elgato Key Light Air config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of the light. */
    host: lanHostSchema,
    /** HTTP port for the light's local API; 9123 unless changed. */
    port: { type: "integer", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  },
  required: ["host"],
} as const;

export type ElgatoKeyLightAirConfig = FromSchema<typeof ELGATO_KEY_LIGHT_AIR_CONFIG_SCHEMA>;

/** `lamp.turnOn()`, `lamp.setBrightness(40)`… forwarded from the light. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ElgatoKeyLightAir extends CapabilityMethods<{ light: ElgatoKeylightAir }> {}

/** An Elgato Key Light Air: one light on the LAN, no account. */
export class ElgatoKeyLightAir extends Device<ElgatoKeyLightAirConfig> {
  readonly model = ELGATO_KEY_LIGHT_AIR;
  readonly capabilities;
  readonly light: ElgatoKeylightAir;

  constructor(instance: DeviceInstance, config: ElgatoKeyLightAirConfig, options: { fetch?: KeylightFetch } = {}) {
    super(instance.id, instance.name, config);
    this.light = new ElgatoKeylightAir({
      id: instance.id,
      host: config.host,
      ...(config.port !== undefined ? { port: config.port } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.capabilities = this.expose({ light: this.light });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.light.getState();
    return { model: ELGATO_KEY_LIGHT_AIR.product };
  }
}

export const ELGATO_KEY_LIGHT_AIR: DeviceModel<ElgatoKeyLightAirConfig> = {
  id: "elgato-key-light-air",
  title: "Elgato Key Light Air",
  manufacturer: "Elgato",
  product: "Key Light Air",
  capabilities: ["light"],
  connectionTypes: ["direct-local"],
  configSchema: ELGATO_KEY_LIGHT_AIR_CONFIG_SCHEMA,
  objectSchemaId: lightSchema.$id,
  create(instance: DeviceInstance, config: ElgatoKeyLightAirConfig, _services: SiteServices, _secrets: SecretsBag): ElgatoKeyLightAir {
    return new ElgatoKeyLightAir(instance, config);
  },
};
