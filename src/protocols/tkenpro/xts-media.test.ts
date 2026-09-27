import { describe, expect, test } from "bun:test";
import {
  VVP_MEDIA_HEADER_SIZE,
  VVP_MEDIA_LEGACY_HEADER_SIZE,
} from "./vvp-media.ts";
import {
  decodeXtsMediaFrame,
  isXtsMediaMessage,
  XTS_MEDIA_TYPE_AUDIO,
  XTS_MEDIA_TYPE_INFO,
  XTS_MEDIA_TYPE_VIDEO_DELTA,
  XTS_MEDIA_TYPE_VIDEO_KEY,
  xtsMediaEnvelopeHeaderSize,
} from "./xts-media.ts";

function modernHeader(mediaType: number, payloadLength: number): Buffer {
  const header = Buffer.alloc(VVP_MEDIA_HEADER_SIZE);
  header.writeUInt32LE(12, 0);
  header.writeUInt32LE(1, 12);
  header.writeUInt8(mediaType, 16);
  header.writeUInt32LE(1920, 24);
  header.writeUInt32LE(1080, 28);
  header.writeBigUInt64LE(55n, 32);
  header.writeUInt32LE(payloadLength, 40);
  return header;
}

function legacyHeader(mediaType: number, payloadLength: number): Buffer {
  const header = Buffer.alloc(VVP_MEDIA_LEGACY_HEADER_SIZE);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(0x83, 12);
  header.writeUInt8(mediaType, 16);
  header.writeUInt8(240, 18);
  header.writeUInt8(135, 19);
  header.writeBigUInt64LE(77n, 20);
  header.writeUInt32LE(payloadLength, 28);
  return header;
}

function envelope(type: number, size: 8 | 16): Buffer {
  const result = Buffer.alloc(size);
  result.set([0, 0, 1, type]);
  return result;
}

describe("Meari raw XTS media envelopes", () => {
  test("decodes the 60-byte modern keyframe boundary", () => {
    const payload = Buffer.from([0, 0, 0, 1, 0x65, 1, 2]);
    const header = modernHeader(0xf0, payload.byteLength);
    // On raw XTS live media this word is opaque metadata, not a byte count.
    header.writeUInt32LE(0xdead_beef, 40);
    const message = Buffer.concat([
      envelope(XTS_MEDIA_TYPE_VIDEO_KEY, 16),
      header,
      payload,
    ]);
    const frame = decodeXtsMediaFrame(message, { protocolVersion: 6 });
    expect(frame).toMatchObject({
      envelopeType: XTS_MEDIA_TYPE_VIDEO_KEY,
      envelopeHeaderSize: 16,
      headerSize: 44,
      kind: "video",
      codec: "h264",
      keyFrame: true,
      messageByteLength: message.byteLength,
    });
    expect(frame.payload).toEqual(payload);
  });

  test("decodes the 52-byte modern delta-video boundary", () => {
    const payload = Buffer.from([0, 0, 1, 0x41, 3]);
    const message = Buffer.concat([
      envelope(XTS_MEDIA_TYPE_VIDEO_DELTA, 8),
      modernHeader(0xf1, payload.byteLength),
      payload,
    ]);
    const frame = decodeXtsMediaFrame(message);
    expect(frame.envelopeHeaderSize).toBe(8);
    expect(frame.keyFrame).toBe(false);
    expect(frame.payload).toEqual(payload);
    expect(frame.payloadLength).toBe(payload.byteLength);
  });

  test("decodes the 40-byte legacy audio boundary", () => {
    const payload = Buffer.from([0xff, 0x7f, 0]);
    const message = Buffer.concat([
      envelope(XTS_MEDIA_TYPE_AUDIO, 8),
      legacyHeader(0xfa, payload.byteLength),
      payload,
    ]);
    const frame = decodeXtsMediaFrame(message, { protocolVersion: 1 });
    expect(frame).toMatchObject({
      envelopeHeaderSize: 8,
      headerSize: 32,
      kind: "audio",
      codec: "pcm_alaw",
      width: 1920,
      height: 1080,
    });
    expect(frame.payload).toEqual(payload);
  });

  test("recognizes info packets but does not misparse them as media", () => {
    const info = Buffer.from([0, 0, 1, XTS_MEDIA_TYPE_INFO, 1, 2, 3, 4]);
    expect(isXtsMediaMessage(info)).toBe(true);
    expect(xtsMediaEnvelopeHeaderSize(XTS_MEDIA_TYPE_INFO)).toBe(8);
    expect(() => decodeXtsMediaFrame(info)).toThrow("stream-info");
    expect(isXtsMediaMessage(Buffer.from([0, 0, 1, 0xfb]))).toBe(false);
  });

  test("rejects a mismatched envelope and truncated metadata", () => {
    const payload = Buffer.from([1, 2]);
    const mismatch = Buffer.concat([
      envelope(XTS_MEDIA_TYPE_AUDIO, 8),
      modernHeader(0xf0, payload.byteLength),
      payload,
    ]);
    expect(() => decodeXtsMediaFrame(mismatch, { protocolVersion: 6 })).toThrow("non-audio");

    const truncated = Buffer.concat([
      envelope(XTS_MEDIA_TYPE_VIDEO_KEY, 16),
      Buffer.alloc(VVP_MEDIA_HEADER_SIZE - 1),
    ]);
    expect(() => decodeXtsMediaFrame(truncated, { protocolVersion: 6 })).toThrow("Invalid XTS");
  });
});
