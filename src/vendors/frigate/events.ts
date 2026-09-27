import { EventLog, type EventFilter, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";
import type { MqttBroker } from "../mqtt-broker";
import { protectRecordingLink, protectRecordingsConfig, type ProtectRecordingsConfig } from "./recordings";
import { frigateEventKey, type FrigateEventHistory } from "./event-history";
import { labelEventOrder } from "./label-feed";
import type { FrigateSnapshotReader } from "./snapshots";
import { PreviewAccessError, type DetectionPreviewReader } from "./previews";

declare module "../../models/device" {
  interface SiteServices { frigateEvents?: FrigateEvents }
}

export interface FrigateEventsConfig {
  topicPrefix: string;
  /** Only established mappings; other cameras retain their Frigate names. */
  cameras: Readonly<Record<string, string>>;
  recordings?: ProtectRecordingsConfig;
  /** Snapshot-only imports have no running video stream by design. */
  photoCameras?: readonly string[];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value);
const score = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 100_000_000_000;
const zones = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(name))].slice(0, 100).sort() : [];

export function frigateEventsConfig(value: unknown): FrigateEventsConfig | undefined {
  if (!object(value) || value.enabled !== true) return undefined;
  const prefix = value.topicPrefix ?? "frigate";
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(prefix) || prefix.length > 100
    || prefix === "hometruth" || prefix.startsWith("hometruth/")) throw new Error("Invalid Frigate MQTT topic prefix");
  const cameras = value.cameras ?? {};
  if (!object(cameras) || Object.entries(cameras).some(([camera, device]) => !name(camera) || !name(device))) {
    throw new Error("Invalid Frigate camera mapping");
  }
  const recordings = protectRecordingsConfig(value.recordings);
  return { topicPrefix: prefix, cameras: { ...cameras } as Record<string, string>, ...(recordings ? { recordings } : {}) };
}

export interface CameraObjectData extends Record<string, unknown> {
  source: "frigate"; objectId: string; camera: string; phase: "new" | "update" | "end";
  label: string; confidence: number; frameTime: number; startTime: number; endTime?: number;
  currentZones: string[]; enteredZones: string[]; subLabel?: string; subLabelConfidence?: number;
}

/** Copy an allowlist: never relay Frigate's base64 thumbnails or arbitrary metadata. Times are Unix seconds. */
export function normalizeFrigateObject(value: unknown): CameraObjectData | undefined {
  if (!object(value) || !["new", "update", "end"].includes(String(value.type)) || !object(value.after)) return;
  const a = value.after;
  const confidence = a.top_score ?? a.score;
  if (!name(a.id) || !name(a.camera) || !label(a.label) || a.false_positive !== false || !score(confidence)
    || !time(a.start_time) || !time(a.frame_time) || (a.end_time != null && !time(a.end_time))) return;
  if ((value.type === "end" && !time(a.end_time)) || (time(a.end_time) && a.end_time < a.start_time)) return;
  const sub = a.sub_label;
  return { source: "frigate", objectId: a.id, camera: a.camera, phase: value.type as CameraObjectData["phase"],
    label: a.label, confidence, frameTime: a.frame_time, startTime: a.start_time,
    ...(time(a.end_time) ? { endTime: a.end_time } : {}),
    currentZones: zones(a.current_zones), enteredZones: zones(a.entered_zones),
    ...(Array.isArray(sub) && label(sub[0]) ? { subLabel: sub[0], ...(score(sub[1]) ? { subLabelConfidence: sub[1] } : {}) } : {}),
  };
}

export function normalizeFrigateClassification(value: unknown): Record<string, unknown> | undefined {
  if (!object(value) || value.type !== "classification" || !name(value.id) || !name(value.camera)
    || !label(value.model) || !time(value.timestamp) || !score(value.score)) return;
  const classification = value.sub_label ?? value.attribute;
  if (!label(classification)) return;
  return { source: "frigate", objectId: value.id, camera: value.camera, model: value.model,
    label: classification, confidence: value.score, frameTime: value.timestamp,
    kind: value.sub_label != null ? "sub_label" : "attribute" };
}

