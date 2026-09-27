import { describe, expect, test } from "bun:test";
import { fingerprint, Graph, GraphError, type Result } from "./graph";
import type { NodeId, NodeRecord, StreamObserved } from "./protocol";

/** Lets the microtask flush a write scheduled run before the test looks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function clock() {
  let at = Date.parse("2026-09-14T12:00:00.000Z");
  return { now: () => new Date(at), tick: (ms = 1_000) => { at += ms; }, iso: () => new Date(at).toISOString() };
}

const A: NodeId = "device/a";
const B: NodeId = "device/b";
const C: NodeId = "device/c";
const D: NodeId = "device/d";

describe("fingerprint", () => {
  test("sorts keys and ignores every observedAt at any depth", () => {
    const left = fingerprint({ b: 1, a: { observedAt: "x", c: [{ observedAt: "y", d: 2 }] }, observedAt: "z" });
    const right = fingerprint({ a: { c: [{ d: 2 }] }, b: 1 });
    expect(left).toBe(right);
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, { observedAt: "x" }])).toBe(fingerprint([1, {}]));
  });
});

describe("Graph sources", () => {
  test("bumps the version only on structural change and refreshes observedAt otherwise", async () => {
    const time = clock();
    const graph = new Graph({ now: time.now });
    const first = graph.publish(A, { value: { on: true, state: { observedAt: time.iso() } } });
    expect(first).toMatchObject({ node: A, version: 1, observedAt: time.iso(), updatedAt: time.iso() });
    const createdAt = time.iso();

    time.tick();
    const same = graph.publish(A, { value: { on: true, state: { observedAt: time.iso() } } });
    expect(same.version).toBe(1);
    expect(same.observedAt).toBe(time.iso());
    expect(same.updatedAt).toBe(createdAt);

    time.tick();
    const changed = graph.publish(A, { value: { on: false, state: { observedAt: time.iso() } } });
    expect(changed).toMatchObject({ version: 2, value: { on: false }, updatedAt: time.iso() });
    await settle();
  });

  test("a fault keeps the last good value, repeats of it change nothing, and recovery drops it", async () => {
    const time = clock();
    const graph = new Graph({ now: time.now });
    const frames: NodeRecord[] = [];
    const observed: StreamObserved[] = [];
    graph.subscribe([A], (record) => frames.push(record), (map) => observed.push(map));

    graph.publish(A, { value: { on: true } });
    const seenAt = time.iso();
    await settle();
    time.tick();
    const faulted = graph.publish(A, { fault: { code: "unreachable", message: "Relay did not answer at 10.77.0.2 (timed out)." } });
    expect(faulted).toMatchObject({ version: 2, value: { on: true }, fault: { code: "unreachable" }, observedAt: seenAt });
    await settle();

    time.tick();
    const again = graph.publish(A, { fault: { code: "unreachable", message: "Relay did not answer at 10.77.0.2 (timed out)." } });
    expect(again.version).toBe(2);
    await settle();

    time.tick();
    const recovered = graph.publish(A, { value: { on: true } });
    expect(recovered.version).toBe(3);
    expect(recovered.fault).toBeUndefined();
    expect(recovered.observedAt).toBe(time.iso());
    await settle();

    expect(frames.map((frame) => frame.version)).toEqual([1, 2, 3]);
    expect(observed).toEqual([]);
  });

  test("notifies once per changed node per flush, with the latest record", async () => {
    const graph = new Graph();
    const frames: NodeRecord[] = [];
    graph.subscribe([A, B], (record) => frames.push(record));
    graph.publish(A, { value: 1 });
    graph.publish(A, { value: 2 });
    graph.publish(A, { value: 3 });
    graph.publish(B, { value: "b" });
    expect(frames).toEqual([]);
    await settle();
    expect(frames.map((frame) => [frame.node, frame.version, frame.value])).toEqual([[A, 3, 3], [B, 1, "b"]]);
  });

  test("coalesces unchanged observations into one observed map per flush", async () => {
    const time = clock();
    const graph = new Graph({ now: time.now });
    const frames: NodeRecord[] = [];
    const observed: StreamObserved[] = [];
    graph.subscribe([A, B], (record) => frames.push(record), (map) => observed.push(map));
    graph.publish(A, { value: 1 });
    graph.publish(B, { value: 2 });
    await settle();
    frames.length = 0;

    time.tick();
    graph.publish(A, { value: 1 });
    graph.publish(B, { value: 2 });
    time.tick();
    graph.publish(A, { value: 1 });
    await settle();
    expect(frames).toEqual([]);
    expect(observed).toEqual([{ [A]: time.iso(), [B]: new Date(Date.parse(time.iso()) - 1_000).toISOString() }]);
  });

  test("a node that changed in the same flush is not also reported as observed", async () => {
    const graph = new Graph();
    const frames: NodeRecord[] = [];
    const observed: StreamObserved[] = [];
    graph.subscribe([A], (record) => frames.push(record), (map) => observed.push(map));
    graph.publish(A, { value: 1 });
    await settle();
    graph.publish(A, { value: 1 });
    graph.publish(A, { value: 2 });
    await settle();
    expect(frames.map((frame) => frame.version)).toEqual([1, 2]);
    expect(observed).toEqual([]);
  });

  test("subscribers only hear about their own nodes and stop after close", async () => {
    const graph = new Graph();
    const frames: NodeRecord[] = [];
    const subscription = graph.subscribe([A], (record) => frames.push(record));
    graph.publish(B, { value: 1 });
    graph.publish(A, { value: 1 });
    await settle();
    subscription.close();
    subscription.close();
    graph.publish(A, { value: 2 });
    await settle();
    expect(frames.map((frame) => frame.node)).toEqual([A]);
  });

  test("flush runs synchronously when asked", () => {
    const graph = new Graph();
    const frames: NodeRecord[] = [];
    graph.subscribe([A], (record) => frames.push(record));
    graph.publish(A, { value: 1 });
    graph.flush();
    expect(frames).toHaveLength(1);
    graph.flush();
    expect(frames).toHaveLength(1);
  });
});

describe("Graph derived nodes", () => {
  const shout = (inputs: readonly (NodeRecord | undefined)[]): Result | undefined => {
    const input = inputs[0];
    return input?.value === undefined ? undefined : { value: `${String(input.value)}!` };
  };

  test("computes now and after every input change, bumping only when the output changes", async () => {
    const graph = new Graph();
    graph.publish(A, { value: "a" });
    const initial = graph.derive(C, [A], shout);
    expect(initial).toMatchObject({ node: C, version: 1, value: "a!" });
    const frames: NodeRecord[] = [];
    graph.subscribe([C], (record) => frames.push(record));
    await settle();
    frames.length = 0;

    graph.publish(A, { value: "b" });
    await settle();
    expect(graph.read(C)).toMatchObject({ version: 2, value: "b!" });
    expect(frames.map((frame) => frame.version)).toEqual([2]);

    graph.derive(D, [C], (inputs) => ({ value: typeof inputs[0]?.value === "string" ? inputs[0].value.length : 0 }));
    graph.publish(A, { value: "c" });
    await settle();
    expect(graph.read(C)?.version).toBe(3);
    expect(graph.read(D)).toMatchObject({ version: 1, value: 2 });
  });

  test("can be declared before its inputs exist", async () => {
    const graph = new Graph();
    expect(graph.derive(C, [A], shout)).toBeUndefined();
    expect(graph.read(C)).toBeUndefined();
    graph.publish(A, { value: "late" });
    await settle();
    expect(graph.read(C)).toMatchObject({ version: 1, value: "late!" });
  });

  test("a diamond recomputes each derived node once per flush from consistent inputs", async () => {
    const graph = new Graph();
    graph.publish(B, { value: 1 });
    graph.derive(A, [B], (inputs) => ({ value: (inputs[0]?.value as number) * 10 }));
    const seen: [unknown, unknown][] = [];
    graph.derive(C, [A, B], (inputs) => {
      seen.push([inputs[0]?.value, inputs[1]?.value]);
      return { value: `${String(inputs[0]?.value)}/${String(inputs[1]?.value)}` };
    });
    seen.length = 0;
    graph.publish(B, { value: 2 });
    graph.publish(B, { value: 3 });
    await settle();
    expect(seen).toEqual([[30, 3]]);
    expect(graph.read(C)).toMatchObject({ version: 2, value: "30/3" });
  });

  test("an unchanged intermediate result stops propagation", async () => {
    const graph = new Graph();
    graph.publish(B, { value: 1 });
    graph.derive(A, [B], (inputs) => ({ value: (inputs[0]?.value as number) > 0 ? "positive" : "other" }));
    let computes = 0;
    graph.derive(C, [A], (inputs) => { computes++; return { value: inputs[0]?.value }; });
    computes = 0;
    graph.publish(B, { value: 5 });
    await settle();
    expect(computes).toBe(0);
    expect(graph.read(A)?.version).toBe(1);
  });

  test("rejects cycles and publishes to derived nodes", () => {
    const graph = new Graph();
    graph.derive(A, [B], shout);
    expect(() => graph.derive(B, [A], shout)).toThrow(GraphError);
    expect(() => graph.derive(B, [B], shout)).toThrow(GraphError);
    graph.derive(C, [A], shout);
    try {
      graph.derive(B, [C], shout);
      throw new Error("expected a cycle");
    } catch (error) {
      expect((error as GraphError).code).toBe("cycle");
    }
    graph.publish(B, { value: "b" });
    expect(() => graph.publish(A, { value: "no" })).toThrow(GraphError);
  });

  test("remove sends a final unconfigured record and dependents recompute with an undefined input", async () => {
    const graph = new Graph();
    graph.publish(A, { value: "a" });
    graph.derive(C, [A], (inputs) => ({ value: inputs[0] ? "present" : "absent" }));
    const frames: NodeRecord[] = [];
    graph.subscribe([A, C], (record) => frames.push(record));
    await settle();
    frames.length = 0;

    graph.remove(A);
    await settle();
    expect(graph.read(A)).toBeUndefined();
    expect(frames).toEqual([
      expect.objectContaining({ node: A, version: 2, fault: { code: "unconfigured", message: "a is not in devices.yml" } }),
      expect.objectContaining({ node: C, version: 2, value: "absent" }),
    ]);
    graph.remove("group/g");
    graph.publish(A, { value: "back" });
    await settle();
    expect(graph.read(A)?.version).toBe(1);
    expect(graph.read(C)).toMatchObject({ version: 3, value: "present" });
  });
});

describe("Graph bookkeeping", () => {
  test("snapshot returns existing records in request order, once each", () => {
    const graph = new Graph();
    graph.publish(B, { value: 2 });
    graph.publish(A, { value: 1 });
    expect(graph.snapshot([A, C, B, A]).map((record) => record.node)).toEqual([A, B]);
  });

  test("retain and release fire at the first subscriber and the last", () => {
    const graph = new Graph();
    const events: string[] = [];
    graph.onRetain((node) => events.push(`+${node}`));
    graph.onRelease((node) => events.push(`-${node}`));
    const one = graph.subscribe([A, B], () => {});
    const two = graph.subscribe([A], () => {});
    expect(events).toEqual([`+${A}`, `+${B}`]);
    expect(graph.isRetained(A)).toBe(true);
    one.close();
    expect(events).toEqual([`+${A}`, `+${B}`, `-${B}`]);
    two.close();
    expect(events).toEqual([`+${A}`, `+${B}`, `-${B}`, `-${A}`]);
    expect(graph.isRetained(A)).toBe(false);
  });

  test("clear drops every node, closes every subscription and releases what was retained", async () => {
    const graph = new Graph();
    const released: NodeId[] = [];
    graph.onRelease((node) => released.push(node));
    const frames: NodeRecord[] = [];
    const subscription = graph.subscribe([A], (record) => frames.push(record));
    graph.publish(A, { value: 1 });
    await settle();
    graph.publish(A, { value: 2 });
    graph.clear();
    await settle();
    expect(released).toEqual([A]);
    expect(graph.read(A)).toBeUndefined();
    expect(graph.isRetained(A)).toBe(false);
    subscription.close();
    expect(released).toEqual([A]);
    graph.publish(A, { value: 3 });
    await settle();
    expect(graph.read(A)?.version).toBe(1);
    expect(frames.map((frame) => frame.version)).toEqual([1]);
  });
});
