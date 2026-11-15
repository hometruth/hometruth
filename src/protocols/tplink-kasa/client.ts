import { decodeKasaFrame, encodeKasaFrame, isRecord, KASA_PORT, KasaError, kasaFrameLength } from "./codec";

/**
 * Sends one complete request frame to `host:port` and resolves with the one
 * complete response frame (length prefix included). Rejects with a
 * `KasaError` coded `unreachable` on connection failure or timeout.
 */
export type KasaTransport = (host: string, port: number, frame: Uint8Array, timeoutMs: number) => Promise<Uint8Array>;

/** One TCP connection per request, as the firmware expects; the whole exchange is bounded by `timeoutMs`. */
export const kasaTcpTransport: KasaTransport = (host, port, frame, timeoutMs) => new Promise<Uint8Array>((resolve, reject) => {
  let settled = false;
  let socket: { end(): void } | undefined;
  let buffer = new Uint8Array(0);
  const finish = (result: { frame: Uint8Array } | { error: KasaError }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { socket?.end(); } catch { /* already closed */ }
    if ("frame" in result) resolve(result.frame);
    else reject(result.error);
  };
  const unreachable = (detail: string) => finish({ error: new KasaError(`Kasa device at ${host} is unreachable: ${detail}`, "unreachable") });
  const timer = setTimeout(() => unreachable(`no response within ${timeoutMs} ms`), timeoutMs);
  void Bun.connect({
    hostname: host,
    port,
    socket: {
      open(connection) {
        socket = connection;
        if (settled) { connection.end(); return; }
        connection.write(frame);
      },
      data(_connection, chunk) {
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer);
        next.set(chunk, buffer.length);
        buffer = next;
        let total: number | undefined;
        try { total = kasaFrameLength(buffer); }
        catch (error) { finish({ error: error as KasaError }); return; }
        if (total !== undefined && buffer.length >= total) finish({ frame: buffer.slice(0, total) });
      },
      error(_connection, error) { unreachable(error.message); },
      connectError(_connection, error) { unreachable(error.message); },
      close() { unreachable("connection closed before a complete response"); },
    },
  }).catch((error: unknown) => unreachable(error instanceof Error ? error.message : String(error)));
});

/** Requests waiting per transport and `host:port`; the firmware handles one connection at a time. */
const queues = new WeakMap<KasaTransport, Map<string, Promise<void>>>();

function serialized<T>(transport: KasaTransport, key: string, run: () => Promise<T>): Promise<T> {
  let byHost = queues.get(transport);
  if (!byHost) queues.set(transport, byHost = new Map());
  const result = (byHost.get(key) ?? Promise.resolve()).then(run);
  const tail = result.then(() => undefined, () => undefined);
  byHost.set(key, tail);
  void tail.then(() => { if (byHost.get(key) === tail) byHost.delete(key); });
  return result;
}

export interface KasaChild {
  /** Full child id as the device reports it: the parent `deviceId` plus a two-digit index. */
  readonly id: string;
  readonly alias: string;
  readonly on: boolean;
}

export interface KasaSysinfo {
  /** As reported, e.g. `EP40(US)`. */
  readonly model: string;
  readonly softwareVersion: string;
  readonly hardwareVersion: string;
  readonly deviceId: string;
  readonly alias: string;
  readonly mac?: string;
  /** Present on single-outlet devices. */
  readonly on?: boolean;
  /** Present on multi-outlet devices, in outlet order. */
  readonly children?: readonly KasaChild[];
}

/** Realtime meter readings normalized to W, V, A and kWh; a field the firmware omitted is absent. */
export interface KasaRealtime {
  readonly powerW?: number;
  readonly voltageV?: number;
  readonly currentA?: number;
  readonly energyKWh?: number;
}

export interface KasaClientOptions {
  port?: number;
  timeoutMs?: number;
  transport?: KasaTransport;
}

/** A client for one Kasa device. Every request to the same host goes through one queue. */
export class KasaClient {
  readonly port: number;
  readonly timeoutMs: number;
  private readonly transport: KasaTransport;

  constructor(readonly host: string, options: KasaClientOptions = {}) {
    this.port = options.port ?? KASA_PORT;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.transport = options.transport ?? kasaTcpTransport;
  }

