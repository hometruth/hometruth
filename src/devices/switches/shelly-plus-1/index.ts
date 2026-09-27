import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { binarySwitchSchema } from "../../../schemas";

/** The subset of `fetch` a Shelly switch needs; narrow enough to fake in tests. */
export type ShellyFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface ShellyGen2SwitchOptions {
  id: string;
  /** LAN IP address or `.local` hostname of the relay. Public hosts are rejected. */
  host: string;
  /** Switch component index on multi-channel devices. Defaults to 0. */
  channel?: number;
  timeoutMs?: number;
  fetch?: ShellyFetch;
}

/**
 * A binary switch backed by a Shelly Gen2+ relay (Plus/Pro/Mini series) using
 * its local HTTP RPC interface: `Switch.Set`, `Switch.Toggle`, and
 * `Switch.GetStatus`. No cloud account is involved.
 */
export class ShellyGen2Switch extends BinarySwitch {
  readonly host: string;
  readonly channel: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ShellyFetch;

  constructor(options: ShellyGen2SwitchOptions) {
    super(options.id);
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new BinarySwitchError("Shelly switch host must be a private LAN address", "invalid_host");
    }
    const channel = options.channel ?? 0;
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
      throw new BinarySwitchError("Shelly switch channel must be an integer from 0 to 15", "protocol");
    }
    this.host = host;
    this.channel = channel;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  override async turnOn(): Promise<void> {
    await this.rpc("Switch.Set", { on: "true" });
  }

  override async turnOff(): Promise<void> {
    await this.rpc("Switch.Set", { on: "false" });
  }

  override async toggle(): Promise<void> {
    await this.rpc("Switch.Toggle", {});
  }

  override async getState(): Promise<BinarySwitchState> {
    const status = await this.rpc("Switch.GetStatus", {});
    const output = status.output;
    if (typeof output !== "boolean") {
      throw new BinarySwitchError("Shelly Switch.GetStatus did not report an output state", "protocol");
    }
    return output ? "on" : "off";
  }

  private async rpc(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`http://${this.host}/rpc/${method}`);
    url.searchParams.set("id", String(this.channel));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BinarySwitchError(`Shelly switch at ${this.host} is unreachable: ${detail}`, "unreachable");
    }
    if (!response.ok) {
      throw new BinarySwitchError(`Shelly ${method} failed with HTTP ${response.status}`, "protocol");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BinarySwitchError(`Shelly ${method} returned a non-JSON response`, "protocol");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BinarySwitchError(`Shelly ${method} returned an unexpected response`, "protocol");
    }
    return body as Record<string, unknown>;
  }
}

export const SHELLY_PLUS_1_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/shelly-plus-1/config",
  title: "Shelly Plus 1 config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of the relay. */
    host: lanHostSchema,
    /** Switch component index on multi-channel devices. */
    channel: { type: "integer", minimum: 0, maximum: 15 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  },
  required: ["host"],
} as const;

export type ShellyPlus1Config = FromSchema<typeof SHELLY_PLUS_1_CONFIG_SCHEMA>;

/** `relay.turnOn()`, `relay.toggle()`, `relay.getState()`… forwarded from the switch. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ShellyPlus1 extends CapabilityMethods<{ binarySwitch: ShellyGen2Switch }> {}

/** A Shelly Plus 1 relay: one binary switch on the LAN, no account. */
export class ShellyPlus1 extends Device<ShellyPlus1Config> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  readonly switch: ShellyGen2Switch;

  constructor(instance: DeviceInstance, config: ShellyPlus1Config, options: { fetch?: ShellyFetch } = {}) {
    super(instance.id, instance.name, config);
    this.switch = new ShellyGen2Switch({
      id: instance.id,
      host: config.host,
      ...(config.channel !== undefined ? { channel: config.channel } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.switch.getState();
    return { model: SHELLY_PLUS_1.product };
  }
}

export const SHELLY_PLUS_1: DeviceModel<ShellyPlus1Config> = {
  id: "shelly-plus-1",
  title: "Shelly Plus 1",
  manufacturer: "Shelly",
  product: "Plus 1",
  capabilities: ["binarySwitch"],
  connectionTypes: ["direct-local"],
  configSchema: SHELLY_PLUS_1_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance: DeviceInstance, config: ShellyPlus1Config, _services: SiteServices, _secrets: SecretsBag): ShellyPlus1 {
    return new ShellyPlus1(instance, config);
  },
};
