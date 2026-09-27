import { expect, test } from "bun:test";
import { DogAnnouncer } from "../automations/dog-announcer";
import { DEFAULT_DOG_CONFIG as EMPTY_DOG_CONFIG, FileDogConfigStore } from "../automations/dog-config";
import { Site } from "../site";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { createApp } from "./app";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_DOG_CONFIG = { ...EMPTY_DOG_CONFIG, cameraId: "test-camera", speakerId: "test-speaker" };

test("automation routes protect writes, persist toggles, preview Frigate silently and remove obsolete endpoints", async () => {
  const a = new DogAnnouncer({
    store: { load: async () => DEFAULT_DOG_CONFIG, save: async () => {} },
    detect: async () => ({ source: "frigate", camera: "kitchen", dog: true, capturedAt: 0, imageHash: "a".repeat(64), elapsedMs: 500 }),
    speak: async () => { throw new Error("Preview must be silent"); }, validate: () => {},
  });
  const cameras = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const app = createApp(cameras, new Site([], undefined, new Map(), [a]));
  const path = "/api/automations/dog-announcer";
  const options = { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(DEFAULT_DOG_CONFIG) };
  try {
    const page = await (await app.request("/automations/dog-announcer")).text();
    expect(page).toContain("Frigate"); expect(page).toContain("OUT");
    expect(page).not.toContain('id="region"'); expect(page).not.toContain('id="black"');
    expect((await app.request(path, { ...options, headers: { ...options.headers, Origin: "https://unrelated.example" } })).status).toBe(403);
    expect((await app.request(path + "/enabled", { ...options, headers: { ...options.headers, Origin: "https://unrelated.example" } })).status).toBe(403);
    for (const enabled of [undefined, null, "false", 0]) expect((await app.request(path + "/enabled", { ...options, body: JSON.stringify({ enabled }) })).status).toBe(400);
    expect((await app.request(path, { ...options, body: JSON.stringify({ ...DEFAULT_DOG_CONFIG, region: {} }) })).status).toBe(400);
    expect((await app.request(path, options)).status).toBe(200);
    const on = await app.request(path + "/enabled", { ...options, body: JSON.stringify({ enabled: true }) });
    expect((await on.json()).config).toEqual({ ...DEFAULT_DOG_CONFIG, enabled: true });
    const preview = await app.request(path + "/preview", { ...options, method: "POST" });
    expect(preview.status).toBe(200); expect((await preview.json()).dog).toBe(true);
    expect(a.events(undefined, { types: ["dog_detected", "dog_announced"] })).toHaveLength(0);
    expect((await app.request(path + "/snapshot?cameraId=missing")).status).toBe(404);
    expect((await app.request(path + "/eval", { ...options, method: "POST" })).status).toBe(404);
    expect((await (await app.request("/api/services")).json()).services.some((s: { id: string }) => s.id === "dog-announcer")).toBe(true);
  } finally { await a.stop(); }
});

test("saved rule survives reload and malformed or superseded settings fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dog-config-")), path = join(directory, "dog.json");
  try {
    const store = new FileDogConfigStore(path);
    expect(await store.load()).toEqual(EMPTY_DOG_CONFIG);
    const config = { ...DEFAULT_DOG_CONFIG, enabled: true };
    await store.save(config); expect(await new FileDogConfigStore(path).load()).toEqual(config);
    await writeFile(path, "{broken"); await expect(store.load()).rejects.toThrow();
    await writeFile(path, JSON.stringify({ ...config, blackText: "black dog" })); await expect(store.load()).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("live preview only serves site cameras without needing Frigate video, forwards cancellation and never invokes detection or speech", async () => {
  const { dogRoutes } = await import("../automations/dog-routes");

  let camera: string | undefined, signal: AbortSignal | undefined, fail = false;
  const a = new DogAnnouncer({
    store: { load: async () => DEFAULT_DOG_CONFIG, save: async () => {} },
    detect: async () => { throw Error("Must not detect"); }, speak: async () => { throw Error("Must not speak"); }, validate: () => {},
    stream: async (id, abort) => {
      camera = id; signal = abort;
      if (fail) throw Error("rtsp://private:secret@10.77.0.3/path");
      return new Response("frame", { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg", "Cache-Control": "no-store" } });
    },
  });
  const app = dogRoutes(a, { get: (id: string) => id === "test-camera" ? { capability: (kind: string) => kind === "camera" ? {} : undefined } : undefined } as unknown as Site);
  const url = "/api/automations/dog-announcer/stream.mjpeg?cameraId=";
  try {
    expect((await app.request(url + "unknown")).status).toBe(404); expect(camera).toBeUndefined();
    const abort = new AbortController();
    const response = await app.request(url + "test-camera", { signal: abort.signal });
    expect(response.headers.get("Content-Type")).toContain("multipart/x-mixed-replace");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("frame"); expect(camera).toBe("test-camera");
    abort.abort(); expect(signal?.aborted).toBe(true); expect(a.events()).toHaveLength(0);
    fail = true;
    const failed = await app.request(url + "test-camera");
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain("secret");
  } finally { await a.stop(); }
});
