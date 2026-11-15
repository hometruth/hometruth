/**
 * Roborock local protocol "1.0" framing, as spoken on TCP port 58867.
 *
 * One frame on the wire:
 *
 *   u32 length (of everything after it)
 *   "1.0"            3 bytes ASCII version
 *   u32 seq
 *   u32 random
 *   u32 timestamp    unix seconds
 *   u16 protocol     0 hello, 1 hello reply, 2 ping, 3 ping reply, 4 request/reply, 5 reply
 *   u16 payload length, then the AES-128-ECB (PKCS#7) payload   (absent on hello/ping)
 *   u32 CRC-32 of everything from the version to the end of the payload
 *
 * All integers are big-endian. The AES key is MD5 of the shuffled hex
 * timestamp, the device's local key, and a fixed salt. This module knows
 * nothing about HomeTruth; it is a pure codec with no I/O.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

export const ROBOROCK_LOCAL_PORT = 58867;
export const ROBOROCK_VERSION = "1.0";
export const ROBOROCK_SALT = "TXdfu$jyZ#TZHsg4";

export const RoborockProtocol = {
  helloRequest: 0,
  helloResponse: 1,
  pingRequest: 2,
  pingResponse: 3,
  generalRequest: 4,
  generalResponse: 5,
} as const;

/** Header: version(3) seq(4) random(4) timestamp(4) protocol(2). */
const HEADER_BYTES = 17;
const CRC_BYTES = 4;
/** Generous bound: a status reply is a few hundred bytes; maps travel elsewhere. */
export const MAX_FRAME_BYTES = 1 << 20;

export class RoborockCodecError extends Error {
  readonly code = "protocol" as const;
  constructor(message: string) {
    super(message);
    this.name = "RoborockCodecError";
  }
}

export interface RoborockMessage {
  readonly seq: number;
  readonly random: number;
  /** Unix seconds; also the input to the payload key. */
  readonly timestamp: number;
  readonly protocol: number;
  /** Plaintext payload; absent for hello and ping frames. */
  readonly payload?: Uint8Array;
}

/** The shuffled hex timestamp the key derivation uses: hex digits 5,6,3,7,1,2,0,4 of the zero-padded value. */
export function encodeTimestamp(timestamp: number): string {
  assertU32(timestamp, "timestamp");
  const hex = timestamp.toString(16).padStart(8, "0");
  return [5, 6, 3, 7, 1, 2, 0, 4].map((index) => hex[index]).join("");
}

/** AES-128 key for one frame: md5(encodeTimestamp(t) + localKey + salt). */
export function deriveKey(localKey: string, timestamp: number): Buffer {
  return createHash("md5").update(encodeTimestamp(timestamp) + localKey + ROBOROCK_SALT, "utf8").digest();
}

