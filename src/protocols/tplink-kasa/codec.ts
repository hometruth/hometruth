/**
 * The legacy TP-Link Kasa local protocol (TCP port 9999, no authentication):
 * each message is a 4-byte big-endian length followed by the JSON body
 * scrambled with the "autokey" XOR cipher, initial key 171. Each output byte
 * of the cipher becomes the key for the next one.
 */

export const KASA_PORT = 9999;
export const KASA_INITIAL_KEY = 171;
/** Largest response body accepted; a six-outlet strip's sysinfo is about 2 KB. */
export const KASA_MAX_RESPONSE_BYTES = 64 * 1024;

export class KasaError extends Error {
  constructor(message: string, readonly code: "unreachable" | "protocol" | "device_error") {
    super(message);
    this.name = "KasaError";
  }
}

/** XOR-autokey encrypt: each ciphertext byte is the key for the next. */
export function kasaEncrypt(plain: Uint8Array): Uint8Array {
  const out = new Uint8Array(plain.length);
  let key = KASA_INITIAL_KEY;
  for (let index = 0; index < plain.length; index++) {
    key ^= plain[index]!;
    out[index] = key;
  }
  return out;
}

/** XOR-autokey decrypt: each ciphertext byte is the key for the next. */
export function kasaDecrypt(cipher: Uint8Array): Uint8Array {
  const out = new Uint8Array(cipher.length);
  let key = KASA_INITIAL_KEY;
  for (let index = 0; index < cipher.length; index++) {
    const byte = cipher[index]!;
    out[index] = key ^ byte;
    key = byte;
  }
  return out;
}

/** One framed request: length prefix plus the encrypted JSON. */
export function encodeKasaFrame(message: unknown): Uint8Array {
  const body = kasaEncrypt(new TextEncoder().encode(JSON.stringify(message)));
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

/**
 * How many bytes a complete frame starting at `buffer[0]` occupies, or
 * `undefined` while the length prefix itself has not fully arrived.
 */
export function kasaFrameLength(buffer: Uint8Array): number | undefined {
  if (buffer.length < 4) return undefined;
  const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
  if (length > KASA_MAX_RESPONSE_BYTES) throw new KasaError(`Kasa response of ${length} bytes is too large`, "protocol");
  return 4 + length;
}

/** Decode one complete framed response into its JSON object. */
export function decodeKasaFrame(frame: Uint8Array): Record<string, unknown> {
  const total = kasaFrameLength(frame);
  if (total === undefined || frame.length !== total) throw new KasaError("Kasa response frame is truncated or has trailing bytes", "protocol");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let body: unknown;
  try { body = JSON.parse(text.decode(kasaDecrypt(frame.subarray(4)))); }
  catch { throw new KasaError("Kasa response is not valid JSON", "protocol"); }
  if (!isRecord(body)) throw new KasaError("Kasa response is not a JSON object", "protocol");
  return body;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
