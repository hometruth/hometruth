/**
 * Ring cloud API client for account and bridge access.
 * This adapter requires internet connectivity and does not provide a local
 * control path. Cloud outages therefore make its device reads unavailable.
 * Endpoints follow the Ring app protocol documented by ring-client-api.
 * OAuth uses a refresh token; REST reads identify locations, bridges and the
 * websocket ticket consumed by asset-socket.ts.
 */
export const RING_OAUTH = "https://oauth.ring.com/oauth/token";
export const RING_CLIENT_API = "https://api.ring.com/clients_api/";
export const RING_DEVICE_API = "https://api.ring.com/devices/v1/";
export const RING_APP_API = "https://app.ring.com/api/v1/";

/** Ring rejects a token presented under any other client id. */
const RING_CLIENT_ID = "ring_official_android";
const RING_USER_AGENT = "android:com.ringapp";
/** Refresh a little early: a token that expires mid-request reads as an auth failure. */
const EXPIRY_MARGIN_MS = 60_000;

export type RingFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export type RingErrorCode =
  | "authentication"
  /** Ring answered, but the account has no such location, bridge, or device. */
  | "unavailable"
  | "rate_limited"
  | "protocol"
  | "invalid_value";

export class RingError extends Error {
  constructor(message: string, readonly code: RingErrorCode) {
    super(message);
    this.name = "RingError";
  }
}

/**
 * What `ring-auth-cli` hands the operator: base64 of `{ rt, hid }`, where
 * `hid` is the hardware id the token was minted against. Ring ties a refresh
 * token to that id, so it has to survive restarts with the token or the next
 * refresh trips two-factor again. A bare token string is accepted too, and
 * gets an id generated for it once.
 */
export interface RingAuthConfig {
  /** The refresh token proper. Ring rotates this on every single use. */
  readonly rt: string;
  readonly hid?: string;
}

export interface RingLocation {
  readonly locationId: string;
  readonly name: string;
}

/** A Smart Lighting Bridge as `clients_api/ring_devices` lists it. */
export interface RingBridge {
  readonly id: string;
  readonly locationId: string;
  readonly description: string;
  readonly kind: string;
}

/** A hub behind a location: an alarm base station or a beams bridge. */
export interface RingAsset {
  readonly uuid: string;
  readonly kind: string;
}

export interface RingTicket {
  readonly host: string;
  /** A short-lived websocket credential; keep it out of logs. */
  readonly ticket: string;
  readonly assets: readonly RingAsset[];
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RingError("Ring returned an unexpected response", "protocol");
  return value as ObjectValue;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RingError(`Ring omitted ${field}`, "protocol");
  return value;
}

/** Ring returns numeric ids for REST devices and string uuids over the socket; both are identities here. */
function identifier(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return string(value, field);
}

/** `beams_bridge_v1` today, but Ring has revved the suffix before. */
export function isBeamsBridgeKind(kind: string): boolean {
  return kind.startsWith("beams_bridge");
}

export function decodeAuthConfig(rawRefreshToken: string): RingAuthConfig {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawRefreshToken, "base64").toString("utf8"));
    const config = object(parsed);
    if (typeof config.rt === "string" && config.rt.trim()) {
      return { rt: config.rt, ...(typeof config.hid === "string" && config.hid ? { hid: config.hid } : {}) };
    }
  } catch {
    // Not a wrapped config; fall through to the bare-token reading.
  }
  return { rt: rawRefreshToken };
}

export function encodeAuthConfig(config: RingAuthConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}

export interface RingClientOptions {
  fetch?: RingFetch;
  now?: () => number;
  timeoutMs?: number;
  /** Used when the stored config carries no hardware id; generated once and persisted with the token. */
  hardwareId?: () => string;
  /**
   * Ring invalidates the old refresh token the moment it issues a new one, so
   * a token that is not written back is good for exactly one more restart.
   */
  onRefreshToken?: (encoded: string) => void | Promise<void>;
}

export class RingClient {
  private readonly fetchImpl: RingFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly onRefreshToken: ((encoded: string) => void | Promise<void>) | undefined;
  private auth: RingAuthConfig;
  private hardwareId: string;
  private accessToken: string | undefined;
  private expiresAt = 0;
  private authenticating: Promise<string> | undefined;

  constructor(rawRefreshToken: string, options: RingClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new RingError("Ring timeoutMs must be 1000..60000", "invalid_value");
    this.timeoutMs = timeoutMs;
    this.onRefreshToken = options.onRefreshToken;
    this.auth = decodeAuthConfig(rawRefreshToken);
    this.hardwareId = this.auth.hid ?? (options.hardwareId ?? (() => crypto.randomUUID()))();
  }

