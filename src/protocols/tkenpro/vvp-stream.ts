import { createHash } from "node:crypto";

/** Native PPStrong VVP live-session control framing. */
export const VVP_STREAM_MAGIC = 0x5656_5099;
export const VVP_STREAM_VERSION = 1;
export const VVP_STREAM_HEADER_SIZE = 60;
export const VVP_STREAM_START_LIVE = 0x11ff;
export const VVP_STREAM_STOP_LIVE = 0x12ff;
export const VVP_STREAM_START_VOICE = 0x1350;
export const VVP_STREAM_STOP_VOICE = 0x1351;
export const VVP_STREAM_HEARTBEAT = 0x888e;
export const VVP_STREAM_PARAMETER = 8;
export const VVP_STREAM_CLOUDEDGE_FLAG = 0;
export const VVP_STREAM_AUTO_ID = 105;
/** Logical channel for this CloudEdge/Pet 3T talkback path. START_VOICE
 * (cmd 0x1350, param 8) and outbound voice messages use channel 0 on this
 * path; the SDK constant name suggesting channel 3 does not describe it. */
export const VVP_STREAM_VOICE_CHANNEL = 0;

const VVP_AUTH_REALM = "meari.p2p.ppcs";
const DEFAULT_USERNAME = "admin";

export interface VvpStreamControlOptions {
  readonly hostKey: string;
  readonly sequence: number;
  readonly command?: number;
  readonly parameter?: number;
  readonly channel?: number;
  readonly streamId?: number;
  readonly streamFlag?: number;
  readonly reserve?: number;
  readonly licenceId?: string;
  readonly username?: string;
}

export interface ParsedVvpStreamControlFrame {
  readonly command: number;
  readonly sequence: number;
  readonly parameter: number;
  readonly channel: number;
  readonly streamId: number;
  readonly streamFlag: number;
  readonly reserve: number;
  readonly auth: string;
  readonly version: number;
}

function assertUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

function requireText(name: string, value: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  if (value.includes("\0")) throw new TypeError(`${name} cannot contain NUL`);
  return value;
}

/**
 * Compute the authenticator used by the 60-byte live-control packet.
 *
 * The unusual host-key rule is copied from the native SDK: ordinary keys use
 * their first 16 characters, while keys longer than 32 characters are kept
 * intact. Modern cameras append their formatted licence ID.
 */
export function buildVvpStreamAuth(options: VvpStreamControlOptions): string {
  const command = options.command ?? VVP_STREAM_START_LIVE;
  const parameter = options.parameter ?? VVP_STREAM_PARAMETER;
  assertUint("sequence", options.sequence, 0xffff_ffff);
  assertUint("command", command, 0xffff_ffff);
  assertUint("parameter", parameter, 0xffff_ffff);
  const hostKey = requireText("hostKey", options.hostKey);
  const password = hostKey.length > 32 ? hostKey : hostKey.slice(0, 16);
  const fields: (string | number)[] = [
    requireText("username", options.username ?? DEFAULT_USERNAME),
    password,
    VVP_STREAM_MAGIC,
    options.sequence,
    command,
    parameter,
    VVP_AUTH_REALM,
  ];
  if (options.licenceId) fields.push(requireText("licenceId", options.licenceId));
  return createHash("md5").update(fields.join("|"), "utf8").digest("hex");
}

/** Build one native 60-byte START_LIVE, STOP_LIVE, or heartbeat frame. */
export function encodeVvpStreamControlFrame(options: VvpStreamControlOptions): Buffer {
  const command = options.command ?? VVP_STREAM_START_LIVE;
  const parameter = options.parameter ?? VVP_STREAM_PARAMETER;
  const channel = options.channel ?? 0;
  const streamId = options.streamId ?? 0;
  const streamFlag = options.streamFlag ?? VVP_STREAM_CLOUDEDGE_FLAG;
  const reserve = options.reserve ?? 0;
  assertUint("sequence", options.sequence, 0xffff_ffff);
  assertUint("command", command, 0xffff_ffff);
  assertUint("parameter", parameter, 0xffff_ffff);
  assertUint("channel", channel, 0xffff_ffff);
  assertUint("streamId", streamId, 0xff);
  assertUint("streamFlag", streamFlag, 0xff);
  assertUint("reserve", reserve, 0xff);

  const frame = Buffer.alloc(VVP_STREAM_HEADER_SIZE);
  frame.writeUInt32BE(VVP_STREAM_MAGIC, 0);
  frame.writeUInt32BE(VVP_STREAM_VERSION, 4);
  frame.writeUInt32BE(options.sequence, 8);
  frame.writeUInt32BE(command, 12);
  frame.write(
    buildVvpStreamAuth({ ...options, command, parameter }),
    16,
    32,
    "ascii",
  );
  frame.writeUInt32BE(parameter, 48);
  frame.writeUInt32LE(channel, 52);
  frame.writeUInt8(streamId, 56);
  frame.writeUInt8(streamFlag, 57);
  frame.writeUInt8(reserve, 58);
  return frame;
}

/** Decode a live-control frame for diagnostics and packet-capture tests. */
export function decodeVvpStreamControlFrame(bytes: Uint8Array): ParsedVvpStreamControlFrame {
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (frame.byteLength !== VVP_STREAM_HEADER_SIZE) {
    throw new Error(`VVP stream frame must be ${VVP_STREAM_HEADER_SIZE} bytes`);
  }
  if (frame.readUInt32BE(0) !== VVP_STREAM_MAGIC) {
    throw new Error("Invalid VVP stream magic");
  }
  const version = frame.readUInt32BE(4);
  if (version !== VVP_STREAM_VERSION) throw new Error(`Unsupported VVP version ${version}`);
  if (frame[59] !== 0) throw new Error("Unsupported VVP stream trailer");
  return {
    command: frame.readUInt32BE(12),
    sequence: frame.readUInt32BE(8),
    parameter: frame.readUInt32BE(48),
    channel: frame.readUInt32LE(52),
    streamId: frame.readUInt8(56),
    streamFlag: frame.readUInt8(57),
    reserve: frame.readUInt8(58),
    auth: frame.toString("ascii", 16, 48),
    version,
  };
}
