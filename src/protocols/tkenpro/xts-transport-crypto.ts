import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * XTS transport-layer payload cipher for Meari factory-10 P2P streams.
 *
 * The native `libmrplayer.so` transport (`iva_transport.cpp` `FUN_00337598` →
 * `iva_transport_xts.cpp` → `xts.cpp`) encrypts the payload region of every
 * outbound media stream frame before it is written to the KCP/XTS transport,
 * and decrypts the same region on receive. The transform recovered from
 * `FUN_00340e78` is:
 *
 *   - key = the session key string, copied to exactly 24 bytes (truncated at 24,
 *     zero-padded if shorter);
 *   - the 24 bytes are split into three 8-byte DES keys and run as 3DES-EDE
 *     (`FUN_00378d04` is the standard DES key schedule, called three times;
 *     `FUN_003412b0` runs one 8-byte block through the three keys in series);
 *   - no chaining between blocks (ECB), no IV;
 *   - only whole 8-byte blocks are transformed: `(len >> 3) << 3` bytes. Any
 *     trailing `len & 7` bytes are left untouched.
 *
 * The region that is transformed starts at a per-frame-type offset inside the
 * XTS message (see {@link xtsTransportPayloadOffset}). For factory-10 mu-law
 * talkback that offset is 40, i.e. everything from the encoded-length descriptor
 * onward, including the audio samples.
 */

export const XTS_TRANSPORT_BLOCK_SIZE = 8;

/** Number of leading bytes left in clear before the encrypted region, keyed by
 * the XTS media type byte at message offset 3. Derived from the native
 * `FUN_00337598` branches: audio/info use a 0x28 (40) offset, key video and
 * photo use 0x30 (48), delta video uses 0x28 (40). */
export function xtsTransportPayloadOffset(mediaType: number): number {
  switch (mediaType) {
    case 0xfc: // key video
    case 0xfe: // photo
      return 0x30;
    case 0xf9: // stream info
    case 0xfa: // audio
    case 0xfd: // delta video
      return 0x28;
    default:
      return 0x28;
  }
}

/**
 * The XTS media/talkback payload key is the fixed string `!mearicloud2.0!`,
 * zero-padded to 24 bytes — a shared constant, not a per-device or per-session
 * secret. With this key the reference encrypted region decrypts to the
 * zero field, the little-endian sample count, and μ-law silence (0xFF from the
 * phone, 0x7E from the camera), and `ENC(00×8)` reproduces the on-wire block
 * `b3a2d90a7270bf3e`. Credit: the Ha-CloudPlus-Meari Home Assistant
 * integration (`p2p_streamer/protocol.py` STREAM_ENCRYPT_KEY) uses the same
 * key to decrypt camera video/audio when E2EE is enabled.
 *
 * Note: the Android `libmrplayer.so` derives a *different* key
 * (`0465c5f5…7f661710`) from `/zIe1M9O0VLnJ9KXEJljAg==` via a static KDF for
 * its own transport context; that key does NOT match what the Pet 3T accepts
 * on the wire. Do not "fix" this back to the KDF value.
 */
export const XTS_TRANSPORT_KEY = "!mearicloud2.0!";

/**
 * Resolve the 24-byte-string XTS transport key. Defaults to the recovered SDK
 * constant {@link XTS_TRANSPORT_KEY}; `HOMETRUTH_XTS_TRANSPORT_KEY` overrides it
 * with a literal value (used only for diagnostics/verification).
 */
export function resolveXtsTransportKeySource(): string {
  const override = process.env.HOMETRUTH_XTS_TRANSPORT_KEY?.trim();
  return override && override.length > 0 ? override : XTS_TRANSPORT_KEY;
}

/** Copy a session key string into exactly 24 bytes (truncate/zero-pad), matching
 * the native `__memcpy_chk(&key, src, min(strlen,0x18), 0x18)` + zero fill. */
export function deriveXtsTransportKey(sessionKey: string | Uint8Array): Buffer {
  const source = typeof sessionKey === "string"
    ? Buffer.from(sessionKey, "utf8")
    : Buffer.from(sessionKey.buffer, sessionKey.byteOffset, sessionKey.byteLength);
  const key = Buffer.alloc(24);
  source.copy(key, 0, 0, Math.min(source.byteLength, 24));
  return key;
}

function transformBlocks(key: Buffer, region: Buffer, encrypt: boolean): Buffer {
  if (key.byteLength !== 24) throw new RangeError("XTS transport key must be 24 bytes");
  const blockBytes = Math.floor(region.byteLength / XTS_TRANSPORT_BLOCK_SIZE) * XTS_TRANSPORT_BLOCK_SIZE;
  if (blockBytes === 0) return Buffer.from(region);
  const cipher = encrypt
    ? createCipheriv("des-ede3", key, null)
    : createDecipheriv("des-ede3", key, null);
  cipher.setAutoPadding(false);
  const head = Buffer.concat([cipher.update(region.subarray(0, blockBytes)), cipher.final()]);
  const tail = region.subarray(blockBytes);
  return tail.byteLength === 0 ? head : Buffer.concat([head, tail]);
}

/** Encrypt the transport payload region of one complete XTS media message in
 * place-safe fashion, returning a new buffer. The message header before
 * {@link xtsTransportPayloadOffset} is copied unchanged. */
export function encryptXtsTransportMessage(message: Uint8Array, key: Buffer): Buffer {
  const buffer = Buffer.from(message);
  if (buffer.byteLength < 4) return buffer;
  const offset = xtsTransportPayloadOffset(buffer[3] as number);
  if (buffer.byteLength <= offset) return buffer;
  const region = transformBlocks(key, buffer.subarray(offset), true);
  region.copy(buffer, offset);
  return buffer;
}

/** Inverse of {@link encryptXtsTransportMessage} for incoming frames/diagnostics. */
export function decryptXtsTransportMessage(message: Uint8Array, key: Buffer): Buffer {
  const buffer = Buffer.from(message);
  if (buffer.byteLength < 4) return buffer;
  const offset = xtsTransportPayloadOffset(buffer[3] as number);
  if (buffer.byteLength <= offset) return buffer;
  const region = transformBlocks(key, buffer.subarray(offset), false);
  region.copy(buffer, offset);
  return buffer;
}

/** Low-level helpers for direct region transforms and tests. */
export function encryptXtsTransportRegion(region: Uint8Array, key: Buffer): Buffer {
  return transformBlocks(key, Buffer.from(region), true);
}

export function decryptXtsTransportRegion(region: Uint8Array, key: Buffer): Buffer {
  return transformBlocks(key, Buffer.from(region), false);
}
