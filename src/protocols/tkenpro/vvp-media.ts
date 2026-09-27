/** Modern playback-media header used by protocol versions 2 and newer. */
export const VVP_MEDIA_HEADER_SIZE = 44;
/** Legacy playback-media header used by protocol versions before version 2. */
export const VVP_MEDIA_LEGACY_HEADER_SIZE = 32;
export const VVP_MEDIA_MAX_PAYLOAD_SIZE = 0x0f_ff_d8;

export const VVP_MEDIA_TYPE_VIDEO_KEY = 0xf0;
export const VVP_MEDIA_TYPE_VIDEO_DELTA = 0xf1;
export const VVP_MEDIA_TYPE_AUDIO = 0xfa;

export const VVP_FRAME_FORMAT_H264 = 0x01;
export const VVP_FRAME_FORMAT_H265 = 0x04;
export const VVP_FRAME_FORMAT_AAC = 0x81;
export const VVP_FRAME_FORMAT_G711_MULAW = 0x82;
export const VVP_FRAME_FORMAT_G711_ALAW = 0x83;
export const VVP_FRAME_FORMAT_PCM = 0x86;

export type VvpMediaKind = "video" | "audio" | "metadata";
export type VvpMediaCodec =
  | "h264"
  | "h265"
  | "aac"
  | "pcm_mulaw"
  | "pcm_alaw"
  | "pcm_s16le"
  | "unknown";

export interface VvpMediaHeaderOptions {
  readonly protocolVersion?: number;
  readonly headerSize?: typeof VVP_MEDIA_HEADER_SIZE | typeof VVP_MEDIA_LEGACY_HEADER_SIZE;
  /**
   * Raw XTS frames are already message-bounded and do not use the final
   * metadata word as a payload size. Their decoder supplies the known size.
   */
  readonly payloadLengthOverride?: number;
}

export interface ParsedVvpMediaHeader {
  readonly headerSize: typeof VVP_MEDIA_HEADER_SIZE | typeof VVP_MEDIA_LEGACY_HEADER_SIZE;
  readonly frameNumber: number;
  readonly field4: number;
  readonly field8: number;
  readonly frameFormat: number;
  readonly mediaType: number;
  readonly mediaFlags: number;
  readonly width: number;
  readonly height: number;
  readonly timestamp: bigint;
  readonly payloadLength: number;
  readonly kind: VvpMediaKind;
  readonly codec: VvpMediaCodec;
  readonly keyFrame: boolean;
  readonly header: Buffer;
}

