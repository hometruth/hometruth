import { createDecipheriv, createHash } from "node:crypto";

export type MeariVideoCodec = "h264" | "h265";

export interface MeariMediaDecryptOptions {
  readonly encryptionVersion: number;
  /** 32 printable bytes returned by CloudEdge's getVideoDecKey(). */
  readonly derivedKey: string | Uint8Array;
  readonly codec: MeariVideoCodec;
  readonly picture?: boolean;
}

function assertDerivationVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 0x7fff_ffff) {
    throw new RangeError("Meari media key version must be a non-negative 32-bit integer");
  }
}

function assertSupportedEncryptionVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > 4) {
    throw new RangeError("Meari media encryption version must be between 0 and 4");
  }
}

function asKey(bytes: string | Uint8Array): Buffer {
  const key = typeof bytes === "string"
    ? Buffer.from(bytes, "utf8")
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (key.byteLength !== 32) {
    throw new RangeError("Meari's derived media key must be exactly 32 bytes");
  }
  return key;
}

/** Exact getVideoDecKey() derivation from CloudEdge's bundled libmrav. */
export function deriveMeariVideoKey(rawKey: string, encryptionVersion: number): string {
  if (!rawKey) throw new TypeError("Meari's raw media key is required");
  assertDerivationVersion(encryptionVersion);
  const material = encryptionVersion <= 3
    ? `${rawKey}|${Buffer.byteLength(rawKey, "utf8")}|meari.stream`
    : `${rawKey}|${Buffer.byteLength(rawKey, "utf8")}|meari.stream|${encryptionVersion}`;
  return createHash("md5").update(material, "utf8").digest("hex");
}

interface AnnexBNal {
  readonly start: number;
  readonly header: number;
}

function findAnnexBNal(bytes: Uint8Array, from: number, limit: number): AnnexBNal | undefined {
  const end = Math.min(bytes.byteLength, limit);
  for (let index = from; index + 3 < end; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0) continue;
    if (bytes[index + 2] === 1) return { start: index, header: index + 3 };
    if (bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      return { start: index, header: index + 4 };
    }
  }
  return undefined;
}

function h264EncryptionOffset(bytes: Uint8Array, limit: number): number | undefined {
  let cursor = 0;
  while (cursor + 4 < limit) {
    const nal = findAnnexBNal(bytes, cursor, limit);
    if (!nal || nal.header >= limit) return undefined;
    const type = (bytes[nal.header] as number) & 0x1f;
    if (type === 1 || type === 5) return nal.header;
    cursor = Math.max(nal.header + 1, findAnnexBNal(bytes, nal.header + 1, limit)?.start ?? limit);
  }
  return undefined;
}

function h265EncryptionOffset(bytes: Uint8Array, limit: number): number | undefined {
  let cursor = 0;
  while (cursor + 4 < limit) {
    const nal = findAnnexBNal(bytes, cursor, limit);
    if (!nal || nal.header >= limit) return undefined;
    const type = ((bytes[nal.header] as number) >> 1) & 0x3f;
    if (type < 10 || (type >= 16 && type <= 21)) return nal.header;
    cursor = Math.max(nal.header + 1, findAnnexBNal(bytes, nal.header + 1, limit)?.start ?? limit);
  }
  return undefined;
}

/**
 * Locate the first VCL NAL exactly as CloudEdge does before decrypting video.
 * Parameter-set and SEI NALs remain clear so a decoder can initialize first.
 */
export function findMeariVideoEncryptionOffset(
  codec: MeariVideoCodec,
  payload: Uint8Array,
): number | undefined {
  const searchLength = payload.byteLength < 2_501
    ? payload.byteLength - 100
    : 2_048;
  if (searchLength < 5) return undefined;
  return codec === "h264"
    ? h264EncryptionOffset(payload, searchLength)
    : h265EncryptionOffset(payload, searchLength);
}

function xorRange(target: Buffer, offset: number, length: number, key: Buffer): void {
  for (let index = 0; index < length; index += 1) {
    target[offset + index] = (target[offset + index] as number) ^ (key[index % key.byteLength] as number);
  }
}

function aesCtrRange(target: Buffer, offset: number, length: number, keyInfo: Buffer): void {
  const decipher = createDecipheriv(
    "aes-128-ctr",
    keyInfo.subarray(0, 16),
    keyInfo.subarray(16, 32),
  );
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(target.subarray(offset, offset + length)),
    decipher.final(),
  ]);
  decrypted.copy(target, offset);
}

/**
 * Decrypt a single encoded media payload without mutating the caller's bytes.
 * Versions 0-3 use CloudEdge's repeating-key XOR; version 4 uses AES-128-CTR.
 */
export function decryptMeariMediaPayload(
  payload: Uint8Array,
  options: MeariMediaDecryptOptions,
): Buffer {
  assertSupportedEncryptionVersion(options.encryptionVersion);
  const key = asKey(options.derivedKey);
  const output = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const result = Buffer.from(output);

  if (options.picture === true) {
    const length = Math.min(result.byteLength, 1_024);
    if (options.encryptionVersion === 4) aesCtrRange(result, 0, length, key);
    else xorRange(result, 0, length, key);
    return result;
  }

  const nalOffset = findMeariVideoEncryptionOffset(options.codec, result);
  if (nalOffset === undefined) {
    throw new Error(`Meari ${options.codec.toUpperCase()} payload has no VCL Annex-B NAL`);
  }
  const encryptedOffset = nalOffset + 64;
  const encryptedLength = 64;
  if (encryptedOffset + encryptedLength > result.byteLength) {
    throw new Error("Meari video payload is too short for its encrypted span");
  }
  if (options.encryptionVersion === 4) {
    aesCtrRange(result, encryptedOffset, encryptedLength, key);
  } else {
    xorRange(result, encryptedOffset, encryptedLength, key);
  }
  return result;
}
