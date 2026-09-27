import { describe, expect, test } from "bun:test";
import {
  buildPpcsLoginData,
  encodePpcsLoginData,
  parsePpcsTargetId,
  ppcsLicenceIdFromSerial,
  ppcsUuidFromSerial,
} from "./ppcs-login.ts";

const base = {
  did: "device-uuid",
  serialNumber: "123456789",
  hostKey: "0123456789abcdef",
  protocolVersion: 6,
} as const;

describe("CloudEdge native PPCS login data", () => {
  test("matches factory-10 serial normalization", () => {
    expect(ppcsUuidFromSerial(base.serialNumber)).toBe("0000000123456789");
    expect(ppcsLicenceIdFromSerial(base.serialNumber)).toBe("00000000000123456789");
    expect(ppcsUuidFromSerial("ABCD1234567890123456")).toBe("1234567890123456");
    expect(ppcsLicenceIdFromSerial("ABCD1234567890123456")).toBe("ABCD1234567890123456");
  });

  test("emits the recovered native field names and defaults", () => {
    const login = buildPpcsLoginData(base);
    expect(login).toMatchObject({
      uuid: "0000000123456789",
      authmode: "xts",
      trytimes: 3,
      udpport: 12305,
      did: "device-uuid",
      factory: 10,
      delaysec: 5,
      licenceid: "00000000000123456789",
      protocolv: 6,
      username: "admin",
      password: "0123456789abcdef",
      mode: 5,
    });
    expect(typeof login.initstring).toBe("string");
  });

  test("serializes only at the bridge boundary and supports optional flags", () => {
    const text = encodePpcsLoginData({
      ...base,
      connectPurpose: "playback",
      voiceEncryption: 1,
      multiStream: true,
      noAudioLowFps: true,
      quickDisplayFirstVideoFrame: 1,
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.use).toBe("playback");
    expect(parsed.voice_enc).toBe(1);
    expect(parsed.multi_stream).toBe(true);
    expect(parsed.no_audio_lowfps).toBe(true);
    expect(parsed.quick_display_first_video_frame).toBe(1);
  });

  test("parses the native three-part target ID", () => {
    expect(parsePpcsTargetId("ab12-001234-xy9")).toEqual({
      prefix: "AB12",
      serialNumber: 1234,
      checkCode: "XY9",
      normalized: "AB12-001234-XY9",
    });
    expect(() => parsePpcsTargetId("0000000123456789")).toThrow();
    expect(() => parsePpcsTargetId("AB12-ABC-XY9")).toThrow();
  });

  test("rejects malformed native inputs", () => {
    expect(() => buildPpcsLoginData({ ...base, protocolVersion: 256 })).toThrow();
    expect(() => buildPpcsLoginData({ ...base, hostKey: "short" })).toThrow();
    expect(() => buildPpcsLoginData({ ...base, serialNumber: "" })).toThrow();
  });
});
