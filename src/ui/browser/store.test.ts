import { describe, expect, test } from "bun:test";
import type { NodeId, NodeRecord } from "../../state/protocol.ts";
import { StateStore, type StoredRecord } from "./store.ts";

const AT = "2026-09-14T10:00:00.000Z";
const LATER = "2026-09-14T10:00:05.000Z";

function record(node: NodeId, version: number, extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node, version, updatedAt: AT, value: { id: node.slice(node.indexOf("/") + 1) }, ...extra };
}

function collector(): { calls: StoredRecord[]; listener: (record: StoredRecord) => void } {
  const calls: StoredRecord[] = [];
  return { calls, listener: (item) => { calls.push(item); } };
}

describe("StateStore", () => {
  test("seeded records are stale until a frame confirms them", () => {
    const store = new StateStore([record("device/a", 1, { observedAt: AT })]);
    expect(store.read("device/a")).toMatchObject({ node: "device/a", version: 1, stale: true });
    expect(store.read("device/b")).toBeUndefined();
    const applied = store.apply(record("device/a", 2, { observedAt: LATER }));
    expect(applied.stale).toBe(false);
    expect(store.read("device/a")).toMatchObject({ version: 2, stale: false, observedAt: LATER });
  });

  test("subscribe refcounts per node and wanted() lists the nodes sorted", () => {
    const store = new StateStore();
    const first = store.subscribe("device/b", () => {}, "glance");
    const second = store.subscribe("device/b", () => {}, "glance");
    const third = store.subscribe("device/a", () => {}, "glance");
    expect(store.count("device/b")).toBe(2);
    expect(store.wanted()).toEqual({ nodes: ["device/a", "device/b"], tier: "glance" });
    first();
    expect(store.count("device/b")).toBe(1);
    expect(store.wanted().nodes).toEqual(["device/a", "device/b"]);
    second();
    expect(store.count("device/b")).toBe(0);
    expect(store.wanted().nodes).toEqual(["device/a"]);
    third();
    expect(store.wanted()).toEqual({ nodes: [], tier: "glance" });
  });

  test("a release is idempotent and never removes another subscriber", () => {
    const store = new StateStore();
    const first = store.subscribe("device/a", () => {}, "live");
    store.subscribe("device/a", () => {}, "live");
    first();
    first();
    expect(store.count("device/a")).toBe(1);
  });

  test("live wins over glance while any live subscriber remains", () => {
    const store = new StateStore();
    store.subscribe("device/a", () => {}, "glance");
    const live = store.subscribe("group/g", () => {}, "live");
    expect(store.wanted()).toEqual({ nodes: ["device/a", "group/g"], tier: "live" });
    live();
    expect(store.wanted()).toEqual({ nodes: ["device/a"], tier: "glance" });
  });

  test("apply notifies only that node's subscribers, each once, with stale false", () => {
    const store = new StateStore();
    const a = collector();
    const alsoA = collector();
    const b = collector();
    store.subscribe("device/a", a.listener, "live");
    store.subscribe("device/a", alsoA.listener, "glance");
    store.subscribe("device/b", b.listener, "live");
    store.apply(record("device/a", 3));
    expect(a.calls.map((item) => item.version)).toEqual([3]);
    expect(alsoA.calls.map((item) => item.version)).toEqual([3]);
    expect(a.calls[0]?.stale).toBe(false);
    expect(b.calls).toEqual([]);
  });

  test("subscribe does not replay the cache; the client does that", () => {
    const store = new StateStore([record("device/a", 1)]);
    const a = collector();
    store.subscribe("device/a", a.listener, "live");
    expect(a.calls).toEqual([]);
  });

  test("observed refreshes observedAt of cached records only and confirms them", () => {
    const store = new StateStore([record("device/a", 1, { observedAt: AT })]);
    const a = collector();
    const b = collector();
    store.subscribe("device/a", a.listener, "live");
    store.subscribe("device/b", b.listener, "live");
    store.observed({ "device/a": LATER, "device/b": LATER });
    expect(store.read("device/a")).toMatchObject({ version: 1, observedAt: LATER, stale: false });
    expect(a.calls).toHaveLength(1);
    expect(store.read("device/b")).toBeUndefined();
    expect(b.calls).toEqual([]);
  });

  test("markStale marks every confirmed record once and leaves already-stale records quiet", () => {
    const store = new StateStore([record("device/seeded", 1)]);
    store.apply(record("device/a", 1));
    store.apply(record("device/b", 1));
    const a = collector();
    const seeded = collector();
    store.subscribe("device/a", a.listener, "live");
    store.subscribe("device/seeded", seeded.listener, "live");
    store.markStale();
    expect(a.calls.map((item) => item.stale)).toEqual([true]);
    expect(seeded.calls).toEqual([]);
    expect(store.read("device/b")?.stale).toBe(true);
    store.markStale();
    expect(a.calls).toHaveLength(1);
  });

  test("a record with a fault keeps the last good value beside it", () => {
    const store = new StateStore();
    store.apply(record("device/a", 1, { value: { on: true } }));
    store.apply({ node: "device/a", version: 2, updatedAt: LATER, value: { on: true }, fault: { code: "unreachable", message: "no answer" } });
    expect(store.read("device/a")).toMatchObject({ value: { on: true }, fault: { code: "unreachable" }, stale: false });
  });
});
