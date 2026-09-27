/** The Matter process controls the running HomeTruth server through its public API. */
export interface SwitchInfo {
  id: string;
  name: string;
  room?: string;
}

export interface SwitchSnapshot {
  on?: boolean;
  reachable: boolean;
}

interface ClientOptions {
  url?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** The API token this bridge presents; defaults to `HOMETRUTH_TOKEN`. */
  token?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value);
}

function switchPath(id: string): string {
  if (!validId(id)) throw new Error("A HomeTruth switch id must be a valid device id");
  return `api/switches/${encodeURIComponent(id)}`;
}

function snapshot(value: unknown, id: string): SwitchSnapshot {
  if (!record(value) || value.id !== id || !record(value.state)) {
    throw new Error(`HomeTruth returned an invalid switch document for ${id}`);
  }
  const state = value.state;
  if (state.availability === "offline" || state.availability === "unknown" || state.availability === "degraded") {
    return { reachable: false };
  }
  if (state.availability !== "online" || (state.value !== "on" && state.value !== "off")) {
    throw new Error(`HomeTruth returned an invalid switch state for ${id}`);
  }
  return { reachable: true, on: state.value === "on" };
}

export class HomeTruthSwitchClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  /**
   * The bridge runs as its own process, so it carries its own token rather
   * than inheriting anything. Give it one scoped to the switches it exposes:
   * `ht tokens issue "Matter bridge" --can write --for group:automatic:switches`.
   */
  private readonly token: string | undefined;

  constructor(options: ClientOptions = {}) {
    const configuredUrl = options.url ?? (process.env.HOMETRUTH_URL?.trim() || "http://127.0.0.1:3000");
    let baseUrl: URL;
    try {
      baseUrl = new URL(configuredUrl);
    } catch {
      throw new Error("HOMETRUTH_URL must be an absolute HTTP or HTTPS URL");
    }
    if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("HOMETRUTH_URL must be an HTTP or HTTPS base URL without credentials, a query, or a fragment");
    }
    if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new Error("The HomeTruth request timeout must be a positive integer in milliseconds");
    }
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.token = options.token ?? process.env.HOMETRUTH_TOKEN?.trim() ?? undefined;
  }

  async discover(): Promise<SwitchInfo[]> {
    const body = await this.request("api/devices");
    if (!record(body) || !Array.isArray(body.devices)) {
      throw new Error("HomeTruth returned an invalid device inventory");
    }
    const devices: SwitchInfo[] = [];
    const ids = new Set<string>();
    for (const device of body.devices) {
      if (!record(device) || !validId(device.id) || typeof device.name !== "string" || !device.name.trim()
        || !Array.isArray(device.capabilities) || !device.capabilities.every((kind) => typeof kind === "string")) {
        throw new Error("HomeTruth returned an invalid device in its inventory");
      }
      if (ids.has(device.id)) throw new Error(`HomeTruth returned duplicate device id ${device.id}`);
      ids.add(device.id);
      if (device.room !== undefined && (typeof device.room !== "string" || !device.room.trim() || device.room.length > 100)) {
        throw new Error("HomeTruth returned an invalid device room");
      }
      if (device.capabilities.includes("binarySwitch")) devices.push({ id: device.id, name: device.name, ...(typeof device.room === "string" ? { room: device.room } : {}) });
    }
    return devices;
  }

  async read(id: string): Promise<SwitchSnapshot> {
    return snapshot(await this.request(switchPath(id)), id);
  }

  async write(id: string, on: boolean): Promise<SwitchSnapshot> {
    if (typeof on !== "boolean") throw new Error("A HomeTruth switch command must be a boolean");
    const observed = snapshot(await this.request(`${switchPath(id)}/${on ? "turn-on" : "turn-off"}`, "POST"), id);
    if (!observed.reachable) throw new Error(`HomeTruth could not read switch ${id} after the command; its state is unknown`);
    return observed;
  }

  private async request(path: string, method: "GET" | "POST" = "GET"): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw new Error(`HomeTruth ${method} ${url.pathname} timed out after ${this.timeoutMs} ms`);
      throw new Error(`HomeTruth ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HomeTruth ${method} ${url.pathname} returned HTTP ${response.status} with invalid JSON`);
    }
    if (!response.ok) {
      const detail = record(body) && record(body.error) && typeof body.error.message === "string"
        ? `: ${body.error.message.slice(0, 400)}`
        : "";
      // A refusal is about the token, and the bridge runs unattended, so the
      // message has to say what to do rather than only what happened.
      const remedy = response.status === 401 || response.status === 403
        ? ' — set HOMETRUTH_TOKEN for this service (ht tokens issue "Matter bridge" --can write --for group:automatic:switches)'
        : "";
      throw new Error(`HomeTruth ${method} ${url.pathname} returned HTTP ${response.status}${detail}${remedy}`);
    }
    return body;
  }
}
