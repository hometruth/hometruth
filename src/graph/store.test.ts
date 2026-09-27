import { describe, expect, test } from "bun:test";
import { GraphStore } from "./store";
import { emoji } from "./icons";
import type { GraphEdge, GraphNode } from "./types";

const node = (id: string, name = id, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, side: "instance", kind: "device", name, context: "", page: `/devices/${id}`,
  icon: emoji("🔌"), ids: [id], ...extra,
});
const edge = (from: string, to: string): GraphEdge => ({ from, to, relation: "uses", origin: "resolution" });

describe("graph store", () => {
  test("a node keeps its identity across rebuilds, even when it is renamed", () => {
    const store = new GraphStore();
    const first = store.reconcile([node("relay", "Porch relay")], []);
    const uuid = first.nodes[0]!.uuid;
    expect(first.added).toBe(1);

    const second = store.reconcile([node("relay", "Front relay")], []);
    expect(second.nodes[0]!.uuid).toBe(uuid);
    expect(second.nodes[0]!.name).toBe("Front relay");
    expect(second.matched).toBe(1);
    expect(second.added).toBe(0);
    store.close();
  });

  test("a node the config stopped declaring is tombstoned, not deleted", () => {
    const store = new GraphStore();
    const uuid = store.reconcile([node("relay"), node("lamp")], []).nodes.find((entry) => entry.id === "lamp")!.uuid;

    const after = store.reconcile([node("relay")], []);
    expect(after.tombstoned).toBe(1);
    expect(store.tombstoned().map((entry) => entry.id)).toEqual(["lamp"]);

    // Added back a week later, it is the same node.
    const again = store.reconcile([node("relay"), node("lamp")], []);
    expect(again.nodes.find((entry) => entry.id === "lamp")!.uuid).toBe(uuid);
    expect(store.tombstoned()).toEqual([]);
    store.close();
  });

  test("an alias carries a node across a key that moved", () => {
    const store = new GraphStore();
    const uuid = store.reconcile([node("old-key")], []).nodes[0]!.uuid;

    // Without the alias the old node would be tombstoned and a new one made.
    store.noteAlias("old-key", "new-key");
    const after = store.reconcile([node("new-key")], []);
    expect(after.nodes[0]!.uuid).toBe(uuid);
    expect(after.tombstoned).toBe(0);
    store.close();
  });

  test("edges are replaced wholesale, so none can point at something gone", () => {
    const store = new GraphStore();
    store.reconcile([node("a"), node("b")], [edge("a", "b")]);
    const after = store.reconcile([node("a"), node("b")], []);
    expect(after.edges).toEqual([]);
    store.close();
  });

  test("pruning removes tombstones, and only when asked", () => {
    const store = new GraphStore();
    store.reconcile([node("a"), node("b")], []);
    store.reconcile([node("a")], []);
    expect(store.tombstoned()).toHaveLength(1);
    expect(store.prune()).toBe(1);
    expect(store.tombstoned()).toEqual([]);
    store.close();
  });
});

describe("stored state", () => {
  test("a record survives a restart and comes back with when it was seen", () => {
    const store = new GraphStore();
    store.reconcile([node("relay", "Relay", { stateNode: "device/relay" })], []);
    store.saveState("device/relay", {
      node: "device/relay", version: 3, value: { status: "online" },
      observedAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z",
    });

    const [restored] = store.loadState();
    expect(restored?.value).toEqual({ status: "online" });
    expect(restored?.version).toBe(3);
    expect(restored?.observedAt).toBe("2026-09-16T12:00:00.000Z");
    store.close();
  });

  test("a fault is stored beside the last good value, not instead of it", () => {
    const store = new GraphStore();
    store.reconcile([node("relay", "Relay", { stateNode: "device/relay" })], []);
    store.saveState("device/relay", {
      node: "device/relay", version: 4, value: { status: "online" },
      fault: { code: "unreachable", message: "Relay did not answer" },
      updatedAt: "2026-09-16T12:00:00.000Z",
    });
    const [restored] = store.loadState();
    expect(restored?.fault?.code).toBe("unreachable");
    expect(restored?.value).toEqual({ status: "online" });
    store.close();
  });

  test("a freshness refresh updates when it was seen without rewriting the value", () => {
    const store = new GraphStore();
    store.reconcile([node("relay", "Relay", { stateNode: "device/relay" })], []);
    store.saveState("device/relay", { node: "device/relay", version: 1, value: { status: "online" }, observedAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z" });
    store.touchState(new Map([["device/relay", "2026-09-16T12:05:00.000Z"]]));
    const [restored] = store.loadState();
    expect(restored?.observedAt).toBe("2026-09-16T12:05:00.000Z");
    expect(restored?.version).toBe(1);
    expect(restored?.value).toEqual({ status: "online" });
    store.close();
  });

  test("state follows its node's identity, so a rename does not orphan it", () => {
    const store = new GraphStore();
    store.reconcile([node("relay", "Porch relay", { stateNode: "device/relay" })], []);
    store.saveState("device/relay", { node: "device/relay", version: 1, value: { status: "online" }, updatedAt: "2026-09-16T12:00:00.000Z" });
    store.reconcile([node("relay", "Front relay", { stateNode: "device/relay" })], []);
    expect(store.loadState()).toHaveLength(1);
    store.close();
  });
});
