/**
 * The page's cache of node records and who wants them. Pure: no transport,
 * no DOM, so `bun test` drives it directly and the state client stays a thin
 * shell around it. A record is `stale` until the stream has confirmed it in
 * this connection (a seeded record, or any record after the stream dropped);
 * components show "Last read {time}" for stale records instead of "Read".
 */
import type { NodeId, NodeRecord, StreamObserved, Tier } from "../../state/protocol.ts";

export interface StoredRecord<V = unknown> extends NodeRecord<V> {
  readonly stale: boolean;
}

export type StoreListener = (record: StoredRecord) => void;

export interface Wanted {
  /** Every node with at least one subscriber, sorted so equal sets give equal stream URLs. */
  readonly nodes: NodeId[];
  /** `live` as soon as one subscriber asks for it; the page has one stream. */
  readonly tier: Tier;
}

interface Subscriber {
  readonly listener: StoreListener;
  readonly tier: Tier;
}

export class StateStore {
  readonly #records = new Map<NodeId, StoredRecord>();
  readonly #subscribers = new Map<NodeId, Set<Subscriber>>();

  constructor(seed: readonly NodeRecord[] = []) {
    for (const record of seed) this.#records.set(record.node, { ...record, stale: true });
  }

  /** Register interest; the listener is not called until a record changes. Returns the release. */
  subscribe(node: NodeId, listener: StoreListener, tier: Tier): () => void {
    const subscriber: Subscriber = { listener, tier };
    let set = this.#subscribers.get(node);
    if (!set) {
      set = new Set();
      this.#subscribers.set(node, set);
    }
    set.add(subscriber);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#subscribers.get(node);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.#subscribers.delete(node);
    };
  }

  read(node: NodeId): StoredRecord | undefined {
    return this.#records.get(node);
  }

  /** How many subscribers a node has right now. */
  count(node: NodeId): number {
    return this.#subscribers.get(node)?.size ?? 0;
  }

  /** A `state` frame or a snapshot record: replaces the cache entry and confirms it. */
  apply(record: NodeRecord): StoredRecord {
    const stored: StoredRecord = { ...record, stale: false };
    this.#records.set(record.node, stored);
    this.#notify(record.node, stored);
    return stored;
  }

  /** An `observed` frame: polls that changed nothing, so only `observedAt` moves. */
  observed(map: StreamObserved): void {
    for (const [node, observedAt] of Object.entries(map)) {
      const current = this.#records.get(node as NodeId);
      if (!current) continue;
      const stored: StoredRecord = { ...current, observedAt, stale: false };
      this.#records.set(current.node, stored);
      this.#notify(current.node, stored);
    }
  }

  /** The stream dropped or the page hid: nothing cached is confirmed any more. */
  markStale(): void {
    for (const [node, record] of this.#records) {
      if (record.stale) continue;
      const stored: StoredRecord = { ...record, stale: true };
      this.#records.set(node, stored);
      this.#notify(node, stored);
    }
  }

  wanted(): Wanted {
    const nodes = [...this.#subscribers.keys()].sort();
    let tier: Tier = "glance";
    for (const set of this.#subscribers.values()) {
      for (const subscriber of set) if (subscriber.tier === "live") tier = "live";
    }
    return { nodes, tier };
  }

  #notify(node: NodeId, record: StoredRecord): void {
    const set = this.#subscribers.get(node);
    if (!set) return;
    for (const subscriber of [...set]) subscriber.listener(record);
  }
}
