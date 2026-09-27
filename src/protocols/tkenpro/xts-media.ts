import {
  decodeVvpMediaFrame,
  VVP_MEDIA_HEADER_SIZE,
  VVP_MEDIA_LEGACY_HEADER_SIZE,
  type ParsedVvpMediaFrame,
  type VvpMediaHeaderOptions,
} from "./vvp-media.ts";

export const XTS_MEDIA_TYPE_INFO = 0xf9;
export const XTS_MEDIA_TYPE_AUDIO = 0xfa;
export const XTS_MEDIA_TYPE_VIDEO_KEY = 0xfc;
export const XTS_MEDIA_TYPE_VIDEO_DELTA = 0xfd;
export const XTS_MEDIA_TYPE_PHOTO = 0xfe;

export type XtsMediaType =
  | typeof XTS_MEDIA_TYPE_INFO
  | typeof XTS_MEDIA_TYPE_AUDIO
  | typeof XTS_MEDIA_TYPE_VIDEO_KEY
  | typeof XTS_MEDIA_TYPE_VIDEO_DELTA
  | typeof XTS_MEDIA_TYPE_PHOTO;

export interface ParsedXtsMediaFrame extends ParsedVvpMediaFrame {
  readonly envelopeType: Exclude<XtsMediaType, typeof XTS_MEDIA_TYPE_INFO>;
  /** Bytes before the embedded VVP media header. */
  readonly envelopeHeaderSize: 8 | 16;
  readonly envelopeHeader: Buffer;
  readonly messageByteLength: number;
}

const XTS_MEDIA_TYPES = new Set<number>([
  XTS_MEDIA_TYPE_INFO,
  XTS_MEDIA_TYPE_AUDIO,
  XTS_MEDIA_TYPE_VIDEO_KEY,
  XTS_MEDIA_TYPE_VIDEO_DELTA,
  XTS_MEDIA_TYPE_PHOTO,
]);

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function isXtsMediaMessage(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4
    && bytes[0] === 0
    && bytes[1] === 0
    && bytes[2] === 1
    && XTS_MEDIA_TYPES.has(bytes[3] as number)
  );
}

export function xtsMediaType(bytes: Uint8Array): XtsMediaType {
  if (!isXtsMediaMessage(bytes)) throw new Error("Invalid XTS media message magic");
  return bytes[3] as XtsMediaType;
}

/**
 * The native `iot_device_stream_received` dispatcher places keyframes and
 * photos behind a 16-byte XTS prefix. Delta video and audio use an 8-byte
 * prefix. The following VVP metadata block is 44 bytes on modern sessions and
 * 32 bytes on legacy sessions.
 */
export function xtsMediaEnvelopeHeaderSize(type: XtsMediaType): 8 | 16 {
  return type === XTS_MEDIA_TYPE_VIDEO_KEY || type === XTS_MEDIA_TYPE_PHOTO ? 16 : 8;
}

function candidateHeaderSizes(
  options: VvpMediaHeaderOptions,
): readonly (typeof VVP_MEDIA_HEADER_SIZE | typeof VVP_MEDIA_LEGACY_HEADER_SIZE)[] {
  if (options.headerSize !== undefined) return [options.headerSize];
  if (options.protocolVersion !== undefined) {
    return [options.protocolVersion < 2 ? VVP_MEDIA_LEGACY_HEADER_SIZE : VVP_MEDIA_HEADER_SIZE];
  }
  return [VVP_MEDIA_HEADER_SIZE, VVP_MEDIA_LEGACY_HEADER_SIZE];
}

function assertEnvelopeMatchesFrame(type: XtsMediaType, frame: ParsedVvpMediaFrame): void {
  if (
    (type === XTS_MEDIA_TYPE_VIDEO_KEY || type === XTS_MEDIA_TYPE_VIDEO_DELTA)
    && frame.kind !== "video"
  ) {
    throw new Error("XTS video envelope contains a non-video VVP frame");
  }
  if (type === XTS_MEDIA_TYPE_AUDIO && frame.kind !== "audio") {
    throw new Error("XTS audio envelope contains a non-audio VVP frame");
  }
  if (
    frame.kind === "video"
    && (frame.width < 1 || frame.height < 1 || frame.width > 16_384 || frame.height > 16_384)
  ) {
    throw new Error(`XTS video dimensions are invalid: ${frame.width}x${frame.height}`);
  }
}

/** Decode one complete raw XTS media message emitted by the KCP reassembler. */
export function decodeXtsMediaFrame(
  bytes: Uint8Array,
  options: VvpMediaHeaderOptions = {},
): ParsedXtsMediaFrame {
  const message = asBuffer(bytes);
  const type = xtsMediaType(message);
  if (type === XTS_MEDIA_TYPE_INFO) {
    throw new Error("XTS stream-info messages do not contain a media frame");
  }
  const envelopeHeaderSize = xtsMediaEnvelopeHeaderSize(type);
  let lastError: unknown;
  for (const headerSize of candidateHeaderSizes(options)) {
    if (message.byteLength < envelopeHeaderSize + headerSize) continue;
    try {
      const payloadLength = message.byteLength - envelopeHeaderSize - headerSize;
      const frame = decodeVvpMediaFrame(message.subarray(envelopeHeaderSize), {
        headerSize,
        payloadLengthOverride: payloadLength,
      });
      assertEnvelopeMatchesFrame(type, frame);
      return {
        ...frame,
        envelopeType: type,
        envelopeHeaderSize,
        envelopeHeader: Buffer.from(message.subarray(0, envelopeHeaderSize)),
        messageByteLength: message.byteLength,
      };
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Invalid XTS media frame${detail}`);
}
