import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCameraRegionStore } from "./region-store";

const cleanupDirs: string[] = [];

async function tempStore(): Promise<{ store: FileCameraRegionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "light-sync-test-"));
  cleanupDirs.push(dir);
  const path = join(dir, "light-sync.json");
  return { store: new FileCameraRegionStore(path), path };
}

afterEach(async () => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const square = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];

describe("FileCameraRegionStore", () => {
  test("load() on a missing file returns an empty map", async () => {
    const { store } = await tempStore();
    expect(await store.load()).toEqual({});
  });

  test("set() then get() round-trips a region", async () => {
    const { store } = await tempStore();
    await store.set("wyze-cam-v3", { points: square });
    const region = await store.get("wyze-cam-v3");
    expect(region?.points).toEqual(square);
  });

  test("set() is restricted to the owner (0600) and creates a 0700 directory", async () => {
    const { store, path } = await tempStore();
    await store.set("wyze-cam-v3", { points: square });
    const { stat } = await import("node:fs/promises");
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(path.replace(/\/[^/]+$/, ""))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  test("set() on one camera preserves another camera's region", async () => {
    const { store } = await tempStore();
    await store.set("camera-a", { points: square });
    await store.set("camera-b", { points: square });
    const all = await store.load();
    expect(Object.keys(all).sort()).toEqual(["camera-a", "camera-b"]);
  });

  test("set() rejects an invalid region and leaves the store unchanged", async () => {
    const { store } = await tempStore();
    await store.set("camera-a", { points: square });
    await expect(store.set("camera-a", { points: [{ x: 0, y: 0 }] })).rejects.toThrow();
    expect((await store.get("camera-a"))?.points).toEqual(square);
  });

  test("delete() removes one camera's region and keeps others", async () => {
    const { store } = await tempStore();
    await store.set("camera-a", { points: square });
    await store.set("camera-b", { points: square });
    await store.delete("camera-a");
    expect(await store.get("camera-a")).toBeUndefined();
    expect(await store.get("camera-b")).toBeDefined();
  });

  test("delete() on a nonexistent camera is a no-op", async () => {
    const { store } = await tempStore();
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  test("load() refuses a symlinked file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "light-sync-test-"));
    cleanupDirs.push(dir);
    const real = join(dir, "real.json");
    const linked = join(dir, "light-sync.json");
    await writeFile(real, JSON.stringify({ version: 1, regions: {} }));
    await symlink(real, linked);
    const store = new FileCameraRegionStore(linked);
    await expect(store.load()).rejects.toThrow(/symbolic link/);
  });

  test("load() drops a corrupt entry but keeps the rest", async () => {
    const { store, path } = await tempStore();
    await store.set("camera-good", { points: square });
    const raw = JSON.parse(await Bun.file(path).text()) as { regions: Record<string, unknown> };
    raw.regions["camera-bad"] = { points: [{ x: 0, y: 0 }] }; // too few points
    await writeFile(path, JSON.stringify(raw));
    await chmod(path, 0o600);
    const all = await store.load();
    expect(Object.keys(all)).toEqual(["camera-good"]);
  });
});
