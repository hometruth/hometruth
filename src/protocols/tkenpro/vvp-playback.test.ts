import { describe, expect, test } from "bun:test";
import { encodeVvpCommandFrame } from "./p2p-command";
import {
  decodeVvpPlaybackResponse,
  encodeVvpPlaybackPauseFrame,
  encodeVvpPlaybackResumeFrame,
  encodeVvpPlaybackSeekFrame,
  encodeVvpPlaybackStartFrame,
  encodeVvpPlaybackStopFrame,
  formatVvpPlaybackTimestamp,
  parseVvpPlaybackTimestamp,
  VVP_PLAYBACK_ACTION_PAUSE,
  VVP_PLAYBACK_ACTION_SEEK,
  VVP_PLAYBACK_ACTION_START,
  VVP_PLAYBACK_COMMAND,
  VVP_PLAYBACK_RESPONSE,
} from "./vvp-playback";

const auth = {
  hostKey: "0123456789abcdef-feedface",
  protocolVersion: 6,
  licenceId: "00000000000123456789",
  sequence: 7,
  videoId: 3,
} as const;

function payload(frame: Buffer): Buffer {
  expect(frame.readUInt32BE(12)).toBe(VVP_PLAYBACK_COMMAND);
  expect(frame.readUInt32BE(48)).toBe(24);
  return frame.subarray(52);
}

describe("Meari VVP SD playback codec", () => {
  test("encodes the native start payload and its aligned wall-clock fields", () => {
    const body = payload(encodeVvpPlaybackStartFrame("20260901235958", auth));
    expect(body.readUInt32LE(0)).toBe(3);
    expect(body.readUInt32LE(4)).toBe(VVP_PLAYBACK_ACTION_START);
    expect(body.readUInt32LE(8)).toBe(0);
    expect(body.readUInt16LE(12)).toBe(2026);
    expect([...body.subarray(14, 24)]).toEqual([9, 1, 0, 23, 59, 58, 0, 0, 0, 0]);
  });

  test("encodes stop, pause, resume, and seek subcommands", () => {
    expect([...payload(encodeVvpPlaybackStopFrame(auth))]).toEqual(new Array(24).fill(0));

    const paused = payload(encodeVvpPlaybackPauseFrame(auth));
    expect(paused.readUInt32LE(0)).toBe(3);
    expect(paused.readUInt32LE(4)).toBe(VVP_PLAYBACK_ACTION_PAUSE);

    const resumed = payload(encodeVvpPlaybackResumeFrame(auth));
    expect(resumed.readUInt32LE(0)).toBe(3);
    expect(resumed.readUInt32LE(4)).toBe(0);

    const sought = payload(encodeVvpPlaybackSeekFrame("20260901010203", auth));
    expect(sought.readUInt32LE(4)).toBe(VVP_PLAYBACK_ACTION_SEEK);
    expect([...sought.subarray(12, 20)]).toEqual([0xea, 0x07, 9, 1, 0, 1, 2, 3]);
  });

  test("validates and formats camera-local timestamps", () => {
    expect(parseVvpPlaybackTimestamp("20260901010203")).toEqual({
      year: 2026,
      month: 9,
      day: 1,
      hour: 1,
      minute: 2,
      second: 3,
    });
    expect(() => parseVvpPlaybackTimestamp("2026-09-01")).toThrow("YYYYMMDDHHmmss");
    expect(() => parseVvpPlaybackTimestamp("20261301010203")).toThrow("month");
    expect(formatVvpPlaybackTimestamp(new Date("2026-09-02T07:08:09Z"), "UTC")).toBe("20260902070809");
  });

  test("decodes the native 12-byte playback response", () => {
    const body = Buffer.alloc(12);
    body.writeInt32LE(3, 0);
    body.writeInt32LE(-14, 4);
    body.writeInt32LE(99, 8);
    const frame = encodeVvpCommandFrame(body, {
      ...auth,
      command: VVP_PLAYBACK_RESPONSE,
    });
    expect(decodeVvpPlaybackResponse(frame, 7)).toMatchObject({
      sequence: 7,
      values: [3, -14, 99],
      result: -14,
    });
    expect(() => decodeVvpPlaybackResponse(frame, 8)).toThrow("sequence mismatch");
  });
});
