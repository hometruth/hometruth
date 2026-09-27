import { isSafeCameraUri } from "../../camera-media";
import { randomUUID } from "node:crypto";
import type { Nrf24CaptureJournal, Nrf24CaptureStatus } from "./capture-journal";
import { UsbQuietCapture, quietIsActive, validateQuietRequest, type QuietCaptureStatus, type QuietCaptureSettings } from "./quiet-capture";
import { dirname, join } from "node:path";

export type Nrf24BridgeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Nrf24BridgeHealth {
  readonly apiVersion: 1;
  readonly status: "ok";
  readonly model: "tmnt-nrf24-listener";
  readonly firmwareVersion: string;
  readonly radio: { readonly present: boolean };
}

interface Nrf24ObservationBase {
  readonly sequence: number;
  /** Milliseconds since the ESP32 booted when this activity was observed. */
  readonly uptimeMs: number;
  readonly channel: number;
}

export interface Nrf24EnergyObservation extends Nrf24ObservationBase {
  readonly kind: "energy";
  readonly rpd: true;
  readonly hits?: number;
  readonly samples?: number;
}

export interface Nrf24PacketObservation extends Nrf24ObservationBase {
  readonly kind: "packet";
  readonly address: string;
  readonly payloadHex: string;
  readonly length: number;
  readonly addressWidth: number;
  readonly crcBytes: number;
  readonly crcValid: boolean;
  readonly noAck?: boolean;
  readonly lengthInferred?: boolean;
  readonly pid?: number;
  readonly bitOffset?: number;
  readonly discovery?: "raw" | "known-address";
  /** Original 32-byte demodulated receive window, not an RF waveform. */
  readonly rawWindowHex?: string;
  readonly pcfLengthField?: number;
  readonly rxPipe?: number;
  readonly rpd?: boolean;
}

export type Nrf24Observation = Nrf24EnergyObservation | Nrf24PacketObservation;

export interface Nrf24ListenerState {
  readonly apiVersion: 1;
  readonly deviceId?: string;
  readonly listening: boolean;
  readonly radioPresent: boolean;
  readonly sequence: number;
  readonly oldestSequence: number;
  readonly dropped: number;
  readonly config: {
    readonly mode?: "energy" | "raw" | "sweep" | "packet";
    readonly channelMin: number;
    readonly channelMax: number;
    readonly dataRateKbps: number;
    readonly channel?: number;
    readonly crcBytes?: number;
  };
  readonly observations: readonly Nrf24Observation[];
  readonly rawFramesSeen?: number;
  readonly sweep?: {
    readonly durationMs: number;
    readonly elapsedMs: number;
    readonly channelsVisited: number;
    readonly passes: number;
    readonly completed: boolean;
  };
}

export type Nrf24ListenRequest = { readonly note?: string } & (
  | { readonly mode: "energy" }
  | { readonly mode: "sweep"; readonly durationMs: 30000; readonly crcBytes: 2 }
  | { readonly mode: "raw"; readonly channel: number; readonly crcBytes: 1 | 2 });

export interface Nrf24TransmitRequest {
  readonly channel: number;
  readonly dataRateKbps: 250 | 1000 | 2000;
  readonly address: string;
  readonly addressWidth: number;
  readonly payloadHex: string;
  readonly crcBytes: number;
  readonly repeatCount?: number;
}

export interface Nrf24TransmitResponse {
  readonly apiVersion: 1;
  readonly sent: true;
  readonly repeats: number;
  readonly uptimeMs: number;
}

export interface Nrf24RadioBridge {
  health(): Promise<Nrf24BridgeHealth>;
  listener(): Promise<Nrf24ListenerState>;
  startListening(request?: Nrf24ListenRequest): Promise<Nrf24ListenerState>;
  stopListening(): Promise<Nrf24ListenerState>;
  transmit(request: Nrf24TransmitRequest): Promise<Nrf24TransmitResponse>;
  captureStatus?(): Nrf24CaptureStatus | undefined;
  cachedListener?(): { state: Nrf24ListenerState; recordedAt: string } | undefined;
  quietStatus?(): Promise<QuietCaptureStatus | undefined>;
  startQuietCapture?(settings: QuietCaptureSettings): Promise<QuietCaptureStatus>;
}

