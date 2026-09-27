import { describe, expect, test } from "bun:test";
import {
  decryptMeariMediaPayload,
  deriveMeariVideoKey,
  findMeariVideoEncryptionOffset,
} from "./media-crypto.ts";

function h264Payload(): Buffer {
  const payload = Buffer.alloc(320, 0x5a);
  payload.set([0, 0, 0, 1, 0x67], 0);
  payload.set([0, 0, 0, 1, 0x65], 20);
  return payload;
}

function h265Payload(): Buffer {
  const payload = Buffer.alloc(320, 0x33);
  payload.set([0, 0, 0, 1, 0x40], 0); // VPS, type 32
  payload.set([0, 0, 0, 1, 0x26], 24); // IDR_W_RADL, type 19
  return payload;
}

describe("Meari media encryption", () => {
  test("matches CloudEdge's versioned MD5 key derivation", () => {
    expect(deriveMeariVideoKey("camera-key", 3)).toBe("769ceacce4153236d52e950c6227071a");
    expect(deriveMeariVideoKey("camera-key", 4)).toBe("7210d3e351fc69ca0216ee6e7205fb08");
    expect(deriveMeariVideoKey("abc", 6)).toBe("216f1999ee3a7f91d5bed1b663ec0a28");
  });

  test("locates the first H.264 and H.265 VCL NAL after parameter sets", () => {
    expect(findMeariVideoEncryptionOffset("h264", h264Payload())).toBe(24);
    expect(findMeariVideoEncryptionOffset("h265", h265Payload())).toBe(28);
  });

  test("round-trips CloudEdge's 64-byte XOR video span", () => {
    const plain = h264Payload();
    const options = {
      encryptionVersion: 3,
      derivedKey: deriveMeariVideoKey("camera-key", 3),
      codec: "h264" as const,
    };
    const encrypted = decryptMeariMediaPayload(plain, options);
    expect(encrypted.subarray(0, 88)).toEqual(plain.subarray(0, 88));
    expect(encrypted.subarray(88, 152)).not.toEqual(plain.subarray(88, 152));
    expect(decryptMeariMediaPayload(encrypted, options)).toEqual(plain);
    expect(plain).toEqual(h264Payload());
  });

  test("round-trips CloudEdge's AES-CTR video span", () => {
    const plain = h265Payload();
    const options = {
      encryptionVersion: 4,
      derivedKey: deriveMeariVideoKey("camera-key", 4),
      codec: "h265" as const,
    };
    const encrypted = decryptMeariMediaPayload(plain, options);
    expect(encrypted.subarray(0, 92)).toEqual(plain.subarray(0, 92));
    expect(decryptMeariMediaPayload(encrypted, options)).toEqual(plain);
  });

  test("round-trips the first 1024 bytes of picture payloads", () => {
    const plain = Buffer.alloc(1_100, 0x7b);
    const options = {
      encryptionVersion: 3,
      derivedKey: deriveMeariVideoKey("camera-key", 3),
      codec: "h264" as const,
      picture: true,
    };
    const encrypted = decryptMeariMediaPayload(plain, options);
    expect(encrypted.subarray(1_024)).toEqual(plain.subarray(1_024));
    expect(decryptMeariMediaPayload(encrypted, options)).toEqual(plain);
  });

  test("rejects invalid versions, key sizes, and non-Annex-B video", () => {
    expect(() => deriveMeariVideoKey("x", -1)).toThrow("non-negative 32-bit integer");
    expect(() => decryptMeariMediaPayload(Buffer.alloc(300), {
      encryptionVersion: 5,
      derivedKey: "a".repeat(32),
      codec: "h264",
    })).toThrow("between 0 and 4");
    expect(() => decryptMeariMediaPayload(Buffer.alloc(300), {
      encryptionVersion: 3,
      derivedKey: "short",
      codec: "h264",
    })).toThrow("exactly 32 bytes");
    expect(() => decryptMeariMediaPayload(Buffer.alloc(300), {
      encryptionVersion: 3,
      derivedKey: "a".repeat(32),
      codec: "h264",
    })).toThrow("no VCL Annex-B NAL");
  });
});
