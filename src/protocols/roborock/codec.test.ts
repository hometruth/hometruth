import { describe, expect, test } from "bun:test";
import {
  RoborockCodecError,
  RoborockFrameReader,
  crc32,
  decodeMessage,
  decodeRpcResponse,
  decryptPayload,
  deriveKey,
  encodeMessage,
  encodeRpcRequest,
  encodeTimestamp,
  encryptPayload,
} from "./codec";

// Synthetic key. Fixtures were computed independently with Python's
// hashlib/struct/zlib and `openssl enc -aes-128-ecb`, not with this codec.
const LOCAL_KEY = "AbCdEfGh12345678";
const TIMESTAMP = 0x65a1b2c3;
const PAYLOAD = '{"dps":{"101":"{\\"id\\":12345,\\"method\\":\\"get_status\\",\\"params\\":[]}"},"t":1705095875}';
const KEY_HEX = "df9348c5259aefbfdc5791f1831559d8";
const CIPHERTEXT_HEX = "6e0320e1e8369bee01add48bece5b823b27350925a4149d0fa7dc739ae7b1353af3bed8eb6b28ed5a7d4cfe0f054ed67be56050ca60d121de25811428256b4e9d74e5bc825abb8be06f72722df27bc3836adf273e6e67a7565ec09895b5b192a";
const FRAME_HEX = `00000077312e30010203040a0b0c0d65a1b2c300040060${CIPHERTEXT_HEX}afd3e71c`;
const HELLO_HEX = "00000015312e30000000010000001665a1b2c3000078cd4d8d";

const hex = (value: string) => Buffer.from(value, "hex");

describe("Roborock 1.0 codec", () => {
  test("shuffles the hex timestamp as digits 5,6,3,7,1,2,0,4", () => {
    expect(encodeTimestamp(0x12345678)).toBe("67482315");
    expect(encodeTimestamp(TIMESTAMP)).toBe("2c135a6b");
    expect(encodeTimestamp(0x1)).toBe("00010000");
  });

  test("derives md5(timestamp + localKey + salt)", () => {
    expect(deriveKey(LOCAL_KEY, TIMESTAMP).toString("hex")).toBe(KEY_HEX);
  });

  test("AES-128-ECB with PKCS#7 matches OpenSSL", () => {
    const key = hex(KEY_HEX);
    expect(encryptPayload(Buffer.from(PAYLOAD), key).toString("hex")).toBe(CIPHERTEXT_HEX);
    expect(decryptPayload(hex(CIPHERTEXT_HEX), key).toString()).toBe(PAYLOAD);
  });

  test("CRC-32 is the zlib polynomial", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test("encodes a request frame byte for byte", () => {
    const frame = encodeMessage({ seq: 0x01020304, random: 0x0a0b0c0d, timestamp: TIMESTAMP, protocol: 4, payload: Buffer.from(PAYLOAD) }, LOCAL_KEY);
    expect(frame.toString("hex")).toBe(FRAME_HEX);
  });

  test("encodes a hello with no payload field", () => {
    expect(encodeMessage({ seq: 1, random: 22, timestamp: TIMESTAMP, protocol: 0 }, LOCAL_KEY).toString("hex")).toBe(HELLO_HEX);
  });

  test("decodes the fixture frame back to its fields and plaintext", () => {
    const message = decodeMessage(hex(FRAME_HEX).subarray(4), LOCAL_KEY);
    expect(message).toMatchObject({ seq: 0x01020304, random: 0x0a0b0c0d, timestamp: TIMESTAMP, protocol: 4 });
    expect(Buffer.from(message.payload!).toString()).toBe(PAYLOAD);
    expect(decodeMessage(hex(HELLO_HEX).subarray(4), LOCAL_KEY)).toEqual({ seq: 1, random: 22, timestamp: TIMESTAMP, protocol: 0 });
  });

  test("round-trips arbitrary payloads, including block-aligned and empty ones", () => {
    for (const text of ["", "x", "0123456789abcdef", "{\"dps\":{}}".repeat(40)]) {
      const encoded = encodeMessage({ seq: 7, random: 99999, timestamp: 1_700_000_000, protocol: 4, payload: Buffer.from(text) }, LOCAL_KEY);
      const decoded = decodeMessage(encoded.subarray(4), LOCAL_KEY);
      expect(Buffer.from(decoded.payload!).toString()).toBe(text);
      expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    }
  });

  test("accepts a zero-length payload field as no payload", () => {
    const body = Buffer.concat([hex(HELLO_HEX).subarray(4, 4 + 17), Buffer.from([0, 0])]);
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(crc32(body), 0);
    expect(decodeMessage(Buffer.concat([body, trailer]), LOCAL_KEY).payload).toBeUndefined();
  });

  test("rejects a bad checksum, a wrong version, a length mismatch, and a wrong key", () => {
    const body = hex(FRAME_HEX).subarray(4);
    const corrupt = Buffer.from(body);
    corrupt[20] = corrupt[20]! ^ 0xff;
    expect(() => decodeMessage(corrupt, LOCAL_KEY)).toThrow("checksum");
    const version = Buffer.from(body);
    version.write("A01", 0, "ascii");
    expect(() => decodeMessage(version, LOCAL_KEY)).toThrow("version");
    expect(() => decodeMessage(body.subarray(0, 10), LOCAL_KEY)).toThrow(RoborockCodecError);
    expect(() => decodeMessage(body, "ZZZZZZZZZZZZZZZZ")).toThrow("local key");
  });

  test("the frame reader reassembles split and coalesced frames", () => {
    const reader = new RoborockFrameReader();
    const stream = Buffer.concat([hex(FRAME_HEX), hex(HELLO_HEX)]);
    const frames = [...reader.push(stream.subarray(0, 3)), ...reader.push(stream.subarray(3, 50)), ...reader.push(stream.subarray(50))];
    expect(frames.map((frame) => frame.toString("hex"))).toEqual([FRAME_HEX.slice(8), HELLO_HEX.slice(8)]);
    expect(() => new RoborockFrameReader().push(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toThrow("Implausible");
  });

  test("wraps RPC requests and unwraps replies", () => {
    expect(Buffer.from(encodeRpcRequest({ id: 12345, method: "get_status", params: [] }, 1705095875)).toString()).toBe(PAYLOAD);
    const reply = (inner: unknown) => Buffer.from(JSON.stringify({ t: 1, dps: { "102": JSON.stringify(inner) } }));
    expect(decodeRpcResponse(reply({ id: 9, result: ["ok"] }))).toEqual({ id: 9, result: ["ok"] });
    expect(decodeRpcResponse(reply({ id: 9, error: { code: -10007, message: "invalid status" } }))).toEqual({ id: 9, error: { code: -10007, message: "invalid status" } });
    expect(decodeRpcResponse(Buffer.from(JSON.stringify({ t: 1, dps: { "121": 8 } })))).toBeUndefined();
    expect(() => decodeRpcResponse(Buffer.from("nope"))).toThrow("JSON");
    expect(() => decodeRpcResponse(reply({ result: [] }))).toThrow("id");
  });
});
