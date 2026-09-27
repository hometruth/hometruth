import { createCipheriv, createDecipheriv } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";

/**
 * Wire-level implementation of the Broadlink LAN protocol used by RM-series
 * IR/RF blasters (RM Mini, RM Pro, RM4). Every packet is a fixed 0x38-byte
 * header followed by an AES-128-CBC encrypted payload; the cipher key starts
 * as a device-independent default and is replaced by a per-device key
 * returned from the auth handshake.
 */

const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);
const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);

const AUTH_COMMAND = 0x65;
const RM_COMMAND = 0x6a;

// RM4-family devices (rmminib/rm4mini/rm4pro in the reference implementation)
// wrap every sub-command in a 2-byte little-endian length prefix followed by
// a 4-byte little-endian sub-command id, both inside the encrypted payload —
// distinct from the older RM mini 3's single-byte sub-command framing.
const RM_SEND_DATA = 0x02;
const RM_ENTER_LEARNING = 0x03;
const RM_CHECK_DATA = 0x04;
const RM_SWEEP_FREQUENCY = 0x19;
const RM_CHECK_FREQUENCY = 0x1a;
const RM_FIND_RF_PACKET = 0x1b;
const RM_CANCEL_SWEEP = 0x1e;

// Older firmware answers -1 while a learn or sweep is still in progress;
// RM4-era firmware answers -5 ("storage full") or -10 ("read error")
// instead. None are faults: they all mean "nothing to report yet".
const RM_NOT_READY = new Set([-1, -5, -10]);

/** One Broadlink pulse tick is 269/8192 ms (about 32.84 µs). */
const PULSE_TICK_MS = 269 / 8192;
/** The largest repeat count one signal packet can carry (byte 1). */
export const MAX_PACKET_REPEATS = 255;

export interface SignalPacketShape {
  /** Extra transmissions the packet already asks for; 0 sends the frame once. */
  repeats: number;
  /** Duration of one frame (all pulses and gaps, including the trailing gap), in milliseconds. */
  frameMs: number;
}

/**
 * Reads the header of a Broadlink signal packet: `[type, repeats, length LE, pulses…]`,
 * where each pulse is one byte of ticks or `0x00` followed by a two-byte big-endian count.
 * Returns undefined when the bytes are too short to be a packet.
 */
export function describeSignalPacket(packet: Buffer): SignalPacketShape | undefined {
  if (packet.length < 5) return undefined;
  const length = packet.readUInt16LE(2);
  const pulses = packet.subarray(4, Math.min(packet.length, 4 + length));
  let ticks = 0;
  for (let index = 0; index < pulses.length;) {
    const byte = pulses[index]!;
    if (byte !== 0) {
      ticks += byte;
      index += 1;
    } else if (index + 2 < pulses.length) {
      ticks += pulses.readUInt16BE(index + 1);
      index += 3;
    } else {
      break;
    }
  }
  return { repeats: packet[1]!, frameMs: ticks * PULSE_TICK_MS };
}

/** A copy of the packet asking for `repeats` extra transmissions (0–255). */
export function withPacketRepeats(packet: Buffer, repeats: number): Buffer {
  const copy = Buffer.from(packet);
  copy[1] = Math.max(0, Math.min(MAX_PACKET_REPEATS, Math.round(repeats)));
  return copy;
}

function buildRmPayload(subCommand: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(data.length + 4, 0x00);
  header.writeUInt32LE(subCommand, 0x02);
  return Buffer.concat([header, data]);
}

function parseRmResponse(decrypted: Buffer): Buffer {
  const length = decrypted.readUInt16LE(0x00);
  return decrypted.subarray(0x06, length + 0x02);
}

export class BroadlinkError extends Error {
  constructor(message: string, readonly code: "unreachable" | "timeout" | "protocol" | "not_authenticated") {
    super(message);
    this.name = "BroadlinkError";
  }
}

function checksum(buffer: Buffer): number {
  let sum = 0xbeaf;
  for (const byte of buffer) sum = (sum + byte) & 0xffff;
  return sum;
}

