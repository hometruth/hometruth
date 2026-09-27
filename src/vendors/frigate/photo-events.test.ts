import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { PhotoLabels } from "../../camera-photos";
import type { ServiceEvent } from "../../models/event-log";
import { jpeg, samplePhoto } from "../../protocols/reveal/test-fixtures";
import { RevealPhotoArchive, revealPhotoKey } from "../reveal/photo-archive";
import { PhotoLabelEvents } from "./photo-events";
import { FrigatePhotoImport, frigatePhotoImportConfig } from "./photo-import";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const result: PhotoLabels = { engine: "speciesnet", model: "test", modelHash: "a".repeat(64), processedAt: 1234,
  detections: [{ label: "animal", score: 0.97, box: [0, 0, 1, 1] }],
  classification: { label: "raccoon", score: 0.9, uncertain: false, taxonomy: "raccoon", candidates: [] } };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "photo-label-events-"));
  // Create the older table first to exercise the production migration.
  const db = new Database(join(dir, "index.sqlite"));
  db.run("CREATE TABLE photo_labels (id TEXT PRIMARY KEY, result TEXT, attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL DEFAULT 0, error TEXT)"); db.close();
  const archive = new RevealPhotoArchive(dir);
  await archive.sync("cloud-camera", { listPhotos: async () => ({ photos: [{ ...samplePhoto, cameraId: "cloud-camera" }] }), downloadPhoto: async () => jpeg }, { intervalMs: 60_000 });
  expect((await archive.list("cloud-camera")).total).toBe(1);
  const id = revealPhotoKey("cloud-camera", samplePhoto.photoId);
  await archive.saveLabels(id, result);
  cleanups.push(async () => { await archive.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, archive, id };
}
const cameras = () => [{ cameraId: "cloud-camera", deviceId: "reveal-camera" }];

test("Filters select saved photo payloads before limits and agree with live publication", async () => {
  const f = await fixture();
  await f.archive.requestFullSync("cloud-camera");
  await f.archive.sync("cloud-camera", { listPhotos: async () => ({ photos: [{ ...samplePhoto, cameraId: "cloud-camera", photoId: "newer" }] }), downloadPhoto: async () => jpeg }, { intervalMs: 60_000 });
  await f.archive.saveLabels(revealPhotoKey("cloud-camera", "newer"), { ...result, processedAt: 9999,
    classification: { ...result.classification!, label: "dog" } });
  const service = new PhotoLabelEvents(f.archive, cameras, async () => {});
  const where = { path: "/data/label", op: "eq", value: "raccoon" } as const;
  expect(service.events(1, { where })).toMatchObject([{ data: { photoId: f.id, label: "raccoon" } }]);
  // Repeating a limited scan must not reuse a finalized SQLite statement.
  expect(service.events(1, { where })).toHaveLength(1);
  const received: ServiceEvent[] = [];
  const stop = service.subscribe(event => received.push(event), { where });
  await service.check();
  expect(received).toEqual(service.events(1, { where }));
  stop(); await service.stop();
});

test("saved species filters and live human/person aliases agree", async () => {
  const f = await fixture();
  const service = new PhotoLabelEvents(f.archive, cameras, async () => {});
  expect(service.events(1, { labels: ["raccoon"] })).toHaveLength(1);
  expect(service.events(1, { labels: ["person"] })).toHaveLength(0);
  expect(service.events(1, { labels: ["person", "raccoon"] })).toHaveLength(1);
  expect(service.detectionLabels()).toEqual(["animal", "raccoon"]);
  expect(service.detectionLabelCounts("reveal-camera")).toEqual({ animal: 1, raccoon: 1 });
  expect(service.detectionLabelCounts("another-camera")).toEqual({});
  await f.archive.saveLabels(f.id, { ...result, classification: { ...result.classification!, label: "human" } });
  const received: ServiceEvent[] = [];
  const unsubscribe = service.subscribe(event => received.push(event), { labels: ["person"] });
  await service.check();
  expect(received).toHaveLength(1);
  expect(received).toEqual(service.events(1, { labels: ["person"] }));
  expect(received).toEqual(service.events(1, { labels: ["Human"] }));
  expect(received).toEqual(service.events(1, { where: { detectionLabels: ["person"] } }));
  expect(service.detectionLabels()).toEqual(["animal", "person"]);
  expect(service.detectionLabelCounts("reveal-camera")).toEqual({ animal: 1, person: 1 });
  unsubscribe(); await service.stop();
});