export type Nrf24BridgeErrorCode = "invalid_url" | "unreachable" | "protocol" | "not_supported";

export class Nrf24BridgeError extends Error {
  constructor(message: string, readonly code: Nrf24BridgeErrorCode) {
    super(message);
    this.name = "Nrf24BridgeError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Nrf24BridgeError(`${label} is not a JSON object`, "protocol");
  }
  return value as Record<string, unknown>;
}

function booleanField(body: Record<string, unknown>, key: string, label: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new Nrf24BridgeError(`${label}.${key} is not a boolean`, "protocol");
  return value;
}

function integerField(body: Record<string, unknown>, key: string, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Nrf24BridgeError(`${label}.${key} is not a valid integer`, "protocol");
  }
  return value as number;
}

function stringField(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Nrf24BridgeError(`${label}.${key} is not a valid string`, "protocol");
  }
  return value;
}

export function decodeNrf24Health(value: unknown): Nrf24BridgeHealth {
  const body = record(value, "health");
  if (body.apiVersion !== 1) throw new Nrf24BridgeError("Bridge API version is not supported", "protocol");
  if (body.status !== "ok") throw new Nrf24BridgeError("Bridge health status is not ok", "protocol");
  if (body.model !== "tmnt-nrf24-listener") throw new Nrf24BridgeError("Response is not from the TMNT nRF24 listener", "protocol");
  const radio = record(body.radio, "health.radio");
  return {
    apiVersion: 1,
    status: "ok",
    model: "tmnt-nrf24-listener",
    firmwareVersion: stringField(body, "firmwareVersion", "health"),
    radio: { present: booleanField(radio, "present", "health.radio") },
  };
}

