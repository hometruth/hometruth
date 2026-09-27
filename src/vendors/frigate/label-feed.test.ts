import { expect, test } from "bun:test";
import { matchesFilter, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../../models/event-log";
import { Service } from "../../models/service";
import { CameraLabelFeed, labelEventOrder } from "./label-feed";

class Source extends Service {
  readonly listeners = new Set<ServiceEventListener>();
  constructor(id: string, readonly rows: ServiceEvent[]) { super(id, id); }
  override status() { return { availability: "online" as const, detail: this.id }; }
  override subjects() { return [...new Set(this.rows.map(row => row.subject!))]; }
  override events(limit = 200, filter: EventFilter = {}) { return this.rows.filter(row => matchesFilter(row, filter)).sort(labelEventOrder).slice(0, limit); }
  override subscribe(fn: ServiceEventListener, filter: EventFilter = {}) {
    const listener = (event: ServiceEvent) => { if (matchesFilter(event, filter)) fn(event); };
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
}

test("all 588 photos page alongside video labels, including equal timestamps and new arrivals", () => {
  const rows = Array.from({ length: 588 }, (_, n): ServiceEvent => ({ at: "2026-09-11T20:00:00.000Z", type: "photo_labeled", level: "info", subject: "reveal",
    message: `Photo ${n}`, data: { photoId: n.toString(16).padStart(64, "0"), eventId: `event-${n}` } }));
  const video = new Source("frigate", [{ at: rows[0]!.at, type: "camera_object", level: "info", subject: "front", message: "Person", data: { camera: "front", objectId: "one" } }]);
  const photos = new Source("photo-labels", rows);
  const feed = new CameraLabelFeed(video, photos);
  const found: ServiceEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = feed.page(100, cursor);
    found.push(...page.events); cursor = page.nextCursor; pages++;
    if (pages === 1) photos.rows.push({ ...rows[0]!, at: "2026-09-11T21:00:00.000Z", data: { photoId: "new" }, message: "New arrival" });
  } while (cursor && pages < 10);
  expect(pages).toBe(6);
  expect(found).toHaveLength(589);
  expect(new Set(found.map(row => row.message)).size).toBe(589);
  expect(feed.page(100, undefined, { subject: "front" }).events).toHaveLength(1);
  expect(feed.page(100, undefined, { types: ["camera_classified"] }).events).toHaveLength(0);
  expect(feed.subjects()).toEqual(["front", "reveal"]);
  for (const invalid of ["garbage", "../", Buffer.from(JSON.stringify([rows[0]!.at, -1])).toString("base64url")]) expect(() => feed.page(100, invalid)).toThrow();
});

test("combined subscriptions relay new photo events once and unsubscribe both sources", () => {
  const video = new Source("frigate", []), photos = new Source("photo-labels", []);
  const feed = new CameraLabelFeed(video, photos);
  const received: ServiceEvent[] = [];
  const stop = feed.subscribe(event => received.push(event), { subject: "reveal" });
  const event: ServiceEvent = { at: new Date().toISOString(), type: "photo_labeled", level: "info", subject: "reveal", message: "Bobcat" };
  photos.listeners.forEach(listener => listener(event));
  video.listeners.forEach(listener => listener({ ...event, subject: "front" }));
  expect(received).toEqual([event]);
  stop();
  expect(video.listeners.size + photos.listeners.size).toBe(0);
});

test("camera detection counts cover older pages and merge photo species with video labels", () => {
  const row = (subject: string, label: string): ServiceEvent => ({ at: "2026-09-11T20:00:00.000Z", type: "camera_object", level: "info", subject, message: label, data: { label } });
  const video = new Source("frigate", [row("front", "person"), row("front", "dog")]);
  const photos = new Source("photo-labels", Array.from({ length: 588 }, () => ({ ...row("reveal", "animal"), type: "photo_labeled",
    data: { detections: [{ label: "animal" }, { label: "animal" }], classification: { label: "raccoon" } } })));
  const feed = new CameraLabelFeed(video, photos);
  expect(feed.detectionOptions(["reveal"])).toEqual({ labels: ["animal", "dog", "person", "raccoon"], labelCounts: { animal: 588, raccoon: 588 } });
  expect(feed.detectionOptions(["front", "reveal", "front"]).labelCounts).toEqual({ person: 1, dog: 1, animal: 588, raccoon: 588 });
  expect(feed.detectionOptions([]).labelCounts).toEqual({});
  expect(feed.detectionLabelCounts("front")).toEqual({ person: 1, dog: 1 });
  expect(feed.detectionLabelCounts("offline")).toEqual({});
  expect(feed.detectionLabelCounts()).toEqual({ person: 1, dog: 1, animal: 588, raccoon: 588 });
});


test("one Filter selects photo and video Events before pagination and during live delivery", () => {
  const event = (id: string, type: string, data: Record<string, unknown>): ServiceEvent => ({ at: "2026-09-11T20:00:00.000Z", type, subject: "camera-4", level: "info", message: id, data: { ...data, eventId: id, objectId: id } });
  const video = new Source("frigate", [event("video", "camera_object", { label: "human" }), event("car", "camera_object", { label: "car" })]);
  const photos = new Source("photo-labels", [event("photo", "photo_labeled", { detections: [{ label: "person" }] })]);
  const feed = new CameraLabelFeed(video, photos);
  const filter = { where: { all: [{ path: "/subject", op: "eq", value: "camera-4" }, { detectionLabels: ["person"] }] } } as const;
  const first = feed.page(1, undefined, filter);
  const second = feed.page(1, first.nextCursor, filter);
  expect(new Set([...first.events, ...second.events].map(row => row.message))).toEqual(new Set(["video", "photo"]));
  expect(second.nextCursor).toBeUndefined();
  const received: ServiceEvent[] = [];
  const stop = feed.subscribe(row => received.push(row), filter);
  for (const source of [photos, video]) for (const row of source.rows) source.listeners.forEach(listener => listener(row));
  expect(received.map(row => row.message)).toEqual(["photo", "video"]);
  stop();
});
