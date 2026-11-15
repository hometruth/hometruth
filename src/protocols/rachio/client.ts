/**
 * Rachio public REST API client (`https://api.rach.io/1/public`).
 *
 * Rachio controllers have no local API: every read and every command goes
 * through Rachio's cloud with a personal API key (Rachio app → Account
 * settings → Get API key) sent as `Authorization: Bearer <key>`. The key is
 * never put in an error message, a URL, or a log line.
 *
 * Rachio meters the API per key, about 1,700 calls a day, and reports the
 * remaining allowance in `X-RateLimit-*` headers on each answer. This client
 * records the latest headers so a caller can stop polling before the account
 * is locked out of commands; it does no scheduling of its own.
 */
export const RACHIO_API = "https://api.rach.io/1/public/";

/** Rachio's documented bounds for `PUT /zone/start`: 0..10800 seconds (three hours). */
export const RACHIO_MAX_ZONE_SECONDS = 10_800;
/** Rachio's documented bounds for `PUT /device/rain_delay`: 0..604800 seconds (seven days). */
export const RACHIO_MAX_RAIN_DELAY_SECONDS = 604_800;

export type RachioFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export type RachioErrorCode =
  /** No API key is configured, so nothing was asked. */
  | "not_configured"
  /** Rachio refused the key (401/403). */
  | "authentication"
  /** The daily allowance is spent (429), or nearly so and polling paused to keep commands working. */
  | "rate_limited"
  /** Rachio answered, but the account has no such controller or zone. */
  | "unavailable"
  /** The cloud could not be reached, timed out, or failed (5xx). */
  | "unreachable"
  /** Rachio answered with something this client does not understand. */
  | "protocol"
  | "invalid_value";

export class RachioError extends Error {
  constructor(message: string, readonly code: RachioErrorCode) {
    super(message);
    this.name = "RachioError";
  }
}

export interface RachioZone {
  readonly id: string;
  readonly zoneNumber: number;
  readonly name: string;
  readonly enabled: boolean;
  /** Seconds; Rachio's per-zone runtime ceiling when the account sets one. */
  readonly maxRuntime?: number;
  /** Milliseconds since the epoch. */
  readonly lastWateredDate?: number;
}

export interface RachioController {
  readonly id: string;
  readonly name: string;
  /** `ONLINE` or `OFFLINE`, as the cloud last heard from the controller. */
  readonly status: string;
  /** False while the controller is in standby (schedules suspended). */
  readonly on: boolean;
  readonly serialNumber?: string;
  /** Rachio's model code, e.g. `GENERATION3_16ZONE`. */
  readonly model?: string;
  /** Milliseconds since the epoch; absent or past means no rain delay. */
  readonly rainDelayExpirationDate?: number;
  /** Only present on controllers wired to a rain sensor. */
  readonly rainSensorTripped?: boolean;
  readonly zones: readonly RachioZone[];
}

/** What `GET /device/{id}/current_schedule` says is running; `undefined` when nothing is. */
export interface RachioCurrentSchedule {
  readonly zoneId?: string;
  readonly zoneNumber?: number;
  readonly status?: string;
  readonly type?: string;
  /** Milliseconds since the epoch. */
  readonly zoneStartDate?: number;
  /** Seconds. */
  readonly zoneDuration?: number;
}

export interface RachioRateLimit {
  readonly limit?: number;
  readonly remaining?: number;
  /** Milliseconds since the epoch. */
  readonly resetAt?: number;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, what: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RachioError(`Rachio returned an unexpected ${what}`, "protocol");
  return value as ObjectValue;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RachioError(`Rachio returned no ${what}`, "protocol");
  return value;
}

const optionalNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const optionalText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

