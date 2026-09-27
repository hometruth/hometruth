import { afterEach, expect, test } from "bun:test";
import mqtt from "mqtt";
import { startMqttBroker, type MqttMessageHandler } from "../mqtt-broker";
import { FrigateEvents, frigateEventsConfig, normalizeFrigateClassification, normalizeFrigateObject } from "./events";
import { validateEventData } from "../../validation";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sample = (type = "new") => ({ type, after: { id: "1789160721.551178-kl8rt6", camera: "front",
  label: "person", top_score: 0.97, false_positive: false, start_time: 1789160721, frame_time: 1789160723,
  end_time: type === "end" ? 1789160730 : null, current_zones: ["porch"], entered_zones: ["porch"] } });

test("preserves track lifecycle, scores and timestamps without relaying images or undeclared data", () => {
  const value = sample("end");
  const data = normalizeFrigateObject({ ...value, after: { ...value.after, thumbnail: "private-image", token: "private",
    sub_label: ["delivery person", 0.8], current_zones: ["porch", "porch", 123] } });
  expect(data).toMatchObject({ objectId: value.after.id, phase: "end", label: "person", confidence: 0.97,
    endTime: 1789160730, subLabel: "delivery person", subLabelConfidence: 0.8, currentZones: ["porch"] });
  expect(validateEventData("camera_object", data!)).toBe(true);
  expect(JSON.stringify(data)).not.toContain("private");
  for (const patch of [{ false_positive: true }, { top_score: 2 }, { frame_time: NaN }, { id: "../bad" }, { end_time: 1 }]) {
    expect(normalizeFrigateObject({ ...value, after: { ...value.after, ...patch } })).toBeUndefined();
  }
  expect(normalizeFrigateObject({ ...sample(), type: "end" })).toBeUndefined();
  expect(normalizeFrigateObject({ type: "update", after: null })).toBeUndefined();
});

test("accepts classification consensus separately from unthresholded face attempts", () => {
  const v = { type: "classification", id: "track-1", camera: "front", timestamp: 100, model: "animal", sub_label: "deer", score: 0.9 };
  expect(normalizeFrigateClassification(v)).toMatchObject({ objectId: "track-1", label: "deer", kind: "sub_label" });
  expect(validateEventData("camera_classified", normalizeFrigateClassification(v)!)).toBe(true);
  expect(normalizeFrigateClassification({ ...v, type: "face", name: "unknown", score: 0.01 })).toBeUndefined();
  expect(normalizeFrigateClassification({ ...v, score: NaN })).toBeUndefined();
  expect(normalizeFrigateClassification({ ...v, sub_label: undefined, attribute: "yes" })?.kind).toBe("attribute");
});

test("rejects feedback loops and invalid camera mappings in configuration", () => {
  expect(frigateEventsConfig({ enabled: false })).toBeUndefined();
  expect(frigateEventsConfig({ enabled: true })).toEqual({ topicPrefix: "frigate", cameras: {} });
  for (const topicPrefix of ["hometruth", "hometruth/events", "frigate/#", "a+", ""]) {
    expect(() => frigateEventsConfig({ enabled: true, topicPrefix })).toThrow();
  }
  expect(() => frigateEventsConfig({ enabled: true, cameras: { front: "bad/id" } })).toThrow();
});

test("maps known cameras, keeps unknown feeds, deduplicates retries and becomes stale without stats", async () => {
  const handlers = new Map<string, MqttMessageHandler>();
  let now = 1000;
  const service = new FrigateEvents({ onMessage: (topic, fn) => { handlers.set(topic, fn); return () => { handlers.delete(topic); }; } },
    { topicPrefix: "frigate", cameras: { front: "front-camera" }, photoCameras: ["reveal"] }, () => now);
  const send = (topic: string, value: unknown) => handlers.get(`frigate/${topic}`)?.(topic, Buffer.from(JSON.stringify(value)));
  expect(service.status().availability).toBe("unknown");
  handlers.get("frigate/events")!("frigate/events", Buffer.from("malformed-json"));
  handlers.get("frigate/events")!("frigate/events", Buffer.alloc(1_048_577));
  send("events", sample()); send("events", sample()); send("events", sample("end"));
  expect(service.events().map(e => e.data?.phase)).toEqual(["end", "new"]);
  expect(service.events()[0]?.subject).toBe("front-camera");
  send("events", { ...sample(), after: { ...sample().after, camera: "other" } });
  expect(service.events()[0]?.subject).toBe("frigate-other");
  send("stats", { cameras: { front: { camera_fps: 5 }, other: { camera_fps: 0 }, reveal: { camera_fps: 0 } } });
  expect(service.status()).toMatchObject({ availability: "degraded" });
  expect(service.status().detail).toContain("1 of 2");
  expect(service.status().detail).not.toContain("reveal");
  now += 181_000;
  expect(service.status().availability).toBe("offline");
  await service.stop();
  expect(handlers.size).toBe(0);
});

test("a real MQTT publisher reaches normalized HomeTruth subscribers once", async () => {
  const broker = await startMqttBroker({ port: 0, hostname: "127.0.0.1" });
  cleanups.push(() => broker.stop());
  const service = new FrigateEvents(broker, { topicPrefix: "frigate", cameras: { front: "front-camera" },
    recordings: { baseUrl: "https://nvr.example.test/protect", cameras: { front: "a".repeat(24) }, preRollSeconds: 5 } });
  cleanups.push(() => service.stop());
  service.subscribe(event => { void broker.publishEvent(event); });
  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${broker.port}`);
  cleanups.push(() => client.endAsync());
  await client.subscribeAsync("hometruth/events/front-camera/camera_object");
  const received: unknown[] = [];
  const message = new Promise<void>(resolve => { client.on("message", (_, payload) => { received.push(JSON.parse(payload.toString())); resolve(); }); });
  const value = sample();
  await client.publishAsync("frigate/events", JSON.stringify({ ...value, after: { ...value.after, recordingUrl: "https://untrusted.example/" } }), { qos: 1 });
  await message;
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ type: "camera_object", subject: "front-camera", data: { source: "frigate", label: "person", confidence: 0.97,
    recordingUrl: `https://nvr.example.test/protect/timelapse/${"a".repeat(24)}?start=1789160718000`, recordingStartTime: 1789160718000 } });
  expect(JSON.stringify(received)).not.toContain("untrusted.example");
});
