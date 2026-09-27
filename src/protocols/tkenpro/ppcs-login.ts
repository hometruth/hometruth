/**
 * CloudEdge's JSON bridge input for the native PPCS login routine.
 *
 * The native library accepts this as a JSON string via `connectIPC3`.  The
 * values below are the field names observed in the app's login-data builder;
 * this module only assembles the in-memory request and never persists it.
 */

export const PPCS_DEFAULT_UDP_PORT = 12_305;
export const PPCS_DEFAULT_TRY_TIMES = 3;
export const PPCS_DEFAULT_DELAY_SECONDS = 5;
export const PPCS_DEFAULT_FACTORY = 10;
export const PPCS_DEFAULT_MODE = 5;
export const PPCS_DEFAULT_AUTH_MODE = "xts";
export const PPCS_DEFAULT_INIT_STRING =
  "EBGAEIBIKHJJGFJKEOGCFAEPHPMAHONDGJFPBKCPAJJMLFKBDBAGCJPBGOLKIKLKAJMJKFDOOFMOBECEJIMM";

export type PpcsLoginValue = string | number | boolean;
export type PpcsLoginData = Readonly<Record<string, PpcsLoginValue>>;

export interface PpcsTargetId {
  readonly prefix: string;
  readonly serialNumber: number;
  readonly checkCode: string;
  readonly normalized: string;
}

