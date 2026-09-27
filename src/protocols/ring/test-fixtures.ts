/** Fakes for the Ring cloud: a scriptable socket and the frames Ring sends over it. */
import type { RingConnectionState, RingDeviceData, RingSocket, RingSource } from "./asset-socket";
import { encodeAuthConfig, RingError } from "./client";

export const RING_HARDWARE_ID = "11111111-2222-3333-4444-555555555555";
export const RING_ASSET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const RING_LOCATION = "loc-1";

export const storedToken = (rt: string) => encodeAuthConfig({ rt, hid: RING_HARDWARE_ID });

export function oauthResponse(body: { access_token?: string; refresh_token?: string; expires_in?: number } = {}): Response {
  return Response.json({ access_token: "access-1", expires_in: 3600, ...body });
}

export function ringDevicesResponse(bridges: unknown[] = [{ id: 42, location_id: RING_LOCATION, description: "Bridge", kind: "beams_bridge_v1" }]): Response {
  return Response.json({ doorbots: [], stickup_cams: [], base_stations: [], beams_bridges: bridges, chimes: [], other: [] });
}

export function ticketResponse(assets: unknown[] = [{ uuid: RING_ASSET, kind: "beams_bridge_v1" }]): Response {
  return Response.json({ assets, host: "ws.example.ring.com", ticket: "ticket-1", subscriptionTopics: [] });
}

/** One device as the hub documents it, split across `general.v2` and `device.v1` the way Ring does. */
export function deviceDocument(zid: string, general: Record<string, unknown>, device: Record<string, unknown> = {}): unknown {
  return { general: { v2: { zid, ...general } }, device: { v1: { ...device } } };
}

export function beamLight(zid: string, name: string, options: { on?: boolean; level?: number; multilevel?: boolean } = {}): unknown {
  return deviceDocument(zid,
    { name, deviceType: options.multilevel === false ? "switch.beams" : "switch.multilevel.beams", categoryId: 2 },
    { ...(options.on !== undefined ? { on: options.on } : {}), ...(options.level !== undefined ? { level: options.level } : {}) });
}

export interface FakeRingSource extends RingSource {
  /** Every write, in order, so a test can assert what was sent rather than what was meant. */
  readonly writes: { zid: string; values: Record<string, unknown> }[];
  /** Apply a change the way Ring's push would, and notify subscribers. */
  push(zid: string, values: Partial<RingDeviceData>): void;
  /** Take the connection down; reads must stop answering from memory. */
  drop(detail?: string): void;
}

/**
 * A Ring connection without a socket, for testing a device rather than the
 * transport. Defaults to online with whatever devices it is given.
 */
export function fakeRingSource(devices: readonly RingDeviceData[] = [], options: { readyError?: RingError; writeError?: RingError } = {}): FakeRingSource {
  const known = new Map(devices.map(device => [device.zid, device]));
  const listeners = new Set<() => void>();
  let availability: RingConnectionState["availability"] = "online";
  let detail = "";
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    writes: [],
    state: () => availability === "online"
      ? { availability, observedAt: "2026-09-18T12:00:00.000Z", devices: new Map(known), bridges: [RING_ASSET] }
      : { availability, detail, devices: new Map(), bridges: [] },
    ready: async () => { if (options.readyError) throw options.readyError; },
    device(zid) { return availability === "online" ? known.get(zid) : undefined; },
    async setDevice(zid, values) {
      if (options.writeError) throw options.writeError;
      this.writes.push({ zid, values });
      const previous = known.get(zid);
      if (previous) known.set(zid, { ...previous, ...values });
      changed();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push(zid, values) {
      const previous = known.get(zid);
      if (previous) known.set(zid, { ...previous, ...values });
      changed();
    },
    drop(reason = "The Ring connection closed") { availability = "offline"; detail = reason; known.clear(); changed(); },
  };
}

type Handler = (event: { readonly data?: unknown }) => void;

/** A socket a test drives by hand: nothing happens until `open()` or `deliver()` is called. */
export class FakeRingSocket implements RingSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly url: string) {}

  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.emit("close", {}); }
  on(type: "open" | "message" | "error" | "close", listener: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  private emit(type: string, event: { readonly data?: unknown }): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }

  open(): void { this.emit("open", {}); }
  fail(): void { this.emit("error", {}); }
  /** Push a frame from Ring; `raw` lets a test send something unparseable. */
  deliver(frame: unknown): void { this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }); }

  deviceList(documents: unknown[], asset = RING_ASSET): void {
    this.deliver({ channel: "message", msg: { msg: "DeviceInfoDocGetList", src: asset, body: documents } });
  }

  dataUpdate(documents: unknown[], asset = RING_ASSET): void {
    this.deliver({ channel: "DataUpdate", msg: { msg: "DataUpdate", src: asset, body: documents } });
  }

  /** Everything this socket was asked to send, parsed. */
  frames(): { channel: string; msg: { msg: string; dst: string; body?: unknown } }[] {
    return this.sent.map(text => JSON.parse(text) as { channel: string; msg: { msg: string; dst: string; body?: unknown } });
  }
}
