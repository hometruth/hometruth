import { describe, expect, test } from "bun:test";
import {
  decodeVvpMediaFrame,
  decodeVvpMediaHeader,
  VVP_MEDIA_HEADER_SIZE,
  VVP_MEDIA_LEGACY_HEADER_SIZE,
  VvpMediaStreamFramer,
} from "./vvp-media";

function modernHeader(payloadLength: number): Buffer {
  const header = Buffer.alloc(VVP_MEDIA_HEADER_SIZE);
  header.writeUInt32LE(42, 0);
  header.writeUInt32LE(7, 4);
  header.writeUInt32LE(8, 8);
  header.writeUInt32LE(1, 12);
  header.writeUInt8(0xf0, 16);
  header.writeUInt32LE(3, 20);
  header.writeUInt32LE(2304, 24);
  header.writeUInt32LE(1296, 28);
  header.writeBigUInt64LE(123_456_789n, 32);
  header.writeUInt32LE(payloadLength, 40);
  return header;
}

describe("Meari VVP playback media framing", () => {
  test("decodes the protocol-v2+ 44-byte channel-2 header", () => {
    const parsed = decodeVvpMediaHeader(modernHeader(6), { protocolVersion: 6 });
    expect(parsed).toMatchObject({
      headerSize: 44,
      frameNumber: 42,
      field4: 7,
      field8: 8,
      frameFormat: 1,
      mediaType: 0xf0,
      mediaFlags: 3,
      width: 2304,
      height: 1296,
      timestamp: 123_456_789n,
      payloadLength: 6,
      kind: "video",
      codec: "h264",
      keyFrame: true,
    });
  });

  test("expands the native legacy width and height representation", () => {
    const header = Buffer.alloc(VVP_MEDIA_LEGACY_HEADER_SIZE);
    header.writeUInt32LE(9, 0);
    header.writeUInt32LE(0x83, 12);
    header.writeUInt8(0xfa, 16);
    header.writeUInt8(2, 17);
    header.writeUInt8(1, 18);
    header.writeUInt8(162, 19);
    header.writeBigUInt64LE(44n, 20);
    header.writeUInt32LE(4, 28);
    const parsed = decodeVvpMediaHeader(header, { protocolVersion: 1 });
    expect(parsed).toMatchObject({
      frameNumber: 9,
      frameFormat: 0x83,
      mediaType: 0xfa,
      mediaFlags: 2,
      width: 2304,
      height: 1296,
      timestamp: 44n,
      payloadLength: 4,
      kind: "audio",
      codec: "pcm_alaw",
      keyFrame: false,
    });
  });

  test("reassembles split frames and emits multiple frames from one chunk", () => {
    const firstPayload = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const secondPayload = Buffer.from([0, 0, 0, 1, 0x41]);
    const first = Buffer.concat([modernHeader(firstPayload.length), firstPayload]);
    const secondHeader = modernHeader(secondPayload.length);
    secondHeader.writeUInt32LE(43, 0);
    secondHeader.writeUInt8(0xf1, 16);
    const second = Buffer.concat([secondHeader, secondPayload]);
    const framer = new VvpMediaStreamFramer({ protocolVersion: 6 });

    expect(framer.push(first.subarray(0, 17))).toEqual([]);
    expect(framer.bufferedByteLength).toBe(17);
    const frames = framer.push(Buffer.concat([first.subarray(17), second]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.payload).toEqual(firstPayload);
    expect(frames[1]?.frameNumber).toBe(43);
    expect(frames[1]?.keyFrame).toBe(false);
    expect(framer.bufferedByteLength).toBe(0);
  });

  test("rejects truncated and oversized frames", () => {
    expect(() => decodeVvpMediaHeader(Buffer.alloc(12))).toThrow("needs 44 bytes");
    const header = modernHeader(4);
    expect(() => decodeVvpMediaFrame(Buffer.concat([header, Buffer.alloc(3)]))).toThrow("length mismatch");
    header.writeUInt32LE(0x10_0000, 40);
    expect(() => decodeVvpMediaHeader(header)).toThrow("too large");
  });
});
