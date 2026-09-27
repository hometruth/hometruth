import { afterEach, expect, test } from "bun:test";
import { DogAnnouncer, type DogDependencies } from "./dog-announcer";
import { DEFAULT_DOG_CONFIG as EMPTY_DOG_CONFIG, parseDogConfig } from "./dog-config";
import type { DogDetection } from "./dog-frame-detector";

const DEFAULT_DOG_CONFIG = { ...EMPTY_DOG_CONFIG, cameraId: "test-camera", speakerId: "test-speaker" };

const active: DogAnnouncer[] = [];
afterEach(async () => { for (const automation of active.splice(0)) await automation.stop(); });
const detection = (dog = true): DogDetection => ({ source: "frigate", camera: "kitchen", dog, capturedAt: 0, imageHash: "a".repeat(64), elapsedMs: 500 });
async function fixture(overrides: Partial<DogDependencies> = {}) {
  let saved = { ...DEFAULT_DOG_CONFIG, enabled: true }, now = 0, dog = true;
  const said: { id: string; text: string }[] = [];
  const automation = new DogAnnouncer({
    store: { load: async () => saved, save: async value => { saved = value; } },
    detect: async () => detection(dog), speak: async (id, text) => { said.push({ id, text }); },
    validate: () => {}, now: () => now, ...overrides,
  });
  active.push(automation); await automation.start();
  return { automation, said, time: (value: number) => { now = value; }, dog: (value: boolean) => { dog = value; }, config: () => saved };
}

test("a dog-positive frame says OUT once, with a shared five-second cooldown", async () => {
  const f = await fixture();
  await f.automation.check();
  f.dog(true); f.time(4999); await f.automation.check();
  expect(f.said).toEqual([{ id: "test-speaker", text: "OUT" }]);
  f.time(5000); await f.automation.check();
  expect(f.said).toHaveLength(2);
  f.dog(false); f.time(10000); await f.automation.check();
  expect(f.said).toHaveLength(2);
  expect(f.automation.events(undefined, { types: ["dog_announced"] })[0]).toMatchObject({ data: { source: "frigate", camera: "kitchen", text: "OUT", speakerId: "test-speaker" } });
});

test("silent checks do not speak, emit detection events or consume the cooldown", async () => {
  const f = await fixture();
  expect(await f.automation.preview(f.config())).toEqual(detection());
  expect(f.said).toHaveLength(0); expect(f.automation.events()).toHaveLength(0);
  await f.automation.check(); expect(f.said).toHaveLength(1);
});

test("slow speech does not block detection or overlap another announcement", async () => {
  const gate = Promise.withResolvers<void>(); let calls = 0;
  const f = await fixture({ speak: async () => { calls++; await gate.promise; } });
  try {
    await f.automation.check(); f.time(6000); await f.automation.check();
    expect(calls).toBe(1);
    expect(f.automation.events(undefined, { types: ["dog_detected"] })).toHaveLength(2);
  } finally { gate.resolve(); }
});

test("speech errors preserve detections and respect the five-second retry limit", async () => {
  let calls = 0;
  const f = await fixture({ speak: async () => { calls++; throw new Error("Speaker offline"); } });
  await f.automation.check(); f.time(4999); await f.automation.check(); expect(calls).toBe(1);
  f.time(5000); await f.automation.check(); expect(calls).toBe(2);
  expect(f.automation.events(undefined, { types: ["dog_detected"] })).toHaveLength(3);
  expect(f.automation.events(undefined, { types: ["dog_announced"] })).toHaveLength(0);
});

test("pausing discards pending Frigate replies and blocks concurrent checks", async () => {
  const gate = Promise.withResolvers<DogDetection>(); let calls = 0;
  const f = await fixture({ detect: async () => { calls++; return gate.promise; } });
  const pending = f.automation.check(); await f.automation.check();
  await f.automation.setEnabled(false); gate.resolve(detection()); await pending;
  expect(calls).toBe(1); expect(f.said).toHaveLength(0); expect(f.automation.view().last).toBeNull();
  expect(await f.automation.check()).toBeUndefined();
});

test("failed Frigate requests stay silent and recover on the next check", async () => {
  let fail = true;
  const f = await fixture({ detect: async () => { if (fail) throw Error("No current frames"); return detection(); } });
  await f.automation.check(); expect(f.said).toHaveLength(0); expect(f.automation.status().availability).toBe("degraded");
  fail = false; await f.automation.check(); expect(f.said).toHaveLength(1); expect(f.automation.status().availability).toBe("online");
});

