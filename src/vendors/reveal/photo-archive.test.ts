import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TactacamReveal } from "../../devices/cameras/tactacam-reveal";
import { RevealError, type RevealPhoto, type RevealPhotoPage } from "../../protocols/reveal/client";
import { jpeg, samplePhoto } from "../../protocols/reveal/test-fixtures";
import { createApp } from "../../server/app";
import { Site } from "../../site";
import { RevealPhotoArchive, revealPhotoKey } from "./photo-archive";
import { startRevealPhotoPolling } from "./polling";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-reveal-archive-"));
  let now = 1_000_000;
  const archive = new RevealPhotoArchive(directory, () => now);
  cleanup.push(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  let pages: RevealPhotoPage[] = [{ photos: [samplePhoto] }];
  const downloads: string[] = [];
  const requests: (string | undefined)[] = [];
  const client = {
    listPhotos: async ({ paginationKey }: { cameraId: string; paginationKey?: string }): Promise<RevealPhotoPage> => {
      requests.push(paginationKey);
      return pages[paginationKey ? Number(paginationKey) : 0]!;
    },
    downloadPhoto: async (photo: RevealPhoto) => { downloads.push(photo.photoId); return jpeg; },
  };
  return { archive, directory, client, downloads, requests,
    now: () => now, advance: (ms = 60_001) => { now += ms; },
    pages: (value: RevealPhotoPage[]) => { pages = value; },
    sync: (options = {}) => archive.sync("camera-1", client, { intervalMs: 60_000, ...options }),
  };
}

