/**
 * The TKENPRO local cloud emulator as a HomeTruth `Service`: one service for
 * the thing that actually runs (sockets the cameras register with, the
 * stand-in listeners that answer for the vendor), with every event tagged by
 * the camera it is about.
 *
 * There is deliberately no service per camera. A camera is not a service; it
 * is the *subject* of events this one service records, so "show me only the
 * kitchen camera" is a filter over one log rather than a separate log per
 * device — which also means an event that involves no camera, or a camera we
 * do not recognize, still has somewhere to go.
 *
 * Everything the emulator hears arrives here: the MsgSvr control channel
 * (`MeariLocalCloudEvent`), the alarm uploads HomeTruth answers in the
 * vendor's place, the vendor API calls it relays, and — while a camera is
 * isolated — what its packet capture sees it attempt. `src/vendors/tkenpro/
 * index.ts` builds one of these at startup and wires the sources into it.
 */
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";
import type { MeariLocalCloudEvent } from "../../protocols/tkenpro/cloud-emulator";
import type { MeariAlarmEvent } from "./alarm-upload";

/** One configured camera, so an event can be tagged with the device it is about. */
export interface TkenproCameraIdentity {
  /** The site device id (`devices.yml`), e.g. `example-camera`. */
  readonly deviceId: string;
  readonly name: string;
  /** The local cloud emulator's uuid for this camera (matched by configured host at startup). */
  readonly uuid: string;
  /** The camera's LAN address, which is how an intercepted upload or a captured packet is matched to it. */
  readonly host?: string;
}

/** Where a saved alarm thumbnail can be fetched from; the rich view's image. */
export function alarmThumbnailUrl(deviceId: string, fileName: string): string {
  return `/api/devices/${encodeURIComponent(deviceId)}/alarms/${encodeURIComponent(fileName)}`;
}

interface Described {
  readonly type: string;
  readonly message: string;
  readonly level?: "info" | "warn" | "error";
  readonly data?: Record<string, unknown>;
}

/** An intercepted alarm as an event: the human sentence, plus the fields the thumbnail view renders. */
export function describeAlarm(event: MeariAlarmEvent, deviceId: string | undefined): Described {
  const what = event.kind === "motion" ? "Motion detected" : `Alarm (vendor type ${event.eventType})`;
  const fileName = event.snapshotPath?.split("/").pop();
  return {
    type: event.kind === "motion" ? "motion" : "alarm",
    message: `${what}${event.videoDurationSeconds ? `, ${event.videoDurationSeconds} s clip` : ""}${event.decibel ? `, ${event.decibel} dB` : ""}`,
    data: {
      ...(deviceId && fileName ? { thumbnailUrl: alarmThumbnailUrl(deviceId, fileName) } : {}),
      ...(event.eventTime ? { eventTime: event.eventTime } : {}),
      ...(event.videoDurationSeconds !== undefined ? { clipSeconds: event.videoDurationSeconds } : {}),
      ...(event.decibel !== undefined ? { decibel: event.decibel } : {}),
      bytes: event.bytes,
      ...(event.mediaId ? { mediaId: event.mediaId } : {}),
      ...(event.deviceUuid ? { uuid: event.deviceUuid } : {}),
      vendorEventType: event.eventType,
    },
  };
}

function describeEvent(event: MeariLocalCloudEvent): Described | undefined {
  switch (event.type) {
    case "connected":
      return { type: "connected", message: "A camera opened a connection" };
    case "registered":
      return { type: "registered", message: "Camera registered", data: { uuid: event.uuid } };
    case "disconnected":
      return { type: "disconnected", message: "Camera disconnected", ...(event.uuid ? { data: { uuid: event.uuid } } : {}) };
    case "settings": {
      const changed = Object.keys(event.values).sort((left, right) => Number(left) - Number(right));
      return {
        type: "settings",
        message: `${event.source === "sync" ? "Camera reported" : "Camera confirmed"} ${changed.length} propert${changed.length === 1 ? "y" : "ies"} changed`,
        data: { uuid: event.uuid, source: event.source, changed },
      };
    }
    case "message": {
      // Structural facts only — never the payload.
      const content = event.content as Record<string, unknown>;
      const cmd = typeof content.cmd === "string" ? content.cmd : undefined;
      const method = typeof content.method === "string" ? content.method : undefined;
      const action = typeof content.action === "string" ? content.action : undefined;
      const unhandledCommand = content.__unhandledCommand;
      const keys = Object.keys(content).filter((key) => !key.startsWith("__")).sort();
      if (event.via === "heartbeat") {
        // Routine heartbeat metadata would otherwise fill the log on every
        // check-in. Keep the raw protocol event intact for other consumers.
        const extraKeys = keys.filter((key) => key !== "runtime" && key !== "t" && key !== "ver");
        if (extraKeys.length === 0) return undefined;
        return { type: "heartbeat_extra", message: `Heartbeat carried extra fields (${extraKeys.join(", ")})`, data: { uuid: event.uuid, changed: extraKeys } };
      }
      if (event.via === "unhandled-command") {
        const command = `0x${Number(unhandledCommand).toString(16)}`;
        return { type: "unhandled_command", message: `Unhandled command ${command}${keys.length > 0 ? ` (${keys.join(", ")})` : ""}`, data: { uuid: event.uuid, command, keys } };
      }
      return {
        type: "message",
        message: `Unrecognized push${cmd ? ` (${[cmd, method, action].filter(Boolean).join("/")})` : ""}`,
        data: { uuid: event.uuid, ...(cmd ? { cmd } : {}), ...(method ? { method } : {}), ...(action ? { action } : {}), keys },
      };
    }
    case "persistence-error":
      return { type: "persistence_error", message: event.message, level: "error" };
    case "protocol-error":
      return { type: "protocol_error", message: event.message, level: "warn", ...(event.uuid ? { data: { uuid: event.uuid } } : {}) };
  }
}

