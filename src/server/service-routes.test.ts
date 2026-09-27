import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { SseFrameReader } from "./test-sse";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { EventLog, type EventData, type EventFilter, type ServiceEvent } from "../models/event-log";
import { Service, type ServiceAction, type ServiceStatus } from "../models/service";
import { Site } from "../site";
import { validators } from "../validation";
import type { SavedFilter } from "../models/filter-store";

class FakeService extends Service {
  private readonly log = new EventLog();
  private availability: ServiceStatus["availability"] = "online";

  constructor(id: string, title: string, private detail = "Running") {
    super(id, title);
  }

  setStatus(availability: ServiceStatus["availability"], detail: string): void {
    this.availability = availability;
    this.detail = detail;
  }

  publish(type: string, message: string, level: "info" | "warn" | "error" = "info", options: { subject?: string; data?: EventData } = {}): void {
    this.log.record(type, message, { level, ...options });
  }

  override status(): ServiceStatus {
    return { availability: this.availability, detail: this.detail };
  }

  override events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] {
    return this.log.recent(limit, filter);
  }

  override subjects(): readonly string[] {
    return this.log.subjects();
  }

  override subscribe(listener: (event: ServiceEvent) => void, filter?: EventFilter): () => void {
    return this.log.subscribe(listener, filter);
  }
}

/** A service with one momentary action whose effect stands for a while, as the Hue proxy's link button does. */
class PairingService extends FakeService {
  until: string | undefined;
  presses = 0;

  override get actions(): readonly ServiceAction[] {
    return [{
      id: "link-button",
      state: () => (this.until ? { until: this.until } : {}),
      invoke: async () => {
        this.presses += 1;
        this.until = new Date(Date.now() + 60_000).toISOString();
        return { detail: "Pairing open for 60s" };
      },
    }];
  }
}

function pairingFixture(until?: string) {
  const cameraService = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const service = new PairingService("hue-proxy", "Hue bridge proxy", "Pairing closed");
  service.until = until;
  return { service, app: createApp(cameraService, new Site([], undefined, new Map(), [service])) };
}

function fixture() {
  const cameraService = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const broker = new FakeService("mqtt-broker", "MQTT broker", "Listening on 0.0.0.0:1883, 0 clients connected");
  broker.publish("started", "Listening on 0.0.0.0:1883");
  const site = new Site([], undefined, new Map(), [broker]);
  const app = createApp(cameraService, site);
  const json = (path: string) => app.request(path, { method: "GET" });
  return { app, json, broker };
}

test("Filter conditions narrow the API before limits and select the same live events", async () => {
  const { app, broker } = fixture();
  const where = encodeURIComponent(JSON.stringify({ all: [
    { path: "/subject", op: "eq", value: "camera-4" },
    { path: "/data/label", op: "eq", value: "person" },
    { timeWindow: { start: "09:00", end: "12:00", timeZone: "UTC", timestamp: { path: "/data/frameTime", format: "unixSeconds" } } },
  ] }));
  const publish = (label: string, subject = "camera-4") => broker.publish("camera_object", label, "info", { subject,
    data: { source: "frigate", camera: subject, objectId: "example-track", phase: "new", label, confidence: 0.9,
      frameTime: Date.parse("2026-09-20T09:00:00Z") / 1000, startTime: 100, currentZones: [], enteredZones: [] } });
  publish("person"); publish("dog"); publish("person", "camera-3");
  const response = await app.request(`/api/services/mqtt-broker/events?where=${where}&limit=1`);
  expect(response.status).toBe(200);
  expect((await response.json()).events).toMatchObject([{ subject: "camera-4", data: { label: "person" } }]);
  const stream = await app.request(`/api/services/mqtt-broker/stream?where=${where}`);
  const reader = new SseFrameReader(stream);
  try {
    expect(await reader.next(1)).toMatchObject([{ data: { subject: "camera-4", data: { label: "person" } } }]);
    publish("dog"); publish("person", "camera-3"); publish("person");
    expect(await reader.next(1)).toMatchObject([{ data: { subject: "camera-4", data: { label: "person" } } }]);
  } finally { await reader.close(); }
});

