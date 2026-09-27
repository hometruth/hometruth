import type { EventFilter, ServiceEvent, ServiceEventListener } from "../../models/event-log";
import { Service } from "../../models/service";
import { frigateEventKey } from "./event-history";

export function labelEventOrder(a: ServiceEvent, b: ServiceEvent): number {
  const key = (e: ServiceEvent) => e.type === "photo_labeled" ? `photo:${e.data?.photoId}` : `video:${frigateEventKey(e.data ?? {})}`;
  return b.at.localeCompare(a.at) || key(b).localeCompare(key(a));
}

/** A read/subscribe projection. Source services own storage, MQTT delivery and lifecycle. */
export class CameraLabelFeed extends Service {
  constructor(private readonly video: Service, private readonly photos?: Service) { super(video.id, video.title); }
  private sources() { return this.photos ? [this.video, this.photos] : [this.video]; }
  override status() {
    const video = this.video.status();
    if (!this.photos) return video;
    const photos = this.photos.status();
    return { availability: video.availability === "online" && photos.availability !== "online" ? "degraded" as const : video.availability,
      detail: `${video.detail}; ${photos.detail}` };
  }
  override subjects() { return [...new Set(this.sources().flatMap(source => [...source.subjects()]))]; }
  override detectionLabels() { return [...new Set(this.sources().flatMap(source => [...source.detectionLabels()]))].sort(); }
  override detectionLabelCounts(subject?: string) {
    const counts = new Map<string, number>();
    for (const source of this.sources()) for (const [label, count] of Object.entries(source.detectionLabelCounts(subject))) {
      counts.set(label, (counts.get(label) ?? 0) + count);
    }
    return Object.fromEntries(counts);
  }
  detectionOptions(subjects?: readonly string[]) {
    const counts = new Map<string, number>();
    for (const subject of subjects === undefined ? [undefined] : new Set(subjects)) {
      for (const [label, count] of Object.entries(this.detectionLabelCounts(subject))) counts.set(label, (counts.get(label) ?? 0) + count);
    }
    return { labels: this.detectionLabels(), labelCounts: Object.fromEntries(counts) };
  }
  override events(limit = 100, filter?: EventFilter) {
    return this.sources().flatMap(source => [...source.events(limit, filter)]).sort(labelEventOrder).slice(0, limit);
  }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) {
    const stop = this.sources().map(source => source.subscribe(listener, filter));
    return () => stop.forEach(unsubscribe => unsubscribe());
  }

  page(limit = 100, cursor?: string, filter: EventFilter = {}): { events: ServiceEvent[]; nextCursor?: string } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid label page size");
    let at: string | undefined, skip = 0;
    if (cursor) {
      try {
        if (cursor.length > 256 || !/^[a-zA-Z0-9_-]+$/u.test(cursor)) throw new Error();
        const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string"
          || new Date(decoded[0]).toISOString() !== decoded[0] || !Number.isSafeInteger(decoded[1]) || decoded[1] < 0 || decoded[1] > 100_000) throw new Error();
        [at, skip] = decoded as [string, number];
      } catch { throw new Error("Invalid label history cursor"); }
    }
    const rows = this.events(limit + skip + 1, { ...filter, ...(at ? { atOrBefore: at } : {}) }).slice(skip);
    const events = rows.slice(0, limit);
    const last = events.at(-1);
    const nextSkip = last ? (last.at === at ? skip : 0) + events.filter(event => event.at === last.at).length : 0;
    return { events, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.at, nextSkip])).toString("base64url") } : {}) };
  }
}