function observation(value: unknown, index: number): Nrf24Observation {
  const label = `listener.observations[${index}]`;
  const body = record(value, label);
  const kind = body.kind;
  if (kind !== "energy" && kind !== "packet") throw new Nrf24BridgeError(`${label}.kind is not energy or packet`, "protocol");
  const uptimeMs = integerField(body, "uptimeMs", label, 0);
  const address = body.address;
  const addressHex = typeof address === "string" ? address.replaceAll(":", "") : undefined;
  if (address !== undefined && (!addressHex || !/^(?:[0-9a-f]{2}){3,5}$/iu.test(addressHex))) {
    throw new Nrf24BridgeError(`${label}.address is not a 3–5 byte hexadecimal address`, "protocol");
  }
  const payloadHex = body.payloadHex;
  if (payloadHex !== undefined && (typeof payloadHex !== "string" || !/^(?:[0-9a-f]{2}){0,32}$/iu.test(payloadHex))) {
    throw new Nrf24BridgeError(`${label}.payloadHex is not a 0–32 byte hexadecimal payload`, "protocol");
  }
  const length = body.length;
  if (length !== undefined && (!Number.isInteger(length) || (length as number) < 0 || (length as number) > 32)) {
    throw new Nrf24BridgeError(`${label}.length is not from 0 to 32`, "protocol");
  }
  if (typeof payloadHex === "string" && typeof length === "number" && payloadHex.length / 2 !== length) {
    throw new Nrf24BridgeError(`${label}.length does not match payloadHex`, "protocol");
  }
  const rpd = body.rpd;
  if (rpd !== undefined && typeof rpd !== "boolean") throw new Nrf24BridgeError(`${label}.rpd is not a boolean`, "protocol");
  const base = {
    sequence: integerField(body, "sequence", label, 0),
    uptimeMs,
    channel: integerField(body, "channel", label, 0, 125),
  };
  if (kind === "energy") {
    if (address !== undefined || payloadHex !== undefined || length !== undefined || rpd !== true) {
      throw new Nrf24BridgeError(`${label} is not a valid energy observation`, "protocol");
    }
    const hits = body.hits;
    const samples = body.samples;
    if (hits !== undefined && (!Number.isInteger(hits) || (hits as number) < 1 || (hits as number) > 255)) {
      throw new Nrf24BridgeError(`${label}.hits is not from 1 to 255`, "protocol");
    }
    if (samples !== undefined && (!Number.isInteger(samples) || (samples as number) < 1 || (samples as number) > 255)) {
      throw new Nrf24BridgeError(`${label}.samples is not from 1 to 255`, "protocol");
    }
    if (typeof hits === "number" && typeof samples === "number" && hits > samples) {
      throw new Nrf24BridgeError(`${label}.hits is greater than samples`, "protocol");
    }
    return { ...base, kind, rpd: true, ...(typeof hits === "number" ? { hits } : {}), ...(typeof samples === "number" ? { samples } : {}) };
  }
  if (!addressHex || typeof payloadHex !== "string" || typeof length !== "number") {
    throw new Nrf24BridgeError(`${label} packet fields are incomplete`, "protocol");
  }
  const addressWidth = integerField(body, "addressWidth", label, 3, 5);
  if (addressHex.length !== addressWidth * 2) throw new Nrf24BridgeError(`${label}.addressWidth does not match address`, "protocol");
  const crcBytes = integerField(body, "crcBytes", label, 0, 2);
  const crcValid = booleanField(body, "crcValid", label);
  const noAck = body.noAck;
  if (noAck !== undefined && typeof noAck !== "boolean") throw new Nrf24BridgeError(`${label}.noAck is not a boolean`, "protocol");
  const rawWindowHex = body.rawWindowHex;
  if (rawWindowHex !== undefined && (typeof rawWindowHex !== "string" || !/^[0-9a-f]{64}$/iu.test(rawWindowHex))) {
    throw new Nrf24BridgeError(`${label}.rawWindowHex is not a 32-byte hexadecimal window`, "protocol");
  }
  return {
    ...base,
    kind,
    address: addressHex.toUpperCase().match(/../gu)!.join(":"),
    payloadHex: payloadHex.toUpperCase(),
    length,
    addressWidth,
    crcBytes,
    crcValid,
    ...(typeof noAck === "boolean" ? { noAck } : {}),
    ...(body.lengthInferred === undefined ? {} : { lengthInferred: booleanField(body, "lengthInferred", label) }),
    ...(body.pid === undefined ? {} : { pid: integerField(body, "pid", label, 0, 3) }),
    ...(body.bitOffset === undefined ? {} : { bitOffset: integerField(body, "bitOffset", label, 0, 255) }),
    ...(typeof rawWindowHex === "string" ? { rawWindowHex: rawWindowHex.toUpperCase() } : {}),
    ...(body.pcfLengthField === undefined ? {} : { pcfLengthField: integerField(body, "pcfLengthField", label, 0, 63) }),
    ...(body.rxPipe === undefined ? {} : { rxPipe: integerField(body, "rxPipe", label, 0, 1) }),
    ...(body.discovery === "raw" || body.discovery === "known-address" ? { discovery: body.discovery } : {}),
    ...(typeof rpd === "boolean" ? { rpd } : {}),
  };
}

