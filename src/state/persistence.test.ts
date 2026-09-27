import { describe, expect, test } from "bun:test";
import { Graph } from "./graph";
import { deviceNode } from "./protocol";
import { GraphStore } from "../graph/store";
import { COLD_AFTER_MS, StatePersistence, isCold } from "./persistence";
import { emoji } from "../graph/icons";
import { elementKey } from "../tags/identity";
import { COLD_AFTER_MS as BROWSER_COLD_AFTER_MS, isCold as browserIsCold } from "../ui/browser/view";
import type { GraphNode } from "../graph/types";

/**
 * A node the way the builder really makes one: addressed by its element key,
 * observed under a state node id. Those are different strings, and using the
 * state id for both would hide a join that has to be right.
 */
const node = (id: string): GraphNode => ({
  id: elementKey("device", id), side: "instance", kind: "device", name: id, context: "",
  page: `/devices/${id}`, icon: emoji("🔌"), ids: [id], stateNode: deviceNode(id),
});

/** Timers the test drives, so nothing waits on a real interval. */
function fakeTimers() {
  let fn: (() => void) | undefined;
  return { timers: { set(f: () => void) { fn = f; return 1; }, clear() { fn = undefined; } }, tick: () => fn?.() };
}

function harness() {
  const store = new GraphStore();
  store.reconcile([node("relay"), node("lamp")], []);
  const graph = new Graph();
  const { timers, tick } = fakeTimers();
  const persistence = new StatePersistence(graph, store, { timers });
  persistence.watch([deviceNode("relay"), deviceNode("lamp")]);
  return { store, graph, persistence, tick };
}

describe("state persistence", () => {
  test("a real change is written through, so a restart comes back live", () => {
    const { store, graph, persistence } = harness();
    graph.publish(deviceNode("relay"), { value: { status: "online", on: true } }, "2026-09-16T12:00:00.000Z");
    graph.flush();

    const rows = store.loadState();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ status: "online", on: true });
    expect(rows[0]?.observedAt).toBe("2026-09-16T12:00:00.000Z");

    // Restored into a fresh graph, the value is there before anything is read.
    const revived = new Graph();
    const back = new StatePersistence(revived, store, { timers: { set: () => 1, clear: () => {} } });
    expect(back.restore()).toBe(1);
    expect(revived.read(deviceNode("relay"))?.value).toEqual({ status: "online", on: true });
    expect(revived.read(deviceNode("relay"))?.observedAt).toBe("2026-09-16T12:00:00.000Z");
    persistence.stop();
    back.stop();
    store.close();
  });

  test("polls that change nothing do not rewrite the value; they batch a freshness refresh", () => {
    const { store, graph, persistence, tick } = harness();
    graph.publish(deviceNode("relay"), { value: { status: "online" } }, "2026-09-16T12:00:00.000Z");
    graph.flush();

    // Same value again, twice: no version bump, so nothing is written yet.
    graph.publish(deviceNode("relay"), { value: { status: "online" } }, "2026-09-16T12:00:05.000Z");
    graph.publish(deviceNode("relay"), { value: { status: "online" } }, "2026-09-16T12:00:10.000Z");
    graph.flush();
    expect(store.loadState()[0]?.observedAt).toBe("2026-09-16T12:00:00.000Z");

    tick();
    expect(store.loadState()[0]?.observedAt).toBe("2026-09-16T12:00:10.000Z");
    expect(store.loadState()[0]?.version).toBe(1);
    persistence.stop();
    store.close();
  });

  test("a fault is kept beside the last good value", () => {
    const { store, graph, persistence } = harness();
    graph.publish(deviceNode("relay"), { value: { status: "online" } }, "2026-09-16T12:00:00.000Z");
    graph.publish(deviceNode("relay"), { fault: { code: "unreachable", message: "no answer" } });
    graph.flush();

    const row = store.loadState()[0];
    expect(row?.fault?.code).toBe("unreachable");
    expect(row?.value).toEqual({ status: "online" });

    const revived = new Graph();
    const back = new StatePersistence(revived, store, { timers: { set: () => 1, clear: () => {} } });
    back.restore();
    expect(revived.read(deviceNode("relay"))?.fault?.code).toBe("unreachable");
    expect(revived.read(deviceNode("relay"))?.value).toEqual({ status: "online" });
    persistence.stop();
    back.stop();
    store.close();
  });

  test("a stored row for a node the graph no longer knows is left alone", () => {
    const { store, graph, persistence } = harness();
    graph.publish(deviceNode("lamp"), { value: { status: "online" } });
    graph.flush();
    persistence.stop();

    const revived = new Graph();
    const back = new StatePersistence(revived, store, { timers: { set: () => 1, clear: () => {} } });
    expect(back.restore((candidate) => candidate !== deviceNode("lamp"))).toBe(0);
    expect(revived.read(deviceNode("lamp"))).toBeUndefined();
    back.stop();
    store.close();
  });
});

describe("cold records", () => {
  test("the server and the browser agree on when a record stops being current", () => {
    // Browser modules may not import values from outside their own two folders,
    // so the threshold is written twice. This is what stops the copies drifting.
    expect(BROWSER_COLD_AFTER_MS).toBe(COLD_AFTER_MS);
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    for (const age of [0, COLD_AFTER_MS - 1, COLD_AFTER_MS + 1, COLD_AFTER_MS * 100]) {
      const at = new Date(now - age).toISOString();
      expect(browserIsCold(at, now), `age ${age}`).toBe(isCold(at, now));
    }
    expect(browserIsCold(undefined, now)).toBe(isCold(undefined, now));
  });

  test("a fresh reading is current; an old one is only what was last seen", () => {
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    expect(isCold("2026-09-16T11:59:50.000Z", now)).toBe(false);
    expect(isCold(new Date(now - COLD_AFTER_MS - 1000).toISOString(), now)).toBe(true);
    // Never observed at all is not something to present as current either.
    expect(isCold(undefined, now)).toBe(true);
    expect(isCold("not a date", now)).toBe(true);
  });
});
