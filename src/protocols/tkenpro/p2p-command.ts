import { createHash } from "node:crypto";

/** Native PPStrong VVP command framing used on reliable P2P channel 0. */
export const VVP_COMMAND_HEADER_SIZE = 52;
export const VVP_COMMAND_REQUEST = 0x8000;
export const VVP_COMMAND_RESPONSE = 0x8001;

// libmrplayer byte-swaps 0x56565099 before storing it on little-endian ARM.
// Consequently the wire bytes are 56 56 50 99: the same value in network
// byte order. Keep the native and wire names as aliases for call-site clarity.
export const VVP_NATIVE_MAGIC = 0x56565099;
export const VVP_WIRE_MAGIC = VVP_NATIVE_MAGIC;

const VVP_VERSION = 1;
const VVP_AUTH_REALM = "meari.p2p.ppcs";
const DEFAULT_HTTP_USER = "admin";
const SUPPORTED_DEVICE_PATHS = ["/devices", "/media", "/tuya", "/flash"] as const;

export interface VvpCommandAuth {
  readonly hostKey: string;
  readonly protocolVersion?: number;
  readonly licenceId?: string;
  readonly fullHostKey?: boolean;
  readonly username?: string;
}

export interface VvpCommandFrameOptions extends VvpCommandAuth {
  readonly sequence: number;
  readonly command?: number;
}

export interface ParsedVvpCommandFrame {
  readonly command: number;
  readonly sequence: number;
  readonly payloadLength: number;
  readonly payload: Buffer;
  readonly auth: string;
  readonly version: number;
  readonly byteLength: number;
}

export interface MeariCommonRequest extends Record<string, unknown> {
  readonly action: "GET" | "POST";
  readonly deviceurl: string;
}

export interface BuildMeariHttpRequestOptions {
  readonly hostKey: string;
  readonly username?: string;
  readonly userAgent?: string;
  readonly contentType?: string;
}

export interface ParsedMeariHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly bodyText: string;
}

function assertUint32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function requireText(name: string, value: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  if (value.includes("\0")) throw new TypeError(`${name} cannot contain NUL`);
  return value;
}

/** Convert the 9-digit retail serial to the 20-character native licence ID. */
export function formatMeariLicenceId(serialOrLicenceId: string): string {
  const value = requireText("serialOrLicenceId", serialOrLicenceId.trim());
  return value.length === 9 ? `${"0".repeat(11)}${value}` : value;
}

/**
 * Compute the authenticator copied into VVP bytes 16..47.
 *
 * PPSP2P's default auth mode truncates the P2P password to 16 bytes; cameras
 * configured for full-key auth use all of it. Protocol versions 2+ append the
 * 20-character licence ID. This is distinct from the 16-character UUID used by
 * factory-10 signaling and is confirmed by successful CloudEdge wire captures.
 */
export function buildVvpCommandAuth(
  payloadLength: number,
  options: VvpCommandFrameOptions,
): string {
  assertUint32("payloadLength", payloadLength);
  assertUint32("sequence", options.sequence);
  const command = options.command ?? VVP_COMMAND_REQUEST;
  assertUint32("command", command);
  const username = requireText("username", options.username ?? DEFAULT_HTTP_USER);
  const hostKey = requireText("hostKey", options.hostKey);
  const password = options.fullHostKey
    ? hostKey
    : Buffer.from(hostKey, "utf8").subarray(0, 16).toString("utf8");
  const fields: (string | number)[] = [
    username,
    password,
    VVP_WIRE_MAGIC,
    options.sequence,
    command,
    payloadLength,
    VVP_AUTH_REALM,
  ];
  if ((options.protocolVersion ?? 1) >= 2) {
    fields.push(requireText("licenceId", options.licenceId ?? ""));
  }
  return createHash("md5").update(fields.join("|"), "utf8").digest("hex");
}

/** Build one native VVP command frame for reliable P2P channel 0. */
export function encodeVvpCommandFrame(
  payload: Uint8Array | string,
  options: VvpCommandFrameOptions,
): Buffer {
  const body = typeof payload === "string"
    ? Buffer.from(payload, "utf8")
    : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  assertUint32("payloadLength", body.byteLength);
  const command = options.command ?? VVP_COMMAND_REQUEST;
  assertUint32("command", command);
  assertUint32("sequence", options.sequence);

  const frame = Buffer.allocUnsafe(VVP_COMMAND_HEADER_SIZE + body.byteLength);
  frame.writeUInt32BE(VVP_WIRE_MAGIC, 0);
  frame.writeUInt32BE(VVP_VERSION, 4);
  frame.writeUInt32BE(options.sequence, 8);
  frame.writeUInt32BE(command, 12);
  frame.write(
    buildVvpCommandAuth(body.byteLength, { ...options, command }),
    16,
    32,
    "ascii",
  );
  frame.writeUInt32BE(body.byteLength, 48);
  body.copy(frame, VVP_COMMAND_HEADER_SIZE);
  return frame;
}

