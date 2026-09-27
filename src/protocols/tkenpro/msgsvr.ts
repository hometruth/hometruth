import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Native Meari MsgSvr framing used by cameras on the persistent TCP control
 * channel (normally port 18665) and by app-side signaling.
 */
export const MSGSVR_MAGIC = 0xe6;
export const MSGSVR_TAIL = 0x9d;
export const MSGSVR_DEFAULT_TYPE = 0xd3;

export const MSGSVR_NODES = Object.freeze({
  APP: 0xa1,
  CAMERA: 0xa2,
  DNS_SERVER: 0xa3,
  SERVER: 0xa5,
  WEBRTC_SERVER: 0xa6,
  DATA_SERVER: 0xa8,
  /** Routed WebRTC messages delivered to a camera use a distinct cloud node. */
  CAMERA_WEBRTC_SERVER: 0xad,
});

export const MSGSVR_METHODS = Object.freeze({
  DIRECT: 0xb1,
  ROUTED: 0xb2,
});

export const MSGSVR_COMMANDS = Object.freeze({
  REGISTER: 0xc1,
  LAN_CONNECT: 0xc3,
  WEBRTC: 0xc6,
  STATUS: 0xc7,
  HEARTBEAT: 0xc9,
  CONNECT: 0xd1,
});

// This fixed key is shipped by the Meari protocol implementation. It is not
// an account, camera, or deployment secret.
const MSGSVR_KEY = Buffer.from([
  0x5f, 0x5f, 0x23, 0x21, 0x48, 0x49, 0x52, 0x43,
  0x6c, 0x6f, 0x75, 0x64, 0x35, 0x2e, 0x30, 0x21,
  0x23, 0x5f, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export interface MsgSvrFrameInput {
  readonly node: number;
  readonly method: number;
  readonly command: number;
  readonly type?: number;
  /** A string is treated as pre-serialized JSON. Other values are serialized. */
  readonly payload: unknown;
  readonly encrypted?: boolean;
}

export interface MsgSvrFrame {
  readonly node: number;
  readonly method: number;
  readonly command: number;
  readonly type: number;
  readonly encrypted: boolean;
  readonly payloadLength: number;
  readonly payloadText: string;
  /** Decrypted bytes, retained for the binary WebRTC relay sub-protocol. */
  readonly payloadBytes: Buffer;
  readonly payload: unknown;
  readonly checksum: number;
  readonly checksumKind: "sum" | "xor";
  readonly byteLength: number;
}

export interface MeariRouteContact {
  readonly node: string;
  readonly domain?: string;
  readonly transport?: string;
  readonly type?: string;
  readonly ip?: string;
  readonly port?: number;
  readonly [key: string]: unknown;
}

export interface MeariRoutedMessage<T = unknown> {
  readonly from: MeariRouteContact;
  readonly to: MeariRouteContact;
  readonly content: T;
  readonly tag?: number;
  readonly flag?: number;
}

export interface MeariRoutedFragmentOptions {
  /** Native XTS splits the serialized inner JSON into 1024-byte pieces. */
  readonly maximumFragmentBytes?: number;
  /** Correlates every fragment belonging to the same routed message. */
  readonly tag?: number;
  /** One-byte discriminator used when a tag is reused. */
  readonly fragmentId?: number;
}

export interface MeariRoutedFragmentInfo {
  readonly tag: number;
  readonly fragmentId: number;
  readonly index: number;
  readonly count: number;
}

export interface MeariIotSettingsRequest {
  readonly sid: string;
  readonly uuid: string;
  readonly cmd: "conf";
  readonly action: "req";
  readonly method: "settings";
  readonly params: {
    readonly code: 100001;
    readonly action: "set";
    readonly name: "iot";
    readonly iot: Readonly<Record<string, unknown>>;
  };
}

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be a byte`);
  }
}

function assertUint32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function decodeWireUint32(name: string, value: number): number {
  if (
    !Number.isInteger(value)
    || value < -0x8000_0000
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${name} must be a 32-bit integer`);
  }
  // The camera serializes JNI/C `uint32_t` fields through a signed Java int
  // on some firmware builds. Normalize either JSON representation here.
  return value >>> 0;
}

function payloadSum(payload: Uint8Array): number {
  let value = 0;
  for (const byte of payload) value = (value + byte) & 0xff;
  return value;
}

function payloadXor(payload: Uint8Array): number {
  let value = 0;
  for (const byte of payload) value ^= byte;
  return value;
}

function encryptPayload(payload: Buffer): Buffer {
  const cipher = createCipheriv("des-ede3", MSGSVR_KEY, null);
  return Buffer.concat([cipher.update(payload), cipher.final()]);
}

