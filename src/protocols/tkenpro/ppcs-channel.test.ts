import { describe, expect, test } from "bun:test";
import {
  decodePpcsChannelAckFrame,
  decodePpcsChannelFrame,
  encodePpcsChannelAckFrame,
  encodePpcsChannelFrame,
  PpcsChannelMux,
  PpcsChannelStreamFramer,
} from "./ppcs-channel";

describe("native PPCS channel frames", () => {
  test("encodes the d0f1/d1 header with big-endian channel sequence and length", () => {
    const frame = encodePpcsChannelFrame({
      channel: 2,
      sequence: 0x1234,
      payload: Buffer.from("abc"),
    });
    expect(frame.toString("hex")).toBe("f1d0d10212340007616263");
    expect(decodePpcsChannelFrame(frame)).toMatchObject({
      magic: 0xd0f1,
      marker: 0xd1,
      channel: 2,
      sequence: 0x1234,
      declaredLength: 7,
      payloadLength: 3,
      payload: Buffer.from("abc"),
    });
  });

  test("encodes the native d1f1 acknowledgment list", () => {
    const frame = encodePpcsChannelAckFrame({ channel: 2, sequences: [1, 0x1234, 0xffff] });
    expect(frame.toString("hex")).toBe("f1d1d1020003000a00011234ffff");
    expect(decodePpcsChannelAckFrame(frame)).toMatchObject({
      magic: 0xd1f1,
      marker: 0xd1,
      channel: 2,
      count: 3,
      declaredLength: 10,
      sequences: [1, 0x1234, 0xffff],
    });
  });

  test("rejects malformed acknowledgment lengths", () => {
    const frame = encodePpcsChannelAckFrame({ channel: 0, sequences: [7] });
    frame.writeUInt16BE(4, 6);
    expect(() => decodePpcsChannelAckFrame(frame)).toThrow("length");
  });

  test("rejects invalid channels, markers, and declared lengths", () => {
    expect(() => encodePpcsChannelFrame({ channel: 8, sequence: 0 })).toThrow("channel");
    const invalidMarker = encodePpcsChannelFrame({ channel: 0, sequence: 0 });
    invalidMarker[2] = 0xd0;
    expect(() => decodePpcsChannelFrame(invalidMarker)).toThrow("marker");
    const invalidLength = encodePpcsChannelFrame({ channel: 0, sequence: 0 });
    invalidLength.writeUInt16BE(3, 6);
    expect(() => decodePpcsChannelFrame(invalidLength)).toThrow("length");
  });

  test("frames arbitrary stream chunks and preserves channel-local sequencing", () => {
    const mux = new PpcsChannelMux();
    const first = mux.encode(0, Buffer.from("control"));
    const voice = mux.encode(1, Buffer.from("voice"));
    const second = mux.encode(0, Buffer.from("next"));
    expect(decodePpcsChannelFrame(first).sequence).toBe(0);
    expect(decodePpcsChannelFrame(voice).sequence).toBe(0);
    expect(decodePpcsChannelFrame(second).sequence).toBe(1);

    const framer = new PpcsChannelStreamFramer();
    expect(framer.push(Buffer.concat([first, voice.subarray(0, 3)]))).toHaveLength(1);
    expect(framer.pendingByteLength).toBe(3);
    expect(framer.push(Buffer.concat([voice.subarray(3), second]))).toMatchObject([
      { channel: 1, sequence: 0, payload: Buffer.from("voice") },
      { channel: 0, sequence: 1, payload: Buffer.from("next") },
    ]);
    expect(framer.pendingByteLength).toBe(0);
  });

  test("wraps the 16-bit sequence counter per channel", () => {
    const mux = new PpcsChannelMux();
    for (let index = 0; index < 0x1_0000; index += 1) mux.encode(2);
    expect(mux.nextSequence(2)).toBe(0);
    expect(mux.nextSequence(1)).toBe(0);
  });
});
