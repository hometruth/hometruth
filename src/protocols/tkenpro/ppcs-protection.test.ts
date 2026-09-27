import { describe, expect, test } from "bun:test";
import {
  decodePpcsOuterPacket,
  encodePpcsOuterPacket,
  ppcsChecksum,
} from "./ppcs-protection";

describe("native PPCS outer protection", () => {
  test("round-trips a deterministic packet with the native header shape", () => {
    const packet = encodePpcsOuterPacket({
      hostKey: "0123456789abcdef0123456789",
      randomKey: Buffer.from([0x12, 0xab]),
      payload: Buffer.from("native ppcs payload"),
    });
    expect(packet.byteLength).toBe(8 + Buffer.byteLength("native ppcs payload"));
    expect(packet.readUInt16BE(0)).toBe(packet.byteLength - 8);
    expect(packet[2]).toBe(0x68);
    expect(packet.subarray(4, 6)).toEqual(Buffer.from([0x12, 0xab]));
    expect(decodePpcsOuterPacket(packet, "0123456789abcdef0123456789").payload)
      .toEqual(Buffer.from("native ppcs payload"));
  });

  test("detects tampering before returning plaintext", () => {
    const packet = encodePpcsOuterPacket({
      hostKey: "test-key",
      randomKey: Buffer.from([1, 2]),
      payload: Buffer.from("payload"),
    });
    packet[packet.length - 1]! ^= 1;
    expect(() => decodePpcsOuterPacket(packet, "test-key")).toThrow("checksum");
  });

  test("matches the empty-payload native checksum seed", () => {
    expect(ppcsChecksum(Buffer.alloc(0))).toEqual(Buffer.from([0x43, 0x53]));
  });
});
