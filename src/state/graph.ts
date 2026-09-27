/**
 * The state graph: one record per node, structural change detection, and one
 * notification per changed node per flush. Sources (`device/*`, `group/*`)
 * are written by the observer through `publish`; a derived node recomputes
 * from its inputs. A write marks the node and schedules one microtask flush:
 * dirty derived nodes recompute shallowest first, so a subscriber never sees
 * a value computed from inputs that disagree, then every subscriber hears
 * once per changed node plus one coalesced `observed` map for the polls that
 * changed nothing.
 */
import { parseNode, type Fault, type NodeId, type NodeRecord, type StreamObserved } from "./protocol";

export type Result<V = unknown> = { readonly value: V } | { readonly fault: Fault };
export type NodeListener = (record: NodeRecord) => void;
export type ObservedListener = (observed: StreamObserved) => void;
/** Inputs arrive in `deps` order, a missing input as `undefined`; return `undefined` to leave the node as it is. */
export type Compute = (inputs: readonly (NodeRecord | undefined)[]) => Result | undefined;

export interface Subscription {
  readonly nodes: ReadonlySet<NodeId>;
  close(): void;
}

export interface GraphOptions {
  readonly now?: () => Date;
}

export class GraphError extends Error {
  constructor(message: string, readonly code: "cycle" | "derived") {
    super(message);
    this.name = "GraphError";
  }
}

interface Entry {
  readonly node: NodeId;
  record: NodeRecord | undefined;
  /** `fingerprint({ value, fault })` of the record; "" before the first write. */
  print: string;
  deps: readonly NodeId[];
  compute: Compute | undefined;
  readonly dependents: Set<NodeId>;
  /** 0 for a source, 1 + the deepest input for a derived node: the recompute order. */
  depth: number;
}

interface Subscriber {
  readonly nodes: ReadonlySet<NodeId>;
  readonly onState: NodeListener;
  readonly onObserved: ObservedListener | undefined;
}

/** The fault a node reports once its device, group switch, or automation is no longer configured. */
export function unconfiguredFault(node: NodeId): Fault {
  const parsed = parseNode(node);
  const id = parsed?.id ?? node;
  const message = parsed?.kind === "group" ? `${id} is not a group switch in devices.yml`
    : parsed?.kind === "automation" ? `${id} is not a configured automation`
    : `${id} is not in devices.yml`;
  return { code: "unconfigured", message };
}