export function parseZone(value: unknown): RachioZone {
  const zone = object(value, "zone");
  const zoneNumber = zone.zoneNumber;
  if (typeof zoneNumber !== "number" || !Number.isInteger(zoneNumber) || zoneNumber < 1) throw new RachioError("Rachio returned a zone without a zone number", "protocol");
  const maxRuntime = optionalNumber(zone.maxRuntime);
  const lastWateredDate = optionalNumber(zone.lastWateredDate);
  return {
    id: text(zone.id, "zone id"),
    zoneNumber,
    name: optionalText(zone.name) ?? `Zone ${zoneNumber}`,
    enabled: zone.enabled !== false,
    ...(maxRuntime !== undefined && maxRuntime > 0 ? { maxRuntime } : {}),
    ...(lastWateredDate !== undefined ? { lastWateredDate } : {}),
  };
}

export function parseController(value: unknown): RachioController {
  const device = object(value, "controller");
  if (typeof device.on !== "boolean") throw new RachioError("Rachio returned a controller without its on/standby state", "protocol");
  const zones = Array.isArray(device.zones) ? device.zones.map(parseZone).sort((a, b) => a.zoneNumber - b.zoneNumber) : [];
  const serialNumber = optionalText(device.serialNumber);
  const model = optionalText(device.model);
  const rainDelayExpirationDate = optionalNumber(device.rainDelayExpirationDate);
  return {
    id: text(device.id, "controller id"),
    name: optionalText(device.name) ?? "Rachio controller",
    status: text(device.status, "controller status"),
    on: device.on,
    ...(serialNumber ? { serialNumber } : {}),
    ...(model ? { model } : {}),
    ...(rainDelayExpirationDate !== undefined ? { rainDelayExpirationDate } : {}),
    ...(typeof device.rainSensorTripped === "boolean" ? { rainSensorTripped: device.rainSensorTripped } : {}),
    zones,
  };
}

export function parseCurrentSchedule(value: unknown): RachioCurrentSchedule | undefined {
  const schedule = object(value, "current schedule");
  // Nothing running is an empty object.
  if (Object.keys(schedule).length === 0) return undefined;
  const zoneId = optionalText(schedule.zoneId);
  const zoneNumber = optionalNumber(schedule.zoneNum) ?? optionalNumber(schedule.zoneNumber);
  if (!zoneId && zoneNumber === undefined) return undefined;
  const status = optionalText(schedule.status);
  const type = optionalText(schedule.type);
  const zoneStartDate = optionalNumber(schedule.zoneStartDate);
  const zoneDuration = optionalNumber(schedule.zoneDuration);
  return {
    ...(zoneId ? { zoneId } : {}),
    ...(zoneNumber !== undefined ? { zoneNumber } : {}),
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(zoneStartDate !== undefined ? { zoneStartDate } : {}),
    ...(zoneDuration !== undefined ? { zoneDuration } : {}),
  };
}

/** The reset header's format is not pinned down by Rachio's docs: accept epoch seconds, epoch milliseconds, or an HTTP date. */
export function parseRateLimitReset(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headerNumber(value: string | null): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function wholeSeconds(seconds: number, maximum: number, what: string): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > maximum) {
    throw new RachioError(`${what} must be a whole number of seconds from 0 to ${maximum}`, "invalid_value");
  }
  return seconds;
}

export interface RachioClientOptions {
  readonly fetch?: RachioFetch;
  readonly timeoutMs?: number;
}

export class RachioClient {
  private readonly fetchImpl: RachioFetch;
  private readonly timeoutMs: number;
  private personIdValue: Promise<string> | undefined;
  private rateLimitValue: RachioRateLimit = {};
  /** Every request this client has made, successful or not: what the daily allowance is charged. */
  requests = 0;

