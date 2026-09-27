import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrigateEventHistory } from "./event-history";
import { FrigateEvents, type FrigateEventsConfig } from "./events";
import { importFrigateHistory, normalizeFrigateHistory } from "./import-history";
import type { MqttMessageHandler } from "../mqtt-broker";

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const config: FrigateEventsConfig = { topicPrefix: "frigate", cameras: { front: "front-camera", quiet: "quiet-camera", offline: "offline-camera" },
  recordings: { baseUrl: "https://nvr.example.test/protect", cameras: { quiet: "a".repeat(24) }, preRollSeconds: 5 } };
const prior = (camera: string, start = 100) => ({ id: `${start}-${camera}`, camera, label: "person", start_time: start, end_time: start + 10,
  zones: ["yard"], top_score: null, false_positive: null, data: { type: "object", top_score: 0.9 }, thumbnail: "private-image" });
const harness = (history: FrigateEventHistory) => {
  const handlers = new Map<string, MqttMessageHandler>();
  const service = new FrigateEvents({ onMessage(topic, fn) { handlers.set(topic, fn); return () => { handlers.delete(topic); }; } }, config, Date.now, history);
  return { service, send: (camera: string) => handlers.get("frigate/events")!("frigate/events", Buffer.from(JSON.stringify({ type: "new", after: {
    id: "track-1", camera, label: "dog", top_score: 0.95, false_positive: false, start_time: 200, frame_time: 202,
  } }))) };
};

test("detection filters match any selected label before limiting saved history", () => {
  const history = new FrigateEventHistory(":memory:");
  try {
    importFrigateHistory(history, [prior("quiet", 100), { ...prior("front", 101), label: "animal", sub_label: "bobcat" },
      ...Array.from({ length: 205 }, (_, n) => ({ ...prior("front", 102 + n), label: "car" }))], config);
    expect(history.recent(1, { labels: ["person"] })[0]?.data?.label).toBe("person");
    expect(history.recent(1, { labels: ["Human"] })[0]?.data?.label).toBe("person");
    expect(history.recent(10, { labels: ["person", "bobcat"] })).toHaveLength(2);
    expect(history.recent(10, { labels: ["person", "bobcat"], subject: "quiet-camera" })).toHaveLength(1);
    expect(history.recent(10, { labels: ["unknown"] })).toHaveLength(0);
    expect(history.recent(1, { where: { all: [
      { path: "/subject", op: "eq", value: "quiet-camera" },
      { path: "/data/label", op: "eq", value: "person" },
    ] } }).map(event => event.subject)).toEqual(["quiet-camera"]);
    expect(history.recent(1, { where: { detectionLabels: ["person"] } })[0]?.subject).toBe("quiet-camera");
    expect(history.detectionLabels()).toEqual(["animal", "bobcat", "car", "person"]);
    const { service, send } = harness(history);
    expect(service.detectionLabelCounts()).toEqual({ animal: 1, bobcat: 1, car: 205, person: 1 });
    expect(service.detectionLabelCounts("quiet-camera")).toEqual({ person: 1 });
    expect(service.detectionLabelCounts("offline-camera")).toEqual({});
    send("quiet");
    // The same live event is also persisted: count it once.
    expect(service.detectionLabelCounts("quiet-camera")).toEqual({ person: 1, dog: 1 });
  } finally { history.close(); }
});

test("camera labels survive reopening, preserve timestamps, and are not replayed to subscribers", async () => {
  const folder = mkdtempSync(join(tmpdir(), "frigate-history-")); folders.push(folder);
  const path = join(folder, "events.sqlite");
  const first = harness(new FrigateEventHistory(path));
  first.send("front"); first.send("quiet");
  const before = first.service.events();
  await first.service.stop();
  const second = harness(new FrigateEventHistory(path));
  const published: unknown[] = [];
  second.service.subscribe(event => published.push(event));
  expect(second.service.events()).toEqual(before);
  // Saved events cannot make an offline server look online.
  expect(second.service.status().availability).toBe("unknown");
  second.send("front");
  expect(published).toHaveLength(0);
  expect(second.service.subjects()).toContain("offline-camera");
  expect(second.service.events(1, { subject: "quiet-camera" })[0]?.data?.camera).toBe("quiet");
  expect(second.service.status().availability).toBe("online");
  await second.service.stop();
});

test("Frigate REST backfill preserves source time, links recordings, and deduplicates tracks", () => {
  const history = new FrigateEventHistory(":memory:");
  try {
    const values = [prior("quiet"), prior("front"), { ...prior("front", 101), false_positive: true }, { ...prior("front", 102), data: { type: "manual" } }];
    expect(importFrigateHistory(history, values, config)).toBe(2);
    expect(importFrigateHistory(history, values, config)).toBe(0);
    const quiet = history.recent(1, { subject: "quiet-camera" })[0]!;
    expect(quiet).toMatchObject({ at: "1970-01-01T00:01:40.000Z", data: { confidence: 0.9, historical: true,
      recordingUrl: `https://nvr.example.test/protect/timelapse/${"a".repeat(24)}?start=95000` } });
    expect(JSON.stringify(history.recent())).not.toContain("private-image");
    expect(normalizeFrigateHistory({ ...prior("front"), data: { type: "object", top_score: 2 } }, config)).toBeUndefined();
  } finally { history.close(); }
});

test("bounded metadata history filters before limiting and rejects image data", () => {
  const history = new FrigateEventHistory(":memory:", 3);
  try {
    expect(importFrigateHistory(history, [prior("quiet", 100), prior("front", 101), prior("front", 102), prior("front", 103)], config)).toBe(4);
    expect(history.recent()).toHaveLength(3);
    expect(history.subjects()).toEqual(["front-camera"]);
    expect(history.recent(1, { subject: "quiet-camera" })).toEqual([]);
    expect(history.recent(1, { types: ["camera_classified"] })).toEqual([]);
    expect(history.recent(1, { level: "error" })).toEqual([]);
    const event = normalizeFrigateHistory(prior("front", 104), config)!;
    expect(() => history.save({ ...event, data: { ...event.data, thumbnail: "private-image" } })).toThrow("Invalid Frigate history event");
  } finally { history.close(); }
});