/** JSON with sorted keys and every `observedAt` omitted at any depth: equal prints mean nothing a component renders changed. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? "";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return canonical(toJSON.call(value));
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "observedAt" || record[key] === undefined) continue;
    out[key] = canonical(record[key]);
  }
  return out;
}

export class Graph {
  readonly #nodes = new Map<NodeId, Entry>();
  readonly #writeListeners = new Set<NodeListener>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #retained = new Map<NodeId, number>();
  readonly #retainListeners: ((node: NodeId) => void)[] = [];
  readonly #releaseListeners: ((node: NodeId) => void)[] = [];
  /** The latest record of every node that changed since the last flush. */
  readonly #changed = new Map<NodeId, NodeRecord>();
  readonly #observed = new Map<NodeId, string>();
  readonly #dirty = new Set<NodeId>();
  #scheduled = false;
  readonly #now: () => Date;

  constructor(options: GraphOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** A source was observed. Equal structure keeps the version, refreshes `observedAt` and queues an `observed` signal. */
  publish(node: NodeId, result: Result, observedAt?: string): NodeRecord {
    const entry = this.#entry(node);
    if (entry.compute) throw new GraphError(`${node} is derived; publish to its inputs instead`, "derived");
    this.#apply(entry, result, observedAt);
    return entry.record!;
  }

  /** Declare `node` computed from `deps`: evaluated now and after every input change. Redefining replaces the inputs. */
  derive(node: NodeId, deps: readonly NodeId[], compute: Compute): NodeRecord | undefined {
    if (deps.some((dep) => dep === node || this.#reaches(dep, node))) {
      throw new GraphError(`${node} would depend on itself`, "cycle");
    }
    const entry = this.#entry(node);
    for (const dep of entry.deps) this.#nodes.get(dep)?.dependents.delete(node);
    entry.deps = [...deps];
    entry.compute = compute;
    for (const dep of deps) this.#entry(dep).dependents.add(node);
    this.#updateDepth(entry);
    this.#evaluate(entry);
    return entry.record;
  }

  /** Forget a node: subscribers get a final `unconfigured` record, dependents recompute with an `undefined` input. */
  remove(node: NodeId): void {
    const entry = this.#nodes.get(node);
    if (!entry) return;
    for (const dep of entry.deps) {
      const input = this.#nodes.get(dep);
      if (!input) continue;
      input.dependents.delete(node);
      if (!input.record && !input.compute && input.dependents.size === 0) this.#nodes.delete(dep);
    }
    if (entry.record) {
      this.#changed.set(node, { node, version: entry.record.version + 1, fault: unconfiguredFault(node), updatedAt: this.#now().toISOString() });
      this.#schedule();
    }
    this.#observed.delete(node);
    this.#dirty.delete(node);
    if (entry.dependents.size === 0) {
      this.#nodes.delete(node);
      return;
    }
    // Dependents keep pointing here, so the node stays as an empty placeholder.
    entry.record = undefined;
    entry.print = "";
    entry.deps = [];
    entry.compute = undefined;
    this.#updateDepth(entry);
    for (const dependent of entry.dependents) this.#dirty.add(dependent);
    this.#schedule();
  }

  /** Internal materialized indexes update at publication, never during page reads. */
  onWrite(listener: NodeListener): () => void {
    this.#writeListeners.add(listener);
    return () => { this.#writeListeners.delete(listener); };
  }

  read(node: NodeId): NodeRecord | undefined {
    return this.#nodes.get(node)?.record;
  }

  /**
   * `onState` runs once per flush per changed node; `onObserved` once per
   * flush with the coalesced map. Pending work flushes first, so a subscriber
   * hears only what changes after it subscribed and a snapshot taken beside
   * it is never sent twice.
   */
  subscribe(nodes: readonly NodeId[], onState: NodeListener, onObserved?: ObservedListener): Subscription {
    this.flush();
    const set: ReadonlySet<NodeId> = new Set(nodes);
    const subscriber: Subscriber = { nodes: set, onState, onObserved };
    this.#subscribers.add(subscriber);
    for (const node of set) this.#retain(node);
    return {
      nodes: set,
      close: () => {
        if (!this.#subscribers.delete(subscriber)) return;
        for (const node of set) this.#release(node);
      },
    };
  }

  /** The records that exist, in request order, each once. */
  snapshot(nodes: readonly NodeId[] = [...this.#nodes.keys()]): NodeRecord[] {
    const records: NodeRecord[] = [];
    const seen = new Set<NodeId>();
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const record = this.read(node);
      if (record) records.push(record);
    }
    return records;
  }

  /** A node gained its first subscriber. */
  onRetain(listener: (node: NodeId) => void): void {
    this.#retainListeners.push(listener);
  }

  /** A node lost its last subscriber. */
  onRelease(listener: (node: NodeId) => void): void {
    this.#releaseListeners.push(listener);
  }

  isRetained(node: NodeId): boolean {
    return this.#retained.has(node);
  }

  /** Rebind: drop every node, close every subscription, and release what was retained. */
  clear(): void {
    const retained = [...this.#retained.keys()];
    this.#subscribers.clear();
    this.#retained.clear();
    this.#nodes.clear();
    this.#changed.clear();
    this.#observed.clear();
    this.#dirty.clear();
    this.#scheduled = false;
    for (const node of retained) for (const listener of this.#releaseListeners) listener(node);
  }

  /** Recompute what is dirty and notify; normally run by the microtask a write schedules. */
  flush(): void {
    this.#scheduled = false;
    this.#recompute();
    if (this.#changed.size === 0 && this.#observed.size === 0) return;
    const changed = [...this.#changed.values()];
    const observed = [...this.#observed];
    this.#changed.clear();
    this.#observed.clear();
    for (const subscriber of [...this.#subscribers]) {
      for (const record of changed) if (subscriber.nodes.has(record.node)) subscriber.onState(record);
      if (!subscriber.onObserved) continue;
      const mine: Record<string, string> = {};
      for (const [node, at] of observed) if (subscriber.nodes.has(node)) mine[node] = at;
      if (Object.keys(mine).length) subscriber.onObserved(mine);
    }
  }

  #entry(node: NodeId): Entry {
    let entry = this.#nodes.get(node);
    if (!entry) {
      entry = { node, record: undefined, print: "", deps: [], compute: undefined, dependents: new Set(), depth: 0 };
      this.#nodes.set(node, entry);
    }
    return entry;
  }

  #reaches(from: NodeId, target: NodeId): boolean {
    for (const dep of this.#nodes.get(from)?.deps ?? []) {
      if (dep === target || this.#reaches(dep, target)) return true;
    }
    return false;
  }

  #updateDepth(entry: Entry): void {
    entry.depth = entry.deps.reduce((depth, dep) => Math.max(depth, (this.#nodes.get(dep)?.depth ?? 0) + 1), 0);
    for (const dependent of entry.dependents) {
      const next = this.#nodes.get(dependent);
      if (next) this.#updateDepth(next);
    }
  }

  /** Store a result; true when the record changed structurally. A fault keeps the last good value beside it. */
  #apply(entry: Entry, result: Result, observedAt: string | undefined): boolean {
    const previous = entry.record;
    const failed = "fault" in result;
    const value = failed ? previous?.value : result.value;
    const fault = failed ? result.fault : undefined;
    const print = fingerprint({ ...(value !== undefined ? { value } : {}), ...(fault ? { fault } : {}) });
    const now = this.#now().toISOString();
    const stamp = observedAt ?? now;
    if (previous && print === entry.print) {
      if (!failed) {
        entry.record = { ...previous, observedAt: stamp };
        for (const listener of this.#writeListeners) listener(entry.record);
        this.#observed.set(entry.node, stamp);
        this.#schedule();
      }
      return false;
    }
    const seen = failed ? previous?.observedAt : stamp;
    entry.record = {
      node: entry.node,
      version: (previous?.version ?? 0) + 1,
      ...(value !== undefined ? { value } : {}),
      ...(fault ? { fault } : {}),
      ...(seen ? { observedAt: seen } : {}),
      updatedAt: now,
    };
    entry.print = print;
    for (const listener of this.#writeListeners) listener(entry.record);
    this.#changed.set(entry.node, entry.record);
    this.#observed.delete(entry.node);
    for (const dependent of entry.dependents) this.#dirty.add(dependent);
    this.#schedule();
    return true;
  }

  #evaluate(entry: Entry): void {
    if (!entry.compute) return;
    const inputs = entry.deps.map((dep) => this.#nodes.get(dep)?.record);
    const result = entry.compute(inputs);
    if (result === undefined) return;
    const newest = inputs.reduce<string | undefined>(
      (latest, input) => input?.observedAt && (!latest || input.observedAt > latest) ? input.observedAt : latest,
      undefined,
    );
    this.#apply(entry, result, newest);
  }

  /** Shallowest dirty node first: an input always recomputes before anything that reads it. */
  #recompute(): void {
    while (this.#dirty.size) {
      let next: NodeId | undefined;
      let depth = Infinity;
      for (const node of this.#dirty) {
        const candidate = this.#nodes.get(node)?.depth ?? 0;
        if (candidate < depth) {
          depth = candidate;
          next = node;
        }
      }
      this.#dirty.delete(next!);
      const entry = this.#nodes.get(next!);
      if (entry) this.#evaluate(entry);
    }
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      if (this.#scheduled) this.flush();
    });
  }

  #retain(node: NodeId): void {
    const count = (this.#retained.get(node) ?? 0) + 1;
    this.#retained.set(node, count);
    if (count === 1) for (const listener of this.#retainListeners) listener(node);
  }

  #release(node: NodeId): void {
    const count = (this.#retained.get(node) ?? 0) - 1;
    if (count > 0) {
      this.#retained.set(node, count);
      return;
    }
    this.#retained.delete(node);
    for (const listener of this.#releaseListeners) listener(node);
  }
}
