import { afterEach, expect, test } from "bun:test";
import { StateData } from "./data";
import { Graph } from "./graph";
import { Site } from "../site";
import { TagStore } from "../tags/store";
import { MemorySignalCodeStore } from "../signal-code-store";
import { MemoryKindleConfigStore } from "../kindle/store";
import { DEFAULT_KINDLE_CONFIG } from "../kindle/config";
import { AirGradientOne } from "../devices/sensors/airgradient-one";
import { deviceNode } from "./protocol";
import { Service } from "../models/service";
import { CompositeDevice } from "../kindle/test-fixture";
import { elementKey } from "../tags/identity";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(site = Site.empty()) {
  const observations = new Graph(), tags = new TagStore(), kindle = new MemoryKindleConfigStore(), signals = new MemorySignalCodeStore();
  const data = new StateData({ site, tags, kindle, signals }, observations);
  cleanup.push(() => data.close(), () => tags.close());
  return { data, observations, tags, kindle, signals };
}

test("topology never discovers devices and changes only when cached inventory or config changes", async () => {
  let reads = 0;
  const air = new AirGradientOne({ id: "air", name: "Air" }, { host: "10.77.0.2" }, { fetch: () => { reads++; return new Promise(() => {}); } });
  const { data, observations, tags } = fixture(new Site([air]));
  await data.refresh();
  const first = data.topology();
  expect(first.nodes().filter(node => node.kind === "sensor").length).toBeGreaterThanOrEqual(8);
  expect(reads).toBe(0);
  expect(data.topology()).toBe(first);
  observations.publish(deviceNode(air.id), { value: { capabilities: { sensor: { state: { sensors: [{ id: "custom", name: "Discovered sensor", value: 1 }] } } } } });
  const discovered = data.topology();
  expect(discovered).not.toBe(first);
  expect(discovered.nodes().some(node => node.name === "Discovered sensor")).toBe(true);
  observations.publish(deviceNode(air.id), { value: { capabilities: { sensor: { state: { sensors: [{ id: "custom", name: "Discovered sensor", value: 2 }] } } } } });
  expect(data.topology()).toBe(discovered);
  observations.publish(deviceNode(air.id), { fault: { code: "timeout", message: "offline" } });
  expect(data.topology()).toBe(discovered);
  const room = tags.create({ name: "room", value: "Office", color: "#123456", description: "" });
  tags.attach(elementKey("device", air.id), { tagId: room.id });
  expect(data.topology()).not.toBe(discovered);
  expect(reads).toBe(0);
});

test("a stale config refresh cannot overwrite a save, and concurrent refreshes share work", async () => {
  const { data, kindle } = fixture();
  const initial = await kindle.load();
  let finish!: (value: typeof initial) => void;
  let reads = 0;
  // Keep save independent of the stalled load so the race is deterministic.
  const updated = new MemoryKindleConfigStore({ ...DEFAULT_KINDLE_CONFIG, refreshSeconds: 90 }).snapshot();
  kindle.save = async () => updated;
  kindle.load = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const first = data.refresh();
  expect(data.refresh()).toBe(first);
  await data.kindle.save(updated.config, initial.revision);
  finish(initial);
  await first;
  expect(reads).toBe(1);
  expect(data.kindleSettings()).toEqual(updated);
});

test("tag reads use memory; rollback restores the cache as well as storage", () => {
  const { tags } = fixture();
  const before = tags.revision;
  expect(() => tags.transaction(() => { tags.create({ name: "", value: "Temporary", color: "#123456", description: "" }); throw new Error("rollback"); })).toThrow("rollback");
  expect(tags.list()).toEqual([]);
  const revision = tags.revision;
  tags.refresh();
  expect(tags.revision).toBe(revision);
  expect(tags.revision).toBeGreaterThan(before);
});


test("page metadata does not query service history and refresh invalidates changed topology", async () => {
  class History extends Service {
    reads = 0;
    subjectsList = ["composite"];
    status() { return { availability: "online" as const, detail: "Ready" }; }
    events() { return []; }
    subscribe() { return () => {}; }
    override subjects() { this.reads++; return [...this.subjectsList]; }
    override detectionLabels() { this.reads++; return ["animal"]; }
  }
  const history = new History("history", "History");
  const site = new Site([new CompositeDevice()], undefined, undefined, [history]);
  const { data, tags } = fixture(site);
  site.setTagSource(tags);
  await data.refresh();
  const reads = history.reads, groups = site.deviceGroups, directory = site.pages(), topology = data.topology();
  for (let count = 0; count < 5; count++) {
    site.list(); site.view("composite");
    expect(site.deviceGroups).toBe(groups);
    expect(site.pages()).toBe(directory);
    expect(data.topology()).toBe(topology);
  }
  expect(history.reads).toBe(reads);
  history.subjectsList = [];
  await data.refresh();
  expect(data.topology()).not.toBe(topology);
  expect(site.view("composite")?.relationships?.some(link => link.id === history.id)).toBe(false);
  const room = tags.create({ name: "room", value: "Office", color: "#123456", description: "" });
  tags.attach(elementKey("device", "composite"), { tagId: room.id });
  expect(site.pages()).not.toBe(directory);
  expect(site.view("composite")?.room).toBe("Office");
});

test("topology reads never scan observations once the publication index is ready", async () => {
  const { data, observations } = fixture(new Site([new CompositeDevice()]));
  await data.refresh();
  const topology = data.topology();
  const original = observations.read;
  let reads = 0;
  observations.read = function(node) { reads++; return original.call(this, node); };
  for (let i = 0; i < 20; i++) expect(data.topology()).toBe(topology);
  expect(reads).toBe(0);
});