  /** Send one JSON message and return the decoded response object. */
  request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const frame = encodeKasaFrame(message);
    return serialized(this.transport, `${this.host}:${this.port}`, async () => decodeKasaFrame(await this.transport(this.host, this.port, frame, this.timeoutMs)));
  }

  /**
   * Call `module.method(params)`, optionally addressed to one child outlet,
   * and return the method's result after checking its `err_code`.
   */
  async call(module: string, method: string, params: Record<string, unknown> = {}, childId?: string): Promise<Record<string, unknown>> {
    const message: Record<string, unknown> = childId ? { context: { child_ids: [childId] } } : {};
    message[module] = { [method]: params };
    const response = await this.request(message);
    const section = response[module];
    if (!isRecord(section)) throw new KasaError(`Kasa response has no ${module} section`, "protocol");
    // An unsupported module answers at module level: {"emeter":{"err_code":-1,"err_msg":"module not support"}}.
    const result = section[method] ?? section;
    if (!isRecord(result)) throw new KasaError(`Kasa response has no ${module}.${method} result`, "protocol");
    const code = result.err_code;
    if (code !== undefined && code !== 0) {
      const detail = typeof result.err_msg === "string" ? result.err_msg.slice(0, 200) : `error ${String(code)}`;
      throw new KasaError(`Kasa ${module}.${method} failed: ${detail}`, "device_error");
    }
    if (section[method] === undefined) throw new KasaError(`Kasa response has no ${module}.${method} result`, "protocol");
    return result;
  }

  async getSysinfo(): Promise<KasaSysinfo> {
    return parseKasaSysinfo(await this.call("system", "get_sysinfo"));
  }

  async setRelayState(on: boolean, childId?: string): Promise<void> {
    await this.call("system", "set_relay_state", { state: on ? 1 : 0 }, childId);
  }

  async getRealtime(childId?: string): Promise<KasaRealtime> {
    return parseKasaRealtime(await this.call("emeter", "get_realtime", {}, childId));
  }
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new KasaError(`Kasa sysinfo has no valid ${field}`, "protocol");
  return value;
}

function relay(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) throw new KasaError(`Kasa sysinfo has no valid ${field}`, "protocol");
  return value === 1;
}

export function parseKasaSysinfo(info: Record<string, unknown>): KasaSysinfo {
  const deviceId = text(info.deviceId, "deviceId", 100);
  const base = {
    model: text(info.model, "model", 100),
    softwareVersion: text(info.sw_ver, "sw_ver"),
    hardwareVersion: text(info.hw_ver, "hw_ver"),
    deviceId,
    alias: typeof info.alias === "string" ? info.alias.slice(0, 100) : "",
    ...(typeof info.mac === "string" && /^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$/u.test(info.mac) ? { mac: info.mac } : {}),
  };
  if (info.children !== undefined) {
    if (!Array.isArray(info.children) || info.children.length === 0 || info.children.length > 16) throw new KasaError("Kasa sysinfo has an invalid children list", "protocol");
    const children = info.children.map((child: unknown, index): KasaChild => {
      if (!isRecord(child)) throw new KasaError(`Kasa outlet ${index} is not an object`, "protocol");
      const raw = text(child.id, `outlet ${index} id`, 120);
      // Some firmware reports only the two-digit suffix; the context needs the full id.
      const id = /^\d{2}$/u.test(raw) ? `${deviceId}${raw}` : raw;
      return { id, alias: typeof child.alias === "string" ? child.alias.slice(0, 100) : "", on: relay(child.state, `outlet ${index} state`) };
    });
    return { ...base, children };
  }
  return { ...base, on: relay(info.relay_state, "relay_state") };
}

function reading(info: Record<string, unknown>, scaled: string, scale: number, legacy: string): number | undefined {
  const milli = info[scaled];
  if (typeof milli === "number" && Number.isFinite(milli)) return milli / scale;
  const plain = info[legacy];
  if (typeof plain === "number" && Number.isFinite(plain)) return plain;
  return undefined;
}

/**
 * Current firmware reports integer milli-units (`power_mw`, `voltage_mv`,
 * `current_ma`, `total_wh`); older firmware reports floats in W, V, A and kWh
 * (`power`, `voltage`, `current`, `total`). Either is accepted.
 */
export function parseKasaRealtime(info: Record<string, unknown>): KasaRealtime {
  const powerW = reading(info, "power_mw", 1000, "power");
  const voltageV = reading(info, "voltage_mv", 1000, "voltage");
  const currentA = reading(info, "current_ma", 1000, "current");
  const energyKWh = reading(info, "total_wh", 1000, "total");
  return {
    ...(powerW !== undefined ? { powerW } : {}),
    ...(voltageV !== undefined ? { voltageV } : {}),
    ...(currentA !== undefined ? { currentA } : {}),
    ...(energyKWh !== undefined ? { energyKWh } : {}),
  };
}
