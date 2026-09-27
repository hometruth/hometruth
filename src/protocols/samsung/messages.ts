/**
 * The Samsung Tizen local API, as message shapes only: URL building, the
 * commands HomeTruth sends, and the frames the set sends back. Nothing here
 * opens a socket, so every shape is checked against captured frames in
 * `messages.test.ts`.
 *
 * Two WebSocket channels share one connection protocol on port 8002 (TLS with
 * the set's own self-signed certificate, which is why the client does not
 * verify it):
 *
 *   samsung.remote.control   key presses and app launches
 *   com.samsung.art-app      the Frame's art mode, as JSON strings inside
 *                            `ms.channel.emit` envelopes
 *
 * Both are token-authenticated: the first connection without a token makes the
 * set show an on-screen prompt, and accepting it returns a token in the
 * `ms.channel.connect` frame that every later connection must carry.
 */

export const REMOTE_CHANNEL = "samsung.remote.control";
export const ART_CHANNEL = "com.samsung.art-app";

/** The only port that carries token authentication; 8001 is the unauthenticated REST port. */
export const TIZEN_WS_PORT = 8002;
export const TIZEN_REST_PORT = 8001;

/** Frame events HomeTruth acts on; anything else is noise from other clients. */
export const CHANNEL_CONNECT = "ms.channel.connect";
export const CHANNEL_READY = "ms.channel.ready";
export const CHANNEL_UNAUTHORIZED = "ms.channel.unauthorized";
export const D2D_SERVICE_MESSAGE = "d2d_service_message";

export interface ChannelUrlOptions {
  host: string;
  channel: string;
  /** The name the set shows in its prompt and its connected-device list. */
  name: string;
  token?: string;
  port?: number;
}

/** `wss://<host>:8002/api/v2/channels/<channel>?name=<base64>&token=<token>`. */
export function channelUrl({ host, channel, name, token, port = TIZEN_WS_PORT }: ChannelUrlOptions): string {
  const url = new URL(`wss://${host}:${port}/api/v2/channels/${channel}`);
  url.searchParams.set("name", Buffer.from(name, "utf8").toString("base64"));
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function deviceInfoUrl(host: string, port = TIZEN_REST_PORT): string {
  return `http://${host}:${port}/api/v2/`;
}

export function applicationUrl(host: string, appId: string, port = TIZEN_REST_PORT): string {
  return `http://${host}:${port}/api/v2/applications/${encodeURIComponent(appId)}`;
}

export type RemoteKeyCommand = "Click" | "Press" | "Release";

/** One `SendRemoteKey` command. `key` is a vendor key name such as `KEY_POWER`. */
export function remoteKeyCommand(key: string, command: RemoteKeyCommand = "Click"): string {
  return JSON.stringify({
    method: "ms.remote.control",
    params: { Cmd: command, DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" },
  });
}

/** Launch an installed app by its Tizen app id over the remote channel. */
export function launchAppCommand(appId: string): string {
  return JSON.stringify({
    method: "ms.channel.emit",
    params: { event: "ed.apps.launch", to: "host", data: { action_type: "DEEP_LINK", appId } },
  });
}

/**
 * One art-app request. The payload is a JSON *string* inside the envelope, and
 * carries the same uuid as both `id` and `request_id` because different
 * firmware generations echo one or the other back.
 */
export function artRequestCommand(request: string, requestId: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    method: "ms.channel.emit",
    params: {
      event: "art_app_request",
      to: "host",
      data: JSON.stringify({ request, ...params, id: requestId, request_id: requestId }),
    },
  });
}

export interface TizenFrame {
  event: string;
  data?: unknown;
}

/** Parse one WebSocket frame. Returns undefined for anything that is not a Tizen event frame. */
export function parseFrame(raw: string): TizenFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { event, data } = value as { event?: unknown; data?: unknown };
  if (typeof event !== "string") return undefined;
  return { event, ...(data !== undefined ? { data } : {}) };
}

/** The token an `ms.channel.connect` frame carries, when it carries one. */
export function tokenOf(frame: TizenFrame): string | undefined {
  if (frame.event !== CHANNEL_CONNECT) return undefined;
  const token = (frame.data as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export interface ArtPayload {
  /** The art-app sub-event, e.g. `artmode_status`; `error` means the request failed. */
  event?: string;
  /** Whichever correlation id this firmware echoed back. */
  id?: string;
  value?: string;
  errorCode?: string;
  /** Every other field the set sent, so a caller can read one this module does not name. */
  fields: Record<string, unknown>;
}

/** Unwrap a `d2d_service_message` frame: its `data` is a JSON string, not an object. */
export function parseArtPayload(frame: TizenFrame): ArtPayload | undefined {
  if (frame.event !== D2D_SERVICE_MESSAGE || typeof frame.data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const fields = parsed as Record<string, unknown>;
  const id = fields["request_id"] ?? fields["id"];
  const event = fields["event"];
  const value = fields["value"];
  const errorCode = fields["error_code"];
  return {
    ...(typeof event === "string" ? { event } : {}),
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof value === "string" ? { value } : {}),
    ...(typeof errorCode === "string" ? { errorCode } : {}),
    fields,
  };
}

export interface TizenDeviceInfo {
  /** `on` while the panel is lit — which on a Frame includes art mode — and `standby` otherwise. */
  powerState?: "on" | "standby";
  name?: string;
  /** The internal platform name, e.g. `22_PONTUSM_FTV`. */
  model?: string;
  /** The name printed on the set, e.g. `QN55LS03B`. */
  modelName?: string;
  wifiMac?: string;
  firmwareVersion?: string;
  /** True only when the set says it is a Frame; the art channel is refused otherwise. */
  frameTvSupport: boolean;
  tokenAuthSupport: boolean;
}

function flagOf(value: unknown): boolean {
  return value === true || value === "true" || value === "True";
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Read `GET /api/v2/`. Absent fields stay absent; nothing is guessed. */
export function parseDeviceInfo(body: unknown): TizenDeviceInfo | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const root = body as Record<string, unknown>;
  const device = typeof root["device"] === "object" && root["device"] !== null ? root["device"] as Record<string, unknown> : undefined;
  if (!device) return undefined;
  const power = device["PowerState"];
  return {
    ...(power === "on" || power === "standby" ? { powerState: power } : {}),
    ...(stringOf(device["name"]) ? { name: stringOf(device["name"])! } : {}),
    ...(stringOf(device["model"]) ? { model: stringOf(device["model"])! } : {}),
    ...(stringOf(device["modelName"]) ? { modelName: stringOf(device["modelName"])! } : {}),
    ...(stringOf(device["wifiMac"]) ? { wifiMac: stringOf(device["wifiMac"])! } : {}),
    ...(stringOf(root["version"]) ? { firmwareVersion: stringOf(root["version"])! } : {}),
    frameTvSupport: flagOf(device["FrameTVSupport"]),
    tokenAuthSupport: flagOf(device["TokenAuthSupport"]),
  };
}
