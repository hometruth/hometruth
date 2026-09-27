import { createSocket, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";

export interface GoveeScan {
  ip: string; device: string; sku: string;
  bleVersionHard: string; bleVersionSoft: string;
  wifiVersionHard: string; wifiVersionSoft: string;
}
export interface GoveeStatus {
  onOff: 0 | 1; brightness: number;
  color: { r: number; g: number; b: number };
  colorTemInKelvin: number;
}
export interface GoveeLanTransport {
  request(host: string, command: "scan" | "devStatus", timeoutMs: number): Promise<unknown>;
  send(host: string, command: "turn" | "brightness" | "colorwc" | "ptReal", data: Record<string, unknown>): Promise<void>;
}
export class GoveeLanError extends Error {
  constructor(message: string, readonly code: "invalid_host" | "unreachable" | "protocol") { super(message); this.name = "GoveeLanError"; }
}
export function assertGoveeHost(host: string): void {
  const octets = host.split(".").map(Number);
  if (!isIPv4(host) || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)) {
    throw new GoveeLanError("Govee host must be a private LAN IPv4 address", "invalid_host");
  }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max; }
export function parseGoveeStatus(value: unknown): GoveeStatus {
  if (!record(value) || !integer(value.onOff, 0, 1) || !integer(value.brightness, 0, 100) || !integer(value.colorTemInKelvin, 0, 40000) || !record(value.color) || ![value.color.r, value.color.g, value.color.b].every(channel => integer(channel, 0, 255))) {
    throw new GoveeLanError("Govee returned an invalid light status", "protocol");
  }
  return value as unknown as GoveeStatus;
}
export function parseGoveeScan(value: unknown): GoveeScan {
  if (!record(value) || !["ip", "device", "sku", "bleVersionHard", "bleVersionSoft", "wifiVersionHard", "wifiVersionSoft"].every(key => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 100)) {
    throw new GoveeLanError("Govee returned an invalid discovery response", "protocol");
  }
  return value as unknown as GoveeScan;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; retry: ReturnType<typeof setInterval>; promise: Promise<unknown> }

/** All controllers reply to port 4002. One socket demultiplexes by source IP and command. */
export class GoveeLanBus implements GoveeLanTransport {
  constructor(private readonly socketFactory: () => Socket = () => createSocket("udp4")) {}
  private socket: Socket | undefined;
  private ready: Promise<Socket> | undefined;
  private readonly pending = new Map<string, Pending>();

  private open(): Promise<Socket> {
    if (this.ready) return this.ready;
    const socket = this.socketFactory();
    this.socket = socket;
    this.ready = new Promise<Socket>((resolve, reject) => {
      socket.on("message", (bytes, remote) => {
        if (bytes.length > 8192) return;
        let body: unknown;
        try { body = JSON.parse(bytes.toString()); } catch { return; }
        if (!record(body) || !record(body.msg) || typeof body.msg.cmd !== "string") return;
        const key = `${remote.address}/${body.msg.cmd}`;
        this.finish(key, undefined, body.msg.data);
      });
      socket.on("error", () => {
        const error = new GoveeLanError("Govee LAN socket failed; port 4002 must be available", "unreachable");
        reject(error);
        for (const key of this.pending.keys()) this.finish(key, error);
        this.close();
      });
      socket.bind(4002, "0.0.0.0", () => { socket.unref(); resolve(socket); });
    });
    return this.ready;
  }
  private finish(key: string, error?: Error, value?: unknown): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key); clearTimeout(pending.timer); clearInterval(pending.retry);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private async packet(host: string, command: string, data: Record<string, unknown>, port: number): Promise<void> {
    assertGoveeHost(host);
    const socket = await this.open();
    await new Promise<void>((resolve, reject) => socket.send(Buffer.from(JSON.stringify({ msg: { cmd: command, data } })), port, host, error => error ? reject(new GoveeLanError("Govee LAN send failed", "unreachable")) : resolve()));
  }
  async request(host: string, command: "scan" | "devStatus", timeoutMs: number): Promise<unknown> {
    assertGoveeHost(host);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new GoveeLanError("Invalid Govee request timeout", "protocol");
    const key = `${host}/${command}`;
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const send = () => { void this.packet(host, command, command === "scan" ? { account_topic: "reserve" } : {}, command === "scan" ? 4001 : 4003).catch(error => this.finish(key, error)); };
    this.pending.set(key, {
      resolve, reject, promise,
      timer: setTimeout(() => this.finish(key, new GoveeLanError(`Govee ${command} timed out`, "unreachable")), timeoutMs),
      retry: setInterval(send, Math.max(250, Math.min(1000, timeoutMs / 3))),
    });
    send();
    return promise;
  }
  send(host: string, command: "turn" | "brightness" | "colorwc" | "ptReal", data: Record<string, unknown>): Promise<void> { return this.packet(host, command, data, 4003); }
  close(): void {
    for (const key of this.pending.keys()) this.finish(key, new GoveeLanError("Govee LAN socket closed", "unreachable"));
    try { this.socket?.close(); } catch { /* Already closed after an error. */ }
    this.socket = undefined; this.ready = undefined;
  }
}

const busKey = Symbol.for("hometruth.govee.lan");
export function goveeLanTransport(): GoveeLanTransport {
  const shared = globalThis as unknown as Record<symbol, GoveeLanBus>;
  return shared[busKey] ??= new GoveeLanBus();
}
