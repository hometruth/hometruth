import { describe, expect, test } from "bun:test";
import {
  decodeVvpVoicePacket,
  encodeMuLaw,
  encodeVvpFactory10VoicePacket,
  encodeVvpVoicePacket,
  pcm16ToMuLaw,
  VVP_FACTORY10_VOICE_HEADER_SIZE,
  VVP_FACTORY10_VOICE_MAX_SAMPLES,
  VVP_VOICE_HEADER_SIZE,
  VVP_VOICE_LEGACY_HEADER_SIZE,
} from "./vvp-voice.ts";

describe("Meari VVP talkback codec", () => {
  test("matches the native PCMU encoder boundaries", () => {
    expect([
      -32_768,
      -1_000,
      -1,
      0,
      1,
      1_000,
      32_767,
    ].map(pcm16ToMuLaw)).toEqual([0x00, 0x4e, 0x7f, 0xff, 0xff, 0xce, 0x80]);
  });

  test("encodes the modern 44-byte type-9 voice packet", () => {
    const pcm = Int16Array.from([-32_768, -1, 0, 1, 32_767]);
    const packet = encodeVvpVoicePacket({ sequence: 7, protocolVersion: 6, pcm });
    expect(packet).toHaveLength(VVP_VOICE_HEADER_SIZE + pcm.length);
    expect(packet.subarray(0, VVP_VOICE_HEADER_SIZE).toString("hex")).toBe(
      "07000000000000000000000082000000fa000000030000001000000001000000000000000000000005000000",
    );
    expect(packet.subarray(VVP_VOICE_HEADER_SIZE)).toEqual(encodeMuLaw(pcm));
    expect(decodeVvpVoicePacket(packet)).toEqual({
      sequence: 7,
      protocolVersion: 2,
      mode: 3,
      audio: Buffer.from([0x00, 0x7f, 0xff, 0xff, 0x80]),
    });
  });

  test("retains the native legacy packet layout", () => {
    const packet = encodeVvpVoicePacket({
      sequence: 9,
      protocolVersion: 1,
      mode: 2,
      pcm: Int16Array.from([0]),
    });
    expect(packet).toHaveLength(VVP_VOICE_LEGACY_HEADER_SIZE + 1);
    expect(packet.subarray(0, VVP_VOICE_LEGACY_HEADER_SIZE).toString("hex")).toBe(
      "09000000000000000000000082000000fa021001000000000000000001000000",
    );
    expect(decodeVvpVoicePacket(packet)).toMatchObject({
      sequence: 9,
      protocolVersion: 1,
      mode: 2,
    });
  });

  test("encodes the native factory-10 XTS talkback message", () => {
    const pcm = Int16Array.from([-32_768, -1, 0, 1, 32_767]);
    const packet = encodeVvpFactory10VoicePacket({ sequence: 7, pcm, channel: 3 });
    expect(packet).toHaveLength(VVP_FACTORY10_VOICE_HEADER_SIZE + pcm.length);
    expect(packet.subarray(0, VVP_FACTORY10_VOICE_HEADER_SIZE).toString("hex")).toBe(
      "000001fa0000310007000000000000000000000082000000fa000003000000001000000001000000000000000000000005000000",
    );
    expect(packet.subarray(VVP_FACTORY10_VOICE_HEADER_SIZE)).toEqual(encodeMuLaw(pcm));
  });

  test("matches the official app's on-wire talkback header byte for byte", () => {
    // Plaintext header of a real CloudEdge -> Pet 3T voice message (LAN
    // capture 2026-09-04): sequence 0x1479, one 320-sample block, channel 0.
    // Bytes 40..51 are encrypted on the wire; they decrypt to the zero field
    // plus the little-endian sample count that the encoder writes here.
    const packet = encodeVvpFactory10VoicePacket({ sequence: 0x1479, pcm: new Int16Array(320) });
    expect(packet.subarray(0, 40).toString("hex")).toBe(
      "000001fa00006c0179140000000000000000000082000000fa000000000000001000000001000000",
    );
    expect(packet.subarray(40, VVP_FACTORY10_VOICE_HEADER_SIZE).toString("hex")).toBe("000000000000000040010000");
    expect(packet).toHaveLength(372);
  });

  test("rejects native frame sizes above the fixed encoder buffer", () => {
    expect(() => encodeVvpVoicePacket({
      sequence: 0,
      pcm: new Int16Array(1_281),
    })).toThrow("cannot exceed 1280 samples");
  });

  test("bounds factory-10 voice blocks to the native 320-sample write", () => {
    expect(() => encodeVvpFactory10VoicePacket({
      sequence: 0,
      pcm: new Int16Array(VVP_FACTORY10_VOICE_MAX_SAMPLES + 1),
    })).toThrow("cannot exceed 320 samples");
  });
});