export interface ParsedVvpMediaFrame extends ParsedVvpMediaHeader {
  readonly payload: Buffer;
  readonly byteLength: number;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function mediaHeaderSize(
  options: VvpMediaHeaderOptions,
): typeof VVP_MEDIA_HEADER_SIZE | typeof VVP_MEDIA_LEGACY_HEADER_SIZE {
  if (options.headerSize !== undefined) return options.headerSize;
  return (options.protocolVersion ?? 2) < 2
    ? VVP_MEDIA_LEGACY_HEADER_SIZE
    : VVP_MEDIA_HEADER_SIZE;
}

function legacyDimension(value: number): number {
  if (value === 1) return 0x900;
  if (value === 2) return 0x800;
  return value * 8;
}

export function vvpMediaKind(mediaType: number): VvpMediaKind {
  if (mediaType === VVP_MEDIA_TYPE_VIDEO_KEY || mediaType === VVP_MEDIA_TYPE_VIDEO_DELTA) {
    return "video";
  }
  if (mediaType === VVP_MEDIA_TYPE_AUDIO) return "audio";
  return "metadata";
}

export function vvpMediaCodec(frameFormat: number): VvpMediaCodec {
  switch (frameFormat) {
    case VVP_FRAME_FORMAT_H264: return "h264";
    case VVP_FRAME_FORMAT_H265: return "h265";
    case VVP_FRAME_FORMAT_AAC: return "aac";
    case VVP_FRAME_FORMAT_G711_MULAW: return "pcm_mulaw";
    case VVP_FRAME_FORMAT_G711_ALAW: return "pcm_alaw";
    case VVP_FRAME_FORMAT_PCM: return "pcm_s16le";
    default: return "unknown";
  }
}

/**
 * Decode the playback header read by libmrplayer from logical PPCS channel 2.
 *
 * The native protocol-v2+ layout is:
 *   u32 frame number, u32 field4, u32 field8, u32 codec/frame format,
 *   u8 media type + 3 reserved bytes, u32 media flags, u32 width,
 *   u32 height, u64 timestamp, u32 payload length.
 *
 * Older 32-byte headers store media flags/width/height in one byte each and
 * encode each video dimension in eight-pixel units. libmrplayer expands that
 * exact layout into the modern structure before dispatching a frame.
 */
export function decodeVvpMediaHeader(
  bytes: Uint8Array,
  options: VvpMediaHeaderOptions = {},
): ParsedVvpMediaHeader {
  const input = asBuffer(bytes);
  const headerSize = mediaHeaderSize(options);
  if (input.byteLength < headerSize) {
    throw new Error(`VVP media header needs ${headerSize} bytes`);
  }
  const header = Buffer.from(input.subarray(0, headerSize));
  const frameFormat = header.readUInt32LE(12);
  const mediaType = header.readUInt8(16);
  if (mediaType < 0xf0 || mediaType > 0xfa) {
    throw new Error(`Unsupported VVP media type 0x${mediaType.toString(16)}`);
  }

  const legacy = headerSize === VVP_MEDIA_LEGACY_HEADER_SIZE;
  const declaredPayloadLength = header.readUInt32LE(legacy ? 28 : 40);
  const payloadLength = options.payloadLengthOverride ?? declaredPayloadLength;
  if (!Number.isInteger(payloadLength) || payloadLength < 0) {
    throw new Error(`Invalid VVP media payload length: ${payloadLength}`);
  }
  if (payloadLength > VVP_MEDIA_MAX_PAYLOAD_SIZE - headerSize) {
    throw new Error(`VVP media payload is too large: ${payloadLength} bytes`);
  }
  const kind = vvpMediaKind(mediaType);
  return {
    headerSize,
    frameNumber: header.readUInt32LE(0),
    field4: header.readUInt32LE(4),
    field8: header.readUInt32LE(8),
    frameFormat,
    mediaType,
    mediaFlags: legacy ? header.readUInt8(17) : header.readUInt32LE(20),
    width: legacy ? legacyDimension(header.readUInt8(18)) : header.readUInt32LE(24),
    height: legacy ? legacyDimension(header.readUInt8(19)) : header.readUInt32LE(28),
    timestamp: header.readBigUInt64LE(legacy ? 20 : 32),
    payloadLength,
    kind,
    codec: vvpMediaCodec(frameFormat),
    keyFrame: mediaType === VVP_MEDIA_TYPE_VIDEO_KEY,
    header,
  };
}

export function decodeVvpMediaFrame(
  bytes: Uint8Array,
  options: VvpMediaHeaderOptions = {},
): ParsedVvpMediaFrame {
  const input = asBuffer(bytes);
  const parsed = decodeVvpMediaHeader(input, options);
  const byteLength = parsed.headerSize + parsed.payloadLength;
  if (input.byteLength !== byteLength) {
    throw new Error(`VVP media frame length mismatch: expected ${byteLength}, received ${input.byteLength}`);
  }
  return {
    ...parsed,
    payload: Buffer.from(input.subarray(parsed.headerSize)),
    byteLength,
  };
}

/** Reassemble channel-2 headers and bodies across arbitrary KCP/IVA chunks. */
export class VvpMediaStreamFramer {
  private readonly options: VvpMediaHeaderOptions;
  private pending = Buffer.alloc(0);

  constructor(options: VvpMediaHeaderOptions = {}) {
    this.options = options;
  }

  get bufferedByteLength(): number {
    return this.pending.byteLength;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }

  push(bytes: Uint8Array): ParsedVvpMediaFrame[] {
    const chunk = asBuffer(bytes);
    if (chunk.byteLength === 0) return [];
    this.pending = this.pending.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.pending, chunk]);

    const frames: ParsedVvpMediaFrame[] = [];
    const headerSize = mediaHeaderSize(this.options);
    while (this.pending.byteLength >= headerSize) {
      const header = decodeVvpMediaHeader(this.pending, this.options);
      const byteLength = header.headerSize + header.payloadLength;
      if (this.pending.byteLength < byteLength) break;
      frames.push(decodeVvpMediaFrame(this.pending.subarray(0, byteLength), this.options));
      this.pending = Buffer.from(this.pending.subarray(byteLength));
    }
    return frames;
  }
}
