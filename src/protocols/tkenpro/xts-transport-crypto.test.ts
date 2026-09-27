import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import {
  decryptXtsTransportMessage,
  decryptXtsTransportRegion,
  deriveXtsTransportKey,
  encryptXtsTransportMessage,
  encryptXtsTransportRegion,
  resolveXtsTransportKeySource,
  xtsTransportPayloadOffset,
  XTS_TRANSPORT_BLOCK_SIZE,
  XTS_TRANSPORT_KEY,
} from "./xts-transport-crypto.ts";

describe("XTS transport payload cipher", () => {
  test("derives a 24-byte key by truncating an over-length string", () => {
    const key = deriveXtsTransportKey("0123456789abcdef0123456789abcdef");
    expect(key.byteLength).toBe(24);
    expect(key.toString("utf8")).toBe("0123456789abcdef01234567");
  });

  test("zero-pads a short key to 24 bytes", () => {
    const key = deriveXtsTransportKey("abc");
    expect(key.byteLength).toBe(24);
    expect(key.subarray(0, 3).toString("utf8")).toBe("abc");
    expect(key.subarray(3).equals(Buffer.alloc(21))).toBe(true);
  });

  test("uses the native per-frame-type header offsets", () => {
    expect(xtsTransportPayloadOffset(0xfa)).toBe(0x28); // audio
    expect(xtsTransportPayloadOffset(0xfd)).toBe(0x28); // delta video
    expect(xtsTransportPayloadOffset(0xf9)).toBe(0x28); // stream info
    expect(xtsTransportPayloadOffset(0xfc)).toBe(0x30); // key video
    expect(xtsTransportPayloadOffset(0xfe)).toBe(0x30); // photo
  });

  test("region transform matches raw 3DES-EDE-ECB on whole blocks and leaves the tail clear", () => {
    const key = deriveXtsTransportKey("EBGAEIBIKHJJGFJKEOGCFAEP");
    // 20 bytes -> 16 encrypted (two blocks) + 4-byte clear tail
    const region = Buffer.from([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0xaa, 0xbb, 0xcc, 0xdd,
    ]);
    const encrypted = encryptXtsTransportRegion(region, key);
    expect(encrypted.byteLength).toBe(region.byteLength);
    // reference: node 3DES-ECB over the first 16 bytes
    const cipher = createCipheriv("des-ede3", key, null);
    cipher.setAutoPadding(false);
    const ref = Buffer.concat([cipher.update(region.subarray(0, 16)), cipher.final()]);
    expect(encrypted.subarray(0, 16).equals(ref)).toBe(true);
    // trailing 4 bytes untouched
    expect(encrypted.subarray(16).equals(region.subarray(16))).toBe(true);
    // round-trips
    expect(decryptXtsTransportRegion(encrypted, key).equals(region)).toBe(true);
  });

  test("leaves regions shorter than one block untouched", () => {
    const key = deriveXtsTransportKey("shortkeyshortkeyshortkey");
    const region = Buffer.from([1, 2, 3, 4, 5, 6, 7]); // < 8
    expect(encryptXtsTransportRegion(region, key).equals(region)).toBe(true);
  });

  test("encrypts only the payload region of a full audio message and round-trips", () => {
    const key = deriveXtsTransportKey("EBGAEIBIKHJJGFJKEOGCFAEP");
    // 52-byte header (audio offset is 0x28=40, so 12 header bytes past 40 are also encrypted)
    const header = Buffer.alloc(40);
    header.writeUInt32BE(0x000001fa, 0); // XTS audio magic
    header[3] = 0xfa;
    const audio = Buffer.alloc(320, 0x7f); // silence-ish mu-law
    const message = Buffer.concat([header, Buffer.alloc(12), audio]);

    const encrypted = encryptXtsTransportMessage(message, key);
    // first 40 bytes (before payload offset) are unchanged
    expect(encrypted.subarray(0, 40).equals(message.subarray(0, 40))).toBe(true);
    // payload region changed
    expect(encrypted.subarray(40).equals(message.subarray(40))).toBe(false);
    // round-trips back to original
    expect(decryptXtsTransportMessage(encrypted, key).equals(message)).toBe(true);
  });

  test("encryptXtsTransportMessage does not mutate the input", () => {
    const key = deriveXtsTransportKey("EBGAEIBIKHJJGFJKEOGCFAEP");
    const message = Buffer.concat([
      (() => { const h = Buffer.alloc(40); h.writeUInt32BE(0x000001fa, 0); h[3] = 0xfa; return h; })(),
      Buffer.alloc(64, 0x11),
    ]);
    const copy = Buffer.from(message);
    encryptXtsTransportMessage(message, key);
    expect(message.equals(copy)).toBe(true);
  });

  test("block size is 8", () => {
    expect(XTS_TRANSPORT_BLOCK_SIZE).toBe(8);
  });
});

describe("XTS transport key source resolution", () => {
  const original = process.env.HOMETRUTH_XTS_TRANSPORT_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.HOMETRUTH_XTS_TRANSPORT_KEY;
    else process.env.HOMETRUTH_XTS_TRANSPORT_KEY = original;
  });

  test("defaults to the recovered SDK constant", () => {
    delete process.env.HOMETRUTH_XTS_TRANSPORT_KEY;
    expect(resolveXtsTransportKeySource()).toBe(XTS_TRANSPORT_KEY);
  });

  test("the shared constant zero-pads to a 24-byte 3DES key", () => {
    expect(XTS_TRANSPORT_KEY).toBe("!mearicloud2.0!");
    const key = deriveXtsTransportKey(XTS_TRANSPORT_KEY);
    expect(key.toString("hex")).toBe("216d65617269636c6f7564322e3021000000000000000000");
  });

  test("reproduces the official app's on-wire talkback ciphertext", () => {
    // Ground truth from a LAN capture of CloudEdge -> Pet 3T (2026-09-04):
    // the encrypted region of a 320-sample talkback frame starts at offset 40
    // with the zero field, the LE sample count, then μ-law silence (0xff).
    const key = deriveXtsTransportKey(XTS_TRANSPORT_KEY);
    const plain = Buffer.concat([Buffer.alloc(8), Buffer.from("40010000", "hex"), Buffer.alloc(12, 0xff)]);
    expect(encryptXtsTransportRegion(plain, key).toString("hex")).toBe(
      "b3a2d90a7270bf3e5f091484d89fa5f270ab9756e306caa0",
    );
    // The camera's own outbound audio uses the same key; its silence is 0x7e.
    expect(decryptXtsTransportRegion(Buffer.from("2639c01798ba71e5", "hex"), key).toString("hex"))
      .toBe("7e7e7e7e7e7e7e7e");
  });

  test("honors a literal environment override", () => {
    process.env.HOMETRUTH_XTS_TRANSPORT_KEY = "some-other-24-byte-value";
    expect(resolveXtsTransportKeySource()).toBe("some-other-24-byte-value");
  });

  test("ignores an empty override", () => {
    process.env.HOMETRUTH_XTS_TRANSPORT_KEY = "";
    expect(resolveXtsTransportKeySource()).toBe(XTS_TRANSPORT_KEY);
  });
});