/** How far into a track Frigate's best frame still stands for the moment of an update. */
export const BEST_FRAME_SPAN_SECONDS = 30;

/** Frigate names a track `<start time>-<random>`; an id that does not say is treated as starting now. */
export function trackStart(objectId: string, fallback: number): number {
  const start = Number(objectId.slice(0, objectId.indexOf("-")));
  return objectId.includes("-") && Number.isFinite(start) && start > 0 ? start : fallback;
}

export class FrigateEvents extends Service {
  private readonly log = new EventLog(500);
  private readonly unsubscribers: (() => void)[] = [];
  private readonly seen = new Set<string>();
  private lastSeenAt = 0;
  private available = false;
  private stopped = false;
  private frames: Readonly<Record<string, number>> = {};
  private historyFailed = false;

  constructor(broker: Pick<MqttBroker, "onMessage">, private readonly config: FrigateEventsConfig, private readonly now = Date.now,
    private readonly history?: FrigateEventHistory, private readonly snapshots?: FrigateSnapshotReader,
    private readonly previews?: DetectionPreviewReader) {
    super("frigate", "Frigate camera labels");
    // Save before live fan-out. Existing rows are read as backlog, never emitted again on startup.
    if (history) this.unsubscribers.push(this.log.subscribe(event => {
      try { history.save(event); this.historyFailed = false; } catch { this.historyFailed = true; }
    }));
    for (const suffix of ["events", "tracked_object_update", "available", "stats"]) {
      this.unsubscribers.push(broker.onMessage(`${config.topicPrefix}/${suffix}`, (_, payload) => {
        // A malformed upstream message must never escape into the broker's event loop.
        try { this.receive(suffix, payload); } catch { /* Ignore invalid messages; never log their content. */ }
      }));
    }
  }

  private receive(topic: string, payload: Buffer): void {
    if (this.stopped || payload.length > 1_048_576) return;
    if (topic === "available") {
      const text = payload.toString("utf8");
      if (text !== "online" && text !== "offline") return;
      this.lastSeenAt = this.now(); this.available = text === "online";
      return;
    }
    const value: unknown = JSON.parse(payload.toString("utf8"));
    if (topic === "stats") {
      if (!object(value) || !object(value.cameras)) return;
      this.frames = Object.fromEntries(Object.entries(value.cameras).filter(([camera, data]) => name(camera) && !this.config.photoCameras?.includes(camera) && object(data)
        && typeof data.camera_fps === "number" && Number.isFinite(data.camera_fps) && data.camera_fps >= 0)
        .map(([camera, data]) => [camera, (data as { camera_fps: number }).camera_fps]));
      this.lastSeenAt = this.now(); this.available = true;
      return;
    }
    const data = topic === "events" ? normalizeFrigateObject(value) : normalizeFrigateClassification(value);
    if (!data) return;
    this.lastSeenAt = this.now(); this.available = true;
    const hash = frigateEventKey(data);
    if (this.seen.has(hash)) return;
    try { if (this.history?.has(hash)) return; } catch { this.historyFailed = true; }
    this.seen.add(hash);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    const camera = data.camera as string;
    const subject = Object.hasOwn(this.config.cameras, camera) ? this.config.cameras[camera]! : `frigate-${camera}`;
    const type = topic === "events" ? "camera_object" : "camera_classified";
    const displayLabel = data.subLabel ?? data.label;
    // Link the observed frame, rather than an hours-old track start or MQTT arrival time.
    const recording = protectRecordingLink(this.config.recordings, camera, data.frameTime);
    this.log.record(type, `${camera}: ${displayLabel} (${Math.round((data.confidence as number) * 100)}%) · ${data.phase ?? "classified"} · ${data.objectId}`,
      { subject, data: { ...data, ...recording } });
  }