describe("REVEAL photo archive", () => {
  test("saves every page once, survives restart, and serves only the selected camera's JPEGs", async () => {
    const f = await fixture();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [samplePhoto, { ...samplePhoto, photoId: "../../other", photoTimestamp: "09112026031132" }] }]);
    await Promise.all([f.sync(), f.sync()]);
    expect(f.downloads).toEqual([samplePhoto.photoId, "../../other"]);
    await f.sync();
    expect(f.requests).toEqual([undefined, "1"]);
    const list = await f.archive.list("camera-1");
    expect(list.total).toBe(2);
    expect(list.photos.find(p => p.capturedAt === "09112026031132")).toBeDefined();
    expect(JSON.stringify(list)).not.toContain("photoUrl");
    expect(JSON.stringify(list)).not.toContain("amazonaws");
    const id = revealPhotoKey("camera-1", "../../other");
    expect(await f.archive.read("camera-1", id)).toEqual(jpeg);
    expect(await f.archive.read("other-camera", id)).toBeUndefined();
    expect(await f.archive.read("camera-1", "../../index.sqlite")).toBeUndefined();
    expect((await stat(join(f.directory, `${id}.jpg`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, "index.sqlite"))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(f.directory, "index.sqlite"))).includes(Buffer.from(samplePhoto.photoUrl))).toBe(false);
    await f.archive.close();
    const reopened = new RevealPhotoArchive(f.directory, f.now);
    cleanup.push(() => reopened.close());
    expect((await reopened.list("camera-1")).total).toBe(2);
    await reopened.sync("camera-1", f.client, { intervalMs: 60_000 });
    expect(f.downloads.length).toBe(2);
  });

  test("incremental polls stop at saved pages and a daily full scan finds late photos", async () => {
    const f = await fixture();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [] }]);
    await f.sync();
    f.advance();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [{ ...samplePhoto, photoId: "late-photo" }] }]);
    await f.sync();
    expect(f.requests).toEqual([undefined, "1", undefined]);
    expect(f.downloads.length).toBe(1);
    f.advance(86_400_001);
    await f.sync();
    expect(f.downloads).toEqual([samplePhoto.photoId, "late-photo"]);
  });

  test("a failed download preserves earlier photos and backs off before retrying the incomplete scan", async () => {
    const f = await fixture();
    f.pages([{ photos: [samplePhoto, { ...samplePhoto, photoId: "second" }] }]);
    const download = f.client.downloadPhoto;
    f.client.downloadPhoto = async photo => {
      if (photo.photoId === "second") throw new Error("failure with a private signed URL");
      return download(photo);
    };
    await f.sync();
    const failed = await f.archive.list("camera-1");
    expect(failed.total).toBe(1);
    expect(failed.sync.lastSuccessAt).toBeUndefined();
    expect(failed.sync.error).not.toContain("private signed URL");
    expect(failed.sync.nextCheckAt).toBe(f.now() + 120_000);
    f.advance();
    await f.sync();
    expect(f.requests.length).toBe(1);
    f.advance();
    f.client.downloadPhoto = download;
    await f.sync();
    expect((await f.archive.list("camera-1")).total).toBe(2);
    expect((await readdir(f.directory)).some(name => name.endsWith(".tmp"))).toBe(false);
    expect(f.downloads).toEqual([samplePhoto.photoId, "second"]);
  });

  test("an interrupted incremental poll resumes beyond its already-saved first page", async () => {
    const f = await fixture();
    await f.sync();
    f.advance();
    const second = { ...samplePhoto, photoId: "second" };
    const third = { ...samplePhoto, photoId: "third" };
    f.pages([{ photos: [second], nextToken: "1" }, { photos: [third, samplePhoto] }]);
    const controller = new AbortController();
    const list = f.client.listPhotos;
    f.client.listPhotos = async args => {
      if (args.paginationKey) controller.abort();
      return list(args);
    };
    await f.sync({ signal: controller.signal });
    expect((await f.archive.list("camera-1")).total).toBe(2);
    f.client.listPhotos = list;
    await f.sync();
    expect((await f.archive.list("camera-1")).total).toBe(3);
    expect(f.downloads).toEqual([samplePhoto.photoId, "second", "third"]);
  });

  test("page batches continue and repeated tokens still report incomplete sync", async () => {
    const f = await fixture();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [], nextToken: "1" }]);
    await f.sync({ maxPages: 1 });
    const pending = await f.archive.list("camera-1");
    expect(pending.sync.error).toBeUndefined();
    expect(pending.sync.continuing).toBe(true);
    expect(pending.sync.pagesScanned).toBe(1);
    f.advance(10_001);
    await f.sync();
    expect((await f.archive.list("camera-1")).sync.error).toContain("pagination token");
    expect((await f.archive.list("camera-1")).sync.lastSuccessAt).toBeUndefined();
  });

  test("resumes a full import from its durable cursor across restarts and has no total page cap", async () => {
    const f = await fixture();
    f.pages(Array.from({ length: 5 }, (_, i) => ({ photos: [{ ...samplePhoto, photoId: `batch-${i}` }], ...(i < 4 ? { nextToken: String(i + 1) } : {}) })));
    await f.sync({ maxPages: 1 });
    await f.archive.close();
    const resumed = new RevealPhotoArchive(f.directory, f.now);
    cleanup.push(() => resumed.close());
    for (let i = 0; i < 4; i++) {
      f.advance(10_001);
      await resumed.sync("camera-1", f.client, { intervalMs: 60_000, maxPages: 1 });
    }
    const complete = await resumed.list("camera-1");
    expect(complete.total).toBe(5);
    expect(complete.sync.continuing).toBe(false);
    expect(complete.sync.pagesScanned).toBe(5);
    expect(complete.sync.lastSuccessAt).toBe(f.now());
    expect(f.requests).toEqual([undefined, "1", "2", "3", "4"]);
    expect(f.downloads.length).toBe(5);
  });

  test("Fetch all overrides incremental stopping without bypassing retry backoff", async () => {
    const f = await fixture();
    await f.sync();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [{ ...samplePhoto, photoId: "older" }] }]);
    await f.archive.requestFullSync("camera-1");
    await f.sync();
    expect((await f.archive.list("camera-1")).total).toBe(2);
    expect((await f.archive.list("camera-1")).sync.fullSyncQueued).toBe(false);
    f.advance();
    const list = f.client.listPhotos;
    f.client.listPhotos = async () => { throw new RevealError("REVEAL rate limited requests; try again later", "rate_limited"); };
    await f.sync();
    const due = (await f.archive.list("camera-1")).sync.nextCheckAt;
    await f.archive.requestFullSync("camera-1");
    expect((await f.archive.list("camera-1")).sync.nextCheckAt).toBe(due);
    f.client.listPhotos = list;
    const calls = f.requests.length;
    await f.sync();
    expect(f.requests.length).toBe(calls);
  });

  test("restarts an expired continuation from the head while keeping saved JPEGs", async () => {
    const f = await fixture();
    f.pages([{ photos: [samplePhoto], nextToken: "1" }, { photos: [{ ...samplePhoto, photoId: "second" }] }]);
    await f.sync({ maxPages: 1 });
    f.advance(10_001);
    const list = f.client.listPhotos;
    f.client.listPhotos = async () => { throw new RevealError("REVEAL cloud returned HTTP 400", "unavailable"); };
    await f.sync();
    f.advance(120_001);
    f.client.listPhotos = list;
    await f.sync();
    expect(f.requests).toEqual([undefined, undefined, "1"]);
    expect(f.downloads).toEqual([samplePhoto.photoId, "second"]);
    expect((await f.archive.list("camera-1")).sync.error).toBeUndefined();
  });

  test("gallery pagination stays stable when newer photos arrive and rejects malformed cursors", async () => {
    const f = await fixture();
    const photos = Array.from({ length: 52 }, (_, i) => ({ ...samplePhoto, photoId: `photo-${i}`, createdTimestamp: 1000 + i }));
    f.pages([{ photos }]);
    await f.sync();
    const first = await f.archive.list("camera-1");
    expect(first.photos.length).toBe(48);
    expect(first.nextCursor).toBeDefined();
    f.advance();
    f.pages([{ photos: [{ ...samplePhoto, photoId: "new", createdTimestamp: 2000 }, ...photos] }]);
    await f.sync();
    const second = await f.archive.list("camera-1", first.nextCursor);
    expect(second.photos.length).toBe(4);
    expect(new Set([...first.photos, ...second.photos].map(p => p.id)).size).toBe(52);
    expect(second.nextCursor).toBeUndefined();
    const oldest = await f.archive.list("camera-1", undefined, "oldest");
    const newer = await f.archive.list("camera-1", oldest.nextCursor, "oldest");
    const played = [...oldest.photos, ...newer.photos];
    expect(played.length).toBe(53);
    expect(played[0]!.uploadedAt).toBe(1000);
    expect(played.at(-1)!.uploadedAt).toBe(2000);
    await expect(f.archive.list("camera-1", "garbage")).rejects.toThrow("Invalid photo cursor");
  });

  test("HTTP gallery stays readable during a cloud outage and never initiates a cloud request", async () => {
    const f = await fixture();
    await f.sync();
    f.advance();
    f.client.listPhotos = async () => { throw new RevealError("REVEAL cloud returned HTTP 503", "unavailable"); };
    await f.sync();
    const device = new TactacamReveal({ id: "trail", name: "Trail" }, { cameraId: "camera-1" }, {}, { archive: f.archive, fetch: async () => { throw new Error("No cloud calls from gallery"); } });
    const app = createApp(undefined, new Site([device]));
    const response = await app.request("/api/cameras/trail/photos");
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.total).toBe(1);
    expect(page.sync.error).toContain("503");
    const photo = await app.request(`/api/cameras/trail/photos/${page.photos[0].id}`);
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(jpeg);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect((await app.request("/api/cameras/trail/photos/not-a-photo")).status).toBe(404);
    expect((await app.request("/api/cameras/trail/photos?cursor=bad")).status).toBe(400);
    expect((await app.request("/api/cameras/trail/photos?order=bad")).status).toBe(400);
    expect((await app.request("/api/cameras/trail/photos/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(202);
    const html = await (await app.request("/cameras/trail")).text();
    expect(html).toContain('data-photo-history="true"');
    expect(html).toContain('id="photo-gallery"');
    expect(html).toContain('id="photo-play"');
    expect(html).toContain('id="photo-sync-all"');
    expect(html).not.toContain('data-action="live"');
  });

  test("missing credentials show a sync error without contacting the cloud", async () => {
    const f = await fixture();
    let networkCalls = 0;
    const device = new TactacamReveal({ id: "trail", name: "Trail" }, { cameraId: "camera-1" }, {}, {
      archive: f.archive, fetch: async () => { networkCalls++; throw new Error("Unexpected request"); },
    });
    await device.syncPhotos();
    expect((await f.archive.list("camera-1")).sync.error).toContain("email and password");
    expect(networkCalls).toBe(0);
  });
});

test("background polling re-resolves devices and stops cleanly without any viewers", async () => {
  let count = 0;
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let devices = [{ syncPhotos: async () => { count++; devices = [{ syncPhotos: async () => { count++; finish(); } }]; } }];
  const polling = startRevealPhotoPolling(() => devices, 5);
  try {
    await completed;
    await polling.stop();
    const stopped = count;
    await Bun.sleep(20);
    expect(count).toBe(stopped);
    expect(count).toBeGreaterThanOrEqual(2);
  } finally { await polling.stop(); }
});