function encrypt(key: Buffer, payload: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, DEFAULT_IV);
  cipher.setAutoPadding(false);
  const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decrypt(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function buildPacket(devType: number, command: number, key: Buffer, payload: Buffer, count: number, mac: Buffer, deviceId: Buffer): Buffer {
  const header = Buffer.alloc(0x38);
  Buffer.from("5aa5aa555aa5aa55", "hex").copy(header, 0x00);
  header.writeUInt16LE(devType, 0x24);
  header.writeUInt16LE(command, 0x26);
  header.writeUInt16LE(count, 0x28);
  mac.copy(header, 0x2a);
  deviceId.copy(header, 0x30);
  header.writeUInt16LE(checksum(payload), 0x34);
  const encrypted = encrypt(key, payload);
  const packet = Buffer.concat([header, encrypted]);
  packet.writeUInt16LE(checksum(packet), 0x20);
  return packet;
}

export interface BroadlinkAuth {
  deviceId: Buffer;
  key: Buffer;
}

/** One UDP request/response round trip; swappable in tests to avoid real sockets. */
export type BroadlinkTransport = (host: string, port: number, packet: Buffer, timeoutMs: number) => Promise<Buffer>;

export interface BroadlinkClientOptions {
  host: string;
  /** Device type reported by discovery; used only in outbound headers. */
  devType?: number;
  port?: number;
  timeoutMs?: number;
  transport?: BroadlinkTransport;
}

/** One UDP request/response round trip against a Broadlink device. */
async function udpRoundTrip(host: string, port: number, packet: Buffer, timeoutMs: number): Promise<Buffer> {
  const socket: Socket = createSocket("udp4");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new BroadlinkError(`Broadlink device at ${host} did not respond within ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.close();
        reject(new BroadlinkError(`Broadlink device at ${host} is unreachable: ${error.message}`, "unreachable"));
      });
      socket.once("message", (message) => {
        clearTimeout(timer);
        socket.close();
        resolve(message);
      });
      socket.send(packet, port, host, (error) => {
        if (error) {
          clearTimeout(timer);
          socket.close();
          reject(new BroadlinkError(`Broadlink device at ${host} is unreachable: ${error.message}`, "unreachable"));
        }
      });
    });
  } finally {
    socket.removeAllListeners();
  }
}

/**
 * A minimal Broadlink LAN client: authenticate once, then send an encrypted
 * command and decrypt its response with the negotiated per-device key.
 */
export class BroadlinkClient {
  readonly host: string;
  private readonly devType: number;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly transport: BroadlinkTransport;
  // The reference implementation starts from a random count in the upper
  // half of the range and keeps the high bit set on every packet; some
  // firmware rejects low/predictable counts as a replay-protection measure.
  private count = 0x8000 + Math.floor(Math.random() * 0x8000);
  private auth?: BroadlinkAuth;

  constructor(options: BroadlinkClientOptions) {
    this.host = options.host;
    this.devType = options.devType ?? 0x2712;
    this.port = options.port ?? 80;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.transport = options.transport ?? udpRoundTrip;
  }

  private nextCount(): number {
    this.count = ((this.count + 1) | 0x8000) & 0xffff;
    return this.count;
  }

  /** Perform the auth handshake, storing the per-device id/key for later commands. */
  async authenticate(): Promise<BroadlinkAuth> {
    const payload = Buffer.alloc(0x50);
    payload[0x04] = 0x31;
    payload[0x05] = 0x31;
    payload[0x06] = 0x31;
    payload[0x07] = 0x31;
    payload[0x08] = 0x31;
    payload[0x09] = 0x31;
    payload[0x0a] = 0x31;
    payload[0x0b] = 0x31;
    payload[0x0c] = 0x31;
    payload[0x0d] = 0x31;
    payload[0x0e] = 0x31;
    payload[0x0f] = 0x31;
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    payload.write("HomeTruth", 0x30, "ascii");

    const zero16 = Buffer.alloc(16);
    const packet = buildPacket(this.devType, AUTH_COMMAND, DEFAULT_KEY, payload, this.nextCount(), zero16, zero16);
    const response = await this.transport(this.host, this.port, packet, this.timeoutMs);
    if (response.length < 0x38 + 0x14) {
      throw new BroadlinkError(`Broadlink device at ${this.host} returned a malformed auth response`, "protocol");
    }
    const errorCode = response.readInt16LE(0x22);
    if (errorCode !== 0) {
      throw new BroadlinkError(`Broadlink device at ${this.host} rejected authentication (error ${errorCode})`, "protocol");
    }
    const decrypted = decrypt(DEFAULT_KEY, response.subarray(0x38));
    const deviceId = Buffer.from(decrypted.subarray(0x00, 0x04));
    const key = decrypted.subarray(0x04, 0x14);
    const auth = { deviceId, key: Buffer.from(key) };
    this.auth = auth;
    return auth;
  }

  private async exchangeRm(subCommand: number, data?: Buffer): Promise<{ errorCode: number; body?: Buffer }> {
    const auth = this.auth;
    if (!auth) throw new BroadlinkError("Not authenticated with the Broadlink device", "not_authenticated");
    const payload = buildRmPayload(subCommand, data);
    const packet = buildPacket(this.devType, RM_COMMAND, auth.key, payload, this.nextCount(), Buffer.alloc(6), auth.deviceId);
    const response = await this.transport(this.host, this.port, packet, this.timeoutMs);
    const errorCode = response.length >= 0x24 ? response.readInt16LE(0x22) : -1;
    if (errorCode !== 0) return { errorCode };
    return { errorCode, body: parseRmResponse(decrypt(auth.key, response.subarray(0x38))) };
  }

  private async sendRm(subCommand: number, data?: Buffer): Promise<Buffer> {
    const { errorCode, body } = await this.exchangeRm(subCommand, data);
    if (body === undefined) {
      throw new BroadlinkError(`Broadlink device at ${this.host} rejected sub-command 0x${subCommand.toString(16)} (error ${errorCode})`, "protocol");
    }
    return body;
  }

  /** Like `sendRm`, but the firmware's "nothing yet" answers resolve to `undefined` instead of throwing. */
  private async pollRm(subCommand: number, label: string): Promise<Buffer | undefined> {
    const { errorCode, body } = await this.exchangeRm(subCommand);
    if (body !== undefined) return body;
    if (RM_NOT_READY.has(errorCode)) return undefined;
    throw new BroadlinkError(`Broadlink device at ${this.host} rejected the ${label} command (error ${errorCode})`, "protocol");
  }

  /** Send a raw IR/RF pulse packet (already in Broadlink's own encoding). */
  async sendCode(code: Buffer): Promise<void> {
    await this.sendRm(RM_SEND_DATA, code);
  }

  /** Enter infrared learning mode; the device will capture the next IR signal it sees. */
  async enterLearning(): Promise<void> {
    await this.sendRm(RM_ENTER_LEARNING);
  }

  /** Poll for a code captured after `enterLearning` or `findRfPacket`; `undefined` until one arrives. */
  async checkLearnedCode(): Promise<Buffer | undefined> {
    const body = await this.pollRm(RM_CHECK_DATA, "learn-status");
    return body ? Buffer.from(body) : undefined;
  }

  /** Start scanning for the carrier of an RF button the user is holding down. */
  async sweepFrequency(): Promise<void> {
    await this.sendRm(RM_SWEEP_FREQUENCY);
  }

  async cancelSweepFrequency(): Promise<void> {
    await this.sendRm(RM_CANCEL_SWEEP);
  }

  /** Poll a running sweep; resolves to the detected carrier in Hz, or `undefined` while still scanning. */
  async checkFrequency(): Promise<number | undefined> {
    const body = await this.pollRm(RM_CHECK_FREQUENCY, "frequency-check");
    if (!body || body.length < 5 || body[0] === 0) return undefined;
    return body.readUInt32LE(1) * 1000;
  }

  /** Lock onto an RF carrier (the device reports and accepts kHz) and wait for a packet on it. */
  async findRfPacket(frequencyHz?: number): Promise<void> {
    let data: Buffer | undefined;
    if (frequencyHz !== undefined) {
      data = Buffer.alloc(4);
      data.writeUInt32LE(Math.round(frequencyHz / 1000), 0);
    }
    await this.sendRm(RM_FIND_RF_PACKET, data);
  }
}
