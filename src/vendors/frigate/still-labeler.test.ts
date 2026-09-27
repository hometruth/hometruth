import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jpeg, samplePhoto } from "../../protocols/reveal/test-fixtures";
import { RevealPhotoArchive, revealPhotoKey } from "../reveal/photo-archive";
import { frigateStillsConfig, parsePhotoLabels, RevealPhotoLabeling } from "./still-labeler";

const result = () => ({ engine: "SpeciesNet on Frigate host", model: "SpeciesNet 4.0.3a", modelHash: "a".repeat(64), processedAt: 1234,
  imageHash: createHash("sha256").update(jpeg).digest("hex"), detections: [{ label: "animal", score: 0.95, box: [0.1, 0.2, 0.7, 0.8] }],
  classification: { label: "raccoon", score: 0.87, taxonomy: "id;animalia;procyon lotor;raccoon", uncertain: false,
    candidates: [{ label: "raccoon", score: 0.87 }] } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("validates confidence, image identity and boxes, and drops undeclared upstream fields", () => {
  const valid = parsePhotoLabels({ ...result(), url: "private", token: "private" }, jpeg);
  expect(valid.classification?.label).toBe("raccoon");
  expect(JSON.stringify(valid)).not.toContain("private");
  expect(() => parsePhotoLabels({ ...result(), imageHash: "b".repeat(64) }, jpeg)).toThrow();
  expect(() => parsePhotoLabels({ ...result(), detections: [{ label: "animal", score: NaN, box: [0, 0, 1, 1] }] }, jpeg)).toThrow();
  expect(() => parsePhotoLabels({ ...result(), detections: [{ label: "animal", score: 1, box: [0.8, 0, 0.2, 1] }] }, jpeg)).toThrow();
  expect(() => parsePhotoLabels({ ...result(), classification: { ...result().classification, score: 1.1 } }, jpeg)).toThrow();
});

test("SSH configuration rejects shell syntax and option injection", () => {
  const config = { enabled: true, sshConfigPath: "/private/ssh_config", sshHost: "frigate", container: "hometruth-photo-labeler" };
  expect(frigateStillsConfig(config)?.container).toBe("hometruth-photo-labeler");
  expect(frigateStillsConfig({ enabled: false })).toBeUndefined();
  for (const patch of [{ sshHost: "-oProxyCommand=bad" }, { container: "name;command" }, { sshConfigPath: "relative/path" }]) {
    expect(() => frigateStillsConfig({ ...config, ...patch })).toThrow();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-photo-labeling-"));
  let now = 1_000_000;
  const archive = new RevealPhotoArchive(directory, () => now);
  const photos = [samplePhoto, { ...samplePhoto, photoId: "second" }];
  const client = { listPhotos: async () => ({ photos }), downloadPhoto: async () => jpeg };
  await archive.sync("camera-1", client, { intervalMs: 60_000 });
  cleanups.push(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  return { archive, directory, photos, client, now: () => now, advance: () => { now += 120_000; } };
}

test("backfills old photos once, persists labels across restarts, then queues future imports", async () => {
  const f = await fixture();
  let calls = 0;
  const labeler = { label: async () => { calls++; return parsePhotoLabels(result(), jpeg); } };
  const worker = new RevealPhotoLabeling(f.archive, labeler, () => ["camera-1"], f.now);
  cleanups.push(() => worker.stop());
  await Promise.all([worker.check(), worker.check()]);
  expect(calls).toBe(1);
  await worker.check();
  await worker.check();
  expect(calls).toBe(2);
  expect((await f.archive.list("camera-1")).labeling).toEqual({ completed: 2, pending: 0, retrying: 0 });
  const reopened = new RevealPhotoArchive(f.directory, f.now);
  cleanups.push(() => reopened.close());
  expect(await reopened.pendingLabels(["camera-1"])).toEqual([]);
  expect((await reopened.list("camera-1")).photos[0]?.labeling?.result?.classification?.label).toBe("raccoon");
  f.advance();
  f.photos.unshift({ ...samplePhoto, photoId: "new-photo" });
  await f.archive.sync("camera-1", f.client, { intervalMs: 60_000 });
  expect(await f.archive.pendingLabels(["camera-1"], 1)).toEqual([{ cameraId: "camera-1", id: revealPhotoKey("camera-1", "new-photo") }]);
  await worker.check();
  expect(calls).toBe(3);
  expect((await f.archive.list("camera-1")).labeling?.pending).toBe(0);
  expect((await f.archive.list("other-camera")).total).toBe(0);
});

test("failures back off globally, keep successful photos, and never persist sensitive error text", async () => {
  const f = await fixture();
  let fail = true, calls = 0;
  const worker = new RevealPhotoLabeling(f.archive, { label: async () => {
    calls++;
    if (fail) throw new Error("private SSH information and token");
    return parsePhotoLabels(result(), jpeg);
  } }, () => ["camera-1"], f.now);
  cleanups.push(() => worker.stop());
  await worker.check();
  await worker.check();
  expect(calls).toBe(1);
  const page = await f.archive.list("camera-1");
  expect(page.labeling).toEqual({ completed: 0, pending: 2, retrying: 1 });
  expect(JSON.stringify(page)).not.toContain("private");
  f.advance(); fail = false;
  await worker.check();
  await worker.check();
  expect((await f.archive.list("camera-1")).labeling?.completed).toBe(2);
});

test("shutdown does not save an unfinished inference result", async () => {
  const f = await fixture();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const worker = new RevealPhotoLabeling(f.archive, { label: async () => { await gate; return parsePhotoLabels(result(), jpeg); } }, () => ["camera-1"], f.now);
  const check = worker.check();
  const stop = worker.stop();
  finish();
  await Promise.all([check, stop]);
  expect((await f.archive.list("camera-1")).labeling?.completed).toBe(0);
});
