import { describe, expect, test } from "bun:test";
import { decodeNrf24Code, encodeNrf24Code } from "./code";

describe("nRF24 saved code", () => {
  test("round-trips the packet settings required for replay", () => {
    const code = encodeNrf24Code({
      kind: "packet", sequence: 4, uptimeMs: 1200, channel: 42,
      address: "A1:B2:C3:D4:E5", addressWidth: 5,
      payloadHex: "0102FF", length: 3, crcBytes: 2, crcValid: true,
    }, 1000);
    expect(code).toStartWith("nrf24:v1:");
    expect(decodeNrf24Code(code)).toEqual({
      channel: 42, dataRateKbps: 1000, address: "A1B2C3D4E5",
      addressWidth: 5, payloadHex: "0102FF", crcBytes: 2,
    });
  });

  test("rejects another format and out-of-range packet settings", () => {
    expect(() => decodeNrf24Code("not-a-code")).toThrow(/supported/);
    const invalid = `nrf24:v1:${Buffer.from(JSON.stringify({
      channel: 126, dataRateKbps: 1000, address: "AABBCC", addressWidth: 3,
      payloadHex: "00", crcBytes: 2,
    })).toString("base64url")}`;
    expect(() => decodeNrf24Code(invalid)).toThrow(/invalid packet settings/);
  });
});