function decryptPayload(payload: Buffer): Buffer {
  if (payload.byteLength === 0 || payload.byteLength % 8 !== 0) {
    throw new Error("Encrypted MsgSvr payload length must be a positive multiple of 8");
  }
  const decipher = createDecipheriv("des-ede3", MSGSVR_KEY, null);
  // Native MsgSvr peers are inconsistent: app-originated frames use PKCS#5,
  // while some production server clusters append zero bytes. Decrypt without
  // OpenSSL's strict unpadding and mirror the SDK's tolerant manual removal.
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  const padding = decrypted.at(-1) ?? 0;
  if (
    padding >= 1 &&
    padding <= 8 &&
    decrypted.subarray(-padding).every((byte) => byte === padding)
  ) {
    return decrypted.subarray(0, -padding);
  }
  let end = decrypted.byteLength;
  while (end > 0 && decrypted[end - 1] === 0) end -= 1;
  return decrypted.subarray(0, end);
}

export function msgSvrFrameByteLength(header: Uint8Array): number {
  if (header.byteLength < 8) throw new Error("MsgSvr header requires 8 bytes");
  if (header[0] !== MSGSVR_MAGIC || header[5] !== MSGSVR_MAGIC) {
    throw new Error("Invalid MsgSvr magic");
  }
  const low = header[6];
  const high = header[7];
  if (low === undefined || high === undefined) throw new Error("Incomplete MsgSvr header");
  return (low | ((high & 0x7f) << 8)) + 10;
}

export function encodeMsgSvrFrame(input: MsgSvrFrameInput): Buffer {
  assertByte("node", input.node);
  assertByte("method", input.method);
  assertByte("command", input.command);
  const type = input.type ?? MSGSVR_DEFAULT_TYPE;
  assertByte("type", type);

  const payloadBytes = ArrayBuffer.isView(input.payload)
    ? Buffer.from(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength)
    : undefined;
  const payloadText = payloadBytes === undefined
    ? typeof input.payload === "string"
      ? input.payload
      : JSON.stringify(input.payload)
    : undefined;
  if (payloadBytes === undefined && payloadText === undefined) {
    throw new TypeError("MsgSvr payload is not JSON serializable");
  }
  const encrypted = input.encrypted ?? true;
  const plain = payloadBytes ?? Buffer.from(payloadText as string, "utf8");
  const payload = encrypted ? encryptPayload(plain) : plain;
  if (payload.byteLength > 0x7fff) throw new RangeError("MsgSvr payload is too large");

  const frame = Buffer.allocUnsafe(payload.byteLength + 10);
  frame[0] = MSGSVR_MAGIC;
  frame[1] = input.node;
  frame[2] = input.method;
  frame[3] = input.command;
  frame[4] = type;
  frame[5] = MSGSVR_MAGIC;
  frame[6] = payload.byteLength & 0xff;
  frame[7] = ((payload.byteLength >> 8) & 0x7f) | (encrypted ? 0x80 : 0);
  payload.copy(frame, 8);
  frame[8 + payload.byteLength] = payloadSum(payload);
  frame[9 + payload.byteLength] = MSGSVR_TAIL;
  return frame;
}

export function decodeMsgSvrFrame(bytes: Uint8Array): MsgSvrFrame {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteLength = msgSvrFrameByteLength(buffer);
  if (buffer.byteLength !== byteLength) {
    throw new Error(`MsgSvr frame length mismatch: expected ${byteLength}, received ${buffer.byteLength}`);
  }
  if (buffer[byteLength - 1] !== MSGSVR_TAIL) throw new Error("Invalid MsgSvr frame tail");

  const payloadLength = byteLength - 10;
  const rawPayload = buffer.subarray(8, 8 + payloadLength);
  const checksum = buffer[8 + payloadLength];
  if (checksum === undefined) throw new Error("MsgSvr frame omitted its checksum");
  const sum = payloadSum(rawPayload);
  const xor = payloadXor(rawPayload);
  const checksumKind = checksum === sum ? "sum" : checksum === xor ? "xor" : undefined;
  if (checksumKind === undefined) throw new Error("Invalid MsgSvr payload checksum");

  const encrypted = (buffer[7] ?? 0) >= 0x80;
  const plain = encrypted ? decryptPayload(rawPayload) : rawPayload;
  const payloadText = plain.toString("utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText) as unknown;
  } catch {
    payload = payloadText;
  }

  const node = buffer[1];
  const method = buffer[2];
  const command = buffer[3];
  const type = buffer[4];
  if (node === undefined || method === undefined || command === undefined || type === undefined) {
    throw new Error("Incomplete MsgSvr frame header");
  }
  return {
    node,
    method,
    command,
    type,
    encrypted,
    payloadLength,
    payloadText,
    payloadBytes: Buffer.from(plain),
    payload,
    checksum,
    checksumKind,
    byteLength,
  };
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function routeContact(value: unknown, name: string): MeariRouteContact {
  const contact = recordValue(value, name);
  if (typeof contact.node !== "string" || !contact.node) {
    throw new Error(`${name} omitted its node`);
  }
  return contact as MeariRouteContact;
}

function escapeBareJsonControlCharacters(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20) {
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      result += character;
    }
  }
  return result;
}