export interface PpcsLoginDataOptions {
  /** The device UUID passed to native PPCS_Connect. */
  readonly did: string;
  /** Camera serial number (`snNum` in the Android model). */
  readonly serialNumber: string;
  /** Device host key; used only while constructing the in-memory JSON. */
  readonly hostKey: string;
  /** Native protocol generation (`p2p` in the Android model). */
  readonly protocolVersion: number;
  /** Native product family. Pet cameras use the factory-10 path. */
  readonly factory?: number;
  readonly initString?: string;
  readonly udpPort?: number;
  readonly tryTimes?: number;
  readonly delaySeconds?: number;
  readonly mode?: number;
  readonly authMode?: string;
  readonly connectPurpose?: string;
  readonly deviceType?: string | number;
  readonly voiceEncryption?: number;
  readonly multiStream?: boolean | number;
  readonly offlineReturnImmediately?: boolean | number;
  readonly noAudioLowFps?: boolean | number;
  readonly quickDisplayFirstVideoFrame?: number;
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function uint(name: string, value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
  return value;
}

/**
 * Parse the `prefix-sn-checkcode` target ID accepted by native PPCS_Connect.
 * Native code uppercases letters, accepts hyphens as separators, and requires
 * exactly two separators before passing the three pieces to its connector.
 */
export function parsePpcsTargetId(value: string): PpcsTargetId {
  const source = requiredText("targetId", value);
  const normalized = source
    .replace(/[^0-9A-Za-z-]/gu, "")
    .replace(/[A-Za-z]+/gu, (segment) => segment.toUpperCase())
    .replace(/-+/gu, "-");
  const pieces = normalized.split("-");
  if (
    pieces.length !== 3
    || !pieces[0]
    || !pieces[1]
    || !pieces[2]
    || pieces[0].length > 16
    || pieces[2].length > 16
    || !/^[A-Z0-9]+$/u.test(pieces[0])
    || !/^\d+$/u.test(pieces[1])
    || !/^[A-Z0-9]+$/u.test(pieces[2])
  ) {
    throw new Error("targetId must contain prefix, numeric serial, and check code");
  }
  const serialNumber = Number(pieces[1]);
  if (!Number.isSafeInteger(serialNumber) || serialNumber < 0) {
    throw new RangeError("targetId serial number is outside the native range");
  }
  return {
    prefix: pieces[0],
    serialNumber,
    checkCode: pieces[2],
    normalized: `${pieces[0]}-${pieces[1]}-${pieces[2]}`,
  };
}

/** Match CloudEdge's serial-to-UUID conversion for factory-10 devices. */
export function ppcsUuidFromSerial(serialNumber: string): string {
  const serial = requiredText("serialNumber", serialNumber);
  return /^\d{9}$/u.test(serial) ? `0000000${serial}` : serial.slice(4);
}

/** Match CloudEdge's serial-to-licence-id conversion for factory-10 devices. */
export function ppcsLicenceIdFromSerial(serialNumber: string): string {
  const serial = requiredText("serialNumber", serialNumber);
  return /^\d{9}$/u.test(serial) ? `00000000000${serial}` : serial;
}

/** Build the native login object without exposing its secret fields to logs. */
export function buildPpcsLoginData(options: PpcsLoginDataOptions): PpcsLoginData {
  const did = requiredText("did", options.did);
  const serialNumber = requiredText("serialNumber", options.serialNumber);
  const hostKey = requiredText("hostKey", options.hostKey);
  if (hostKey.length < 8) throw new RangeError("hostKey must contain at least 8 characters");
  const protocolVersion = uint("protocolVersion", options.protocolVersion, 0xff);
  const udpPort = uint("udpPort", options.udpPort ?? PPCS_DEFAULT_UDP_PORT, 0xffff);
  const tryTimes = uint("tryTimes", options.tryTimes ?? PPCS_DEFAULT_TRY_TIMES, 0xff);
  const delaySeconds = uint(
    "delaySeconds",
    options.delaySeconds ?? PPCS_DEFAULT_DELAY_SECONDS,
    0xffff,
  );
  const factory = uint("factory", options.factory ?? PPCS_DEFAULT_FACTORY, 0xff);
  const mode = uint("mode", options.mode ?? PPCS_DEFAULT_MODE, 0xff);
  const authMode = requiredText("authMode", options.authMode ?? PPCS_DEFAULT_AUTH_MODE);
  const initString = requiredText(
    "initString",
    options.initString ?? PPCS_DEFAULT_INIT_STRING,
  );
  const data: Record<string, PpcsLoginValue> = {
    uuid: ppcsUuidFromSerial(serialNumber),
    authmode: authMode,
    trytimes: tryTimes,
    udpport: udpPort,
    did,
    factory,
    initstring: initString,
    delaysec: delaySeconds,
    licenceid: ppcsLicenceIdFromSerial(serialNumber),
    protocolv: protocolVersion,
    username: "admin",
    password: hostKey,
    mode,
  };
  if (options.connectPurpose !== undefined) data.use = requiredText("connectPurpose", options.connectPurpose);
  if (options.deviceType !== undefined) {
    data.devicetype = typeof options.deviceType === "number"
      ? uint("deviceType", options.deviceType, 0xffff)
      : requiredText("deviceType", options.deviceType);
  }
  if (options.voiceEncryption !== undefined) data.voice_enc = uint("voiceEncryption", options.voiceEncryption, 0xff);
  if (options.multiStream !== undefined) {
    data.multi_stream = typeof options.multiStream === "boolean"
      ? options.multiStream
      : uint("multiStream", options.multiStream, 0xff);
  }
  if (options.offlineReturnImmediately !== undefined) {
    data.offline_return_immediately = typeof options.offlineReturnImmediately === "boolean"
      ? options.offlineReturnImmediately
      : uint("offlineReturnImmediately", options.offlineReturnImmediately, 1);
  }
  if (options.noAudioLowFps !== undefined) {
    data.no_audio_lowfps = typeof options.noAudioLowFps === "boolean"
      ? options.noAudioLowFps
      : uint("noAudioLowFps", options.noAudioLowFps, 1);
  }
  if (options.quickDisplayFirstVideoFrame !== undefined) {
    data.quick_display_first_video_frame = uint("quickDisplayFirstVideoFrame", options.quickDisplayFirstVideoFrame, 1);
  }
  return Object.freeze(data);
}

/** Serialize login data exactly once, at the native bridge boundary. */
export function encodePpcsLoginData(options: PpcsLoginDataOptions): string {
  return JSON.stringify(buildPpcsLoginData(options));
}
