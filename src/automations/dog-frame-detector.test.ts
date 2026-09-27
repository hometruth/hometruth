import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DogFrameDetector } from "./dog-frame-detector";

const jpeg = new Uint8Array([255, 216, 42, 255, 217]);
const imageHash = createHash("sha256").update(jpeg).digest("hex");
const signal = new AbortController().signal;
const labels = (dog = false) => ({ dog, imageHash });

test("sends the fresh JPEG and returns dog or no dog", async () => {
  let now = 10_000;
  const detector = new DogFrameDetector(async (id, abort) => {
    expect(id).toBe("kitchen"); expect(abort).toBe(signal);
    return { bytes: jpeg, at: now };
  }, { label: async (bytes, abort) => {
    expect(bytes).toBe(jpeg); expect(abort).toBe(signal); now += 600;
    return labels(true);
  } }, () => now);
  expect(await detector.detect("kitchen", signal)).toEqual({ source: "frigate", camera: "kitchen", dog: true,
    capturedAt: 10_000, imageHash, elapsedMs: 600 });
});

test("a negative frame produces no dog", async () => {
  const detector = new DogFrameDetector(async () => ({ bytes: jpeg, at: 100 }),
    { label: async () => labels(false) }, () => 100);
  expect((await detector.detect("kitchen", signal)).dog).toBe(false);
});

test("rejects old frames before inference and replies belonging to another image", async () => {
  const stale = new DogFrameDetector(async () => ({ bytes: jpeg, at: 0 }),
    { label: async () => { throw Error("Must not infer"); } }, () => 1501);
  await expect(stale.detect("kitchen", signal)).rejects.toThrow("fresh camera frame");
  const wrong = new DogFrameDetector(async () => ({ bytes: jpeg, at: 0 }),
    { label: async () => ({ ...labels(), imageHash: "b".repeat(64) }) }, () => 0);
  await expect(wrong.detect("kitchen", signal)).rejects.toThrow("Invalid dog detection");
});

test("late or cancelled inference cannot produce an announcement result", async () => {
  for (const cancelled of [false, true]) {
    let now = 100;
    const abort = new AbortController();
    const detector = new DogFrameDetector(async () => ({ bytes: jpeg, at: now }), { label: async () => {
      if (cancelled) abort.abort(); else now += 3001;
      return labels(true);
    } }, () => now);
    await expect(detector.detect("kitchen", abort.signal)).rejects.toThrow();
  }
});
