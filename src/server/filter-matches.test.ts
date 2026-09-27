import { expect, test } from "bun:test";
import { createApp } from "./app";
import { SseFrameReader } from "./test-sse";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { Site } from "../site";
import { EventLog } from "../models/event-log";
import { FilterStore } from "../models/filter-store";
import { FilterMatches } from "../models/filter-matches";
import { validators } from "../validation";

test("live Filter matches are visible as a service, in its history and SSE, and through the Event catalog", async () => {
  const store = new FilterStore();
  const matches = new FilterMatches(store);
  const source = new EventLog();
  const cameras = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const site = new Site([], undefined, new Map(), [matches]);
  const app = createApp(cameras, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store);
  matches.connect([source]);
  const stream = new SseFrameReader(await app.request("/api/services/filter-matches/stream"));
  try {
    const result = await app.request("/api/filters", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Motion events", condition: { path: "/type", op: "eq", value: "motion" } }) });
    expect(result.status).toBe(201);
    const { filter } = await result.json();
    const original = source.record("motion", "Motion detected", { subject: "camera-4", data: { bytes: 123 } });
    const [live] = await stream.next(1);
    expect(live).toMatchObject({ event: "service-event", data: { type: "filter_matched", subject: "camera-4", data: { filterId: filter.id, filterName: "Motion events", filterRevision: 1, event: original } } });
    const history = await (await app.request("/api/services/filter-matches/events")).json();
    expect(validators.serviceEventsResponse(history)).toBe(true);
    expect(history.events).toEqual([live!.data]);
    const page = await app.request("/services/filter-matches");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Motion events");
    const catalog = await (await app.request("/api/event-types")).json();
    expect(catalog.types.find((type: { id: string }) => type.id === "filter_matched")).toMatchObject({ label: "Filter matched", payloadSchema: { required: ["filterId", "filterName", "filterRevision", "event"] } });
    const services = await (await app.request("/api/services")).json();
    expect(services.services).toContainEqual(expect.objectContaining({ id: "filter-matches", page: "/services/filter-matches" }));
  } finally { await stream.close(); await matches.stop(); store.close(); await cameras.close(); }
});