  constructor(private readonly apiKey: string, options: RachioClientOptions = {}) {
    if (!apiKey.trim()) throw new RachioError("A Rachio API key is required", "not_configured");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The allowance Rachio last reported. */
  get rateLimit(): RachioRateLimit { return this.rateLimitValue; }

  /** `GET /person/info`: the account the key belongs to. Asked once per client. */
  async personId(): Promise<string> {
    this.personIdValue ??= this.request("GET", "person/info").then(body => text(object(body, "account").id, "account id"));
    try { return await this.personIdValue; } catch (error) {
      this.personIdValue = undefined;
      throw error;
    }
  }

  /** `GET /person/{id}`: every controller on the account, each with its zones and status. */
  async controllers(): Promise<RachioController[]> {
    const person = object(await this.request("GET", `person/${encodeURIComponent(await this.personId())}`), "account");
    if (!Array.isArray(person.devices)) throw new RachioError("Rachio returned an account without a device list", "protocol");
    return person.devices
      .filter(device => !(device && typeof device === "object" && (device as ObjectValue).deleted === true))
      .map(parseController);
  }

  /** `GET /device/{id}/current_schedule`: what is watering right now, if anything. */
  async currentSchedule(deviceId: string): Promise<RachioCurrentSchedule | undefined> {
    return parseCurrentSchedule(await this.request("GET", `device/${encodeURIComponent(deviceId)}/current_schedule`));
  }

  /** `PUT /zone/start`: water one zone for `seconds` (1..10800). */
  async startZone(zoneId: string, seconds: number): Promise<void> {
    if (seconds < 1) throw new RachioError("A zone must water for at least one second", "invalid_value");
    await this.request("PUT", "zone/start", { id: zoneId, duration: wholeSeconds(seconds, RACHIO_MAX_ZONE_SECONDS, "Zone duration") });
  }

  /** `PUT /device/stop_water`: stop every zone on the controller. Rachio has no per-zone stop. */
  async stopWater(deviceId: string): Promise<void> {
    await this.request("PUT", "device/stop_water", { id: deviceId });
  }

  /** `PUT /device/off` puts the controller in standby; `PUT /device/on` resumes schedules. */
  async setStandby(deviceId: string, standby: boolean): Promise<void> {
    await this.request("PUT", standby ? "device/off" : "device/on", { id: deviceId });
  }

  /** `PUT /device/rain_delay`: skip schedules for `seconds` (0 cancels a delay). */
  async rainDelay(deviceId: string, seconds: number): Promise<void> {
    await this.request("PUT", "device/rain_delay", { id: deviceId, duration: wholeSeconds(seconds, RACHIO_MAX_RAIN_DELAY_SECONDS, "Rain delay") });
  }

  private async request(method: "GET" | "PUT", path: string, body?: ObjectValue): Promise<unknown> {
    let response: Response;
    this.requests++;
    try {
      response = await this.fetchImpl(new URL(path, RACHIO_API), {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RachioError("Rachio's cloud could not be reached or timed out", "unreachable");
    }
    this.recordRateLimit(response.headers);
    if (response.status === 401 || response.status === 403) throw new RachioError("Rachio refused the API key; create a new one in the Rachio app and store it with `ht secrets set vendors.rachio.apiKey`", "authentication");
    if (response.status === 429) throw new RachioError("Rachio's daily API allowance for this key is spent", "rate_limited");
    if (response.status === 404) throw new RachioError("Rachio has no such controller or zone on this account", "unavailable");
    if (response.status >= 500) throw new RachioError(`Rachio's cloud failed (HTTP ${response.status})`, "unreachable");
    if (!response.ok) throw new RachioError(`Rachio rejected the request (HTTP ${response.status})`, "protocol");
    const raw = await response.text().catch(() => "");
    if (!raw.trim()) return {};
    try { return JSON.parse(raw) as unknown; } catch {
      throw new RachioError("Rachio returned a response that is not JSON", "protocol");
    }
  }

  private recordRateLimit(headers: Headers): void {
    const limit = headerNumber(headers.get("x-ratelimit-limit"));
    const remaining = headerNumber(headers.get("x-ratelimit-remaining"));
    const resetAt = parseRateLimitReset(headers.get("x-ratelimit-reset"));
    if (limit === undefined && remaining === undefined && resetAt === undefined) return;
    this.rateLimitValue = {
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }
}
