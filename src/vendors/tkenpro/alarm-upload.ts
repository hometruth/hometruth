/**
 * The Pet 3T's alarm path, stood in for locally. On motion (and the other
 * on-device detections) the camera does not tell its MsgSvr session
 * anything; it `PUT`s a thumbnail over plain HTTP to the vendor's Alibaba
 * OSS bucket with an `x-oss-callback` header that carries the event record
 * (type, device, time, clip length, loudness), and OSS relays that record
 * to the CloudEdge API, which pushes to the app. This module implements the
 * local upload response for that supported protocol path.
 *
 * While a camera is isolated its bucket hostname resolves here, and this
 * interceptor answers the upload the way OSS does (200, `Server:
 * AliyunOSS`, an ETag, the `{"t":…,"resultCode":"1001"}` body) so the
 * firmware neither retries nor backs off, keeps the thumbnail on disk, and
 * hands the event to whoever listens: the camera's motion sensor and the
 * MQTT relay. Nothing here reaches the vendor; the user's cloud clips stop
 * while the camera is isolated, which is the point of isolating it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CaptureSource, HttpInterceptor } from "../../network/isolation";

/** The bucket the US region's cameras upload to; the only one seen so far. Other regions would add their own. */
export const MEARI_ALARM_UPLOAD_HOSTNAMES: readonly string[] = ["meari-oss-us.oss-us-west-1.aliyuncs.com"];

export type MeariAlarmKind = "motion" | "other";

/** How the camera encoded the thumbnail it uploaded. */
export type AlarmThumbnailEncoding = "jpeg" | "obfuscated";

export interface MeariAlarmEvent {
  readonly at: string;
  /** The camera's LAN address, which is how a site device recognizes its own alarms. */
  readonly sourceAddress: string;
  /** The emulator's uuid for the camera (`deviceID` minus the `ppsc` prefix), when the callback carried it. */
  readonly deviceUuid?: string;
  /** The vendor's numeric event type; 1 is motion (captured). Others are passed through as `other`. */
  readonly eventType: number;
  readonly kind: MeariAlarmKind;
  /** The camera's own clock, `YYYYMMDDhhmmss`, as it put it in the callback. */
  readonly eventTime?: string;
  readonly mediaId?: string;
  readonly videoDurationSeconds?: number;
  readonly decibel?: number;
  /** Thumbnail size; the bytes themselves are on disk (`snapshotPath`) and never in the event. */
  readonly bytes: number;
  readonly snapshotPath?: string;
  /**
   * `jpeg` when the upload was a plain image, `obfuscated` when it was not.
   * This firmware scrambles the thumbnail before uploading it (the vendor's
   * cloud presumably unscrambles it), so a saved file is not directly
   * viewable; see `src/protocols/tkenpro/alarm-image.ts`.
   */
  readonly encoding?: AlarmThumbnailEncoding;
}

/** Whether these bytes are a plain JPEG, by its start-of-image marker. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export interface MeariAlarmUploadOptions {
  /** Whether a camera at this address is currently sending its alarms here (isolated); default: never. */
  readonly hears?: (sourceAddress: string) => boolean;
  /** Where thumbnails go; default `.hometruth/captures/alarms`. Empty string keeps nothing on disk. */
  readonly snapshotDirectory?: string;
  /** Thumbnails kept per camera before the oldest is deleted; default 50. */
  readonly keepSnapshots?: number;
  readonly now?: () => number;
}

/** Where alarm thumbnails are kept; the HTTP route that serves them is confined to this directory. */
export const ALARM_CAPTURE_DIRECTORY = ".hometruth/captures/alarms";

const DEFAULT_KEEP = 50;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The callback record OSS would have relayed, decoded from the header: base64 JSON with a query-string body. */
export function parseOssCallback(header: string | null): { callbackUrl?: string; body: Record<string, string> } | undefined {
  if (!header) return undefined;
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { callbackUrl?: unknown; callbackBody?: unknown };
    const body: Record<string, string> = {};
    if (typeof json.callbackBody === "string") {
      for (const [key, value] of new URLSearchParams(json.callbackBody)) body[key] = value;
    }
    return { ...(typeof json.callbackUrl === "string" ? { callbackUrl: json.callbackUrl } : {}), body };
  } catch {
    return undefined;
  }
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `/7e/v/<userID>/<n>/<YYYYMMDD>/v2-<mediaId>-<eventTime>.jpgx3` → the media id and event time when the callback lacks them. */
function parseUploadPath(pathname: string): { mediaId?: string; eventTime?: string } {
  const match = /v2-([0-9a-f]{8,64})-(\d{14})\.\w+$/u.exec(pathname);
  return match ? { mediaId: match[1]!, eventTime: match[2]! } : {};
}

