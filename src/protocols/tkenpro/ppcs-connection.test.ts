import { describe, expect, test } from "bun:test";
import {
  decodePpcsConnectionMessage,
  encodePpcsConnectionMessage,
  protectPpcsConnectionMessage,
  unprotectPpcsConnectionMessage,
} from "./ppcs-connection";
import { decodePpcsOuterPacket } from "./ppcs-protection";

const target = {
  prefix: "AB12",
  serialNumber: 123456789,
  checkCode: "XY9",
} as const;

describe("native PPCS connection-worker messages", () => {
  test("encodes the short f1/0x67 target probe", () => {
    const message = encodePpcsConnectionMessage({ kind: 0x67, ...target });
    expect(message.byteLength).toBe(24);
    expect(message.subarray(0, 4)).toEqual(Buffer.from([0xf1, 0x67, 0x00, 0x14]));
    expect(message.readUInt32BE(12)).toBe(target.serialNumber);
    expect(decodePpcsConnectionMessage(message)).toMatchObject({
      kind: 0x67,
      declaredLength: 0x14,
      prefix: target.prefix,
      serialNumber: target.serialNumber,
      checkCode: target.checkCode,
    });
  });

  test("keeps the recovered f1/0x53 endpoint and mode slots fixed-size", () => {
    const message = encodePpcsConnectionMessage({
      kind: 0x53,
      ...target,
      endpointData: Buffer.alloc(24, 0x11),
      modeData: Buffer.from([1, 2, 3, 4, 5]),
    });
    expect(message.byteLength).toBe(56);
    expect(message.readUInt16BE(2)).toBe(0x34);
    expect(message.subarray(24, 48)).toEqual(Buffer.alloc(24, 0x11));
    expect(message.subarray(48, 53)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  test("matches native short-probe protection as a separate mode", () => {
    const message = encodePpcsConnectionMessage({
      kind: 0x20,
      ...target,
      routeBytes: Buffer.from([1, 2, 3, 4]),
    });
    const protectedMessage = protectPpcsConnectionMessage(message, {
      mode: "host-key",
      hostKey: "0123456789abcdef0123456789",
    });
    expect(unprotectPpcsConnectionMessage(protectedMessage, "0123456789abcdef0123456789"))
      .toEqual(message);
  });

  test("uses the outer wrapper only when explicitly requested", () => {
    const message = encodePpcsConnectionMessage({ kind: 0x67, ...target });
    const protectedMessage = protectPpcsConnectionMessage(message, {
      mode: "outer",
      hostKey: "test-key",
      randomKey: Buffer.from([0x12, 0xab]),
    });
    expect(protectedMessage[2]).toBe(0x68);
    expect(decodePpcsOuterPacket(protectedMessage, "test-key").payload).toEqual(message);
  });
});
