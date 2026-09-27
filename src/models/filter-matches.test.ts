import { expect, test } from "bun:test";
import { EventLog, type ServiceEvent } from "./event-log";
import { FilterStore } from "./filter-store";
import { FilterMatches } from "./filter-matches";
import { EventBusForwarder } from "../event-bus";
import { validateEventData } from "../validation";

const detection = (at = "2026-09-21T23:00:00Z", label = "person"): ServiceEvent => ({
  at, type: "camera_object", level: "info", subject: "camera-4", message: `Camera 4: ${label}`,
  data: { source: "frigate", camera: "camera_4", objectId: "track-1", phase: "new", label,
    confidence: 0.95, frameTime: Date.parse(at) / 1000, startTime: Date.parse(at) / 1000, currentZones: [], enteredZones: [] },
});
const people = { detectionLabels: ["person"] };

test("every matching saved Filter emits a typed event retaining the source subject and full Event", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store, () => new Date("2026-09-22T12:00:00Z"));
  try {
    const first = store.create({ name: "People", condition: people });
    const night = store.create({ name: "Night", condition: { timeWindow: { start: "20:00", end: "08:00", timeZone: "UTC" } } });
    store.create({ name: "Dogs", condition: { detectionLabels: ["dog"] } });
    const received: ServiceEvent[] = [];
    matches.subscribe(event => received.push(event));
    const source = detection();
    matches.accept(source);
    expect(received).toHaveLength(2);
    expect(new Set(received.map(event => event.data!.filterId))).toEqual(new Set([first.filter.id, night.filter.id]));
    for (const event of received) {
      expect(event).toMatchObject({ at: "2026-09-22T12:00:00.000Z", type: "filter_matched", level: "info", subject: "camera-4",
        data: { filterRevision: 1, event: source } });
      expect(validateEventData(event.type, event.data)).toBe(true);
      expect(event.data!.event).not.toBe(source);
    }
    // Each output owns a snapshot; subscriber mutation cannot change the input or a sibling match.
    (received[0]!.data!.event as ServiceEvent).data!.label = "changed";
    expect((received[1]!.data!.event as ServiceEvent).data!.label).toBe("person");
    expect(source.data!.label).toBe("person");
    matches.accept(source);
    expect(received).toHaveLength(2);
    expect(matches.subjects()).toEqual(["camera-4"]);
    expect(matches.events(1, { where: { path: "/data/filterId", op: "eq", value: first.filter.id } })).toHaveLength(1);
  } finally { await matches.stop(); store.close(); }
});

test("new, edited, renamed and deleted filters affect the next event; failed writes do not invalidate the cache", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  const list = store.list.bind(store);
  let reads = 0;
  store.list = () => { reads++; return list(); };
  try {
    matches.accept(detection());
    expect(matches.events()).toEqual([]);
    const record = store.create({ name: "People", condition: people });
    matches.accept(detection());
    const cachedReads = reads;
    matches.accept(detection("2026-09-22T00:00:00Z"));
    expect(reads).toBe(cachedReads);
    expect(matches.events()).toHaveLength(2);
    store.update(record.filter.id, { name: "Dogs", condition: { detectionLabels: ["dog"] }, revision: 1 });
    const generation = store.generation;
    expect(() => store.update(record.filter.id, { name: "Stale", condition: people, revision: 1 })).toThrow();
    expect(store.generation).toBe(generation);
    matches.accept(detection());
    expect(matches.events()).toHaveLength(2);
    matches.accept(detection(undefined, "dog"));
    expect(matches.events()[0]!.data).toMatchObject({ filterId: record.filter.id, filterName: "Dogs", filterRevision: 2 });
    store.delete(record.filter.id, 2);
    matches.accept(detection(undefined, "dog"));
    expect(matches.events()).toHaveLength(3);
    expect(matches.status().detail).toContain("0 saved filters");
  } finally { await matches.stop(); store.close(); }
});

test("source subscriptions evaluate live events only, deduplicate connections and stop cleanly", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  const source = new EventLog();
  try {
    store.create({ name: "Every event", condition: { all: [] } });
    source.record("motion", "History", { subject: "camera-4", data: { bytes: 0 } });
    matches.connect([source, source, matches]);
    matches.connect([source]);
    expect(matches.events()).toEqual([]);
    const live = source.record("motion", "New motion", { subject: "camera-4", data: { bytes: 0 } });
    expect(matches.events()).toHaveLength(1);
    expect(matches.events()[0]!.data!.event).toEqual(live);
    // Pure history reads never trigger evaluation.
    source.recent(); matches.events();
    expect(matches.events()).toHaveLength(1);
    await matches.stop();
    source.record("motion", "After stop", { data: { bytes: 0 } });
    matches.accept(detection());
    expect(matches.events()).toHaveLength(1);
    expect(matches.status().availability).toBe("offline");
  } finally { await matches.stop(); store.close(); }
});

test("match events cannot recurse, and forwarding emits each match once without a broker server", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  const publications: ServiceEvent[] = [];
  const forwarder = new EventBusForwarder({ async publishEvent(event) { publications.push(event); matches.accept(event); } }, () => {});
  try {
    store.create({ name: "Everything", condition: { all: [] } });
    matches.subscribe(matches.accept);
    matches.subscribe(forwarder.publish);
    matches.accept(detection());
    await forwarder.stop();
    expect(matches.events()).toHaveLength(1);
    expect(publications).toEqual([...matches.events()]);
    // The rule also applies to a deserialized/mirrored match with a fresh object identity.
    matches.accept(structuredClone(publications[0]!));
    expect(matches.events()).toHaveLength(1);
  } finally { await forwarder.stop(); await matches.stop(); store.close(); }
});

test("a photo outbox retry emits no duplicate match; a newly classified result is a new Event", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  try {
    store.create({ name: "People", condition: people });
    const photo: ServiceEvent = { at: "2026-09-21T23:00:00Z", type: "photo_labeled", level: "info", subject: "camera-5", message: "Photo labeled: person",
      data: { source: "reveal", eventId: "a".repeat(64), photoId: "b".repeat(64), camera: "camera_5", processedAt: 1,
        engine: "example", model: "example", modelHash: "c".repeat(64), detections: [{ label: "person", score: 0.9, box: [0, 0, 1, 1] }] } };
    expect(validateEventData(photo.type, photo.data)).toBe(true);
    matches.accept(photo);
    matches.accept(structuredClone(photo));
    expect(matches.events()).toHaveLength(1);
    matches.accept({ ...photo, data: { ...photo.data, eventId: "d".repeat(64) } });
    expect(matches.events()).toHaveLength(2);
  } finally { await matches.stop(); store.close(); }
});

test("one source event uses a consistent filter revision snapshot even when a listener edits another filter", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  try {
    store.create({ name: "A first", condition: people });
    const second = store.create({ name: "B second", condition: people });
    const unsubscribe = matches.subscribe(() => {
      unsubscribe();
      store.update(second.filter.id, { name: "B changed", condition: { detectionLabels: ["dog"] }, revision: 1 });
    });
    matches.accept(detection());
    expect(matches.events()).toHaveLength(2);
    expect(matches.events().find(event => event.data!.filterId === second.filter.id)!.data).toMatchObject({ filterName: "B second", filterRevision: 1 });
    matches.accept(detection());
    expect(matches.events()).toHaveLength(3);
  } finally { await matches.stop(); store.close(); }
});
