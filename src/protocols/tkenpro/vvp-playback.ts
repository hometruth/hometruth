import {
  decodeVvpCommandFrame,
  encodeVvpCommandFrame,
  type VvpCommandAuth,
} from "./p2p-command";

/** Native PPStrong SD-card playback commands carried on reliable channel 0. */
export const VVP_PLAYBACK_COMMAND = 0x131a;
export const VVP_PLAYBACK_RESPONSE = 0x131b;
export const VVP_PLAYBACK_PAYLOAD_SIZE = 24;
export const VVP_PLAYBACK_RESPONSE_SIZE = 12;

export const VVP_PLAYBACK_ACTION_STOP_OR_RESUME = 0;
export const VVP_PLAYBACK_ACTION_SEEK = 6;
export const VVP_PLAYBACK_ACTION_PAUSE = 8;
export const VVP_PLAYBACK_ACTION_START = 16;

export interface VvpPlaybackTimestamp {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface VvpPlaybackFrameOptions extends VvpCommandAuth {
  readonly sequence: number;
  readonly videoId?: number;
}

export interface ParsedVvpPlaybackResponse {
  readonly sequence: number;
  readonly values: readonly [number, number, number];
  readonly result: number;
  readonly payload: Buffer;
}

function assertUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

/** Parse the 14-digit local-camera timestamp accepted by libmrplayer. */
export function parseVvpPlaybackTimestamp(value: string): VvpPlaybackTimestamp {
  if (!/^\d{14}$/u.test(value)) {
    throw new TypeError("Playback timestamp must use YYYYMMDDHHmmss");
  }
  const timestamp: VvpPlaybackTimestamp = {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
    hour: Number(value.slice(8, 10)),
    minute: Number(value.slice(10, 12)),
    second: Number(value.slice(12, 14)),
  };
  assertUint("year", timestamp.year, 0xffff);
  if (timestamp.month < 1 || timestamp.month > 12) throw new RangeError("month must be between 1 and 12");
  if (timestamp.day < 1 || timestamp.day > 31) throw new RangeError("day must be between 1 and 31");
  assertUint("hour", timestamp.hour, 23);
  assertUint("minute", timestamp.minute, 59);
  assertUint("second", timestamp.second, 59);
  return timestamp;
}

/** Format a Date using the camera's wall-clock timezone, not UTC. */
export function formatVvpPlaybackTimestamp(date: Date, timeZone = "America/Los_Angeles"): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError("Playback date is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}${part("hour")}${part("minute")}${part("second")}`;
}

function playbackPayload(videoId: number, action: number, timestamp?: VvpPlaybackTimestamp): Buffer {
  assertUint("videoId", videoId, 0xffff_ffff);
  assertUint("action", action, 0xffff_ffff);
  const payload = Buffer.alloc(VVP_PLAYBACK_PAYLOAD_SIZE);
  payload.writeUInt32LE(videoId, 0);
  payload.writeUInt32LE(action, 4);
  if (timestamp) {
    payload.writeUInt16LE(timestamp.year, 12);
    payload.writeUInt8(timestamp.month, 14);
    payload.writeUInt8(timestamp.day, 15);
    // Offset 16 is a native-struct alignment byte and remains zero.
    payload.writeUInt8(timestamp.hour, 17);
    payload.writeUInt8(timestamp.minute, 18);
    payload.writeUInt8(timestamp.second, 19);
  }
  return payload;
}

function playbackFrame(payload: Buffer, options: VvpPlaybackFrameOptions): Buffer {
  return encodeVvpCommandFrame(payload, {
    ...options,
    command: VVP_PLAYBACK_COMMAND,
  });
}

export function encodeVvpPlaybackStartFrame(
  timestamp: string,
  options: VvpPlaybackFrameOptions,
): Buffer {
  return playbackFrame(playbackPayload(
    options.videoId ?? 0,
    VVP_PLAYBACK_ACTION_START,
    parseVvpPlaybackTimestamp(timestamp),
  ), options);
}

/** Stop is the action-zero frame with video ID zero in the native SDK. */
export function encodeVvpPlaybackStopFrame(options: Omit<VvpPlaybackFrameOptions, "videoId">): Buffer {
  return playbackFrame(playbackPayload(0, VVP_PLAYBACK_ACTION_STOP_OR_RESUME), options);
}

export function encodeVvpPlaybackPauseFrame(options: VvpPlaybackFrameOptions): Buffer {
  return playbackFrame(playbackPayload(
    options.videoId ?? 0,
    VVP_PLAYBACK_ACTION_PAUSE,
  ), options);
}

export function encodeVvpPlaybackResumeFrame(options: VvpPlaybackFrameOptions): Buffer {
  return playbackFrame(playbackPayload(
    options.videoId ?? 0,
    VVP_PLAYBACK_ACTION_STOP_OR_RESUME,
  ), options);
}

export function encodeVvpPlaybackSeekFrame(
  timestamp: string,
  options: VvpPlaybackFrameOptions,
): Buffer {
  return playbackFrame(playbackPayload(
    options.videoId ?? 0,
    VVP_PLAYBACK_ACTION_SEEK,
    parseVvpPlaybackTimestamp(timestamp),
  ), options);
}

/** Decode the 0x131b acknowledgement returned for a playback start. */
export function decodeVvpPlaybackResponse(
  bytes: Uint8Array,
  expectedSequence?: number,
): ParsedVvpPlaybackResponse {
  const frame = decodeVvpCommandFrame(bytes);
  if (frame.command !== VVP_PLAYBACK_RESPONSE) {
    throw new Error(`Expected VVP playback response 0x${VVP_PLAYBACK_RESPONSE.toString(16)}`);
  }
  if (expectedSequence !== undefined && frame.sequence !== expectedSequence) {
    throw new Error(`Playback response sequence mismatch: expected ${expectedSequence}, received ${frame.sequence}`);
  }
  if (frame.payloadLength !== VVP_PLAYBACK_RESPONSE_SIZE) {
    throw new Error(`VVP playback response must contain ${VVP_PLAYBACK_RESPONSE_SIZE} bytes`);
  }
  const values = [
    frame.payload.readInt32LE(0),
    frame.payload.readInt32LE(4),
    frame.payload.readInt32LE(8),
  ] as const;
  return {
    sequence: frame.sequence,
    values,
    // libmrplayer branches on the middle 32-bit response field.
    result: values[1],
    payload: frame.payload,
  };
}
