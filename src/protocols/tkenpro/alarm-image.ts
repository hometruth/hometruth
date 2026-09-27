/**
 * Alarm thumbnails that a Pet 3T uploads to Alibaba OSS are ordinary baseline
 * JPEGs whose first 1024 bytes have been XORed with the camera's 32-byte
 * picture key. Everything past that offset is left in the clear, which is why
 * an intercepted upload still ends with a plaintext `ff d9` and why the tail of
 * the file already looks like well-formed Huffman scan data.
 *
 * This is the same construction that `media-crypto.ts` implements for the
 * `picture` case of CloudEdge's stream decryptor: a repeating-key XOR over a
 * fixed-size prefix rather than a whole-file cipher. The camera reuses it for
 * the alarm snapshot it posts over plain HTTP, so recovering the image needs
 * nothing more than the key and a bounded XOR.
 *
 * The prefix boundary is 1024 bytes, independent of the JPEG header length.
 * Preserve bytes beyond that boundary when encoding or decoding a fixture.
 *
 * The key is provisioned per camera and is not derived from the media id, the
 * device uuid, the account id or the `!mearicloud2.0!` talkback constant; each
 * camera's key has to be learned and stored alongside its other secrets.
 */

/** Bytes at the head of an uploaded thumbnail that carry the XOR. */
export const ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE = 1_024;

/** Length of a camera's picture key, as 32 printable hex characters. */
export const ALARM_IMAGE_KEY_SIZE = 32;

const JPEG_SOI = 0xff_d8;
const JPEG_EOI = 0xff_d9;

function asKey(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  if (bytes.byteLength !== ALARM_IMAGE_KEY_SIZE) {
    throw new RangeError("A TKENPRO alarm picture key must be exactly 32 bytes");
  }
  return bytes;
}

function startsWithMarker(bytes: Uint8Array, marker: number): boolean {
  return bytes.byteLength >= 2
    && ((bytes[0] as number) << 8 | (bytes[1] as number)) === marker;
}

function endsWithMarker(bytes: Uint8Array, marker: number): boolean {
  const end = bytes.byteLength;
  return end >= 2
    && ((bytes[end - 2] as number) << 8 | (bytes[end - 1] as number)) === marker;
}

/**
 * True when the bytes look like an upload this module can decode: long enough
 * to carry the encrypted prefix, not already a plain JPEG, and still carrying
 * the clear end-of-image marker that the camera leaves untouched.
 */
export function isEncodedAlarmThumbnail(bytes: Uint8Array): boolean {
  return bytes.byteLength > ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE
    && !startsWithMarker(bytes, JPEG_SOI)
    && endsWithMarker(bytes, JPEG_EOI);
}

/**
 * Recover the JPEG behind an intercepted alarm upload, returning undefined when
 * the bytes are not in the expected form or the key does not produce an image.
 * The caller's buffer is never mutated.
 */
export function decodeAlarmThumbnail(
  bytes: Uint8Array,
  key: string | Uint8Array,
): Uint8Array | undefined {
  if (!isEncodedAlarmThumbnail(bytes)) return undefined;
  const picture = asKey(key);
  const decoded = Uint8Array.from(bytes);
  for (let index = 0; index < ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE; index += 1) {
    decoded[index] = (decoded[index] as number)
      ^ (picture[index % ALARM_IMAGE_KEY_SIZE] as number);
  }
  return startsWithMarker(decoded, JPEG_SOI) ? decoded : undefined;
}

/**
 * Re-apply the camera's obfuscation, which is useful for building fixtures and
 * for replaying a thumbnail back through the capture path. The transform is its
 * own inverse over the encrypted prefix.
 */
export function encodeAlarmThumbnail(
  bytes: Uint8Array,
  key: string | Uint8Array,
): Uint8Array {
  const picture = asKey(key);
  const encoded = Uint8Array.from(bytes);
  const span = Math.min(ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE, encoded.byteLength);
  for (let index = 0; index < span; index += 1) {
    encoded[index] = (encoded[index] as number)
      ^ (picture[index % ALARM_IMAGE_KEY_SIZE] as number);
  }
  return encoded;
}
