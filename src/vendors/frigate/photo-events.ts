import { createHash } from "node:crypto";
import { detectionLabel } from "../../models/detection-labels";
import { compileEventFilter, EventLog, type EventData, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";
import type { RevealPhotoArchive, SavedPhotoLabels } from "../reveal/photo-archive";
import type { FrigatePhotoImport } from "./photo-import";

export function photoLabelEvent(job: SavedPhotoLabels, subject: string): ServiceEvent & { data: EventData } {
  const result = job.result;
  const classification = result.classification;
  const message = classification ? `${classification.uncertain ? "Possibly " : ""}${classification.label} (${Math.round(classification.score * 100)}%)`
    : result.detections.map(detection => detection.label).join(", ") || "No objects detected";
  return { at: new Date(result.processedAt).toISOString(), level: "info", type: "photo_labeled", subject,
    message: `Photo labeled: ${message}`, data: {
      source: "reveal", eventId: createHash("sha256").update(JSON.stringify([job.id, job.serializedResult])).digest("hex"),
      photoId: job.id, camera: job.cameraId,
      ...(job.capturedAt !== null ? { capturedAt: job.capturedAt } : {}),
      ...(job.uploadedAt !== null ? { uploadedAt: job.uploadedAt } : {}),
      processedAt: result.processedAt, engine: result.engine, model: result.model, modelHash: result.modelHash,
      detections: result.detections,
      ...(classification ? { label: classification.label, confidence: classification.score, uncertain: classification.uncertain } : {}),
    } };
}

declare module "../../models/device" {
  interface SiteServices { photoLabelEvents?: PhotoLabelEvents }
}

/** The archive is the durable outbox. A broker callback acknowledges publication, not subscriber receipt. */
export class PhotoLabelEvents extends Service {
  private eventAt = 0;
  private readonly log = new EventLog(200, () => new Date(this.eventAt));
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private failed = false;

  constructor(private readonly archive: RevealPhotoArchive,
    private readonly cameras: () => readonly { cameraId: string; deviceId: string }[],
    private readonly publish: (event: ServiceEvent) => Promise<void>, private readonly native?: FrigatePhotoImport) {
    super("photo-labels", "Photo labels");
  }

  async prepare(): Promise<void> { await this.archive.prepare(); }

  check(): Promise<void> { return this.running ??= this.checkOnce().finally(() => { this.running = undefined; }); }
  private async checkOnce(): Promise<void> {
    if (this.stopped) return;
    const cameras = this.cameras();
    try {
      for (const job of await this.archive.pendingLabelEvents(cameras.map(camera => camera.cameraId), 20)) {
        if (this.stopped) break;
        const subject = cameras.find(camera => camera.cameraId === job.cameraId)?.deviceId;
        if (!subject) continue;
        const saved = photoLabelEvent(job, subject);
        this.eventAt = job.result.processedAt;
        const event = this.log.record(saved.type, saved.message, { subject, data: saved.data });
        // Published directly, excluded from index.ts's generic service fan-out, so we can acknowledge success.
        await this.publish(event);
        await this.archive.markLabelEventPublished(job.id, job.serializedResult);
      }
      this.failed = false;
    } catch { this.failed = true; }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.native?.start();
    const tick = async () => {
      await this.check();
      if (!this.stopped) { this.timer = setTimeout(tick, this.failed ? 30_000 : 1000); this.timer.unref(); }
    };
    void tick();
  }
  override status(): ServiceStatus {
    const { completed, total } = this.archive.labelCounts(this.cameras().map(camera => camera.cameraId));
    const native = this.native?.status();
    return { availability: this.stopped ? "offline" : this.failed || native?.failed ? "degraded" : "online",
      detail: (this.stopped ? "Stopped" : this.failed ? "Photo label publication failed; queued for retry" : `REVEAL: ${completed} of ${total} photos labeled; new photos added automatically`)
        + (native ? `; ${native.detail}` : "") };
  }
  override events(limit = 200, filter: EventFilter = {}) {
    const matches = compileEventFilter(filter);
    if (filter.level && filter.level !== "info" || filter.types?.length && !filter.types.includes("photo_labeled")) return [];
    const cameras = this.cameras().filter(camera => !filter.subject || camera.deviceId === filter.subject);
    return this.archive.labeledPhotos(cameras.map(camera => camera.cameraId), limit, filter.atOrBefore, filter.labels?.map(label => detectionLabel(label)!),
      filter.where ? job => matches(photoLabelEvent(job, cameras.find(camera => camera.cameraId === job.cameraId)!.deviceId)) : undefined)
      .map(job => photoLabelEvent(job, cameras.find(camera => camera.cameraId === job.cameraId)!.deviceId));
  }
  override subjects() { return this.cameras().map(camera => camera.deviceId); }
  override detectionLabels() { return this.archive.detectionLabels(this.cameras().map(camera => camera.cameraId)); }
  override detectionLabelCounts(subject?: string) {
    return this.archive.detectionLabelCounts(this.cameras().filter(camera => subject === undefined || camera.deviceId === subject).map(camera => camera.cameraId));
  }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  override async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; await this.native?.stop(); }
}