  override status(): ServiceStatus {
    if (this.stopped) return { availability: "offline", detail: "Stopped" };
    if (!this.lastSeenAt) return { availability: "unknown", detail: `Waiting for ${this.config.topicPrefix} MQTT events` };
    if (!this.available || this.now() - this.lastSeenAt > 180_000) return { availability: "offline", detail: "Frigate MQTT is offline or its heartbeat is stale" };
    const cameras = Object.entries(this.frames);
    const missing = cameras.filter(([, fps]) => fps === 0).map(([camera]) => camera);
    const detail = cameras.length
      ? `${cameras.length - missing.length} of ${cameras.length} video feeds producing frames${missing.length ? `; no frames: ${missing.join(", ")}` : ""}`
      : "Receiving Frigate object labels over MQTT";
    return { availability: missing.length || this.historyFailed ? "degraded" : "online",
      detail: detail + (this.historyFailed ? "; label history could not be saved or read" : "") };
  }
  override events(limit?: number, filter?: EventFilter) {
    const live = this.log.recent(limit, filter);
    if (!this.history) return live;
    try {
      const saved = this.history.recent(limit, filter);
      const unique = new Map([...saved, ...live].map(event => [frigateEventKey(event.data!), event]));
      return [...unique.values()].sort(labelEventOrder).slice(0, limit ?? 500);
    } catch { this.historyFailed = true; return live; }
  }
  override subjects() {
    let saved: readonly string[] = [];
    try { saved = this.history?.subjects() ?? []; } catch { this.historyFailed = true; }
    return [...new Set([...Object.values(this.config.cameras), ...Object.keys(this.frames).map(camera =>
      Object.hasOwn(this.config.cameras, camera) ? this.config.cameras[camera]! : `frigate-${camera}`), ...saved, ...this.log.subjects()])];
  }
  override detectionLabels() {
    try { return [...new Set([...(this.history?.detectionLabels() ?? []), ...super.detectionLabels()])].sort(); }
    catch { this.historyFailed = true; return super.detectionLabels(); }
  }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  /**
   * The picture for one detection. Frigate's snapshot is the track's best frame from any
   * moment of it, so for an update well after the track began (a car parked since morning,
   * updated at night) it shows another time of day. Then the recorded frame at `frameTime`
   * is the picture; when there is none, there is no picture rather than a misleading one.
   */
  async snapshot(camera: string, objectId: string, signal: AbortSignal, frameTime?: number): Promise<Uint8Array | undefined> {
    const known = frameTime === undefined
      ? this.log.recent().some(event => event.data?.camera === camera && event.data?.objectId === objectId) || this.history?.hasObject(camera, objectId)
      : this.log.recent().some(event => event.data?.camera === camera && event.data?.objectId === objectId && event.data?.frameTime === frameTime)
        || this.history?.hasObjectFrame(camera, objectId, frameTime);
    if (!known) return;
    if (frameTime !== undefined && frameTime - trackStart(objectId, frameTime) > BEST_FRAME_SPAN_SECONDS) {
      if (!this.previews) return;
      return this.previews.still(camera, frameTime, signal);
    }
    if (!this.snapshots) throw new Error("Frigate snapshot access is not configured");
    return this.snapshots.read(camera, objectId, signal);
  }
  async preview(camera: string, objectId: string, frameTime: number, signal: AbortSignal) {
    const known = this.log.recent().some(event => event.data?.camera === camera && event.data?.objectId === objectId
      && event.data?.frameTime === frameTime) || this.history?.hasObjectFrame(camera, objectId, frameTime);
    if (!known) return;
    if (!this.previews) throw new PreviewAccessError("Protect recording access is not configured");
    return this.previews.read(camera, frameTime, signal);
  }
  override async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.history?.close();
  }
}