export function encryptPayload(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptPayload(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new RoborockCodecError("Encrypted payload is not a whole number of AES blocks");
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Bad padding after decryption almost always means the wrong local key.
    throw new RoborockCodecError("Payload did not decrypt; the local key is probably wrong");
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3, the zlib one). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One complete frame, length prefix included. */
export function encodeMessage(message: RoborockMessage, localKey: string): Buffer {
  assertU32(message.seq, "seq");
  assertU32(message.random, "random");
  assertU32(message.timestamp, "timestamp");
  if (!Number.isInteger(message.protocol) || message.protocol < 0 || message.protocol > 0xffff) throw new RoborockCodecError("protocol must be a u16");
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(ROBOROCK_VERSION, 0, "ascii");
  header.writeUInt32BE(message.seq, 3);
  header.writeUInt32BE(message.random, 7);
  header.writeUInt32BE(message.timestamp, 11);
  header.writeUInt16BE(message.protocol, 15);
  const parts: Buffer[] = [header];
  if (message.payload !== undefined) {
    const encrypted = encryptPayload(message.payload, deriveKey(localKey, message.timestamp));
    if (encrypted.length > 0xffff) throw new RoborockCodecError("Payload is too large for one frame");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(encrypted.length, 0);
    parts.push(length, encrypted);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.alloc(CRC_BYTES);
  trailer.writeUInt32BE(crc32(body), 0);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length + CRC_BYTES, 0);
  return Buffer.concat([prefix, body, trailer]);
}

/** Decode one frame body (without its 4-byte length prefix). */
export function decodeMessage(frame: Uint8Array, localKey: string): RoborockMessage {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.length < HEADER_BYTES + CRC_BYTES) throw new RoborockCodecError("Frame is shorter than a header");
  if (bytes.toString("ascii", 0, 3) !== ROBOROCK_VERSION) throw new RoborockCodecError(`Unsupported protocol version ${JSON.stringify(bytes.toString("latin1", 0, 3))}`);
  const bodyEnd = bytes.length - CRC_BYTES;
  if (crc32(bytes.subarray(0, bodyEnd)) !== bytes.readUInt32BE(bodyEnd)) throw new RoborockCodecError("Frame checksum does not match");
  const seq = bytes.readUInt32BE(3);
  const random = bytes.readUInt32BE(7);
  const timestamp = bytes.readUInt32BE(11);
  const protocol = bytes.readUInt16BE(15);
  if (bodyEnd === HEADER_BYTES) return { seq, random, timestamp, protocol };
  if (bodyEnd < HEADER_BYTES + 2) throw new RoborockCodecError("Frame has a truncated payload length");
  const length = bytes.readUInt16BE(HEADER_BYTES);
  if (HEADER_BYTES + 2 + length !== bodyEnd) throw new RoborockCodecError("Frame payload length does not match the frame size");
  if (length === 0) return { seq, random, timestamp, protocol };
  const payload = decryptPayload(bytes.subarray(HEADER_BYTES + 2, bodyEnd), deriveKey(localKey, timestamp));
  return { seq, random, timestamp, protocol, payload };
}

/**
 * Splits a TCP byte stream into frame bodies. Feed every chunk; complete
 * frames come back in order, partial ones wait for the next chunk.
 */
export class RoborockFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < HEADER_BYTES + CRC_BYTES || length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new RoborockCodecError(`Implausible frame length ${length}`);
      }
      if (this.buffer.length < 4 + length) break;
      frames.push(Buffer.from(this.buffer.subarray(4, 4 + length)));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}

/** The JSON wrapper around one RPC request: `{"dps":{"101":"<json>"},"t":<ts>}`. */
export function encodeRpcRequest(request: { id: number; method: string; params: unknown }, timestamp: number): Uint8Array {
  const inner = JSON.stringify({ id: request.id, method: request.method, params: request.params });
  return Buffer.from(JSON.stringify({ dps: { "101": inner }, t: timestamp }), "utf8");
}

export interface RoborockRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Parse an RPC reply payload: `{"dps":{"102":"{\"id\":n,\"result\":…}"},"t":…}`.
 * Returns undefined for a payload that carries no RPC reply (status pushes
 * use other dps keys).
 */
export function decodeRpcResponse(payload: Uint8Array): RoborockRpcResponse | undefined {
  let outer: unknown;
  try { outer = JSON.parse(Buffer.from(payload).toString("utf8")); }
  catch { throw new RoborockCodecError("Payload is not JSON"); }
  const dps = (outer as { dps?: unknown } | null)?.dps;
  if (!dps || typeof dps !== "object") return undefined;
  const raw = (dps as Record<string, unknown>)["102"];
  if (raw === undefined) return undefined;
  let inner: unknown;
  try { inner = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new RoborockCodecError("RPC reply is not JSON"); }
  if (!inner || typeof inner !== "object") throw new RoborockCodecError("RPC reply is not an object");
  const { id, result, error } = inner as { id?: unknown; result?: unknown; error?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id)) throw new RoborockCodecError("RPC reply has no id");
  if (error !== undefined) {
    const detail = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
    return {
      id,
      error: {
        ...(typeof detail.code === "number" ? { code: detail.code } : {}),
        ...(typeof detail.message === "string" ? { message: detail.message.slice(0, 200) } : {}),
      },
    };
  }
  return { id, result };
}

function assertU32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RoborockCodecError(`${name} must be a u32`);
}
