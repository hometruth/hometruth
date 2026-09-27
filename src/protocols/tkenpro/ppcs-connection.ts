import {
  decodePpcsHostProtectedPayload,
  encodePpcsHostProtectedPayload,
  encodePpcsOuterPacket,
} from "./ppcs-protection.ts";

/** Native connection-worker message kinds recovered from libmrplayer.so. */
export type PpcsConnectionMessageKind = 0x20 | 0x53 | 0x54 | 0x56 | 0x67 | 0x6a | 0x80;

export interface PpcsConnectionTarget {
  /** Native builders reserve seven bytes plus a zero terminator. */
  readonly prefix: string;
  readonly serialNumber: number;
  /** Native builders reserve seven bytes plus a zero terminator. */
  readonly checkCode: string;
}

export interface PpcsConnectionMessageBase extends PpcsConnectionTarget {
  readonly kind: PpcsConnectionMessageKind;
}

export interface PpcsConnectionMessage20 extends PpcsConnectionMessageBase {
  readonly kind: 0x20;
  /** Native builder copies four bytes at offset 24; the remaining tail is zero. */
  readonly routeBytes?: Uint8Array;
}

export interface PpcsConnectionMessage53 extends PpcsConnectionMessageBase {
  readonly kind: 0x53;
  /** Native endpoint structure, byte-swapped by the native helper. */
  readonly endpointData: Uint8Array;
  /** Five bytes assembled from the native mode/endpoint flags. */
  readonly modeData: Uint8Array;
}

export interface PpcsConnectionMessage54 extends PpcsConnectionMessageBase {
  readonly kind: 0x54;
  readonly endpointData: Uint8Array;
  /** Native relay/server field is copied into a 23-byte slot. */
  readonly server?: string;
}

export interface PpcsConnectionMessage56 extends PpcsConnectionMessageBase {
  readonly kind: 0x56;
  readonly endpointData: Uint8Array;
  /** Sixteen bytes copied from the alternate endpoint/session structure. */
  readonly sessionData?: Uint8Array;
}

export interface PpcsConnectionMessage67 extends PpcsConnectionMessageBase {
  readonly kind: 0x67;
}

export interface PpcsConnectionMessage6a extends PpcsConnectionMessageBase {
  readonly kind: 0x6a;
  readonly server?: string;
}

export interface PpcsConnectionMessage80 extends PpcsConnectionMessageBase {
  readonly kind: 0x80;
  /** Native builder consumes the first sixteen bytes at offset 24. */
  readonly routeData?: Uint8Array;
  readonly port?: number;
}

export type PpcsConnectionMessage =
  | PpcsConnectionMessage20
  | PpcsConnectionMessage53
  | PpcsConnectionMessage54
  | PpcsConnectionMessage56
  | PpcsConnectionMessage67
  | PpcsConnectionMessage6a
  | PpcsConnectionMessage80;

export type PpcsConnectionProtection =
  | { readonly mode?: "raw" }
  | { readonly mode: "host-key"; readonly hostKey: string }
  | { readonly mode: "outer"; readonly hostKey: string; readonly randomKey?: Uint8Array };

export interface ParsedPpcsConnectionMessage {
  readonly kind: PpcsConnectionMessageKind;
  readonly declaredLength: number;
  readonly byteLength: number;
  readonly prefix: string;
  readonly serialNumber: number;
  readonly checkCode: string;
  readonly payload: Buffer;
}

const CONNECTION_HEADER_SIZE = 4;
// Prefix slot (8) + serial (4) + check-code slot (8). The native packet
// begins this block at offset four, so the common fields end at offset 24.
const TARGET_BLOCK_SIZE = 20;
const ENDPOINT_DATA_SIZE = 24;
const ASCII_SLOT_SIZE = 8;

function bytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function textSlot(name: string, value: string): Buffer {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "ascii") !== normalized.length) {
    throw new TypeError(`${name} must be non-empty ASCII`);
  }
  if (normalized.length >= ASCII_SLOT_SIZE) {
    throw new RangeError(`${name} must not exceed seven characters`);
  }
  const slot = Buffer.alloc(ASCII_SLOT_SIZE);
  slot.write(normalized, 0, "ascii");
  return slot;
}

function uint(name: string, value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
  return value;
}

function targetBlock(input: PpcsConnectionTarget): Buffer {
  const block = Buffer.alloc(TARGET_BLOCK_SIZE);
  textSlot("prefix", input.prefix).copy(block, 0);
  block.writeUInt32BE(uint("serialNumber", input.serialNumber, 0xffff_ffff), 8);
  textSlot("checkCode", input.checkCode).copy(block, 12);
  return block;
}

function fixedBytes(name: string, value: Uint8Array | undefined, length: number): Buffer {
  const result = value === undefined ? Buffer.alloc(length) : bytes(value);
  if (result.byteLength !== length) throw new RangeError(`${name} must contain ${length} bytes`);
  return result;
}

