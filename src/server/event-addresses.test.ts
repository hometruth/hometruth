import { expect, test } from "bun:test";
import { addressesFor } from "../element-api/addresses";
import { eventForApi } from "../element-api/event-presentation";
import { CompositeDevice } from "../kindle/test-fixture";
import { EventHistory } from "../models/event-history";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../models/event-log";
import { Service } from "../models/service";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { elementKey } from "../tags/identity";
import { createApp } from "./app";
import { SseFrameReader } from "./test-sse";

class CameraEvents extends Service {
  readonly log = new EventLog();
  constructor() { super("events-5", "Camera Archive"); }
  status() { return { availability: "online" as const, detail: "Ready" }; }
  events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  override subjects() { return this.log.subjects(); }
}

test("events advertise friendly thumbnail URLs in history and every stream without changing stored events", async () => {
  const device = new CompositeDevice("camera-17", "Porch Camera");
  const service = new CameraEvents();
  const site = new Site([device], undefined, undefined, [service]);
  const hub = new StateHub(), history = new EventHistory(":memory:");
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, hub, undefined, undefined, undefined, history);
  const internalUrl = "/api/devices/camera-17/alarms/motion.jpg";
  const publicUrl = "/api/devices/porch-camera/alarms/motion.jpg";
  const publish = (message: string) => service.log.record("motion", message, { subject: device.id, data: { bytes: 100, thumbnailUrl: internalUrl } });
  const recorded = publish("Archived motion");
  history.save(recorded);
  const address = addressesFor(hub).address(elementKey("device", device.id))!;
  const routes = ["/api/events", "/api/devices/porch-camera/events", `/api/elements/${address}/events`, "/api/services/camera-archive/events"];
  const readers: SseFrameReader[] = [];
  try {
    for (const path of routes) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.events.find((event: ServiceEvent) => event.message === "Archived motion")?.data?.thumbnailUrl).toBe(publicUrl);
    }
    for (const path of ["/api/events/stream", "/api/devices/porch-camera/events/stream", `/api/elements/${address}/events/stream`, "/api/services/camera-archive/stream"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const reader = new SseFrameReader(response); readers.push(reader);
      expect(await reader.next(1)).toMatchObject([{ data: { data: { thumbnailUrl: publicUrl } } }]);
    }
    publish("Live motion");
    for (const reader of readers) expect(await reader.next(1)).toMatchObject([{ data: { message: "Live motion", data: { thumbnailUrl: publicUrl } } }]);
    const html = await (await app.request(`${site.list()[0]!.page}/log`)).text();
    expect(html).toContain(`src="${publicUrl}"`);
    const seed = JSON.parse(html.match(/data-event-seed>(.*?)<\/script>/s)![1]!);
    expect(seed.events.every((event: ServiceEvent) => event.data?.thumbnailUrl === publicUrl)).toBe(true);
    expect(recorded.data?.thumbnailUrl).toBe(internalUrl);
    expect(history.page().events[0]?.data?.thumbnailUrl).toBe(internalUrl);
  } finally {
    for (const reader of readers) await reader.close();
    hub.stop(); history.close();
  }
});

test("event serialization only formats the documented thumbnail URL", () => {
  const internalUrl = "/api/devices/camera-17/alarms/motion.jpg";
  const event: ServiceEvent = { at: "2026-01-01T00:00:00Z", level: "info", type: "motion", message: internalUrl,
    data: { thumbnailUrl: internalUrl, note: internalUrl, nested: { thumbnailUrl: internalUrl } } };
  const shown = eventForApi(event, path => path.replace("camera-17", "porch-camera"));
  expect(shown.message).toBe(internalUrl);
  expect(shown.data).toEqual({ thumbnailUrl: "/api/devices/porch-camera/alarms/motion.jpg", note: internalUrl, nested: { thumbnailUrl: internalUrl } });
  const external = { ...event, data: { thumbnailUrl: "https://images.example.test/motion.jpg" } };
  expect(eventForApi(external, () => { throw new Error("External URLs are not API addresses"); })).toBe(external);
});
