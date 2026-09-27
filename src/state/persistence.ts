/**
 * Keeping state across a restart, so the house comes back live rather than
 * blank.
 *
 * The volume objection to this does not survive contact with how the graph
 * already works. `Graph.#apply` fingerprints every result: an identical
 * fingerprint keeps the version, refreshes `observedAt` only, and lands in the
 * coalesced `observed` map, while a real change bumps the version and lands in
 * `state`. Those are exactly the two buckets a persistence layer wants, and the
 * flush already computes both. So writes track *state changes*, not poll
 * frequency: a relay on since Tuesday is one row, last written Tuesday, however
 * often it is read.
 *
 * Restoring is the harder half, because a restored value is *last known*, not
 * current — the relay may have been switched by hand while the process was
 * down, and `PRODUCT.md` says the interface never dresses an unknown as a
 * value. The mechanism for saying so already exists and is already on this
 * path: the browser marks every seeded record stale until the stream confirms
 * it and renders it as "Last read {time}". A restored record is a seeded
 * record. What is added here is only the age: a page seed is seconds old, a
 * restored one can be days old, and `isCold` is what tells them apart.
 */
import type { Graph } from "./graph";
import { isNodeId, type NodeId, type NodeRecord } from "./protocol";
import type { GraphStore, StoredState } from "../graph/store";

/** How often freshness-only refreshes are flushed, rather than one write per poll. */
export const TOUCH_INTERVAL_MS = 30_000;

/**
 * Beyond this, a record is no longer "what things are doing" but "what they
 * were last seen doing", and must be presented as such. Generous enough that an
 * ordinary page seed, seconds old, is never called cold.
 */
export const COLD_AFTER_MS = 60_000;

export function isCold(observedAt: string | undefined, now = Date.now()): boolean {
  if (!observedAt) return true;
  const seen = Date.parse(observedAt);
  return !Number.isFinite(seen) || now - seen > COLD_AFTER_MS;
}

export interface PersistenceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: PersistenceTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface PersistenceOptions {
  readonly timers?: PersistenceTimers;
  readonly intervalMs?: number;
}

/**
 * Writes a graph's records through to the store and puts them back on boot.
 * Subscribing rather than being called by the graph keeps the graph free of any
 * knowledge that a database exists.
 */
export class StatePersistence {
  readonly #pending = new Map<NodeId, string>();
  readonly #timers: PersistenceTimers;
  #ticker: unknown;
  #subscription: { close(): void } | undefined;

  constructor(private readonly graph: Graph, private readonly store: GraphStore, options: PersistenceOptions = {}) {
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#ticker = this.#timers.set(() => this.flush(), options.intervalMs ?? TOUCH_INTERVAL_MS);
  }

  /**
   * Put stored records back into the graph. Runs before the first request is
   * served: restoring after a page had rendered would *cause* the flash it
   * exists to remove.
   *
   * A value is revalidated by whoever reads it, not here; what this does refuse
   * is a row whose node is not one the graph knows any more.
   */
  restore(known?: (node: NodeId) => boolean): number {
    let restored = 0;
    for (const row of this.store.loadState()) {
      if (!isNodeId(row.node)) continue;
      if (known && !known(row.node)) continue;
      if (row.value === undefined && !row.fault) continue;
      if (row.value !== undefined && row.fault) this.graph.publish(row.node, { value: row.value }, row.observedAt);
      this.graph.publish(
        row.node,
        row.fault ? { fault: { code: row.fault.code as never, message: row.fault.message } } : { value: row.value },
        row.observedAt,
      );
      restored += 1;
    }
    return restored;
  }

  /** Start writing changes through. Returns nothing; use `stop` to detach. */
  watch(nodes: readonly NodeId[]): void {
    this.#subscription?.close();
    this.#subscription = this.graph.subscribe(
      nodes,
      (record) => this.#save(record),
      (observed) => {
        for (const [node, at] of Object.entries(observed)) {
          if (isNodeId(node)) this.#pending.set(node, at);
        }
      },
    );
  }

  #save(record: NodeRecord): void {
    this.#pending.delete(record.node);
    this.store.saveState(record.node, {
      node: record.node,
      version: record.version,
      ...(record.value === undefined ? {} : { value: record.value }),
      ...(record.fault ? { fault: { code: record.fault.code, message: record.fault.message } } : {}),
      ...(record.observedAt ? { observedAt: record.observedAt } : {}),
      updatedAt: record.updatedAt,
    });
  }

  /** Write the coalesced freshness refreshes. Called on a timer, and on stop. */
  flush(): void {
    if (!this.#pending.size) return;
    const batch = new Map(this.#pending);
    this.#pending.clear();
    this.store.touchState(batch);
  }

  stop(): void {
    this.flush();
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#timers.clear(this.#ticker);
    this.#ticker = undefined;
  }
}
