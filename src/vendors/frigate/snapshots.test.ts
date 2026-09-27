import { expect, test } from "bun:test";
import { FrigateSnapshots, frigateSnapshotsConfig } from "./snapshots";
import { FrigateEvents, trackStart } from "./events";
import { FrigateEventHistory } from "./event-history";
import { normalizeFrigateHistory } from "./import-history";
import { createApp } from "../../server/app";
import { CameraService } from "../tkenpro/camera-service";
import { Site } from "../../site";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const signal = () => new AbortController().signal;

test("snapshot configuration and identifiers exclude remote command/path injection", async () => {
  const good = { enabled: true, sshConfigPath: "/private/ssh_config", sshHost: "frigate", container: "frigate" };
  expect(frigateSnapshotsConfig(good)).toEqual({ sshConfigPath: "/private/ssh_config", sshHost: "frigate", container: "frigate" });
  for (const patch of [{ container: "frigate; id" }, { sshHost: "-oProxyCommand=id" }, { sshConfigPath: "relative" }]) {
    expect(() => frigateSnapshotsConfig({ ...good, ...patch })).toThrow();
  }
  let reads = 0;
  const snapshots = new FrigateSnapshots(async () => { reads++; return jpeg; });
  for (const id of ["../secret", "id?camera=elsewhere", "a/b", "$(id)"]) expect(await snapshots.read("front", id, signal())).toBeUndefined();
  expect(reads).toBe(0);
});

test("repeated track updates share a bounded, expiring snapshot and cancelled callers do not cancel others", async () => {
  let now = 0, reads = 0;
  const gate = Promise.withResolvers<Uint8Array>();
  const snapshots = new FrigateSnapshots(async () => { reads++; return gate.promise; }, () => now);
  const cancelled = new AbortController();
  const first = snapshots.read("front", "track", cancelled.signal).catch(error => error);
  const second = snapshots.read("front", "track", signal());
  cancelled.abort(); gate.resolve(jpeg);
  expect(await first).toBeInstanceOf(Error);
  expect(await second).toEqual(jpeg);
  expect(reads).toBe(1);
  expect(await snapshots.read("front", "track", signal())).toEqual(jpeg);
  expect(reads).toBe(1);
  now = 30_001;
  await snapshots.read("front", "track", signal());
  expect(reads).toBe(2);
});

test("a not-yet-saved snapshot can appear later, and invalid media never enters the cache", async () => {
  let now = 0, reads = 0;
  const snapshots = new FrigateSnapshots(async () => ++reads === 1 ? undefined : jpeg, () => now);
  expect(await snapshots.read("front", "track", signal())).toBeUndefined();
  now = 2001;
  expect(await snapshots.read("front", "track", signal())).toEqual(jpeg);
  const invalid = new FrigateSnapshots(async () => new TextEncoder().encode("<html>Private login response</html>"));
  await expect(invalid.read("front", "track", signal())).rejects.toThrow("Invalid Frigate snapshot");
});

test("snapshot route serves only known camera/track pairs and hides upstream errors without starting servers", async () => {
  const history = new FrigateEventHistory(":memory:");
  const config = { topicPrefix: "frigate", cameras: { front: "front-device" } };
  history.save(normalizeFrigateHistory({ id: "track", camera: "front", label: "person", start_time: 100, end_time: 110,
    data: { type: "object", top_score: 0.9 } }, config)!);
  let reads = 0, mode = "ready";
  const service = new FrigateEvents({ onMessage: () => () => {} }, config, Date.now, history, {
    async read() { reads++; if (mode === "error") throw new Error("private SSH credentials"); return mode === "ready" ? jpeg : undefined; },
  });
  const cameras = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const app = createApp(cameras, new Site([], undefined, new Map(), [service]));
  try {
    const response = await app.request("/api/services/frigate/frames/front/track");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect((await app.request("/api/services/frigate/frames/other/track")).status).toBe(404);
    expect((await app.request("/api/services/frigate/frames/front/missing")).status).toBe(404);
    expect((await app.request("/api/services/frigate/frames/front/bad%2Fid")).status).toBe(400);
    expect(reads).toBe(1);
    mode = "missing";
    expect((await app.request("/api/services/frigate/frames/front/track")).status).toBe(404);
    mode = "error";
    const failure = await app.request("/api/services/frigate/frames/front/track");
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("private SSH");
  } finally { await service.stop(); }
});

test("an update long after its track began shows the recorded frame at that moment, not the track's best frame", async () => {
  const config = { topicPrefix: "frigate", cameras: { front: "front-device" } };
  const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
  const snapshotReads: string[] = [], stills: number[] = [];
  const recorded = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd9]);
  const previews = {
    async read() { return undefined; },
    async still(camera: string, frameTime: number) { stills.push(frameTime); return camera === "front" ? recorded : undefined; },
  };
  const service = new FrigateEvents({ onMessage: (topic, handler) => { handlers.set(topic, handler); return () => {}; } }, config, Date.now,
    undefined, { async read(_, objectId) { snapshotReads.push(objectId); return jpeg; } }, previews);
  const publish = (frameTime: number) => handlers.get("frigate/events")!("frigate/events", Buffer.from(JSON.stringify({
    type: "update", after: { id: "1000.5-abc", camera: "front", label: "car", false_positive: false, top_score: 0.99, start_time: 1000.5, frame_time: frameTime },
  })));
  publish(1010); publish(1100);
  const cameras = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const app = createApp(cameras, new Site([], undefined, new Map(), [service]));
  const frame = async (query: string) => app.request(`/api/services/frigate/frames/front/1000.5-abc${query}`);
  try {
    expect(new Uint8Array(await (await frame("?at=1100")).arrayBuffer())).toEqual(recorded);
    expect(stills).toEqual([1100]);
    // Early in the track the best frame stands for the moment, and carries Frigate's box.
    expect(new Uint8Array(await (await frame("?at=1010")).arrayBuffer())).toEqual(jpeg);
    expect(new Uint8Array(await (await frame("")).arrayBuffer())).toEqual(jpeg);
    expect(snapshotReads).toEqual(["1000.5-abc", "1000.5-abc"]);
    expect((await frame("?at=1234")).status).toBe(404);
    for (const time of ["", "NaN", "-1"]) expect((await frame(`?at=${time}`)).status).toBe(400);
    expect(stills).toEqual([1100]);
  } finally { await service.stop(); }
  // Without recorded frames there is no picture, never the best frame from another time of day.
  const blind = new FrigateEvents({ onMessage: (topic, handler) => { handlers.set(topic, handler); return () => {}; } }, config, Date.now,
    undefined, { async read() { return jpeg; } });
  publish(1100);
  try {
    expect(await blind.snapshot("front", "1000.5-abc", signal(), 1100)).toBeUndefined();
  } finally { await blind.stop(); }
  expect(trackStart("1000.5-abc", 7)).toBe(1000.5);
  expect(trackStart("no-start", 7)).toBe(7);
  expect(trackStart("track", 7)).toBe(7);
});
