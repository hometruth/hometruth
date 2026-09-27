/**
 * The websocket half of Ring's cloud: one connection per location, carrying
 * every device behind that location's hubs (for Smart Lighting, the Bridge).
 *
 * The REST API in `client.ts` can name a Bridge but cannot see the lights
 * paired to it, and cannot switch one. Only this socket can. Despite the
 * name Ring's own client uses, the wire format is plain JSON frames rather
 * than socket.io framing: `{ channel, msg }` in both directions.
 *
 * Ring pushes a frame whenever a device changes, which is what lets a light
 * report its real state without anything here polling. When the socket is
 * down the devices report as offline rather than replaying their last known
 * values: a light nobody can reach is not a light that is still on.
 */
import { RingError, isBeamsBridgeKind, type RingClient } from "./client";

/** The slice of a WebSocket this needs, small enough to fake in a test. */
export interface RingSocket {
  send(data: string): void;
  close(): void;
  on(type: "open" | "message" | "error" | "close", listener: (event: { readonly data?: unknown }) => void): void;
}

export type RingSocketFactory = (url: string) => RingSocket;

/** Adapts the platform `WebSocket` to the narrow interface above. */
export function webSocketFactory(url: string): RingSocket {
  const socket = new WebSocket(url);
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    on: (type, listener) => socket.addEventListener(type, event => listener(event as { readonly data?: unknown })),
  };
}

/**
 * A device as the hub describes it, flattened from `general.v2` and
 * `device.v1`. Only the fields this project reads are named; Ring sends many
 * more, and which ones appear depends on the product.
 */
export interface RingDeviceData {
  readonly zid: string;
  readonly name: string;
  readonly deviceType: string;
  /** `switch.beams` and friends: whether the light is lit. */
  readonly on?: boolean;
  /** Brightness as a fraction, 0..1, on `switch.multilevel.beams`. */
  readonly level?: number;
  readonly batteryLevel?: number;
  readonly motionStatus?: string;
  readonly tamperStatus?: string;
  readonly commStatus?: string;
  readonly parentZid?: string;
}

export const RING_BEAMS_SWITCH = "switch.beams";
export const RING_BEAMS_MULTILEVEL_SWITCH = "switch.multilevel.beams";
export const RING_BEAMS_MOTION_SENSOR = "motion-sensor.beams";

/** Every beam device that behaves as a light. */
export function isBeamsLightType(deviceType: string): boolean {
  return deviceType === RING_BEAMS_SWITCH || deviceType === RING_BEAMS_MULTILEVEL_SWITCH;
}

const DEVICE_LIST = "DeviceInfoDocGetList";
const DEVICE_SET = "DeviceInfoSet";

type ObjectValue = Record<string, unknown>;