test("queued configuration and pause preserve settings without resetting cooldown", async () => {
  const f = await fixture(); await f.automation.check();
  const next = { ...f.config(), text: "Out please" };
  await Promise.all([f.automation.configure(next), f.automation.setEnabled(false)]);
  expect(f.config()).toEqual({ ...next, enabled: false });
  await f.automation.setEnabled(true); f.time(4999); await f.automation.check(); expect(f.said).toHaveLength(1);
  f.time(5000); await f.automation.check(); expect(f.said[1]?.text).toBe("Out please");
});

test("silent checks reserve the busy slot while awaiting Frigate", async () => {
  const gate = Promise.withResolvers<DogDetection>();
  const f = await fixture({ detect: () => gate.promise });
  const pending = f.automation.preview(f.config());
  await expect(f.automation.preview(f.config())).rejects.toThrow("already running");
  gate.resolve(detection()); await pending;
});

test("checks start every five seconds without adding request latency to their cadence", async () => {
  const starts: number[] = [], sampled = Promise.withResolvers<void>();
  const f = await fixture({ detect: async () => {
    starts.push(performance.now()); if (starts.length === 2) sampled.resolve();
    await Bun.sleep(400); return detection(false);
  } });
  await sampled.promise; await f.automation.stop();
  expect(starts).toHaveLength(2);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(4800);
  expect(starts[1]! - starts[0]!).toBeLessThan(5400);
}, 15_000);

test("only the current rule contract is accepted", () => {
  expect(parseDogConfig(DEFAULT_DOG_CONFIG)).toEqual(DEFAULT_DOG_CONFIG);
  for (const patch of [{ blackText: "black dog" }, { region: {} }, { text: "" }, { cameraId: "", enabled: true }, { intervalMs: 1000 }, { intervalMs: 2000 }, { cooldownMs: 4999 }, { cooldownMs: 6000 }]) {
    expect(() => parseDogConfig({ ...DEFAULT_DOG_CONFIG, ...patch })).toThrow();
  }
});

test("variable speaker latency cannot compress announcements into less than five seconds", async () => {
  const gate = Promise.withResolvers<void>(); let calls = 0;
  const f = await fixture({ speak: async () => { if (++calls === 1) await gate.promise; } });
  await f.automation.check(); f.time(3000); gate.resolve();
  await Bun.sleep(0);
  f.time(7999); await f.automation.check(); expect(calls).toBe(1);
  f.time(8000); await f.automation.check(); expect(calls).toBe(2);
});

test("one outage logs one error and one recovery even when the failure detail changes and no dog is present", async () => {
  let error: string | undefined = "Frigate did not respond with current detections";
  const f = await fixture({ detect: async () => { if (error) throw Error(error); return detection(false); } });
  await f.automation.check(); await f.automation.check();
  error = "Frigate detection is unavailable for this camera";
  await f.automation.check(); await f.automation.check();
  expect(f.automation.events(undefined, { types: ["automation_error"] })).toHaveLength(1);
  expect(f.automation.status()).toEqual({ availability: "degraded", detail: error });
  error = undefined;
  await f.automation.check(); await f.automation.check();
  expect(f.automation.events(undefined, { types: ["automation_recovered"] })).toHaveLength(1);
  expect(f.automation.events()[0]).toMatchObject({ type: "automation_recovered", subject: "test-camera", message: "Frigate detection recovered — processing fresh camera frames" });
  expect(f.automation.status().availability).toBe("online");
  expect(f.said).toHaveLength(0);
  error = "Frigate is offline again"; await f.automation.check();
  expect(f.automation.events(undefined, { types: ["automation_error"] })).toHaveLength(2);
});

test("successful detection cannot clear or repeatedly log an unresolved speaker failure", async () => {
  let speechFails = true;
  const f = await fixture({ speak: async () => { if (speechFails) throw Error("Speaker offline"); } });
  await f.automation.check();
  f.time(5000); await f.automation.check();
  expect(f.automation.events(undefined, { types: ["automation_error"] })).toHaveLength(1);
  expect(f.automation.events(undefined, { types: ["automation_recovered"] })).toHaveLength(0);
  expect(f.automation.status()).toEqual({ availability: "degraded", detail: "Speaker offline" });
  speechFails = false; f.time(10000); await f.automation.check();
  expect(f.automation.events(undefined, { types: ["automation_recovered"] })).toHaveLength(1);
  expect(f.automation.status().availability).toBe("online");
});


test("pausing aborts inference and releases its camera capture", async () => {
  let released = 0;
  const f = await fixture({
    detect: async (_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Error("Cancelled")), { once: true });
    }),
    release: () => { released++; },
  });
  const pending = f.automation.check();
  await f.automation.setEnabled(false); await pending;
  expect(released).toBe(1);
  expect(f.said).toHaveLength(0);
  expect(f.automation.events(undefined, { types: ["automation_error"] })).toHaveLength(0);
});
