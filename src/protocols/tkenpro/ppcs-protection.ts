import { randomBytes } from "node:crypto";

/** Native PPCS outer packet marker. */
export const PPCS_OUTER_MARKER = 0x68;
export const PPCS_OUTER_HEADER_SIZE = 8;
export const PPCS_KEY_BYTES = 0x14;

// DAT_0017132c from libmrplayer.so. This is a protocol constant, not a device
// credential. The native code uses it as a byte lookup table for its small
// stateful transform.
const PPCS_LOOKUP = Uint8Array.from(Buffer.from(
  "7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a388ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af4237d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17",
  "hex",
));

export interface PpcsOuterPacketInput {
  readonly hostKey: string;
  readonly payload: Uint8Array;
  /** Two random bytes used by the native second transform. */
  readonly randomKey?: Uint8Array;
}

export interface ParsedPpcsOuterPacket {
  readonly declaredLength: number;
  readonly randomKey: Buffer;
  readonly checksum: Buffer;
  readonly encryptedPayload: Buffer;
  readonly payload: Buffer;
  readonly byteLength: number;
}

function keyBytes(key: string): Buffer {
  return Buffer.from(key, "utf8").subarray(0, PPCS_KEY_BYTES);
}

function seedForKey(key: string): Uint8Array {
  let sum = 0;
  let third = 0;
  let difference = 0;
  let xor = 0;
  for (const byte of keyBytes(key)) {
    sum = (sum + byte) & 0xff;
    third = (third + Math.floor(byte / 3)) & 0xff;
    difference = (difference - byte) & 0xff;
    xor ^= byte;
  }
  // The native routine stores the three trailing accumulators through a
  // little-endian 3-byte stack slot (`CONCAT12(xor, CONCAT11(third,
  // difference))`).  Consequently the byte order consumed by the lookup is
  // sum, difference, third, xor.
  return Uint8Array.from([sum, difference, third, xor]);
}

function transformForward(payload: Uint8Array, key: string): Buffer {
  const input = Buffer.from(payload);
  if (key.length === 0 || input.byteLength === 0) return Buffer.from(input);
  const seed = seedForKey(key);
  const output = Buffer.allocUnsafe(input.byteLength);
  output[0] = PPCS_LOOKUP[seed[0] as number]! ^ (input[0] as number);
  for (let index = 1; index < input.byteLength; index += 1) {
    const previousPlain = input[index - 1] as number;
    const lookupIndex = ((seed[previousPlain & 3] as number) + previousPlain) & 0xff;
    output[index] = PPCS_LOOKUP[lookupIndex]! ^ (input[index] as number);
  }
  return output;
}

function transformReverse(payload: Uint8Array, key: string): Buffer {
  const input = Buffer.from(payload);
  if (key.length === 0 || input.byteLength === 0) return Buffer.from(input);
  const seed = seedForKey(key);
  const output = Buffer.allocUnsafe(input.byteLength);
  output[0] = PPCS_LOOKUP[seed[0] as number]! ^ (input[0] as number);
  for (let index = 1; index < input.byteLength; index += 1) {
    // The native stream is chained from the already recovered plaintext:
    // c[i] = p[i] XOR table(seed[p[i-1] & 3] + p[i-1]).
    const previousPlain = output[index - 1] as number;
    const lookupIndex = ((seed[previousPlain & 3] as number) + previousPlain) & 0xff;
    output[index] = PPCS_LOOKUP[lookupIndex]! ^ (input[index] as number);
  }
  return output;
}

/**
 * Apply the single native host-key transform used by PPCS connection probes.
 * This is intentionally separate from the eight-byte outer wrapper: native
 * connection helpers call the former directly, while channel data normally
 * uses the latter.
 */
export function encodePpcsHostProtectedPayload(payload: Uint8Array, hostKey: string): Buffer {
  return transformForward(payload, hostKey);
}

/** Reverse the single native host-key transform used by connection probes. */
export function decodePpcsHostProtectedPayload(payload: Uint8Array, hostKey: string): Buffer {
  return transformReverse(payload, hostKey);
}

/** Native cfa0 checksum pair used in the outer header. */
export function ppcsChecksum(payload: Uint8Array): Buffer {
  const input = Buffer.from(payload);
  let left = 0x53;
  let right = 0x43;
  let first = 0x43;
  let second = 0x53;
  for (let index = 0; index < input.byteLength; index += 1) {
    const mixed = right ^ (input[index] as number);
    right = mixed ^ left;
    first = right;
    if ((index & 1) === 0) {
      left = (input[input.byteLength - index - 1] as number) ^ mixed;
      second = left;
    }
  }
  return Buffer.from([input.byteLength === 0 ? 0x43 : first, input.byteLength === 0 ? 0x53 : second]);
}

function randomKey(value: Uint8Array | undefined): Buffer {
  const key = value === undefined ? randomBytes(2) : Buffer.from(value);
  if (key.byteLength !== 2) throw new RangeError("PPCS random key must contain two bytes");
  return key;
}

function randomKeyText(value: Uint8Array): string {
  return `${(value[0] as number).toString(16).padStart(2, "0").toUpperCase()}${
    (value[1] as number).toString(16).padStart(2, "0").toUpperCase()
  }`;
}

/** Encode the native length/'h'/random/checksum protected packet. */
export function encodePpcsOuterPacket(input: PpcsOuterPacketInput): Buffer {
  const plain = Buffer.from(input.payload);
  if (plain.byteLength > 0xffff) throw new RangeError("PPCS outer payload is too large");
  const random = randomKey(input.randomKey);
  const first = transformForward(plain, input.hostKey);
  const encrypted = transformForward(first, randomKeyText(random));
  const packet = Buffer.allocUnsafe(PPCS_OUTER_HEADER_SIZE + encrypted.byteLength);
  packet.writeUInt16BE(encrypted.byteLength, 0);
  packet.writeUInt8(PPCS_OUTER_MARKER, 2);
  packet.writeUInt8(0, 3);
  random.copy(packet, 4);
  ppcsChecksum(encrypted).copy(packet, 6);
  encrypted.copy(packet, PPCS_OUTER_HEADER_SIZE);
  return packet;
}

/** Decode and reverse the native outer packet transform. */
export function decodePpcsOuterPacket(bytes: Uint8Array, hostKey: string): ParsedPpcsOuterPacket {
  const packet = Buffer.from(bytes);
  if (packet.byteLength < PPCS_OUTER_HEADER_SIZE) throw new Error("Truncated PPCS outer packet");
  if (packet[2] !== PPCS_OUTER_MARKER) throw new Error("Invalid PPCS outer packet marker");
  const declaredLength = packet.readUInt16BE(0);
  const byteLength = PPCS_OUTER_HEADER_SIZE + declaredLength;
  if (packet.byteLength !== byteLength) {
    throw new Error(`PPCS outer packet length mismatch: expected ${byteLength}, received ${packet.byteLength}`);
  }
  const random = Buffer.from(packet.subarray(4, 6));
  const checksum = Buffer.from(packet.subarray(6, 8));
  const encryptedPayload = Buffer.from(packet.subarray(PPCS_OUTER_HEADER_SIZE));
  if (!ppcsChecksum(encryptedPayload).equals(checksum)) {
    throw new Error("PPCS outer packet checksum mismatch");
  }
  const first = transformReverse(encryptedPayload, randomKeyText(random));
  const payload = transformReverse(first, hostKey);
  return { declaredLength, randomKey: random, checksum, encryptedPayload, payload, byteLength };
}
