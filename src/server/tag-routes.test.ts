import { StateHub } from "../state/hub";
import { afterEach, describe, expect, test } from "bun:test";
import { Device } from "../models/device";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { TemperatureSensor } from "../models/sensor";
import { StringLightControl } from "../models/string-light";
import { TestLight, TestRelay } from "../kindle/test-fixture";
import { DEFAULT_KINDLE_CONFIG } from "../kindle/config";
import { MemoryKindleConfigStore } from "../kindle/store";
import { MemorySignalCodeStore } from "../signal-code-store";
import { Site } from "../site";
import { TagStore } from "../tags/store";
import { elementKey, listElements } from "../tags/elements";
import { createApp } from "./app";
import { DogAnnouncer } from "../automations/dog-announcer";
import { SensorCollection } from "../models/sensors";

const stores: TagStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
class Thermometer extends TemperatureSensor {
  async getState(): Promise<never> { throw new Error("Tagging must not read the sensor"); }
}
class RelayDevice extends Device {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities = { binarySwitch: new TestRelay("relay") };
  override readonly sensors = [new Thermometer("temperature", "Temperature")];
  async probe(): Promise<never> { throw new Error("Tagging must not probe hardware"); }
}
const request = (app: ReturnType<typeof createApp>, path: string, method: string, body: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function fixture() {
  const first = new RelayDevice("same-id", "Kitchen switch", { password: "private-config" }); first.room = "Kitchen";
  const other = new RelayDevice("other", "Other switch", {});
  const site = new Site([first, other], undefined, undefined, undefined, undefined, undefined, [{ id: "same-id", name: "Combined switches", members: [first.id, other.id], asSwitch: true }]);
  const tags = new TagStore(); stores.push(tags);
  const kindle = new MemoryKindleConfigStore();
  const signals = new MemorySignalCodeStore();
  const app = createApp(undefined, site, signals, undefined, undefined, undefined, undefined, undefined, undefined, kindle, undefined, tags);
  return { app, site, tags, kindle, signals };
}

describe("universal tag routes", () => {
  test("discovers individual bridged sensors once and keeps their identities separate", async () => {
    let reads = 0;
    class Collection extends SensorCollection {
      async getState() {
        reads++;
        return { availability: "online" as const, sensors: [
          { id: "bridge-temperature", name: "Bridge temperature", quantity: "temperature", unit: "°C", availability: "unknown" as const },
          { id: "bridge-motion", name: "Bridge motion", quantity: "motion", unit: "", availability: "unknown" as const },
        ] };
      }
    }
    class BridgedDevice extends Device {
      readonly model = { ...SHELLY_PLUS_1, capabilities: ["sensor"] as const };
      readonly capabilities = { sensor: new Collection("collection") };
      async probe(): Promise<never> { throw new Error("Must not probe hardware"); }
    }
    const site = new Site([new BridgedDevice("bridge", "Bridge", {})]);
    const store = new TagStore(); stores.push(store);
    const hub = new StateHub();
    const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store, hub);
    await hub.observer.refresh("device/bridge");
    const first = await (await app.request("/api/elements?kind=sensor")).json();
    expect(first.elements.map((element: { name: string }) => element.name)).toEqual(["Bridge temperature", "Bridge motion"]);
    const key = elementKey("sensor", "bridge", "bridge-temperature");
    expect((await request(app, `/api/elements/${key}/tags`, "POST", { value: "temperature" })).status).toBe(200);
    expect(store.tagsFor(elementKey("sensor", "bridge", "bridge-motion"))).toEqual([]);
    expect(reads).toBe(1);
  });

  test("catalogs devices, groups, automatic groups, nested sensors, capabilities, controls, properties, and rooms", async () => {
    const { app } = fixture();
    const result = await (await app.request("/api/elements?limit=200")).json();
    const keys = result.elements.map((element: { key: string }) => element.key);
    for (const key of [elementKey("device", "same-id"), elementKey("group", "same-id"), elementKey("group-switch", "same-id"), elementKey("group", "automatic:switches"), elementKey("sensor", "same-id", "temperature"), elementKey("sensor", "other", "temperature"), elementKey("capability", "same-id", "binarySwitch"), elementKey("control", "same-id", "binarySwitch", "turnOn"), elementKey("property", "same-id", "binarySwitch", "value")]) expect(keys).toContain(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(JSON.stringify(result)).not.toContain("private-config");
    const page = await (await app.request("/api/elements?path=" + encodeURIComponent("/switches/kitchen-switch/settings"))).json();
    expect(page.elements.map((element: { kind: string }) => element.kind)).toContain("sensor");
    expect(page.elements.every((element: { key: string }) => element.key !== elementKey("device", "other"))).toBe(true);
  });

  test("attaches many UUID tags, renames without rewriting assignments, and removes only the chosen link", async () => {
    const { app, tags } = fixture();
    const key = elementKey("sensor", "same-id", "temperature");
    const first = await request(app, `/api/elements/${key}/tags`, "POST", { value: "climate" });
    expect(first.status).toBe(200);
    const tag = (await first.json()).tags[0];
    const secondKey = elementKey("group", "automatic:switches");
    expect((await request(app, `/api/elements/${secondKey}/tags`, "POST", { tagId: tag.id })).status).toBe(200);
    expect((await request(app, `/api/elements/${key}/tags`, "POST", { value: "kitchen" })).status).toBe(200);
    const before = tags.assignments();
    const changed = await request(app, `/api/tags/${tag.id}`, "PATCH", { value: "NewTag2", color: "#ee2277", description: "A renamed tag", revision: tag.revision });
    expect(changed.status).toBe(200);
    expect(tags.assignments()).toEqual(before);
    const payload = await changed.json();
    expect((await app.request(payload.page)).status).toBe(200);
    expect((await app.request("/tags/climate")).status).toBe(404);
    const list = await (await app.request(`/api/elements/${key}/tags`)).json();
    expect(list.tags).toHaveLength(2);
    expect(list.tags.find((item: { id: string }) => item.id === tag.id)).toMatchObject({ value: "NewTag2", color: "#ee2277", description: "A renamed tag" });
    const matching = await (await app.request(`/api/elements?tagId=${tag.id}`)).json();
    expect(matching.total).toBe(2);
    expect((await request(app, `/api/elements/${key}/tags/${tag.id}`, "DELETE", {})).status).toBe(200);
    expect(tags.tagsFor(secondKey)).toHaveLength(1);
    expect(tags.tagsFor(key)).toHaveLength(1);
  });

  test("rejects unknown elements, tagging a tag, invalid values, duplicate pairs, and stale revisions", async () => {
    const { app, tags } = fixture();
    for (const value of ["", "a\tb", "a\nb"]) expect((await request(app, "/api/tags", "POST", { value, color: "#123456", description: "" })).status).toBe(400);
    const tag = tags.create({ value: "valid", color: "#123456", description: "" });
    const fakeTagKey = Buffer.from(JSON.stringify(["tag", tag.id])).toString("base64url");
    for (const key of ["unknown", fakeTagKey]) expect((await request(app, `/api/elements/${key}/tags`, "POST", { value: "mustnotexist" })).status).toBe(404);
    // Nothing was created by the rejected attaches: `valid` plus the rooms the
    // migration made from this fixture's own config.
    expect(tags.list().filter(entry => !entry.name)).toHaveLength(1);
    expect((await request(app, `/api/tags/${tag.id}/tags`, "POST", { tagId: tag.id })).status).toBe(404);
    expect((await request(app, "/api/tags", "POST", { value: "valid", color: "#123456", description: "" })).status).toBe(409);
    expect((await request(app, `/api/tags/${tag.id}`, "PATCH", { value: "changed", color: "#123456", description: "", revision: 9 })).status).toBe(409);
    const key = elementKey("device", "same-id");
    expect((await request(app, `/api/elements/${key}/tags`, "POST", { tagId: tag.id, value: "both" })).status).toBe(400);
    expect((await request(app, `/api/elements/${key}/tags`, "POST", { tagId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });

  test("enforces alphanumeric-and-dash tag NAMES on creation, rename, and inline tagging without changing saved data", async () => {
    const { app, tags } = fixture();
    const key = elementKey("device", "same-id");
    const tag = tags.create({ value: "Kitchen2", color: "#123456", description: "" });
    tags.attach(key, { tagId: tag.id });
    const before = tags.assignments();
    // The strict charset moved to the NAME. A value is a display string, which
    // is what lets a room be called "Master Bathroom".
    for (const name of ["foo_bar", ".", "..", "~", "a/b", "a?b", "#", "%2e", "é", "🚪", "a b"]) {
      const fields = { name, value: "Kitchen3", color: "#123456", description: "" };
      expect((await request(app, "/api/tags", "POST", fields)).status).toBe(400);
      expect((await request(app, `/api/tags/${tag.id}`, "PATCH", { ...fields, revision: tag.revision })).status).toBe(400);
      expect((await request(app, `/api/elements/${key}/tags`, "POST", { name, value: "Kitchen3" })).status).toBe(400);
    }
    expect(tags.list().filter(entry => !entry.name)).toEqual([tag]);
    expect(tags.assignments()).toEqual(before);
    const response = await (await app.request(`/api/tags/${tag.id}`)).json();
    expect(response.page).toBe("/tags/kitchen2");
    expect((await app.request(response.page)).status).toBe(200);
    expect((await app.request("/tags/~Kitchen2")).status).toBe(404);
  });

  test("tagging honors origin checks and displays hostile descriptions as text", async () => {
    const { app } = fixture();
    const denied = await app.request("/api/tags", { method: "POST", headers: { "content-type": "application/json", origin: "https://other.example" }, body: JSON.stringify({ value: "nope", color: "#123456", description: "" }) });
    expect(denied.status).toBe(403);
    const value = 'Kitchen2';
    const created = await request(app, "/api/tags", "POST", { value, color: "#123456", description: '</textarea><script>alert(1)</script>' });
    expect(created.status).toBe(201);
    const response = await app.request((await created.json()).page);
    const html = await response.text();
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('</textarea><script>alert(1)</script>');
    expect(html).not.toContain('<section class="element-tag-panel"');
  });
});

test("catalog includes scenes, shows, presets, automations, widgets, models, schemas, and event types without issuing commands", async () => {
  const light = new TestLight("string");
  const fail = async () => { throw new Error("Must not invoke a scene"); };
  const shows = { getScenes: () => [{ id: "scene", name: "Dinner", colors: ["#ff0000"], pattern: "repeat" as const }], getSceneState: () => ({ status: "idle" as const }), applyScene: fail,
    getShows: () => [{ id: "show", name: "Party", category: "Color", kind: "animation" as const }], getShowState: () => ({ status: "idle" as const }), playShow: fail, stopShow: fail,
    getPresets: () => [{ id: "preset", name: "Aurora", category: "Nature" }], applyPreset: fail };
  class StringDevice extends Device {
    readonly model = { ...SHELLY_PLUS_1, id: "test-string", capabilities: ["stringLight"] as const };
    readonly capabilities = { stringLight: new StringLightControl("string", light, () => [], shows) };
    async probe(): Promise<never> { throw new Error("Must not probe"); }
  }
  const dog = new DogAnnouncer({} as ConstructorParameters<typeof DogAnnouncer>[0]);
  const site = new Site([new StringDevice("string", "Patio lights", {})], undefined, undefined, [dog]);
  const kindle = new MemoryKindleConfigStore({ ...DEFAULT_KINDLE_CONFIG, canvas: { width: 758, height: 1024, grid: 8, widgets: [{ id: "label", kind: "text", text: "My home", x: 8, y: 8, width: 100, height: 100, fontSize: 24, align: "left", border: false }] } });
  const hub = new StateHub();
  const data = hub.configure({ site, signals: new MemorySignalCodeStore(), kindle, tags: new TagStore() });
  await data.refresh();
  const elements = listElements(data.topology());
  hub.stop();
  for (const key of [elementKey("scene", "string", "scene"), elementKey("show", "string", "show"), elementKey("preset", "string", "preset"), elementKey("automation", "dog-announcer"), elementKey("widget", "kindle", "label")]) expect(elements.some(element => element.key === key)).toBe(true);
  for (const kind of ["model", "schema", "event-type"]) expect(elements.some(element => element.kind === kind)).toBe(true);
  expect(elements.some(element => element.name === "Tag" && element.kind === "schema")).toBe(true);
});