function asObject(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

/**
 * Ring splits a device across `general.v2` and `device.v1`; the union is the
 * device. An update frame carries only the fields that changed, so
 * everything but `zid` is optional here and the caller merges.
 */
export type RingDeviceUpdate = Partial<RingDeviceData> & { readonly zid: string };

export function flattenDeviceDocument(document: unknown): RingDeviceUpdate | undefined {
  const doc = asObject(document);
  if (!doc) return undefined;
  const merged: ObjectValue = { ...asObject(asObject(doc.general)?.v2), ...asObject(asObject(doc.device)?.v1) };
  const zid = merged.zid;
  if (typeof zid !== "string" || !zid) return undefined;
  return {
    zid,
    ...(typeof merged.name === "string" && merged.name ? { name: merged.name } : {}),
    ...(typeof merged.deviceType === "string" ? { deviceType: merged.deviceType } : {}),
    ...(typeof merged.on === "boolean" ? { on: merged.on } : {}),
    ...(typeof merged.level === "number" && Number.isFinite(merged.level) ? { level: merged.level } : {}),
    ...(typeof merged.batteryLevel === "number" ? { batteryLevel: merged.batteryLevel } : {}),
    ...(typeof merged.motionStatus === "string" ? { motionStatus: merged.motionStatus } : {}),
    ...(typeof merged.tamperStatus === "string" ? { tamperStatus: merged.tamperStatus } : {}),
    ...(typeof merged.commStatus === "string" ? { commStatus: merged.commStatus } : {}),
    ...(typeof merged.parentZid === "string" ? { parentZid: merged.parentZid } : {}),
  };
}

export interface RingConnectionState {
  readonly availability: "online" | "offline" | "unknown";
  /** Why it is not online; empty when nothing has been attempted yet. */
  readonly detail?: string;
  /** When the hub last told us anything; only present while online. */
  readonly observedAt?: string;
  readonly devices: ReadonlyMap<string, RingDeviceData>;
  /** The beams bridges this location reported, by asset uuid. */
  readonly bridges: readonly string[];
}

const OFFLINE_NO_ATTEMPT: RingConnectionState = { availability: "unknown", devices: new Map(), bridges: [] };

/**
 * What a Ring device reads and writes through. `RingAssetConnection` is the
 * real one; a site with no Ring account gets an inert stand-in instead, so
 * the models never branch on whether the account exists.
 */
export interface RingSource {
  state(): RingConnectionState;
  /** Open the connection if it is not open; the device lists arrive with it. */
  ready(): Promise<void>;
  device(zid: string): RingDeviceData | undefined;
  setDevice(zid: string, values: Record<string, unknown>): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface RingAssetConnectionOptions {
  socket?: RingSocketFactory;
  /** Backoff between reconnects; a test passes a no-op to keep the loop out of the way. */
  reconnectDelayMs?: number;
  schedule?: (run: () => void, ms: number) => void;
  now?: () => Date;
}

/**
 * One location's socket, shared by every Ring device configured against it.
 * Opening a second connection for the same location makes Ring drop the
 * first, so the site service hands out exactly one of these per location.
 */
export class RingAssetConnection implements RingSource {
  private socket: RingSocket | undefined;
  private connecting: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, (data: RingDeviceData[]) => void>();
  private devices = new Map<string, RingDeviceData>();
  private bridges: string[] = [];
  private availability: "online" | "offline" | "unknown" = "unknown";
  private detail = "";
  private observedAt = "";
  private seq = 1;
  private closed = false;
  private readonly socketFactory: RingSocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly schedule: (run: () => void, ms: number) => void;
  private readonly now: () => Date;

  constructor(private readonly client: RingClient, readonly locationId: string, options: RingAssetConnectionOptions = {}) {
    this.socketFactory = options.socket ?? webSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.schedule = options.schedule ?? ((run, ms) => { setTimeout(run, ms).unref?.(); });
    this.now = options.now ?? (() => new Date());
  }

  state(): RingConnectionState {
    if (this.availability !== "online") return { availability: this.availability, ...(this.detail ? { detail: this.detail } : {}), devices: new Map(), bridges: this.bridges };
    return { availability: "online", observedAt: this.observedAt, devices: new Map(this.devices), bridges: this.bridges };
  }

  device(zid: string): RingDeviceData | undefined {
    return this.availability === "online" ? this.devices.get(zid) : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Connect if nothing is connected; resolves once the device lists have arrived. */
  async ready(): Promise<void> {
    if (this.closed) throw new RingError("This Ring connection is closed", "unavailable");
    if (this.availability === "online" && this.socket) return;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const { host, ticket, assets } = await this.client.ticket(this.locationId);
    const hubs = assets.filter(asset => isBeamsBridgeKind(asset.kind) || asset.kind.startsWith("base_station"));
    this.bridges = assets.filter(asset => isBeamsBridgeKind(asset.kind)).map(asset => asset.uuid);
    if (!hubs.length) {
      this.fail("This Ring location has no Bridge or base station");
      throw new RingError("This Ring location has no Bridge or base station", "unavailable");
    }
    if (!/^[A-Za-z0-9.-]+$/u.test(host)) throw new RingError("Ring returned an unusable websocket host", "protocol");
    const socket = this.socketFactory(`wss://${host}/ws?authcode=${encodeURIComponent(ticket)}&ack=false`);
    this.socket = socket;
    socket.on("message", event => this.receive(event.data));
    socket.on("close", () => this.dropped("The Ring connection closed"));
    socket.on("error", () => this.dropped("The Ring connection failed"));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const lists = hubs.map(hub => new Promise<void>(done => {
        this.pending.set(hub.uuid, devices => {
          for (const device of devices) this.devices.set(device.zid, device);
          done();
        });
      }));
      socket.on("open", () => {
        for (const hub of hubs) this.send({ msg: DEVICE_LIST, dst: hub.uuid });
        void Promise.all(lists).then(() => {
          if (settled) return;
          settled = true;
          this.availability = "online";
          this.detail = "";
          this.observedAt = this.now().toISOString();
          resolve();
          this.changed();
        });
      });
      socket.on("error", () => {
        if (settled) return;
        settled = true;
        reject(new RingError("The Ring connection failed", "unavailable"));
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        reject(new RingError("The Ring connection closed before the device list arrived", "unavailable"));
      });
    });
  }

  private fail(detail: string): void {
    this.availability = "offline";
    this.detail = detail;
  }

  private dropped(detail: string): void {
    if (this.closed) return;
    const wasOnline = this.availability === "online";
    this.fail(detail);
    // Nothing here knows whether a light stayed on, so nothing here claims it did.
    this.devices = new Map();
    this.socket = undefined;
    this.pending.clear();
    if (wasOnline) this.changed();
    this.schedule(() => { if (!this.closed) void this.ready().catch(() => {}); }, this.reconnectDelayMs);
  }

  private send(message: { msg: string; datatype?: string; dst: string; body?: unknown }): void {
    const socket = this.socket;
    if (!socket) throw new RingError("The Ring connection is not open", "unavailable");
    socket.send(JSON.stringify({ channel: "message", msg: { ...message, seq: this.seq++ } }));
  }

  private receive(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: ObjectValue | undefined;
    try { frame = asObject(JSON.parse(raw)); } catch { return; }
    const message = asObject(frame?.msg);
    if (!message) return;
    const documents = Array.isArray(message.body) ? message.body : [];
    const updates = documents.map(flattenDeviceDocument).filter((device): device is RingDeviceUpdate => Boolean(device));

    if (message.msg === DEVICE_LIST && typeof message.src === "string") {
      // A listing is the whole device, so anything without a type is not one.
      const devices = updates.filter((update): update is RingDeviceData => typeof update.deviceType === "string")
        .map(update => ({ ...update, name: update.name ?? update.zid }));
      const waiting = this.pending.get(message.src);
      this.pending.delete(message.src);
      waiting?.(devices);
      if (!waiting && devices.length) {
        for (const device of devices) this.devices.set(device.zid, device);
        this.observedAt = this.now().toISOString();
        this.changed();
      }
      return;
    }
    if (frame?.channel === "DataUpdate" && updates.length) {
      let touched = false;
      for (const update of updates) {
        const previous = this.devices.get(update.zid);
        // An update carries only what changed, so merge rather than replace.
        if (previous) { this.devices.set(update.zid, { ...previous, ...update }); touched = true; continue; }
        // Nothing known about it and no type to classify it by: wait for a listing.
        if (typeof update.deviceType !== "string") continue;
        this.devices.set(update.zid, { ...update, deviceType: update.deviceType, name: update.name ?? update.zid });
        touched = true;
      }
      if (!touched) return;
      this.observedAt = this.now().toISOString();
      this.changed();
    }
  }

  /** Set fields on one device, addressed through whichever hub reported it. */
  async setDevice(zid: string, values: Record<string, unknown>): Promise<void> {
    await this.ready();
    const hub = this.bridges[0];
    if (!hub) throw new RingError("This Ring location has no Bridge to send through", "unavailable");
    this.send({ msg: DEVICE_SET, datatype: "DeviceInfoSetType", dst: hub, body: [{ zid, device: { v1: values } }] });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;
    this.devices = new Map();
    this.availability = "unknown";
    this.listeners.clear();
  }
}

export { OFFLINE_NO_ATTEMPT };