/** Parse firmware JSON while repairing only bare control bytes inside strings. */
function parseMeariRoutedJson<T>(bytes: Uint8Array): T {
  const text = Buffer.from(bytes).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    try {
      return JSON.parse(escapeBareJsonControlCharacters(text)) as T;
    } catch {
      throw new Error("Routed payload content is not complete JSON", { cause });
    }
  }
}

/** Encode the JSON-in-Base64 envelope used by MsgSvr command routing. */
export function encodeMeariRoutedPayload<T>(message: MeariRoutedMessage<T>): Record<string, unknown> {
  routeContact(message.from, "route source");
  routeContact(message.to, "route destination");
  const payload: Record<string, unknown> = {
    from: message.from,
    to: message.to,
    content: Buffer.from(JSON.stringify(message.content), "utf8").toString("base64"),
  };
  if (message.tag !== undefined) payload.tag = message.tag;
  if (message.flag !== undefined) payload.flag = message.flag;
  return payload;
}

/**
 * Encode a routed payload exactly as the native XTS client does. Messages up
 * to 1024 serialized bytes use one ordinary envelope; larger messages carry
 * a tag plus a packed fragment flag on each envelope.
 *
 * The packed flag is: fragment index, fragment count, random fragment id,
 * and the constant 0x40 marker, from most- to least-significant byte.
 */
export function encodeMeariRoutedPayloads<T>(
  message: MeariRoutedMessage<T>,
  options: MeariRoutedFragmentOptions = {},
): readonly Record<string, unknown>[] {
  routeContact(message.from, "route source");
  routeContact(message.to, "route destination");
  const maximum = options.maximumFragmentBytes ?? 1_024;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 0x7fff) {
    throw new RangeError("maximumFragmentBytes must be between 1 and 32767");
  }
  const serialized = Buffer.from(JSON.stringify(message.content), "utf8");
  if (serialized.byteLength <= maximum) return [encodeMeariRoutedPayload(message)];

  const count = Math.ceil(serialized.byteLength / maximum);
  if (count > 0xff) throw new RangeError("Routed message requires more than 255 fragments");
  const tag = options.tag ?? randomBytes(4).readUInt32LE(0);
  const fragmentId = options.fragmentId ?? randomBytes(1)[0] ?? 0;
  assertUint32("tag", tag);
  assertByte("fragmentId", fragmentId);

  const payloads: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = serialized.subarray(index * maximum, Math.min((index + 1) * maximum, serialized.byteLength));
    const flag = index * 0x100_0000 + count * 0x1_0000 + fragmentId * 0x100 + 0x40;
    payloads.push({
      from: message.from,
      to: message.to,
      tag,
      flag,
      content: chunk.toString("base64"),
    });
  }
  return payloads;
}

/** Return native fragment metadata, or undefined for an ordinary envelope. */
export function decodeMeariRoutedFragmentInfo(value: unknown): MeariRoutedFragmentInfo | undefined {
  const payload = recordValue(value, "routed payload");
  if (typeof payload.tag !== "number" || typeof payload.flag !== "number") return undefined;
  const tag = decodeWireUint32("routed payload tag", payload.tag);
  const flag = decodeWireUint32("routed payload flag", payload.flag);
  const marker = flag & 0xff;
  const fragmentId = Math.floor(flag / 0x100) & 0xff;
  const count = Math.floor(flag / 0x1_0000) & 0xff;
  const index = Math.floor(flag / 0x100_0000) & 0xff;
  if (marker !== 0x40 || count === 0) return undefined;
  if (index >= count) throw new Error("Routed payload fragment index exceeds its count");
  return { tag, fragmentId, index, count };
}

interface PendingRoutedMessage {
  readonly from: MeariRouteContact;
  readonly to: MeariRouteContact;
  readonly tag: number;
  readonly fragmentId: number;
  readonly chunks: Array<Buffer | undefined>;
  received: number;
}

/** Incrementally reconstruct native XTS routed payload fragments. */
export class MeariRoutedPayloadAssembler {
  private readonly pending = new Map<string, PendingRoutedMessage>();
  readonly maximumPendingMessages: number;

