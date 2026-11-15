import { describe, expect, test } from "bun:test";
import {
  buildVvpStreamAuth,
  decodeVvpStreamControlFrame,
  encodeVvpStreamControlFrame,
  VVP_STREAM_AUTO_ID,
  VVP_STREAM_MAGIC,
  VVP_STREAM_START_LIVE,
} from "./vvp-stream.ts";

const options = {
  hostKey: "0123456789abcdef0123456789abcdef",
  licenceId: "00000000000100000001",
  sequence: 0,
  streamId: VVP_STREAM_AUTO_ID,
};

describe("Meari VVP stream control codec", () => {
  test("matches the native CloudEdge START_LIVE frame", () => {
    expect(buildVvpStreamAuth(options)).toBe("3da92a51d0f9550c58947f591a7e3dfc");

    const frame = encodeVvpStreamControlFrame(options);
    expect(frame).toHaveLength(60);
    expect(frame.subarray(0, 16).toString("hex")).toBe(
      "565650990000000100000000000011ff",
    );
    expect(frame.readUInt32BE(0)).toBe(VVP_STREAM_MAGIC);
    expect(frame.toString("ascii", 16, 48)).toBe("3da92a51d0f9550c58947f591a7e3dfc");
    expect(frame.subarray(48).toString("hex")).toBe("000000080000000069000000");
    expect(decodeVvpStreamControlFrame(frame)).toMatchObject({
      command: VVP_STREAM_START_LIVE,
      sequence: 0,
      parameter: 8,
      channel: 0,
      streamId: 105,
      streamFlag: 0,
      reserve: 0,
    });
  });

  test("uses the native long-host-key exception", () => {
    const hostKey = "abcdefghijklmnopqrstuvwxyz123456789";
    const actual = buildVvpStreamAuth({ hostKey, sequence: 0 });
    const truncated = buildVvpStreamAuth({ hostKey: hostKey.slice(0, 16), sequence: 0 });
    expect(actual).not.toBe(truncated);
  });
});
