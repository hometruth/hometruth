import { afterEach, expect, test } from "bun:test";
import { createApp } from "./app";
import { Site } from "../site";
import { CompositeDevice } from "../kindle/test-fixture";
import { StateHub } from "../state/hub";
import { TagStore } from "../tags/store";
import { MemorySignalCodeStore } from "../signal-code-store";
import { MemoryKindleConfigStore } from "../kindle/store";
import { deviceNode } from "../state/protocol";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function promptly<T>(work: Promise<T> | T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Rendering waited for I/O")), 1000); })]); }
  finally { clearTimeout(timeout); }
}

test("mainstream HTML and graph reads render cached state while every source is stalled", async () => {
  const device = new CompositeDevice();
  const value = await device.describe();
  let deviceReads = 0, metadataReads = 0;
  device.describe = () => { deviceReads++; return new Promise(() => {}); };
  const signals = new MemorySignalCodeStore();
  signals.snapshot = () => { metadataReads++; return new Promise(() => {}); };
  const kindle = new MemoryKindleConfigStore();
  kindle.load = () => { metadataReads++; return new Promise(() => {}); };
  const matter = { read: () => { metadataReads++; return new Promise<never>(() => {}); } };
  const site = new Site([device]);
  const hub = new StateHub(), tags = new TagStore();
  cleanup.push(() => hub.stop(), () => tags.close());
  const app = createApp(undefined, site, signals, undefined, undefined, undefined, undefined, undefined, matter, kindle, undefined, tags, hub);
  hub.observer.publish(device.id, value);
  const reads = metadataReads;
  const page = site.view(device.id)!.page;
  for (const path of ["/", "/devices", "/switches", "/buttons", page, `${page}/settings`, `${page}/graph`, "/graph", "/api/graph", "/api/elements", "/tags", "/kindle", "/kindle/settings", "/kindle/designer", "/api/kindle/snapshot", "/api/state"]) {
    const response = await promptly(app.request(path));
    expect(response.status, path).toBe(200);
    const text = await response.text();
    if (path === page) {
      expect(text).toContain("data-state-snapshot");
      expect(text.match(/<ht-(?:switch|light)\b[^>]*>([\s\S]*?)<\/ht-(?:switch|light)>/)?.[1]).toContain('aria-pressed="true"');
      expect(text).toContain('id="ht-state"');
    }
  }
  expect(deviceReads).toBe(0);
  expect(metadataReads).toBe(reads);
});

test("a cold device page renders unknown immediately without starting discovery", async () => {
  const device = new CompositeDevice();
  let reads = 0;
  device.describe = () => { reads++; return new Promise(() => {}); };
  const site = new Site([device]), hub = new StateHub(), tags = new TagStore();
  cleanup.push(() => hub.stop(), () => tags.close());
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags, hub);
  const response = await promptly(app.request(site.view(device.id)!.page));
  const html = await response.text();
  expect(html).toContain('data-state-snapshot data-availability="unknown" data-stale="true"');
  expect(reads).toBe(0);
});

test("page hydration ships rooms, tag assignments, and cached event history without reading sources", async () => {
  const { Service } = await import("../models/service");
  const { EventLog } = await import("../models/event-log");
  const { DeviceEventLogs } = await import("../models/device-event-log");
  const { elementKey } = await import("../tags/identity");
  class History extends Service {
    readonly log = new EventLog();
    reads = 0;
    status() { return { availability: "online" as const, detail: "Ready" }; }
    events(limit?: number) { this.reads++; return this.log.recent(limit); }
    subscribe(listener: import("../models/event-log").ServiceEventListener) { return this.log.subscribe(listener); }
  }
  const device = new CompositeDevice(), history = new History("history", "History");
  history.log.record("availability_changed", "Seeded service reading", { subject: device.id });
  const logs = new DeviceEventLogs();
  logs.record(device.id, "availability_changed", "Seeded local reading");
  const hub = new StateHub(), tags = new TagStore();
  cleanup.push(() => hub.stop(), () => tags.close());
  const room = tags.create({ name: "room", value: "Office", color: "#123456", description: "" });
  tags.attach(elementKey("device", device.id), { tagId: room.id });
  const site = new Site([device], undefined, undefined, [history]);
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, logs, undefined, undefined, undefined, undefined, tags, hub);
  const reads = history.reads;
  const page = site.view(device.id)!.page;
  const settings = await (await app.request(`${page}/settings`)).text();
  expect(settings).toContain('value="room:Office" selected');
  expect(settings).toContain('>room = Office</a>');
  const log = await (await app.request(`${page}/log`)).text();
  expect(log).toContain('class="event-body"><div>Seeded service reading');
  expect(log).toContain('class="event-body"><div>Seeded local reading');
  history.log.record("availability_changed", "New service fault", { subject: device.id });
  const service = await (await app.request(site.pages().page("service", history.id)!)).text();
  expect(service).toContain('class="event-body"><div>New service fault');
  expect(history.reads).toBe(reads);
  for (const html of [settings, log, service]) {
    const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
    expect(visible).not.toContain("Loading…");
    expect(visible).not.toContain("Checking…");
  }
});
