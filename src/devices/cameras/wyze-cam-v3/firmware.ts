/**
 * Local endpoint profiles for Wyze Cam v3 firmware variants.
 * Stock cloud-only firmware is not modeled. A profile describes addresses,
 * not a guarantee that every release supports every endpoint. Check the
 * firmware's documentation and configured device; see docs/WYZE.md.
 */
import type { CameraMediaSource } from "../../../camera-media";

export type WyzeCamV3Firmware = "thingino" | "wyze-rtsp" | "wz-mini-hacks";
export const WYZE_CAM_V3_FIRMWARES: readonly WyzeCamV3Firmware[] = ["thingino", "wyze-rtsp", "wz-mini-hacks"];

export type WyzeCamV3Stream = "main" | "sub";

export interface WyzeCamV3FirmwareProfile {
  readonly id: WyzeCamV3Firmware;
  readonly title: string;
  /** Plain RTSP port and the path per stream. */
  readonly rtsp: { readonly port: number; readonly paths: Readonly<Record<WyzeCamV3Stream, string>> };
  /** RTSP over TLS, when the firmware offers it (Wyze's beta: self-signed certificate, TCP only). */
  readonly rtsps?: { readonly port: number; readonly paths: Readonly<Record<WyzeCamV3Stream, string>> };
  /** The RTSP login the firmware ships with, when it ships with one. Thingino's username cannot be changed. */
  readonly defaultRtspCredentials?: { readonly username: string; readonly password: string };
  /**
   * HTTP still-image endpoints per stream, when the firmware has them.
   * Thingino (2026 web UI): `/x/dl0.jpg` and `/x/dl1.jpg`, authenticated by
   * the camera's web API key (`?token=`), not by the RTSP login. Older builds
   * served `/image.jpg` with basic auth; 2026 builds redirect that to the UI.
   */
  readonly snapshotPaths?: Readonly<Record<WyzeCamV3Stream, string>>;
  /** ONVIF device service, when the firmware has one; identity and reboot come from it. */
  readonly onvifDeviceServicePath?: string;
  /** Where the URL templates above come from. */
  readonly source: string;
}

export const WYZE_CAM_V3_FIRMWARE_PROFILES: Readonly<Record<WyzeCamV3Firmware, WyzeCamV3FirmwareProfile>> = {
  thingino: {
    id: "thingino",
    title: "Thingino (replacement firmware)",
    rtsp: { port: 554, paths: { main: "/ch0", sub: "/ch1" } },
    defaultRtspCredentials: { username: "thingino", password: "thingino" },
    snapshotPaths: { main: "/x/dl0.jpg", sub: "/x/dl1.jpg" },
    onvifDeviceServicePath: "/onvif/device_service",
    source: "Thingino wiki: Media-Streaming-Endpoints, ONVIF; web UI preview.js (2026-08 build) for /x/dl0.jpg + token",
  },
  "wyze-rtsp": {
    id: "wyze-rtsp",
    title: "Wyze RTSP firmware (beta 4.36.16.x)",
    // The beta page documents `stream0` only; a sub stream is mentioned but unnamed.
    rtsp: { port: 554, paths: { main: "/stream0/", sub: "/stream0/" } },
    rtsps: { port: 322, paths: { main: "/stream0/", sub: "/stream0/" } },
    source: "wyze-beta.s3.us-west-2.amazonaws.com/rtsp.html",
  },
  "wz-mini-hacks": {
    id: "wz-mini-hacks",
    title: "wz_mini_hacks (SD-card overlay on stock firmware ≤ 4.36.9.139)",
    // v4l2rtspserver with both streams enabled; single-stream setups serve `/unicast`.
    rtsp: { port: 8554, paths: { main: "/video1_unicast", sub: "/video2_unicast" } },
    source: "wz_mini_hacks wiki: Video-Streaming",
  },
};

export interface WyzeCamV3MediaOptions {
  readonly host: string;
  readonly firmware: WyzeCamV3Firmware;
  readonly stream?: WyzeCamV3Stream;
  /** Overrides the profile's RTSP port (wz_mini's `RTSP_PORT`, a re-homed Thingino). */
  readonly rtspPort?: number;
  /** Use RTSPS where the firmware offers it. */
  readonly secure?: boolean;
  readonly credentials?: { readonly username: string; readonly password: string };
  /** The firmware's web API key (Thingino: Settings → Web UI → API key); unlocks the HTTP snapshot. */
  readonly webApiKey?: string;
}

/** The stream and snapshot addresses for one camera, credentials kept out of the URIs. */
export function wyzeCamV3MediaSource(options: WyzeCamV3MediaOptions): CameraMediaSource {
  const profile = WYZE_CAM_V3_FIRMWARE_PROFILES[options.firmware];
  const stream = options.stream ?? "main";
  const secure = options.secure === true && profile.rtsps !== undefined;
  const scheme = secure ? "rtsps" : "rtsp";
  const endpoint = secure && profile.rtsps ? profile.rtsps : profile.rtsp;
  const port = options.rtspPort ?? endpoint.port;
  const credentials = options.credentials ?? profile.defaultRtspCredentials;
  const snapshotPath = profile.snapshotPaths?.[stream];
  // Without the key the HTTP endpoint answers 401; the media bridge then grabs a frame from RTSP instead.
  const snapshotUri = snapshotPath && options.webApiKey
    ? `http://${options.host}${snapshotPath}?token=${encodeURIComponent(options.webApiKey)}`
    : undefined;
  return {
    streamUri: `${scheme}://${options.host}:${port}${endpoint.paths[stream]}`,
    ...(snapshotUri ? { snapshotUri } : {}),
    ...(credentials ? { username: credentials.username, password: credentials.password } : {}),
  };
}

/** The ONVIF device service URL for firmware that has one. */
export function wyzeCamV3OnvifUrl(host: string, firmware: WyzeCamV3Firmware): string | undefined {
  const path = WYZE_CAM_V3_FIRMWARE_PROFILES[firmware].onvifDeviceServicePath;
  return path ? `http://${host}${path}` : undefined;
}
