/**
 * A scripted Roborock robot for tests: it speaks the 1.0 framing through a
 * `RoborockConnect`, answers hello and ping, and replies to RPC methods
 * from a table. No sockets, no hardware.
 */
import type { RoborockConnect, RoborockSocketHandlers } from "./client";
import { RoborockFrameReader, RoborockProtocol, decodeMessage, encodeMessage } from "./codec";

export type FakeRoborockReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  /** Swallow the request. */
  | "silent";

export interface FakeRoborockOptions {
  readonly localKey: string;
  /** Replies by method; a function sees the params. Unlisted methods are silent. */
  readonly methods?: Record<string, FakeRoborockReply | ((params: unknown) => FakeRoborockReply)>;
  /** The key the robot encrypts replies with, when it differs (a wrong configured key). */
  readonly replyKey?: string;
  /** Reject connections, as a robot that is off or refuses the port. */
  readonly refuse?: boolean;
  /** Ignore hello. */
  readonly silentHello?: boolean;
  /** Write replies a few bytes at a time. */
  readonly fragment?: boolean;
  /** Reply with protocol 5 instead of 4. */
  readonly replyProtocol?: number;
}

export interface FakeRoborockRequest {
  readonly protocol: number;
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

export class FakeRoborock {
  readonly requests: FakeRoborockRequest[] = [];
  connections = 0;
  closes = 0;
  private handlers: RoborockSocketHandlers | undefined;

  constructor(readonly options: FakeRoborockOptions) {}

  readonly connect: RoborockConnect = async (_target, handlers) => {
    if (this.options.refuse) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    this.connections++;
    this.handlers = handlers;
    const reader = new RoborockFrameReader();
    let open = true;
    return {
      write: (bytes) => {
        if (!open) throw new Error("socket closed");
        for (const frame of reader.push(bytes)) queueMicrotask(() => { if (open) this.handle(frame, handlers); });
      },
      close: () => { if (open) { open = false; this.closes++; } },
    };
  };

  /** The robot drops the TCP connection. */
  hangUp(): void {
    this.handlers?.closed();
  }

  /** An unsolicited status push, which a client must ignore. */
  push(timestamp = 1_700_000_000): void {
    const payload = Buffer.from(JSON.stringify({ t: timestamp, dps: { "121": 8, "122": 100 } }));
    this.send(this.handlers!, { seq: 5, random: 5, timestamp, protocol: RoborockProtocol.generalRequest, payload });
  }

  private handle(frame: Buffer, handlers: RoborockSocketHandlers): void {
    const message = decodeMessage(frame, this.options.localKey);
    const base = { seq: message.seq, random: message.random, timestamp: message.timestamp };
    if (message.protocol === RoborockProtocol.helloRequest) {
      this.requests.push({ protocol: message.protocol });
      if (!this.options.silentHello) this.send(handlers, { ...base, protocol: RoborockProtocol.helloResponse });
      return;
    }
    if (message.protocol === RoborockProtocol.pingRequest) {
      this.requests.push({ protocol: message.protocol });
      this.send(handlers, { ...base, protocol: RoborockProtocol.pingResponse });
      return;
    }
    const outer = JSON.parse(Buffer.from(message.payload!).toString()) as { dps: Record<string, string>; t: number };
    const inner = JSON.parse(outer.dps["101"]!) as { id: number; method: string; params: unknown };
    this.requests.push({ protocol: message.protocol, id: inner.id, method: inner.method, params: inner.params });
    const entry = this.options.methods?.[inner.method] ?? "silent";
    const reply = typeof entry === "function" ? entry(inner.params) : entry;
    if (reply === "silent") return;
    const body = "result" in reply ? { id: inner.id, result: reply.result } : { id: inner.id, error: reply.error };
    const payload = Buffer.from(JSON.stringify({ t: message.timestamp, dps: { "102": JSON.stringify(body) } }));
    this.send(handlers, { ...base, protocol: this.options.replyProtocol ?? RoborockProtocol.generalRequest, payload });
  }

  private send(handlers: RoborockSocketHandlers, message: Parameters<typeof encodeMessage>[0]): void {
    const bytes = encodeMessage(message, this.options.replyKey ?? this.options.localKey);
    if (!this.options.fragment) { handlers.data(bytes); return; }
    for (let offset = 0; offset < bytes.length; offset += 5) handlers.data(bytes.subarray(offset, offset + 5));
  }
}

/** A plausible S7-family `get_status` result (synthetic). */
export function fakeStatus(overrides: Record<string, unknown> = {}): unknown {
  return [{
    msg_ver: 2, msg_seq: 1, state: 8, battery: 100, clean_time: 1830, clean_area: 31_250_000,
    error_code: 0, map_present: 1, in_cleaning: 0, in_returning: 0, fan_power: 102, dnd_enabled: 0,
    water_box_status: 0, lock_status: 0, dock_type: 3, ...overrides,
  }];
}