export function decodeNrf24ListenerState(value: unknown): Nrf24ListenerState {
  const body = record(value, "listener");
  if (body.apiVersion !== 1) throw new Nrf24BridgeError("Listener API version is not supported", "protocol");
  const config = record(body.config, "listener.config");
  if (!Array.isArray(body.observations) || body.observations.length > 500) {
    throw new Nrf24BridgeError("listener.observations is not a bounded array", "protocol");
  }
  const channelMin = integerField(config, "channelMin", "listener.config", 0, 125);
  const channelMax = integerField(config, "channelMax", "listener.config", 0, 125);
  if (channelMin > channelMax) throw new Nrf24BridgeError("listener.config.channelMax is below channelMin", "protocol");
  const dataRateKbps = integerField(config, "dataRateKbps", "listener.config", 1, 10000);
  const mode = config.mode;
  if (mode !== undefined && mode !== "energy" && mode !== "raw" && mode !== "packet" && mode !== "sweep") {
    throw new Nrf24BridgeError("listener.config.mode is invalid", "protocol");
  }
  const configuredChannel = config.channel;
  if (configuredChannel !== undefined && (!Number.isSafeInteger(configuredChannel) || (configuredChannel as number) < 0 || (configuredChannel as number) > 125)) {
    throw new Nrf24BridgeError("listener.config.channel is invalid", "protocol");
  }
  const configuredCrc = config.crcBytes;
  if (configuredCrc !== undefined && (![0, 1, 2].includes(configuredCrc as number))) {
    throw new Nrf24BridgeError("listener.config.crcBytes is invalid", "protocol");
  }
  let sweep: Nrf24ListenerState["sweep"];
  if (mode === "sweep") {
    const progress = record(body.sweep, "listener.sweep");
    const durationMs = integerField(progress, "durationMs", "listener.sweep", 30000, 30000);
    sweep = {
      durationMs,
      elapsedMs: integerField(progress, "elapsedMs", "listener.sweep", 0, durationMs),
      channelsVisited: integerField(progress, "channelsVisited", "listener.sweep", 0, channelMax - channelMin + 1),
      passes: integerField(progress, "passes", "listener.sweep", 0, 10000),
      completed: booleanField(progress, "completed", "listener.sweep"),
    };
  }
  return {
    apiVersion: 1,
    listening: booleanField(body, "listening", "listener"),
    ...(body.deviceId === undefined ? {} : { deviceId: stringField(body, "deviceId", "listener") }),
    radioPresent: booleanField(body, "radioPresent", "listener"),
    sequence: integerField(body, "sequence", "listener", 0),
    oldestSequence: integerField(body, "oldestSequence", "listener", 0),
    dropped: integerField({ dropped: body.dropped ?? body.droppedObservations }, "dropped", "listener", 0),
    config: {
      channelMin, channelMax, dataRateKbps,
      ...(typeof mode === "string" ? { mode } : {}),
      ...(typeof configuredChannel === "number" ? { channel: configuredChannel } : {}),
      ...(typeof configuredCrc === "number" ? { crcBytes: configuredCrc } : {}),
    },
    observations: body.observations.map(observation),
    ...(body.rawFramesSeen === undefined ? {} : { rawFramesSeen: integerField(body, "rawFramesSeen", "listener", 0) }),
    ...(sweep ? { sweep } : {}),
  };
}

export function decodeNrf24TransmitResponse(value: unknown): Nrf24TransmitResponse {
  const body = record(value, "transmit");
  if (body.apiVersion !== 1 || body.sent !== true) throw new Nrf24BridgeError("Bridge did not confirm transmission", "protocol");
  return {
    apiVersion: 1,
    sent: true,
    repeats: integerField(body, "repeats", "transmit", 1, 20),
    uptimeMs: integerField(body, "uptimeMs", "transmit", 0),
  };
}

export interface Nrf24BridgeClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: Nrf24BridgeFetch;
  readonly journal?: Nrf24CaptureJournal;
  /** Shares a recent read between the background collector and UI viewers. */
  readonly readCacheMs?: number;
}

/** HTTP adapter for the ESP32 firmware. Wire-format knowledge is confined to this class. */
export class Nrf24BridgeClient implements Nrf24RadioBridge {
  readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: Nrf24BridgeFetch;
  private state: Nrf24ListenerState | undefined;
  private pendingListener: Promise<Nrf24ListenerState> | undefined;
  private pendingOperation: Promise<unknown> | undefined;
  private readonly journal: Nrf24CaptureJournal | undefined;
  private readonly readCacheMs: number;
  private lastReadAt = 0;
  private readonly quiet: UsbQuietCapture | undefined;