/** Decode a complete VVP command frame and optionally match its request. */
export function decodeVvpCommandFrame(
  bytes: Uint8Array,
  expectedRequestSequence?: number,
): ParsedVvpCommandFrame {
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (frame.byteLength < VVP_COMMAND_HEADER_SIZE) {
    throw new Error("VVP command frame is shorter than its 52-byte header");
  }
  if (frame.readUInt32BE(0) !== VVP_WIRE_MAGIC) {
    throw new Error("Invalid VVP command magic");
  }
  const version = frame.readUInt32BE(4);
  if (version !== VVP_VERSION) throw new Error(`Unsupported VVP version ${version}`);
  const sequence = frame.readUInt32BE(8);
  const command = frame.readUInt32BE(12);
  const payloadLength = frame.readUInt32BE(48);
  const byteLength = VVP_COMMAND_HEADER_SIZE + payloadLength;
  if (frame.byteLength !== byteLength) {
    throw new Error(`VVP command length mismatch: expected ${byteLength}, received ${frame.byteLength}`);
  }
  if (expectedRequestSequence !== undefined) {
    assertUint32("expectedRequestSequence", expectedRequestSequence);
    if (command !== VVP_COMMAND_RESPONSE) {
      throw new Error(`Expected VVP command response 0x${VVP_COMMAND_RESPONSE.toString(16)}`);
    }
    if (sequence !== expectedRequestSequence) {
      throw new Error(
        `VVP response sequence mismatch: expected ${expectedRequestSequence}, received ${sequence}`,
      );
    }
  }
  return {
    command,
    sequence,
    payloadLength,
    payload: Buffer.from(frame.subarray(VVP_COMMAND_HEADER_SIZE)),
    auth: frame.toString("ascii", 16, 48),
    version,
    byteLength,
  };
}

function devicePath(deviceUrl: string): string {
  const url = requireText("deviceurl", deviceUrl);
  const index = SUPPORTED_DEVICE_PATHS
    .map((prefix) => url.indexOf(prefix))
    .filter((candidate) => candidate >= 0)
    .sort((left, right) => left - right)[0];
  if (index === undefined) {
    throw new TypeError("deviceurl must contain /devices, /media, /tuya, or /flash");
  }
  return url.slice(index);
}

/**
 * Build the HTTP payload carried by the native authenticated P2P command.
 * Most routes use CloudEdge's HTTP/1.0 wrapper body. The firmware's main
 * settings read is a captured exception: an empty application/json HTTP/1.1
 * request is required there.
 */
export function buildMeariCommonHttpRequest(
  request: MeariCommonRequest,
  options: BuildMeariHttpRequestOptions,
): Buffer {
  const action = request.action;
  if (action !== "GET" && action !== "POST") {
    throw new TypeError("action must be GET or POST");
  }
  const method = action;
  const path = devicePath(request.deviceurl);
  const username = requireText("username", options.username ?? DEFAULT_HTTP_USER);
  const hostKey = requireText("hostKey", options.hostKey);
  const emptySettingsRead = action === "GET" && path === "/devices/settings";
  const body = emptySettingsRead
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(request), "utf8");
  const authorization = Buffer.from(`${username}:${hostKey}`, "utf8").toString("base64");
  const lines = [
    `${method} ${path} HTTP/${emptySettingsRead ? "1.1" : "1.0"}`,
    "Host: 127.0.0.1",
    `User-Agent: ${options.userAgent ?? "Awesome HTTP Client"}`,
    `Content-Type: ${options.contentType ?? (emptySettingsRead
      ? "application/json"
      : "text/plain, charset=us-ascii")}`,
    "Connection: close",
    `Authorization: Basic ${authorization}`,
    `Content-Length: ${body.byteLength}`,
    "",
    "",
  ];
  return body.byteLength === 0
    ? Buffer.from(lines.join("\r\n"), "utf8")
    : Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), body]);
}

/** Parse the ordinary HTTP response carried by a VVP 0x8001 payload. */
export function parseMeariHttpResponse(bytes: Uint8Array): ParsedMeariHttpResponse {
  const response = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trimmed = response.toString("utf8").trim();
  if (trimmed.startsWith("{")) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed) as unknown;
    } catch (cause) {
      throw new Error("Invalid Meari common-response JSON", { cause });
    }
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new Error("Invalid Meari common-response envelope");
    }
    const value = envelope as Record<string, unknown>;
    const status = Number(value.http_code);
    if (!Number.isInteger(status)) {
      throw new Error("Meari common response omitted http_code");
    }
    const result = value.http_result;
    const bodyText = typeof result === "string"
      ? result
      : result === undefined || result === null
        ? ""
        : JSON.stringify(result);
    return {
      status,
      statusText: status === 200 ? "OK" : "",
      headers: Object.freeze({}),
      body: Buffer.from(bodyText, "utf8"),
      bodyText,
    };
  }
  const separator = response.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("Meari HTTP response omitted its header terminator");
  const headerText = response.toString("latin1", 0, separator);
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/u.exec(statusLine);
  if (!match) throw new Error("Invalid Meari HTTP status line");
  const statusText = match[2] ?? "";
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid Meari HTTP response header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  const body = Buffer.from(response.subarray(separator + 4));
  const contentLength = headers["content-length"];
  if (contentLength !== undefined && Number.parseInt(contentLength, 10) !== body.byteLength) {
    throw new Error("Meari HTTP response Content-Length mismatch");
  }
  return {
    status: Number.parseInt(match[1] as string, 10),
    statusText,
    headers: Object.freeze(headers),
    body,
    bodyText: body.toString("utf8"),
  };
}