test("invalid Filter conditions are rejected before opening a stream", async () => {
  const { app } = fixture();
  for (const input of ["{", "null", "{}", JSON.stringify({ timeWindow: { start: "09:00", end: "12:00", timeZone: "Invalid/Zone" } }), " ".repeat(16_385)]) {
    for (const route of ["events", "stream"]) {
      const response = await app.request(`/api/services/mqtt-broker/${route}?where=${encodeURIComponent(input)}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_filter");
    }
  }
});

test("Frigate camera counts ignore checked labels and stay current for unmatched live detections", async () => {
  const cameraService = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const video = new FakeService("frigate", "Frigate");
  let objectId = 0;
  const publish = (subject: string, label: string) => video.publish("camera_object", label, "info", { subject,
    data: { source: "frigate", camera: subject, objectId: String(++objectId), phase: "new", label, confidence: 0.9,
      frameTime: 100, startTime: 100, currentZones: [], enteredZones: [] } });
  publish("front", "person"); publish("yard", "dog");
  const app = createApp(cameraService, new Site([], undefined, new Map(), [video]));
  const response = await app.request("/api/services/frigate/events?subject=front&label=dog&limit=1");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(validators.serviceEventsResponse(body)).toBe(true);
  expect(body).toMatchObject({ events: [], labels: ["dog", "person"], labelCounts: { person: 1 } });
  const empty = await (await app.request("/api/services/frigate/events?subject=offline")).json();
  expect(empty).toMatchObject({ events: [], labels: ["dog", "person"], labelCounts: {} });

  const stream = await app.request("/api/services/frigate/stream?subject=front&label=person");
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  try {
    await reader.read(); // Retry hint.
    expect(decoder.decode((await reader.read()).value)).toContain("event: service-event");
    expect(decoder.decode((await reader.read()).value)).toContain('"labelCounts":{"person":1}');
    publish("yard", "cat");
    publish("front", "dog");
    const update = decoder.decode((await reader.read()).value);
    expect(update).toContain("event: detection-labels");
    expect(update).not.toContain("event: service-event");
    const counts = JSON.parse(update.split("data: ")[1]!).labelCounts;
    expect(counts).toEqual({ person: 1, dog: 1 });
  } finally { await reader.cancel(); }
});

test("the camera labels page includes photo cameras in its device menu and applies their Filter on first render", async () => {
  const video = new FakeService("frigate", "Camera labels"), photos = new FakeService("photo-labels", "Photo labels");
  video.publish("camera_object", "Video-only observation", "info", { subject: "video-camera", data: {
    source: "frigate", camera: "video", objectId: "video-1", phase: "new", label: "person", confidence: 0.9,
    frameTime: 100, startTime: 100, currentZones: [], enteredZones: [],
  } });
  photos.publish("photo_labeled", "Photo-only observation", "info", { subject: "reveal-camera", data: {
    source: "reveal", camera: "cloud-camera", eventId: "event-1", photoId: "a".repeat(64), processedAt: 1000,
    engine: "synthetic", model: "test", modelHash: "b".repeat(64), detections: [], label: "bobcat", confidence: 0.9,
  } });
  const site = new Site([], undefined, new Map(), [video, photos]);
  const app = createApp(undefined, site);
  const condition = { all: [{ path: "/subject", op: "eq", value: "reveal-camera" }, { detectionLabels: ["bobcat"] }] };
  const where = encodeURIComponent(JSON.stringify(condition));
  const page = await app.request(site.pages().page("service", "frigate")! + "?where=" + where);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('name="event-subject" value="video-camera"');
  expect(html).toContain('name="event-subject" value="reveal-camera"');
  expect(html).toContain("Photo-only observation");
  expect(html).not.toContain("Video-only observation");
  const history = await (await app.request("/api/services/frigate/events?where=" + where)).json();
  expect(history.subjects).toEqual(["video-camera", "reveal-camera"]);
  expect(history.events).toHaveLength(1);
  expect(history.events[0]).toMatchObject({ subject: "reveal-camera", type: "photo_labeled" });
  expect(history.labelCounts).toEqual({ bobcat: 1 });
});

test("a saved multi-camera Filter scopes pagination, counts and live events to either selected camera", async () => {
  const video = new FakeService("frigate", "Camera labels");
  let objectId = 0;
  const publish = (subject: string, label: string) => video.publish("camera_object", `${subject} ${label}`, "info", { subject,
    data: { source: "frigate", camera: subject, objectId: String(++objectId), phase: "new", label, confidence: 0.9,
      frameTime: 100, startTime: 100, currentZones: [], enteredZones: [] } });
  publish("front", "person"); publish("yard", "person"); publish("excluded", "cat");
  const app = createApp(undefined, new Site([], undefined, new Map(), [video]));
  const condition = { all: [{ path: "/subject", op: "in", value: ["front", "yard"] }, { detectionLabels: ["person"] }] };
  const created = await app.request("/api/filters", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Outdoor people", condition }) });
  expect(created.status).toBe(201);
  const saved = await created.json() as SavedFilter;
  const query = `?filter=${saved.filter.id}`;
  const first = await (await app.request("/api/services/frigate/events" + query + "&limit=1")).json();
  const second = await (await app.request("/api/services/frigate/events" + query + "&limit=1&before=" + first.nextCursor)).json();
  expect(new Set([...first.events, ...second.events].map((event: ServiceEvent) => event.subject))).toEqual(new Set(["front", "yard"]));
  expect(second.nextCursor).toBeUndefined();
  expect(first.labelCounts).toEqual({ person: 2 });
  const stream = new SseFrameReader(await app.request("/api/services/frigate/stream" + query));
  try {
    const backlog = await stream.next(3);
    expect(backlog.filter(frame => frame.event === "service-event")).toHaveLength(2);
    expect(backlog.at(-1)).toMatchObject({ event: "detection-labels", data: { labelCounts: { person: 2 } } });
    publish("excluded", "person"); publish("yard", "dog");
    expect(await stream.next(1)).toMatchObject([{ event: "detection-labels", data: { labelCounts: { person: 2, dog: 1 } } }]);
    for (const subject of ["front", "yard"]) {
      publish(subject, "person");
      const frames = await stream.next(2);
      expect(frames[0]).toMatchObject({ event: "service-event", data: { subject } });
      expect(frames[1]?.event).toBe("detection-labels");
    }
  } finally { await stream.close(); }
  const conflicting = await (await app.request("/api/services/frigate/events" + query + "&subject=excluded")).json();
  expect(conflicting.events).toEqual([]); expect(conflicting.labelCounts).toEqual({});
});

describe("service routes", () => {
  test("GET /api/services lists every service with its status and page", async () => {
    const { json } = fixture();
    const response = await json("/api/services");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validators.serviceListResponse(body)).toBe(true);
    // `actions` is part of the listing so a client that has never heard of
    // this service can still offer what it declares; the broker declares none.
    expect(body.services).toEqual([{ id: "mqtt-broker", title: "MQTT broker", health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, availability: "online", detail: "Listening on 0.0.0.0:1883, 0 clients connected", page: "/services/mqtt-broker", actions: [], endpoints: [] }]);
  });

  test("GET /api/services/:id/events returns that service's recent events, newest first", async () => {
    const { json, broker } = fixture();
    broker.publish("client_connected", 'Client "wyze-cam-v3" connected', "info", { data: { clientId: "wyze-cam-v3" } });
    const response = await json("/api/services/mqtt-broker/events");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validators.serviceEventsResponse(body)).toBe(true);
    expect(body.serviceId).toBe("mqtt-broker");
    expect(body.events.map((event: { type: string }) => event.type)).toEqual(["client_connected", "started"]);
  });

  test("GET /api/services/:id/events honors ?limit=", async () => {
    const { json, broker } = fixture();
    broker.publish("client_connected", "1", "info", { data: { clientId: "example-client" } });
    broker.publish("client_disconnected", "2", "info", { data: { clientId: "example-client" } });
    const response = await json("/api/services/mqtt-broker/events?limit=1");
    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe("client_disconnected");
  });

  test("GET /api/services/:id/events 404s for an unknown service", async () => {
    const { json } = fixture();
    const response = await json("/api/services/nope/events");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  test("GET /services renders the list page with a link to the service", async () => {
    const { app } = fixture();
    const response = await app.request("/services");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("MQTT broker");
    expect(html).toContain('href="/services/mqtt-broker"');
  });

  test("GET /services/:id renders that service's status and starts polling its events", async () => {
    const { app } = fixture();
    const response = await app.request("/services/mqtt-broker");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("MQTT broker");
    expect(html).toContain("Listening on 0.0.0.0:1883");
    expect(html).toContain('data-service-id="mqtt-broker"');
    // Motion remains selectable even before one has arrived (or after it has
    // aged out of the broker's bounded in-memory event ring).
    expect(html).toContain('<option value="motion"');
    // A service with no actions is unchanged: no control, and no script for one.
    expect(html).not.toContain("data-service-action");
  });

  test("GET /services/:id renders one control per action, already showing what that action has standing", async () => {
    const { app } = pairingFixture(new Date(Date.now() + 42_000).toISOString());
    const html = await (await app.request("/services/hue-proxy")).text();
    expect(html).toContain('data-service-action="link-button"');
    // The label is the catalog's, keyed by the action's own id.
    expect(html).toMatch(/data-action="link-button"[^>]*>Open pairing</u);
    // The open window is in the first paint, not fetched afterwards.
    expect(html).toContain('data-action="link-button" data-state="active"');
    expect(html).toContain("<span class=\"action-state\" data-action-state>Active for 42 more seconds</span>");
  });

  test("an action that has nothing standing renders its control at rest", async () => {
    const { app } = pairingFixture();
    const html = await (await app.request("/services/hue-proxy")).text();
    expect(html).toContain('data-service-action="link-button"');
    expect(html).not.toContain('data-action="link-button" data-state="active"');
    expect(html).toContain("<span class=\"action-state\" data-action-state></span>");
  });

  test("POST /api/services/:id/actions/:action performs it and answers with the new deadline", async () => {
    const { app, service } = pairingFixture();
    const response = await app.request("/api/services/hue-proxy/actions/link-button", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    const body = await response.json() as { serviceId: string; action: string; detail: string; until: string };
    expect(body).toMatchObject({ serviceId: "hue-proxy", action: "link-button", detail: "Pairing open for 60s" });
    expect(Date.parse(body.until)).toBeGreaterThan(Date.now());
    expect(service.presses).toBe(1);
  });

  test("GET /services/:id 404s for an unknown service", async () => {
    const { app } = fixture();
    const response = await app.request("/services/nope");
    expect(response.status).toBe(404);
  });

  test("a degraded/offline service reports the matching availability through the API", async () => {
    const { json, broker } = fixture();
    broker.setStatus("offline", "Stopped");
    const body = await (await json("/api/services")).json();
    expect(body.services[0]).toMatchObject({ availability: "offline", detail: "Stopped" });
  });
});

describe("service event stream (SSE)", () => {
  test("sends the backlog immediately as service-event frames, oldest first", async () => {
    const { app, broker } = fixture();
    broker.publish("client_connected", 'Client "cam" connected', "info", { data: { clientId: "cam" } });
    const response = await app.request("/api/services/mqtt-broker/stream");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = new SseFrameReader(response);
    const frames = await reader.next(2);
    await reader.close();
    expect(frames.map((frame) => [frame.event, (frame.data as { type: string }).type])).toEqual([
      ["service-event", "started"],
      ["service-event", "client_connected"],
    ]);
  });

  test("pushes a new event the moment it is recorded, with no further request", async () => {
    const { app, broker } = fixture();
    const response = await app.request("/api/services/mqtt-broker/stream");
    const reader = new SseFrameReader(response);
    const backlog = await reader.next(1);
    expect(backlog).toHaveLength(1);

    broker.publish("message_published", '"cam" published to thingino/porch', "info", { data: { clientId: "cam", topic: "thingino/porch" } });
    const pushed = await reader.next(1);
    await reader.close();
    expect(pushed).toEqual([{ event: "service-event", data: expect.objectContaining({ type: "message_published" }) }]);
  });

  test("404s for an unknown service", async () => {
    const { app } = fixture();
    const response = await app.request("/api/services/nope/stream");
    expect(response.status).toBe(404);
  });
});

describe("filtering a service's events", () => {
  function filterFixture() {
    const base = fixture();
    base.broker.publish("motion", "Kitchen motion", "info", { subject: "example-camera", data: { bytes: 1_000, thumbnailUrl: "/api/devices/example-camera/alarms/a.jpg" } });
    base.broker.publish("registered", "Kitchen registered", "info", { subject: "example-camera", data: { uuid: "u1" } });
    base.broker.publish("motion", "Hall motion", "info", { subject: "example-camera-2", data: { bytes: 2_000 } });
    return base;
  }

  test("?subject= narrows to one device, and the response lists every device for the menu", async () => {
    const { json } = filterFixture();
    const response = await json("/api/services/mqtt-broker/events?subject=example-camera");
    const body = await response.json() as { events: { message: string }[]; subjects: string[]; types: string[] };
    expect(validators.serviceEventsResponse(body)).toBe(true);
    expect(body.events.map((event) => event.message)).toEqual(["Kitchen registered", "Kitchen motion"]);
    expect(body.subjects).toEqual(["example-camera", "example-camera-2"]);
    expect(body.types).toContain("motion");
  });

  test("?type= narrows to particular kinds, and the two filters combine", async () => {
    const { json } = filterFixture();
    const byType = await (await json("/api/services/mqtt-broker/events?type=motion")).json() as { events: { message: string }[] };
    expect(byType.events.map((event) => event.message)).toEqual(["Hall motion", "Kitchen motion"]);

    const both = await (await json("/api/services/mqtt-broker/events?subject=example-camera-2&type=motion")).json() as { events: { message: string }[] };
    expect(both.events.map((event) => event.message)).toEqual(["Hall motion"]);

    const many = await (await json("/api/services/mqtt-broker/events?type=motion,registered")).json() as { events: unknown[] };
    expect(many.events).toHaveLength(3);
  });

  test("an event carries its subject and its typed data through the API", async () => {
    const { json } = filterFixture();
    const body = await (await json("/api/services/mqtt-broker/events?subject=example-camera&type=motion")).json() as { events: { subject: string; data: Record<string, unknown> }[] };
    expect(body.events[0]).toMatchObject({
      subject: "example-camera",
      data: { bytes: 1_000, thumbnailUrl: "/api/devices/example-camera/alarms/a.jpg" },
    });
  });

  test("the live stream is filtered at the source, so a filtered view never receives another device's events", async () => {
    const { app, broker } = filterFixture();
    const response = await app.request("/api/services/mqtt-broker/stream?subject=example-camera-2");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    /** Reads until `text` arrives, so the retry hint and each frame may land in any chunking. */
    const readUntil = async (text: string): Promise<string> => {
      let seen = "";
      for (let attempt = 0; attempt < 10 && !seen.includes(text); attempt += 1) {
        seen += decoder.decode((await reader.read()).value);
      }
      return seen;
    };

    const backlog = await readUntil("Hall motion");
    expect(backlog).toContain("Hall motion");
    expect(backlog).not.toContain("Kitchen motion");

    broker.publish("motion", "Hall motion again", "info", { subject: "example-camera-2", data: { bytes: 3 } });
    broker.publish("motion", "Kitchen motion again", "info", { subject: "example-camera", data: { bytes: 3 } });
    const next = await readUntil("Hall motion again");
    expect(next).toContain("Hall motion again");
    expect(next).not.toContain("Kitchen");
    await reader.cancel();
  });
});

describe("the event type catalog route", () => {
  test("GET /api/event-types describes every type, its view, and its schema", async () => {
    const { json } = fixture();
    const response = await json("/api/event-types");
    expect(response.status).toBe(200);
    const body = await response.json() as { types: { id: string; view: string; payloadSchema: Record<string, unknown> }[] };
    expect(validators.eventTypeCatalogResponse(body)).toBe(true);
    const motion = body.types.find((type) => type.id === "motion");
    expect(motion?.view).toBe("thumbnail");
    expect(motion?.payloadSchema).toMatchObject({ type: "object" });
  });
});


test("saved Filters drive event history, pagination and live subscriptions", async () => {
  const { app, broker } = fixture();
  const input = { name: "People on camera 4", condition: { all: [
    { path: "/subject", op: "eq", value: "camera-4" }, { detectionLabels: ["person"] },
  ] } };
  const write = (path: string, method: string, body: unknown) => app.request(path, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const created = await write("/api/filters", "POST", input);
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const record = await created.json() as SavedFilter;
  const path = `/api/filters/${record.filter.id}`;
  expect(record.slug).toBe("people-on-camera-4");
  expect((await app.request(`/services/mqtt-broker?filter=${record.slug}`)).status).toBe(200);
  expect((await app.request(`/services/mqtt-broker?editing-filter=${record.slug}`)).status).toBe(200);
  for (const key of ["filter", "editing-filter"]) {
    expect((await app.request(`/services/mqtt-broker?${key}=${record.filter.id}`)).status).toBe(404);
  }
  expect((await (await app.request("/api/filters")).json()).filters).toEqual([record]);
  expect(await (await app.request(path)).json()).toEqual(record);
  const publish = (message: string, subject: string, label: string) => broker.publish("camera_object", message, "info", { subject,
    data: { source: "frigate", camera: "camera_4", objectId: message, phase: "new", label, confidence: 0.9, frameTime: 100, startTime: 100, currentZones: [], enteredZones: [] } });
  publish("match", "camera-4", "person");
  publish("other-camera", "camera-3", "person");
  publish("other-label", "camera-4", "car");
  const query = `?filter=${record.filter.id}`;
  const history = await (await app.request("/api/services/mqtt-broker/events" + query + "&limit=1")).json();
  expect(history.events.map((event: ServiceEvent) => event.message)).toEqual(["match"]);
  const stream = new SseFrameReader(await app.request("/api/services/mqtt-broker/stream" + query));
  try {
    expect((await stream.next(1))[0]?.data).toMatchObject({ message: "match" });
    publish("rejected-live", "camera-3", "person");
    publish("accepted-live", "camera-4", "Human");
    expect((await stream.next(1))[0]?.data).toMatchObject({ message: "accepted-live" });
  } finally { await stream.close(); }
  const renamed = await write(path, "PUT", { ...input, name: "Renamed", revision: 1 });
  expect(renamed.status).toBe(200);
  expect((await renamed.json()).slug).toBe("renamed");
  expect((await app.request(`/services/mqtt-broker?filter=${record.slug}`)).status).toBe(404);
  expect((await app.request("/services/mqtt-broker?filter=renamed")).status).toBe(200);
  expect((await write(path, "PUT", { ...input, revision: 1 })).status).toBe(409);
  expect((await write(path + "?revision=1", "DELETE", {})).status).toBe(409);
  expect((await write(path + "?revision=2", "DELETE", {})).status).toBe(200);
  expect((await app.request(path)).status).toBe(404);
  for (const endpoint of ["events", "stream"]) expect((await app.request(`/api/services/mqtt-broker/${endpoint}${query}`)).status).toBe(404);
  expect((await write("/api/filters", "POST", { name: "Invalid", condition: {} })).status).toBe(400);
  expect((await write("/api/filters", "POST", { ...input, name: "x".repeat(150_000) })).status).toBe(413);
});
