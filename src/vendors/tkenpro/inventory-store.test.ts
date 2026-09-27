import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  FileCameraInventoryStore,
  mergeInventoryCameras,
  sanitizeInventoryCamera,
  type InventoryCamera,
} from "./inventory-store.ts";

const scratch: string[] = [];
function tempPath(): string {
  const path = join(tmpdir(), `hometruth-inventory-${randomUUID()}`, "discovered-cameras.json");
  scratch.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(join(path, ".."), { recursive: true, force: true })));
});

const sample: InventoryCamera = {
  id: "uuid:abc-123",
  host: "10.78.0.147",
  sources: ["meari-lan", "ws-discovery"],
  model: "Pet 3T",
  firmware: "5.7.3",
  deviceName: "Kitchen cam",
  serialNumber: "100000001",
  endpointReference: "urn:uuid:abc-123",
  onvifAdvertised: true,
  onvifEndpoints: ["http://10.78.0.147/onvif/device_service"],
  openPorts: [80, 8000],
  lastSeen: "2026-09-03T00:00:00.000Z",
};

describe("camera inventory store", () => {
  test("round-trips a saved camera and writes an owner-only file", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await store.save([sample]);
    const loaded = await store.load();
    expect(loaded).toEqual([sample]);
    const mode = (await lstat(store.path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("returns an empty list when the file does not exist", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    expect(await store.load()).toEqual([]);
  });

  test("dedupes by id and sorts by host on save", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await store.save([
      { ...sample, id: "b", host: "10.78.0.200" },
      { ...sample, id: "a", host: "10.78.0.100" },
      { ...sample, id: "b", host: "10.78.0.200", model: "dupe-ignored" },
    ]);
    const loaded = await store.load();
    expect(loaded.map((c) => c.host)).toEqual(["10.78.0.100", "10.78.0.200"]);
  });

  test("clear removes the file and is idempotent", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await store.save([sample]);
    await store.clear();
    expect(await store.load()).toEqual([]);
    await store.clear(); // no throw on missing file
  });

  test("refuses to load a symlinked inventory path", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await mkdir(join(store.path, ".."), { recursive: true });
    const real = join(store.path, "..", "real.json");
    await writeFile(real, JSON.stringify({ version: 1, cameras: [] }), { mode: 0o600 });
    await symlink(real, store.path);
    await expect(store.load()).rejects.toThrow(/symbolic link/i);
  });

  test("survives a corrupt file by validating on load", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await mkdir(join(store.path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(store.path, "{ not valid json", { mode: 0o600 });
    await expect(store.load()).rejects.toThrow();
  });

  test("drops entries missing id or host and re-saves cleanly", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await mkdir(join(store.path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(store.path, JSON.stringify({
      version: 1,
      cameras: [sample, { host: "1.2.3.4" }, { id: "x" }, "garbage"],
    }), { mode: 0o600 });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(sample.id);
  });
});

describe("inventory merge", () => {
  const camA: InventoryCamera = { ...sample, id: "a", host: "10.78.0.64" };
  const camB: InventoryCamera = { ...sample, id: "b", host: "10.78.0.147" };

  test("mergeInventoryCameras keeps cameras absent from the new scan", () => {
    const merged = mergeInventoryCameras([camA, camB], [{ ...camB, firmware: "9.9.9" }]);
    expect(merged.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(merged.find((c) => c.id === "b")?.firmware).toBe("9.9.9");
  });

  test("store.merge accumulates across scans that each see one camera", async () => {
    const store = new FileCameraInventoryStore(tempPath());
    await store.merge([camA]);        // scan 1: only camera A answered
    const after = await store.merge([camB]); // scan 2: only camera B answered
    expect(after.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect((await store.load()).map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});

describe("sanitizeInventoryCamera", () => {
  test("requires id and host", () => {
    expect(sanitizeInventoryCamera({ host: "1.2.3.4" })).toBeUndefined();
    expect(sanitizeInventoryCamera({ id: "a" })).toBeUndefined();
    expect(sanitizeInventoryCamera(null)).toBeUndefined();
  });

  test("coerces list/port fields and fills lastSeen", () => {
    const c = sanitizeInventoryCamera({
      id: "a", host: "1.2.3.4",
      sources: ["x", "x", 5, "y"],
      openPorts: [80, 80, 99999, -1, 8000],
      onvifEndpoints: "not-an-array",
    });
    expect(c?.sources).toEqual(["x", "y"]);
    expect(c?.openPorts).toEqual([80, 8000]);
    expect(c?.onvifEndpoints).toEqual([]);
    expect(typeof c?.lastSeen).toBe("string");
  });
});
