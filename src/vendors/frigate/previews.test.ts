import { expect, test } from "bun:test";
import { DetectionPreviews, PreviewAccessError } from "./previews";
import { FrigateEvents } from "./events";
import { FrigateEventHistory } from "./event-history";
import { normalizeFrigateHistory } from "./import-history";
import { createApp } from "../../server/app";
import { CameraService } from "../tkenpro/camera-service";
import { Site } from "../../site";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const signal = () => new AbortController().signal;

test("previews sample ten real seconds around each update, with a shared expiring cache", async () => {
  const times: number[] = []; let now = 500_000;
  const previews = new DetectionPreviews(async (_, time) => { times.push(time); return jpeg; }, () => now);
  const [one, two] = await Promise.all([previews.read("front", 100.5, signal()), previews.read("front", 100.5, signal())]);
  expect(times).toEqual(Array.from({ length: 10 }, (_, n) => 98 + n));
  expect(one).toEqual(two); expect(one?.playbackRate).toBe(5);
  expect(one?.frames.map(f => f.time)).toEqual(times);
  await previews.read("front", 100.5, signal()); expect(times.length).toBe(10);
  now += 300_001;
  await previews.read("front", 100.5, signal()); expect(times.length).toBe(20);
});

test("partial previews preserve missing seconds and retry while recent recordings arrive", async () => {
  let now = 103_000;
  const times: number[] = [];
  const previews = new DetectionPreviews(async (_, time) => { times.push(time); return time === 99 ? undefined : jpeg; }, () => now);
  const partial = await previews.read("front", 100, signal());
  expect(partial?.frames.map(f => f.time)).toEqual([98, 100, 101]);
  expect(times).toEqual([98, 99, 100, 101]);
  now += 10_000;
  expect((await previews.read("front", 100, signal()))?.frames.length).toBe(9);
  const missing = new DetectionPreviews(async () => undefined, () => now);
  expect(await missing.read("front", 100, signal())).toBeUndefined();
});

test("leaving the last preview cancels remote reads; another viewer keeps shared work alive", async () => {
  let upstream: AbortSignal | undefined;
  const gate = Promise.withResolvers<Uint8Array>();
  const previews = new DetectionPreviews(async (_, __, signal) => { upstream = signal; return gate.promise; });
  const a = new AbortController(), b = new AbortController();
  const one = previews.read("front", 100, a.signal).catch(() => "cancelled");
  const two = previews.read("front", 100, b.signal).catch(() => "cancelled");
  a.abort(); expect(await one).toBe("cancelled"); expect(upstream?.aborted).toBe(false);
  b.abort(); expect(await two).toBe("cancelled"); expect(upstream?.aborted).toBe(true);
  gate.resolve(jpeg);
});

test("preview media is bounded and invalid frames are rejected", async () => {
  for (const bad of [new Uint8Array([1, 2]), new Uint8Array(256 * 1024 + 1)]) {
    await expect(new DetectionPreviews(async () => bad).read("front", 100, signal())).rejects.toThrow("Invalid preview frame");
  }
  let reads = 0;
  const previews = new DetectionPreviews(async () => { reads++; return jpeg; });
  expect(await previews.read("../private", 100, signal())).toBeUndefined(); expect(reads).toBe(0);
});

test("preview cache evicts old windows and limits simultaneous remote work", async () => {
  let reads = 0;
  const previews = new DetectionPreviews(async () => { reads++; return jpeg; });
  for (let i = 0; i < 33; i++) await previews.read("front", 100 + i * 10, signal());
  await previews.read("front", 100, signal()); expect(reads).toBe(340);
  const gate = Promise.withResolvers<Uint8Array>();
  const busy = new DetectionPreviews(async () => gate.promise);
  const first = busy.read("front", 100, signal()), second = busy.read("yard", 100, signal());
  await expect(busy.read("pet", 100, signal())).rejects.toThrow("busy");
  gate.resolve(jpeg); await Promise.all([first, second]);
});

test("preview route checks the exact saved detection time and hides private upstream errors", async () => {
  const history = new FrigateEventHistory(":memory:");
  const config = { topicPrefix: "frigate", cameras: { front: "front-device" } };
  history.save(normalizeFrigateHistory({ id: "track", camera: "front", label: "person", start_time: 100, end_time: 110,
    data: { type: "object", top_score: 0.9 } }, config)!);
  let reads = 0, mode = "ready";
  const service = new FrigateEvents({ onMessage: () => () => {} }, config, Date.now, history, undefined, {
    async read(camera, frameTime) {
      reads++; expect(camera).toBe("front"); expect(frameTime).toBe(100);
      if (mode === "error") throw new Error("private password");
      if (mode === "access") throw new PreviewAccessError("private password");
      return { playbackRate: 5, frames: [{ time: 98, image: "one" }, { time: 99, image: "two" }] };
    },
    async still() { return undefined; },
  });
  const cameras = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const app = createApp(cameras, new Site([], undefined, new Map(), [service]));
  try {
    const route = "/api/services/frigate/previews/front/track?at=100";
    const response = await app.request(route);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).frames.length).toBe(2);
    for (const path of ["front/track?at=101", "yard/track?at=100", "front/missing?at=100"]) {
      expect((await app.request("/api/services/frigate/previews/" + path)).status).toBe(404);
    }
    for (const time of ["", "NaN", "Infinity", "-1"]) expect((await app.request(route.replace("100", time))).status).toBe(400);
    expect(reads).toBe(1);
    for (const [kind, status] of [["error", 502], ["access", 503]] as const) {
      mode = kind; const failure = await app.request(route); expect(failure.status).toBe(status);
      expect(await failure.text()).not.toContain("private password");
    }
  } finally { await service.stop(); }
});

test("a still is one validated recorded frame at the whole second of the detection", async () => {
  const times: number[] = [];
  const previews = new DetectionPreviews(async (camera, time) => { times.push(time); return camera === "front" ? jpeg : undefined; });
  expect(await previews.still("front", 1100.7, signal())).toEqual(jpeg);
  expect(times).toEqual([1100]);
  expect(await previews.still("yard", 1100, signal())).toBeUndefined();
  expect(await previews.still("../private", 1100, signal())).toBeUndefined();
  expect(times).toEqual([1100, 1100]);
  const invalid = new DetectionPreviews(async () => new TextEncoder().encode("<html>login</html>"));
  await expect(invalid.still("front", 1100, signal())).rejects.toThrow("Invalid preview frame");
});