function uuidOf(event: MeariLocalCloudEvent): string | undefined {
  return "uuid" in event ? event.uuid : undefined;
}

/** What a camera's own slice of the log says about it, for the emulator's status line and the camera page. */
export interface CameraLinkStatus {
  readonly deviceId: string;
  readonly name: string;
  readonly connected: boolean;
  readonly lastEventAt?: string;
}

export class MeariCloudEmulatorService extends Service {
  private readonly log = new EventLog(400);
  private readonly connected = new Set<string>();
  private cameras: readonly TkenproCameraIdentity[];
  private byUuid: Map<string, TkenproCameraIdentity>;
  private byHost: Map<string, TkenproCameraIdentity>;

  constructor(cameras: readonly TkenproCameraIdentity[] = []) {
    super("tkenpro-cloud-emulator", "TKENPRO local cloud emulator");
    this.cameras = cameras;
    this.byUuid = new Map(cameras.map((camera) => [camera.uuid, camera]));
    this.byHost = new Map(cameras.flatMap((camera) => camera.host ? [[camera.host, camera] as const] : []));
  }

  /** Every camera this emulator serves, whether or not it is connected right now. */
  get identities(): readonly TkenproCameraIdentity[] {
    return this.cameras;
  }

  /** The site device id of the camera at a LAN address, when it is one we know. */
  deviceIdAt(address: string): string | undefined {
    return this.byHost.get(address)?.deviceId;
  }

  /** One line per camera, for the status detail and the "filter by camera" menu. */
  linkStatuses(): readonly CameraLinkStatus[] {
    return this.cameras.map((camera) => {
      const last = this.log.recent(1, { subject: camera.deviceId })[0];
      return {
        deviceId: camera.deviceId,
        name: camera.name,
        connected: this.connected.has(camera.uuid),
        ...(last ? { lastEventAt: last.at } : {}),
      };
    });
  }

  isConnected(deviceId: string): boolean {
    const camera = this.cameras.find((candidate) => candidate.deviceId === deviceId);
    return camera !== undefined && this.connected.has(camera.uuid);
  }

  /** One event from the MsgSvr control channel, tagged with the camera it came from. */
  ingest(event: MeariLocalCloudEvent): void {
    if (event.type === "registered") this.connected.add(event.uuid);
    if (event.type === "disconnected" && event.uuid) this.connected.delete(event.uuid);
    const uuid = uuidOf(event);
    const subject = uuid ? this.byUuid.get(uuid)?.deviceId : undefined;
    const described = describeEvent(event);
    if (described) this.record(described, subject);
  }

  /** One alarm the upload interceptor caught. Returns the camera it belongs to, when it is one we know. */
  ingestAlarm(event: MeariAlarmEvent): string | undefined {
    const deviceId = this.byHost.get(event.sourceAddress)?.deviceId;
    this.record(describeAlarm(event, deviceId), deviceId);
    return deviceId;
  }

  /**
   * One event about a device's network behaviour: a request to a hostname we
   * stand in for, or something its packet capture saw it attempt. Recorded
   * here rather than in an "isolation" service because the vendor stand-in
   * *is* this emulator — a camera's traffic is this service's business.
   */
  ingestNetwork(described: Described, address: string): void {
    this.record(described, this.byHost.get(address)?.deviceId);
  }

  private record(described: Described, subject: string | undefined): void {
    this.log.record(described.type, described.message, {
      ...(described.level ? { level: described.level } : {}),
      ...(subject ? { subject } : {}),
      ...(described.data ? { data: described.data } : {}),
    });
  }

  override status(): ServiceStatus {
    const links = this.linkStatuses();
    const connected = links.filter((link) => link.connected);
    const detail = links.length === 0
      ? "No cameras configured"
      : `${connected.length} of ${links.length} camera${links.length === 1 ? "" : "s"} connected${connected.length < links.length ? ` (waiting: ${links.filter((link) => !link.connected).map((link) => link.name).join(", ")})` : ""}`;
    return { availability: connected.length > 0 ? "online" : links.length === 0 ? "unknown" : "degraded", detail };
  }

  override events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] {
    return this.log.recent(limit, filter);
  }

  override subjects(): readonly string[] {
    // Every configured camera, so the filter menu lists a quiet camera too.
    return [...new Set([...this.cameras.map((camera) => camera.deviceId), ...this.log.subjects()])];
  }

  override subscribe(listener: ServiceEventListener, filter?: EventFilter): () => void {
    return this.log.subscribe(listener, filter);
  }
}

declare module "../../models/device" {
  interface SiteServices {
    /** The local cloud emulator; the cameras it serves are subjects of its events, not services of their own. */
    tkenproCloud?: MeariCloudEmulatorService;
  }
}

/** One emulator service per runtime; `cameras` should be every camera configured in `devices.yml`. */
export function createTkenproCloudServices(cameras: readonly TkenproCameraIdentity[]): MeariCloudEmulatorService {
  return new MeariCloudEmulatorService(cameras);
}