function serverSlot(value: string | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(24);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "ascii") !== normalized.length) {
    throw new TypeError("server must be ASCII");
  }
  if (normalized.length > 23) throw new RangeError("server must not exceed 23 characters");
  const result = Buffer.alloc(24);
  result.write(normalized, 0, "ascii");
  return result;
}

function header(kind: PpcsConnectionMessageKind, totalLength: number): Buffer {
  const result = Buffer.alloc(totalLength);
  result[0] = 0xf1;
  result[1] = kind;
  result.writeUInt16BE(totalLength - CONNECTION_HEADER_SIZE, 2);
  return result;
}

/** Encode a native f1 connection-worker message without sending it. */
export function encodePpcsConnectionMessage(input: PpcsConnectionMessage): Buffer {
  const target = targetBlock(input);
  switch (input.kind) {
    case 0x67: {
      const result = header(input.kind, 24);
      target.copy(result, 4);
      return result;
    }
    case 0x20: {
      const result = header(input.kind, 40);
      target.copy(result, 4);
      fixedBytes("routeBytes", input.routeBytes, 4).copy(result, 24);
      return result;
    }
    case 0x6a: {
      const result = header(input.kind, 48);
      target.copy(result, 4);
      serverSlot(input.server).copy(result, 24);
      return result;
    }
    case 0x80: {
      const result = header(input.kind, 44);
      target.copy(result, 4);
      fixedBytes("routeData", input.routeData, 16).copy(result, 24);
      result.writeUInt32BE(uint("port", input.port ?? 0, 0xffff_ffff), 40);
      return result;
    }
    case 0x53: {
      const result = header(input.kind, 56);
      target.copy(result, 4);
      fixedBytes("endpointData", input.endpointData, ENDPOINT_DATA_SIZE).copy(result, 24);
      fixedBytes("modeData", input.modeData, 5).copy(result, 48);
      return result;
    }
    case 0x54: {
      const result = header(input.kind, 80);
      target.copy(result, 4);
      fixedBytes("endpointData", input.endpointData, ENDPOINT_DATA_SIZE).copy(result, 24);
      serverSlot(input.server).copy(result, 56);
      return result;
    }
    case 0x56: {
      const result = header(input.kind, 72);
      target.copy(result, 4);
      fixedBytes("endpointData", input.endpointData, ENDPOINT_DATA_SIZE).copy(result, 24);
      fixedBytes("sessionData", input.sessionData, 16).copy(result, 56);
      return result;
    }
  }
}

/**
 * Apply the protection selected by the native call site. This function only
 * transforms bytes; it does not open a socket or attempt a camera connection.
 */
export function protectPpcsConnectionMessage(
  message: Uint8Array,
  protection: PpcsConnectionProtection = {},
): Buffer {
  if (protection.mode === undefined || protection.mode === "raw") {
    return Buffer.from(message);
  }
  if (protection.mode === "host-key") {
    return encodePpcsHostProtectedPayload(message, protection.hostKey);
  }
  if (protection.mode !== "outer") throw new Error("Unknown PPCS connection protection mode");
  return encodePpcsOuterPacket({
    hostKey: protection.hostKey,
    payload: message,
    ...(protection.randomKey === undefined ? {} : { randomKey: protection.randomKey }),
  });
}

/** Reverse the one-pass protection used by the short native probe messages. */
export function unprotectPpcsConnectionMessage(message: Uint8Array, hostKey: string): Buffer {
  return decodePpcsHostProtectedPayload(message, hostKey);
}

function readAsciiSlot(bytesValue: Buffer, offset: number): string {
  const end = bytesValue.indexOf(0, offset);
  const limit = end < 0 ? offset + ASCII_SLOT_SIZE : end;
  return bytesValue.subarray(offset, limit).toString("ascii");
}

/** Parse only the common, non-secret fields of one clear f1 message. */
export function decodePpcsConnectionMessage(message: Uint8Array): ParsedPpcsConnectionMessage {
  const input = bytes(message);
  if (input.byteLength < CONNECTION_HEADER_SIZE) throw new Error("Truncated PPCS connection message");
  if (input[0] !== 0xf1) throw new Error("Invalid PPCS connection message marker");
  const kind = input[1] as PpcsConnectionMessageKind;
  if (![0x20, 0x53, 0x54, 0x56, 0x67, 0x6a, 0x80].includes(kind)) {
    throw new Error(`Unknown PPCS connection message kind: 0x${kind.toString(16)}`);
  }
  const declaredLength = input.readUInt16BE(2);
  const byteLength = declaredLength + CONNECTION_HEADER_SIZE;
  if (byteLength !== input.byteLength) {
    throw new Error(`PPCS connection message length mismatch: expected ${byteLength}, received ${input.byteLength}`);
  }
  if (input.byteLength < 24) throw new Error("PPCS connection message omits target fields");
  return {
    kind,
    declaredLength,
    byteLength,
    prefix: readAsciiSlot(input, 4),
    serialNumber: input.readUInt32BE(12),
    checkCode: readAsciiSlot(input, 16),
    payload: Buffer.from(input),
  };
}