  /** The current refresh token, wrapped with its hardware id, ready to store. */
  get storedToken(): string {
    return encodeAuthConfig({ rt: this.auth.rt, hid: this.hardwareId });
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // A fetch error can carry the request body, and that body carries the token.
      throw new RingError("Ring cloud request failed or timed out", "unavailable");
    }
  }

  private async json(response: Response): Promise<ObjectValue> {
    try { return object(await response.json()); }
    catch { throw new RingError("Ring returned an invalid JSON response", "protocol"); }
  }

  /** A cached access token, refreshed (and the refresh token rotated) when it is close to expiring. */
  async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.accessToken;
    if (this.authenticating) return this.authenticating;
    this.authenticating = this.refresh().finally(() => { this.authenticating = undefined; });
    return this.authenticating;
  }

  private async refresh(): Promise<string> {
    const response = await this.send(new URL(RING_OAUTH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "2fa-support": "true",
        hardware_id: this.hardwareId,
        "User-Agent": RING_USER_AGENT,
      },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: this.auth.rt, client_id: RING_CLIENT_ID, scope: "client" }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new RingError("Ring rejected the refresh token. Mint a new one with `npx -p ring-client-api ring-auth-cli` and store it in vendors.ring.refreshToken", "authentication");
    }
    if (response.status === 429) throw new RingError("Ring is rate limiting this account; try again later", "rate_limited");
    if (!response.ok) throw new RingError(`Ring authentication failed with HTTP ${response.status}`, "authentication");
    const body = await this.json(response);
    const accessToken = string(body.access_token, "an access token");
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    this.accessToken = accessToken;
    this.expiresAt = this.now() + expiresIn * 1000;
    if (typeof body.refresh_token === "string" && body.refresh_token && body.refresh_token !== this.auth.rt) {
      this.auth = { rt: body.refresh_token, hid: this.hardwareId };
      // Persisting is best effort: a write failure must not take the session down,
      // and the token in hand is still good until the next refresh.
      try { await this.onRefreshToken?.(this.storedToken); } catch { /* reported by the caller's own store */ }
    }
    return accessToken;
  }

  private async get(url: URL): Promise<ObjectValue> {
    const token = await this.token();
    const response = await this.send(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", hardware_id: this.hardwareId, "User-Agent": RING_USER_AGENT },
    });
    if (response.status === 401 || response.status === 403) {
      // The cached token is stale or revoked; the next call re-authenticates.
      this.accessToken = undefined;
      this.expiresAt = 0;
      throw new RingError("Ring rejected the access token", "authentication");
    }
    if (response.status === 404) throw new RingError("Ring has no such location or device on this account", "unavailable");
    if (response.status === 429) throw new RingError("Ring is rate limiting this account; try again later", "rate_limited");
    if (!response.ok) throw new RingError(`Ring request failed with HTTP ${response.status}`, "unavailable");
    return await this.json(response);
  }

  async listLocations(): Promise<readonly RingLocation[]> {
    const body = await this.get(new URL("locations", RING_DEVICE_API));
    return array(body.user_locations).map(value => {
      const location = object(value);
      return { locationId: identifier(location.location_id, "a location id"), name: typeof location.name === "string" ? location.name : "Ring location" };
    });
  }

  /** Every Smart Lighting Bridge on the account. The lights behind one are only visible over the socket. */
  async listBridges(): Promise<readonly RingBridge[]> {
    const body = await this.get(new URL("ring_devices", RING_CLIENT_API));
    return array(body.beams_bridges).map(value => {
      const bridge = object(value);
      return {
        id: identifier(bridge.id, "a bridge id"),
        locationId: identifier(bridge.location_id, "a bridge location id"),
        description: typeof bridge.description === "string" ? bridge.description : "Ring Bridge",
        kind: typeof bridge.kind === "string" ? bridge.kind : "beams_bridge_v1",
      };
    });
  }

  /**
   * A short-lived websocket credential for one location, plus the hubs it
   * covers. Ring issues these per connection; they are not reusable.
   */
  async ticket(locationId: string): Promise<RingTicket> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(locationId)) throw new RingError("Provide a valid Ring location id", "invalid_value");
    const url = new URL("clap/tickets", RING_APP_API);
    url.searchParams.set("locationID", locationId);
    url.searchParams.set("enableExtendedEmergencyCellUsage", "true");
    url.searchParams.set("requestedTransport", "ws");
    const body = await this.get(url);
    const assets = array(body.assets).map(value => {
      const asset = object(value);
      return { uuid: string(asset.uuid, "an asset uuid"), kind: typeof asset.kind === "string" ? asset.kind : "" };
    });
    return { host: string(body.host, "a websocket host"), ticket: string(body.ticket, "a websocket ticket"), assets };
  }
}