test("Frigate import retries, survives restart, and queues new or changed photos without republishing MQTT", async () => {
  const f = await fixture();
  let fail = true, calls = 0;
  const target = { key: "test-frigate", async import(jobs: unknown[]) { calls++; expect(jobs).toHaveLength(1); if (fail) throw new Error("private error"); } };
  const mapping = () => [{ cameraId: "cloud-camera", camera: "reveal" }];
  const importer = new FrigatePhotoImport(f.archive, target, mapping);
  await importer.check();
  expect(importer.status()).toMatchObject({ failed: true });
  expect(await f.archive.pendingNativePhotos(["cloud-camera"], target.key)).toHaveLength(1);
  expect(importer.status().detail).not.toContain("private");
  fail = false; await importer.check(); await importer.stop();
  expect(f.archive.nativePhotoCount(["cloud-camera"], target.key)).toBe(1);
  const reopened = new RevealPhotoArchive(f.dir); await reopened.prepare(); cleanups.push(() => reopened.close());
  const restarted = new FrigatePhotoImport(reopened, target, mapping);
  await restarted.check(); expect(calls).toBe(2);
  // A response for an older result must not acknowledge a replacement result.
  const old = JSON.stringify(result);
  await reopened.saveLabels(f.id, { ...result, processedAt: 9999 });
  await reopened.markNativePhoto(f.id, old, target.key);
  expect(await reopened.pendingNativePhotos(["cloud-camera"], target.key)).toHaveLength(1);
  await restarted.check(); expect(calls).toBe(3);
  expect(await reopened.pendingLabelEvents(["cloud-camera"])).toHaveLength(1);
  // A future cloud photo enters the same labeling/import queues.
  await reopened.requestFullSync("cloud-camera");
  await reopened.sync("cloud-camera", { listPhotos: async () => ({ photos: [{ ...samplePhoto, cameraId: "cloud-camera", photoId: "future" }] }), downloadPhoto: async () => jpeg }, { intervalMs: 60_000 });
  await reopened.saveLabels(revealPhotoKey("cloud-camera", "future"), result);
  await restarted.check(); expect(calls).toBe(4);
  expect(reopened.nativePhotoCount(["cloud-camera"], target.key)).toBe(2);
  await restarted.stop();
});

test("native photo import config rejects shell syntax, duplicate targets and unsupported names", () => {
  const good = { enabled: true, sshConfigPath: "/tmp/ssh_config", sshHost: "frigate", container: "frigate", cameras: { reveal: "reveal_cam1" } };
  expect(frigatePhotoImportConfig(good)?.cameras.reveal).toBe("reveal_cam1");
  expect(() => frigatePhotoImportConfig({ ...good, container: "frigate; id" })).toThrow();
  expect(() => frigatePhotoImportConfig({ ...good, cameras: { a: "same", b: "same" } })).toThrow();
});

test("publishes existing labels, persists acknowledgements across restart, then emits changed results", async () => {
  const f = await fixture();
  const received: ServiceEvent[] = [];
  const publish = async (event: ServiceEvent) => { received.push(event); };
  const service = new PhotoLabelEvents(f.archive, cameras, publish);
  await Promise.all([service.check(), service.check()]);
  await service.check();
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ type: "photo_labeled", subject: "reveal-camera", data: { photoId: f.id, label: "raccoon", confidence: 0.9, processedAt: 1234 } });
  const reopened = new RevealPhotoArchive(f.dir);
  cleanups.push(() => reopened.close());
  const restarted = new PhotoLabelEvents(reopened, cameras, publish);
  await restarted.check();
  expect(received).toHaveLength(1);
  expect(restarted.events()).toHaveLength(1);
  expect(received[0]).toEqual(restarted.events()[0]);
  expect(restarted.events(20, { subject: "another-camera" })).toEqual([]);
  expect(restarted.events(20, { atOrBefore: "1970-01-01T00:00:01.000Z" })).toEqual([]);
  expect(restarted.subjects()).toContain("reveal-camera");
  await reopened.saveLabels(f.id, { ...result, processedAt: 1235 });
  await restarted.check();
  expect(received).toHaveLength(2);
  expect(received[1]?.data?.eventId).not.toBe(received[0]?.data?.eventId);
  await restarted.stop(); await service.stop();
});

test("failed publication stays queued and retries with the same event ID", async () => {
  const f = await fixture();
  const received: ServiceEvent[] = [];
  let fail = true;
  const service = new PhotoLabelEvents(f.archive, cameras, async event => { received.push(event); if (fail) throw new Error("private error"); });
  await service.check();
  expect(service.status().availability).toBe("degraded");
  expect(await f.archive.pendingLabelEvents(["cloud-camera"])).toHaveLength(1);
  fail = false;
  await service.check();
  expect(received[0]?.data?.eventId).toBe(received[1]?.data?.eventId);
  expect(await f.archive.pendingLabelEvents(["cloud-camera"])).toHaveLength(0);
  expect(JSON.stringify(service.events())).not.toContain("private");
  await service.stop();
});

test("does not acknowledge an inference result replaced while it was being sent", async () => {
  const f = await fixture();
  const job = (await f.archive.pendingLabelEvents(["cloud-camera"]))[0]!;
  await f.archive.saveLabels(f.id, { ...result, processedAt: 9999 });
  await f.archive.markLabelEventPublished(f.id, job.serializedResult);
  expect(await f.archive.pendingLabelEvents(["cloud-camera"])).toHaveLength(1);
  expect(await f.archive.pendingLabelEvents(["another-camera"])).toHaveLength(0);
});
