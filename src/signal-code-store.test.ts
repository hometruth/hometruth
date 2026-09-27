import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSignalCodeStore, MemorySignalCodeStore, SignalCodeStoreError } from "./signal-code-store";

async function tempPath(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "hometruth-ir-rf-"));
  return join(directory, "ir-rf-codes.json");
}

describe.each([
  ["MemorySignalCodeStore", () => new MemorySignalCodeStore()],
  ["FileSignalCodeStore", async () => new FileSignalCodeStore(await tempPath())],
])("%s", (_name, makeStore) => {
  test("starts empty for an unknown device", async () => {
    const store = await makeStore();
    expect(await store.list("blaster")).toEqual([]);
  });

  test("adds a code and returns it in later listings", async () => {
    const store = await makeStore();
    const saved = await store.add("blaster", { name: "TV power", channel: "infrared", code: "AAECAw==" });
    expect(saved.name).toBe("TV power");
    expect(saved.channel).toBe("infrared");
    expect(saved.code).toBe("AAECAw==");
    expect(saved.id).toBeTruthy();
    expect(saved.learnedAt).toBeTruthy();

    const listed = await store.list("blaster");
    expect(listed).toEqual([saved]);
  });

  test("keeps codes for different devices separate", async () => {
    const store = await makeStore();
    await store.add("blaster-1", { name: "A", channel: "infrared", code: "AAA=" });
    await store.add("blaster-2", { name: "B", channel: "infrared", code: "BBB=" });
    expect((await store.list("blaster-1")).map((c) => c.name)).toEqual(["A"]);
    expect((await store.list("blaster-2")).map((c) => c.name)).toEqual(["B"]);
  });

  test("stores an RF frequency alongside the code", async () => {
    const store = await makeStore();
    const saved = await store.add("blaster", { name: "Fan RF", channel: "radio-frequency", code: "AAA=", frequencyHz: 433920000 });
    expect(saved.frequencyHz).toBe(433920000);
  });

  test("keeps a default hold and lets it be changed or cleared", async () => {
    const store = await makeStore();
    const saved = await store.add("blaster", { name: "Dim up", channel: "infrared", code: "AAA=", durationMs: 3000 });
    expect(saved.durationMs).toBe(3000);
    const once = await store.add("blaster", { name: "Once", channel: "infrared", code: "BBB=", durationMs: 0 });
    expect(once.durationMs).toBeUndefined();

    const updated = await store.update("blaster", saved.id, { durationMs: 1500 });
    expect(updated?.durationMs).toBe(1500);
    expect((await store.list("blaster")).map((c) => c.durationMs)).toEqual([1500, undefined]);

    const cleared = await store.update("blaster", saved.id, { durationMs: 0 });
    expect(cleared).toBeDefined();
    expect(cleared?.durationMs).toBeUndefined();
    expect(await store.update("blaster", "missing", { durationMs: 1000 })).toBeUndefined();
  });

  test("rejects a blank name", async () => {
    const store = await makeStore();
    await expect(store.add("blaster", { name: "   ", channel: "infrared", code: "AAA=" }))
      .rejects.toThrow(SignalCodeStoreError);
  });

  test("removes a code by id and reports whether it existed", async () => {
    const store = await makeStore();
    const saved = await store.add("blaster", { name: "TV power", channel: "infrared", code: "AAA=" });
    expect(await store.remove("blaster", saved.id)).toBe(true);
    expect(await store.list("blaster")).toEqual([]);
    expect(await store.remove("blaster", saved.id)).toBe(false);
    expect(await store.remove("unknown-device", "whatever")).toBe(false);
  });
});

describe("FileSignalCodeStore persistence", () => {
  test("persists codes across store instances at the same path", async () => {
    const path = await tempPath();
    const first = new FileSignalCodeStore(path);
    const saved = await first.add("blaster", { name: "TV power", channel: "infrared", code: "AAA=" });

    const second = new FileSignalCodeStore(path);
    expect(await second.list("blaster")).toEqual([saved]);
  });

  test("treats a missing file as an empty catalog", async () => {
    const store = new FileSignalCodeStore(await tempPath());
    expect(await store.list("blaster")).toEqual([]);
  });
});