export class MeariAlarmUploadInterceptor implements HttpInterceptor {
  readonly id = "tkenpro-alarm-upload";
  readonly hostnames = MEARI_ALARM_UPLOAD_HOSTNAMES;
  private readonly listeners = new Set<(event: MeariAlarmEvent) => void>();
  private readonly latest = new Map<string, MeariAlarmEvent>();
  private readonly directory: string | undefined;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly hearing: (sourceAddress: string) => boolean;
  /** Alarms handled since start, for status lines. */
  count = 0;

  constructor(options: MeariAlarmUploadOptions = {}) {
    const directory = options.snapshotDirectory ?? ALARM_CAPTURE_DIRECTORY;
    this.directory = directory ? resolve(directory) : undefined;
    this.keep = options.keepSnapshots ?? DEFAULT_KEEP;
    this.now = options.now ?? Date.now;
    this.hearing = options.hears ?? (() => false);
  }

  hears(sourceAddress: string): boolean {
    return this.hearing(sourceAddress);
  }

  onAlarm(listener: (event: MeariAlarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The most recent alarm from a camera address, if any since start. */
  lastAlarm(sourceAddress: string): MeariAlarmEvent | undefined {
    return this.latest.get(sourceAddress);
  }

  async handle(request: Request, source: CaptureSource): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method !== "PUT") return undefined;
    const callback = parseOssCallback(request.headers.get("x-oss-callback"));
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return new Response("", { status: 413 });
    const body = new Uint8Array(await request.arrayBuffer());
    const fromPath = parseUploadPath(url.pathname);
    const record = callback?.body ?? {};
    const eventType = number(record.eventType) ?? -1;
    const deviceId = record.deviceID ?? "";
    const eventTime = record.eventTime ?? fromPath.eventTime;
    const mediaId = fromPath.mediaId;
    let snapshotPath: string | undefined;
    if (this.directory && body.length > 0) {
      snapshotPath = await this.keepSnapshot(source.device?.id ?? source.address, `${eventTime ?? String(this.now())}-${eventType === 1 ? "motion" : `type${eventType}`}${mediaId ? `-${mediaId.slice(0, 12)}` : ""}.jpg`, body).catch(() => undefined);
    }
    const event: MeariAlarmEvent = {
      at: new Date(this.now()).toISOString(),
      sourceAddress: source.address,
      ...(deviceId.startsWith("ppsc") && deviceId.length > 4 ? { deviceUuid: deviceId.slice(4) } : {}),
      eventType,
      kind: eventType === 1 ? "motion" : "other",
      ...(eventTime ? { eventTime } : {}),
      ...(mediaId ? { mediaId } : {}),
      ...(number(record.videoDuration) !== undefined ? { videoDurationSeconds: number(record.videoDuration)! } : {}),
      ...(number(record.decibel) !== undefined ? { decibel: number(record.decibel)! } : {}),
      bytes: body.length,
      ...(snapshotPath ? { snapshotPath } : {}),
      ...(body.length > 0 ? { encoding: looksLikeJpeg(body) ? "jpeg" as const : "obfuscated" as const } : {}),
    };
    this.count += 1;
    this.latest.set(source.address, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One listener's failure must not fail the camera's upload.
      }
    }
    return ossResponse(body, this.now());
  }

  private async keepSnapshot(folder: string, name: string, bytes: Uint8Array): Promise<string> {
    const directory = join(this.directory!, folder.replace(/[^a-z0-9._-]/giu, "_"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name.replace(/[^a-z0-9._-]/giu, "_"));
    await writeFile(path, bytes, { mode: 0o600 });
    const files = (await readdir(directory)).filter((entry) => entry.endsWith(".jpg")).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - this.keep))) await unlink(join(directory, stale)).catch(() => undefined);
    return path;
  }
}

/** What OSS answered in the capture: 200, its server banner, a request id, the object's MD5 as the ETag, and a small JSON body. */
export function ossResponse(body: Uint8Array, nowMs: number): Response {
  const payload = JSON.stringify({ t: nowMs, resultCode: "1001" });
  return new Response(payload, {
    status: 200,
    headers: {
      Server: "AliyunOSS",
      "Content-Type": "application/json",
      Connection: "keep-alive",
      "x-oss-request-id": randomBytes(12).toString("hex").toUpperCase(),
      "x-oss-server-time": "3",
      ETag: `"${createHash("md5").update(body).digest("hex").toUpperCase()}"`,
    },
  });
}