  constructor(options: Nrf24BridgeClientOptions) {
    let baseUrl: URL;
    try { baseUrl = new URL(options.baseUrl); }
    catch { throw new Nrf24BridgeError("Radio bridge baseUrl is not a URL", "invalid_url"); }
    if (!isSafeCameraUri(baseUrl.href) || !["http:", "https:"].includes(baseUrl.protocol)
      || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Nrf24BridgeError("Radio bridge baseUrl must be an HTTP URL on the private LAN", "invalid_url");
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.fetchImpl = options.fetch ?? fetch;
    this.journal = options.journal;
    if (options.journal) this.quiet = new UsbQuietCapture(join(dirname(options.journal.status().path), "usb"));
    this.readCacheMs = options.readCacheMs ?? 0;
  }

  captureStatus() { return this.journal?.status(); }
  cachedListener() { return this.journal?.lastSnapshot(); }
  quietStatus() { return this.quiet?.status() ?? Promise.resolve(undefined); }

  startQuietCapture(request: QuietCaptureSettings): Promise<QuietCaptureStatus> {
    return this.exclusive(async () => {
      const settings = validateQuietRequest(request);
      if (!this.quiet || !this.journal) throw new Nrf24BridgeError("USB capture requires disk recording", "not_supported");
      // Read and persist before any operation that can clear device memory.
      const before = await this.readListener();
      if (!before.deviceId) throw new Nrf24BridgeError("Bridge did not supply its USB identity", "protocol");
      await this.journal.append({ event: "quiet_capture_requested", ...settings });
      try { return await this.quiet.start(before.deviceId, settings); }
      catch (error) { throw new Nrf24BridgeError(error instanceof Error ? error.message : String(error), "protocol"); }
    });
  }

  health(): Promise<Nrf24BridgeHealth> {
    return this.exclusive(() => this.request("health", "GET", decodeNrf24Health));
  }
  listener(): Promise<Nrf24ListenerState> {
    if (this.pendingListener) return this.pendingListener;
    if (this.state && this.readCacheMs > 0 && Date.now() - this.lastReadAt < this.readCacheMs) return Promise.resolve(this.state);
    const pending = this.exclusive(() => this.readListener()).finally(() => {
      if (this.pendingListener === pending) this.pendingListener = undefined;
    });
    this.pendingListener = pending;
    return pending;
  }
  private async readListener(): Promise<Nrf24ListenerState> {
    const since = this.state?.sequence;
    const next = await this.request(`api/listener${since === undefined ? "" : `?since=${since}`}`, "GET", decodeNrf24ListenerState);
    const merged = await this.merge(next);
    this.lastReadAt = Date.now();
    return merged;
  }
  async startListening(request: Nrf24ListenRequest = { mode: "energy" }): Promise<Nrf24ListenerState> {
    this.lastReadAt = 0;
    return this.exclusive(async () => {
      // A sweep clears firmware history. Drain and fsync its tail first.
      if (this.journal) await this.readListener();
      this.lastReadAt = 0;
      return this.merge(await this.request("api/listener/start", "POST", decodeNrf24ListenerState, request));
    });
  }
  async stopListening(): Promise<Nrf24ListenerState> {
    this.lastReadAt = 0;
    return this.exclusive(async () => this.merge(await this.request("api/listener/stop", "POST", decodeNrf24ListenerState)));
  }
  transmit(request: Nrf24TransmitRequest): Promise<Nrf24TransmitResponse> {
    return this.exclusive(() => this.request("api/transmit", "POST", decodeNrf24TransmitResponse, request));
  }

  /** The ESP32 handles one connection at a time, including its response body. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation ? this.pendingOperation.then(operation) : operation();
    const settled = result.then(() => {}, () => {}).finally(() => {
      if (this.pendingOperation === settled) this.pendingOperation = undefined;
    });
    this.pendingOperation = settled;
    return result;
  }

  private async merge(next: Nrf24ListenerState): Promise<Nrf24ListenerState> {
    const restarted = this.state !== undefined && next.sequence < this.state.sequence;
    const previous = restarted ? [] : this.state?.observations ?? [];
    const bySequence = new Map([...previous, ...next.observations].map((item) => [item.sequence, item]));
    const observations = [...bySequence.values()]
      .filter((item) => item.sequence >= next.oldestSequence && item.sequence <= next.sequence)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, 200);
    const merged = { ...next, observations };
    if (restarted) await this.journal?.append({ event: "sequence_reset", previousSequence: this.state?.sequence, sequence: next.sequence,
      detail: "Possible bridge restart; capture sequence alone is not a boot identifier" });
    if (this.state && !restarted && next.oldestSequence > this.state.sequence + 1) {
      await this.journal?.append({ event: "history_gap", firstUnavailableSequence: this.state.sequence + 1,
        lastUnavailableSequence: next.oldestSequence - 1, dropped: next.dropped,
        detail: "Observations became unavailable before retrieval; a new sweep also clears the bridge ring" });
    }
    // Never advance the incremental cursor until the received data is durable.
    await this.journal?.snapshot(merged);
    this.state = merged;
    return this.state;
  }

  private async request<T>(path: string, method: "GET" | "POST", decode: (value: unknown) => T, payload: object = {}): Promise<T> {
    if (this.quiet && quietIsActive(await this.quietStatus())) {
      // Also hydrates the last disk snapshot after a HomeTruth worker reload,
      // so the page can show USB progress instead of losing its offline view.
      await this.journal?.append({ event: "usb_capture_http_suppressed", path, method });
      throw new Nrf24BridgeError("USB capture is active; Wi-Fi may be intentionally off. Radio controls are locked until it finishes.", "protocol");
    }
    // Retry a dropped read once. A control (especially replay) must never be
    // repeated automatically when its response might have been lost.
    const requestId = randomUUID();
    try { return await this.requestOnce(path, method, decode, payload, requestId, 1); }
    catch (error) {
      if (method !== "GET" || !(error instanceof Nrf24BridgeError) || error.code !== "unreachable") throw error;
      return this.requestOnce(path, method, decode, payload, requestId, 2);
    }
  }

  private async requestOnce<T>(path: string, method: "GET" | "POST", decode: (value: unknown) => T, payload: object, requestId: string, attempt: number): Promise<T> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const context = { requestId, attempt, path, method, startedAt };
    // In particular, persist transmit intent before allowing any RF side effect.
    await this.journal?.append({ event: "http_request", ...context, ...(method === "POST" ? { payload } : {}) });
    let response: Response | undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let transportError: string | undefined;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        redirect: "error",
        headers: { accept: "application/json", connection: "close", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            const remaining = 65536 - size;
            chunks.push(part.value.slice(0, remaining));
            size += Math.min(remaining, part.value.byteLength);
            if (part.value.byteLength > remaining) {
              await reader.cancel();
              throw new Nrf24BridgeError("Radio response exceeded the 64 KiB safety limit", "protocol");
            }
          }
        } finally { reader.releaseLock(); }
      }
    } catch (error) {
      transportError = error instanceof Error ? error.message : String(error);
    }
    const bytes = Buffer.concat(chunks, size);
    const expectedLength = response?.headers.get("content-length");
    if (!transportError && expectedLength != null && !response?.headers.has("content-encoding") && Number(expectedLength) !== size) {
      transportError = `Radio bridge response was incomplete (${size} of ${expectedLength} bytes)`;
    }
    let body: unknown;
    let validJson = false;
    try { body = JSON.parse(bytes.toString("utf8")); validJson = true; } catch { /* Preserve partial and malformed bytes below. */ }
    await this.journal?.append({ event: "http_response", ...context, durationMs: Math.round(performance.now() - started),
      status: response?.status ?? null, contentType: response?.headers.get("content-type") ?? null,
      expectedBytes: expectedLength == null ? null : Number(expectedLength), receivedBytes: size,
      ...(validJson ? { body } : { bodyBase64: bytes.toString("base64") }),
      ...(transportError ? { error: transportError, complete: false } : { complete: true }),
    });
    if (transportError || !response) {
      throw new Nrf24BridgeError(response
        ? `Radio bridge response was interrupted before it finished: ${transportError}`
        : `Radio bridge did not answer: ${transportError}`, transportError?.includes("64 KiB") ? "protocol" : "unreachable");
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new Nrf24BridgeError(`Radio bridge does not support ${method} /${path}`, "not_supported");
    }
    if (!response.ok) throw new Nrf24BridgeError(`Radio bridge returned HTTP ${response.status}`, "protocol");
    if (!validJson) throw new Nrf24BridgeError("Radio bridge returned invalid JSON", "protocol");
    try { return decode(body); }
    catch (error) {
      await this.journal?.append({ event: "decode_error", ...context, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
