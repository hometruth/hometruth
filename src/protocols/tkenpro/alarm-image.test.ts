import { describe, expect, test } from "bun:test";
import {
  ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE,
  decodeAlarmThumbnail,
  encodeAlarmThumbnail,
  isEncodedAlarmThumbnail,
} from "./alarm-image.ts";

const KEY = "0123456789abcdef0123456789abcdef";

/**
 * A stand-in for a real upload: a JPEG header, enough filler to run past the
 * encrypted prefix, and the end-of-image marker the camera leaves in the clear.
 */
function plainThumbnail(): Uint8Array {
  const bytes = new Uint8Array(ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE + 64).fill(0x5a);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  bytes.set([0xff, 0xd9], bytes.byteLength - 2);
  return bytes;
}

describe("TKENPRO alarm thumbnails", () => {
  test("round-trips the camera's prefix XOR", () => {
    const plain = plainThumbnail();
    const encoded = encodeAlarmThumbnail(plain, KEY);

    expect(encoded.subarray(0, 2)).not.toEqual(plain.subarray(0, 2));
    expect(decodeAlarmThumbnail(encoded, KEY)).toEqual(plain);
  });

  test("leaves everything past the first 1024 bytes untouched", () => {
    const plain = plainThumbnail();
    const encoded = encodeAlarmThumbnail(plain, KEY);
    const tail = ALARM_IMAGE_ENCRYPTED_PREFIX_SIZE;

    expect(encoded.subarray(tail)).toEqual(plain.subarray(tail));
    expect(encoded.subarray(encoded.byteLength - 2)).toEqual(
      Uint8Array.from([0xff, 0xd9]),
    );
  });

  test("does not mutate the caller's bytes", () => {
    const encoded = encodeAlarmThumbnail(plainThumbnail(), KEY);
    const original = Uint8Array.from(encoded);

    decodeAlarmThumbnail(encoded, KEY);

    expect(encoded).toEqual(original);
  });

  test("recognises an upload only while it is still obfuscated", () => {
    const plain = plainThumbnail();

    expect(isEncodedAlarmThumbnail(encodeAlarmThumbnail(plain, KEY))).toBe(true);
    expect(isEncodedAlarmThumbnail(plain)).toBe(false);
  });

  test("returns undefined for bytes that are not an encoded thumbnail", () => {
    const plain = plainThumbnail();
    const truncated = encodeAlarmThumbnail(plain, KEY).subarray(0, 512);

    expect(decodeAlarmThumbnail(plain, KEY)).toBeUndefined();
    expect(decodeAlarmThumbnail(truncated, KEY)).toBeUndefined();
  });

  test("returns undefined when the key belongs to another camera", () => {
    const encoded = encodeAlarmThumbnail(plainThumbnail(), KEY);

    expect(decodeAlarmThumbnail(encoded, "ffffffffffffffffffffffffffffffff"))
      .toBeUndefined();
  });

  test("rejects a key that is not 32 bytes", () => {
    const encoded = encodeAlarmThumbnail(plainThumbnail(), KEY);

    expect(() => decodeAlarmThumbnail(encoded, "too-short")).toThrow(RangeError);
  });
});