  constructor(maximumPendingMessages = 64) {
    if (!Number.isInteger(maximumPendingMessages) || maximumPendingMessages < 1) {
      throw new RangeError("maximumPendingMessages must be a positive integer");
    }
    this.maximumPendingMessages = maximumPendingMessages;
  }

  accept<T = unknown>(value: unknown): MeariRoutedMessage<T> | undefined {
    const info = decodeMeariRoutedFragmentInfo(value);
    if (!info) return decodeMeariRoutedPayload<T>(value);
    const payload = recordValue(value, "routed payload");
    if (typeof payload.content !== "string") throw new Error("Routed fragment omitted content");
    const from = routeContact(payload.from, "route source");
    const to = routeContact(payload.to, "route destination");
    const key = `${info.tag}:${info.fragmentId}`;
    let message = this.pending.get(key);
    if (!message) {
      while (this.pending.size >= this.maximumPendingMessages) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
      message = {
        from,
        to,
        tag: info.tag,
        fragmentId: info.fragmentId,
        chunks: Array.from({ length: info.count }),
        received: 0,
      };
      this.pending.set(key, message);
    } else if (message.chunks.length !== info.count) {
      this.pending.delete(key);
      throw new Error("Routed fragment count changed within one message");
    }

    if (!message.chunks[info.index]) {
      message.chunks[info.index] = Buffer.from(payload.content, "base64");
      message.received += 1;
    }
    if (message.received !== message.chunks.length) return undefined;
    this.pending.delete(key);

    const content = parseMeariRoutedJson<T>(Buffer.concat(message.chunks as Buffer[]));
    return { from: message.from, to: message.to, content, tag: message.tag };
  }

  clear(): void {
    this.pending.clear();
  }
}

/** Decode a complete (non-fragmented) JSON-in-Base64 MsgSvr routed envelope. */
export function decodeMeariRoutedPayload<T = unknown>(value: unknown): MeariRoutedMessage<T> {
  const payload = recordValue(value, "routed payload");
  if (typeof payload.content !== "string" || !payload.content) {
    throw new Error("Routed payload omitted content");
  }
  const content = parseMeariRoutedJson<T>(Buffer.from(payload.content, "base64"));
  return {
    from: routeContact(payload.from, "route source"),
    to: routeContact(payload.to, "route destination"),
    content,
    ...(typeof payload.tag === "number" ? { tag: payload.tag } : {}),
    ...(typeof payload.flag === "number" ? { flag: payload.flag } : {}),
  };
}

/** Build CloudEdge's native `conf/settings` request for one or more IoT values. */
export function buildMeariIotSettingsRequest(
  deviceUuid: string,
  iot: Readonly<Record<string, unknown>>,
  sid = String(Math.floor(Date.now() / 1_000)),
): MeariIotSettingsRequest {
  if (!deviceUuid.trim()) throw new TypeError("deviceUuid is required");
  if (!sid.trim()) throw new TypeError("sid is required");
  if (Object.keys(iot).length === 0) throw new TypeError("At least one IoT value is required");
  return {
    sid,
    uuid: deviceUuid,
    cmd: "conf",
    action: "req",
    method: "settings",
    params: {
      code: 100001,
      action: "set",
      name: "iot",
      iot,
    },
  };
}

/**
 * Build the plaintext LAN punch sent to a camera's negotiated host candidate.
 * The eight random hexadecimal characters are followed by the native channel
 * suffix, yielding the 16-character session identifier expected by firmware.
 */
export function encodeMeariLanConnectFrame(sessionPrefix: string): Buffer {
  if (!/^[0-9a-f]{8}$/u.test(sessionPrefix)) {
    throw new TypeError("sessionPrefix must be eight lowercase hexadecimal characters");
  }
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.APP,
    method: MSGSVR_METHODS.ROUTED,
    command: MSGSVR_COMMANDS.LAN_CONNECT,
    type: 0xd1,
    payload: { sid: `${sessionPrefix}00000001` },
    encrypted: false,
  });
}

/** Extract all complete MsgSvr frames while retaining an incomplete tail. */
export function splitMsgSvrFrames(bytes: Uint8Array): {
  readonly frames: readonly Buffer[];
  readonly remainder: Buffer;
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Buffer[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 8) {
    const candidate = buffer.subarray(offset);
    const byteLength = msgSvrFrameByteLength(candidate);
    if (candidate.byteLength < byteLength) break;
    frames.push(Buffer.from(candidate.subarray(0, byteLength)));
    offset += byteLength;
  }
  return { frames, remainder: Buffer.from(buffer.subarray(offset)) };
}
