/**
 * The graph on disk.
 *
 * SQLite through `bun:sqlite`, which is already how tags and the Reveal photo
 * archive persist: no new dependency, real transactions, and indexes that make
 * the reverse lookup as cheap as the forward one.
 *
 * What it buys is durable identity. An element key is a deterministic function
 * of a thing's position in the config *and the schemas*, so it changes when a
 * schema's shape changes — move `brightnessPercent` under `state.brightness`
 * and every property key in the house changes at once. That makes it the right
 * key for *matching* a rebuilt desired set against what was here before, and
 * the wrong one for anything a person attached to a node. So the key is demoted
 * to `naturalKey` and each node gets a UUID that never changes.
 *
 * Reconciliation only ever flows config into the graph, never back: nothing
 * here writes a device's configuration out. A node the config no longer
 * declares is tombstoned rather than deleted, so a device removed and added
 * again a week later is the *same* node, with whatever was attached to it
 * intact.
 *
 * UUIDs alone do not survive a schema being restructured — the natural key
 * changes, the match fails, and a new node appears beside a tombstoned one. The
 * `aliases` table is what closes that: one row saying a key is now another key,
 * written when the schema moves. It stays empty until something moves, and it
 * is why the table exists from the start rather than being retrofitted.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphEdge, GraphNode, Icon, NodeId } from "./types";

export const DEFAULT_GRAPH_STORE_PATH = ".hometruth/graph.sqlite";

/** A node as the store holds it: the desired-set node plus its durable identity. */
export interface StoredNode extends GraphNode {
  readonly uuid: string;
  /** False once the config stopped declaring it; kept so what was attached survives. */
  readonly present: boolean;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface Reconciliation {
  readonly nodes: readonly StoredNode[];
  readonly edges: readonly GraphEdge[];
  readonly added: number;
  readonly matched: number;
  readonly tombstoned: number;
}

interface NodeRow {
  uuid: string;
  natural_key: string;
  side: string;
  kind: string;
  name: string;
  context: string;
  page: string;
  icon: string;
  ids: string;
  schema_key: string | null;
  state_node: string | null;
  present: number;
  first_seen: string;
  last_seen: string;
}

interface StateRow {
  uuid: string;
  version: number;
  value: string | null;
  fault: string | null;
  observed_at: string | null;
  updated_at: string;
}

/** One node's stored state, in the shape the state graph already speaks. */
export interface StoredState {
  readonly node: string;
  readonly version: number;
  readonly value?: unknown;
  readonly fault?: { readonly code: string; readonly message: string };
  readonly observedAt?: string;
  readonly updatedAt: string;
}

export class GraphStore {
  readonly #db: Database;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nodes (
        uuid        TEXT PRIMARY KEY,
        natural_key TEXT NOT NULL UNIQUE,
        side        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        context     TEXT NOT NULL DEFAULT '',
        page        TEXT NOT NULL DEFAULT '',
        icon        TEXT NOT NULL,
        ids         TEXT NOT NULL DEFAULT '[]',
        schema_key  TEXT,
        state_node  TEXT,
        present     INTEGER NOT NULL DEFAULT 1,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_by_kind ON nodes(kind, present);
      CREATE TABLE IF NOT EXISTS edges (
        from_key TEXT NOT NULL,
        to_key   TEXT NOT NULL,
        relation TEXT NOT NULL,
        label    TEXT,
        via      TEXT,
        origin   TEXT NOT NULL,
        PRIMARY KEY (from_key, to_key, relation)
      );
      CREATE INDEX IF NOT EXISTS edges_by_to ON edges(to_key, relation);
      CREATE TABLE IF NOT EXISTS aliases (
        old_natural_key TEXT PRIMARY KEY,
        new_natural_key TEXT NOT NULL,
        noted_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_state (
        uuid        TEXT PRIMARY KEY REFERENCES nodes(uuid) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        value       TEXT,
        fault       TEXT,
        observed_at TEXT,
        updated_at  TEXT NOT NULL
      );`);
  }

  close(): void { this.#db.close(); }

  /** A key that has moved: the reconciler follows this instead of tombstoning. */
  noteAlias(from: NodeId, to: NodeId, now = new Date()): void {
    this.#db.query("INSERT OR REPLACE INTO aliases (old_natural_key, new_natural_key, noted_at) VALUES (?, ?, ?)")
      .run(from, to, now.toISOString());
  }

  aliases(): ReadonlyMap<string, string> {
    const rows = this.#db.query("SELECT old_natural_key, new_natural_key FROM aliases").all() as { old_natural_key: string; new_natural_key: string }[];
    return new Map(rows.map((row) => [row.old_natural_key, row.new_natural_key]));
  }

  /** Follow a chain of aliases to wherever a key ended up. */
  #resolveKey(key: string, aliases: ReadonlyMap<string, string>): string {
    let current = key;
    for (let hops = 0; hops < 8; hops += 1) {
      const next = aliases.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  /**
   * Bring the store in line with a freshly built desired set, in one
   * transaction, and return the nodes with their durable identities attached.
   */
  reconcile(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = new Date()): Reconciliation {
    const stamp = now.toISOString();
    const aliases = this.aliases();
    const rows = this.#db.query("SELECT * FROM nodes").all() as NodeRow[];

    // Index what is stored by where its key has since moved to, so a desired
    // node carrying the new key finds the row that still carries the old one.
    const byResolved = new Map<string, NodeRow>();
    for (const row of rows) byResolved.set(this.#resolveKey(row.natural_key, aliases), row);

    let added = 0;
    let matched = 0;
    const out: StoredNode[] = [];
    const claimed = new Set<string>();

    // Keyed on uuid, not natural_key, because an alias means the key itself can
    // change while the node stays the same.
    const upsert = this.#db.query(`INSERT INTO nodes (uuid, natural_key, side, kind, name, context, page, icon, ids, schema_key, state_node, present, first_seen, last_seen)
      VALUES ($uuid, $key, $side, $kind, $name, $context, $page, $icon, $ids, $schema, $state, 1, $first, $last)
      ON CONFLICT(uuid) DO UPDATE SET
        natural_key = $key, side = $side, kind = $kind, name = $name, context = $context, page = $page,
        icon = $icon, ids = $ids, schema_key = $schema, state_node = $state, present = 1, last_seen = $last`);
    const tombstone = this.#db.query("UPDATE nodes SET present = 0 WHERE uuid = ?");
    const clearEdges = this.#db.query("DELETE FROM edges");
    const addEdge = this.#db.query("INSERT OR REPLACE INTO edges (from_key, to_key, relation, label, via, origin) VALUES (?, ?, ?, ?, ?, ?)");

    this.#db.transaction(() => {
      for (const node of nodes) {
        const before = byResolved.get(node.id);
        const uuid = before?.uuid ?? randomUUID();
        if (before) { matched += 1; claimed.add(before.uuid); } else added += 1;
        upsert.run({
          uuid, key: node.id, side: node.side, kind: node.kind, name: node.name,
          context: node.context, page: node.page, icon: JSON.stringify(node.icon),
          ids: JSON.stringify(node.ids), schema: node.schema ?? null, state: node.stateNode ?? null,
          first: before?.first_seen ?? stamp, last: stamp,
        });
        out.push({ ...node, uuid, present: true, firstSeen: before?.first_seen ?? stamp, lastSeen: stamp });
      }

      for (const row of rows) {
        if (!claimed.has(row.uuid)) tombstone.run(row.uuid);
      }

      // Edges are cheap and wholly derived; replacing them is simpler and safer
      // than diffing, and it cannot leave one pointing at something gone.
      clearEdges.run();
      for (const edge of edges) {
        addEdge.run(edge.from, edge.to, edge.relation, edge.label ?? null, edge.via ?? null, edge.origin);
      }
    })();

    const tombstoned = rows.filter((row) => !claimed.has(row.uuid) && row.present === 1).length;
    return { nodes: out, edges, added, matched, tombstoned };
  }

  /** Nodes the config no longer declares, still holding whatever was attached to them. */
  tombstoned(): readonly StoredNode[] {
    const rows = this.#db.query("SELECT * FROM nodes WHERE present = 0").all() as NodeRow[];
    return rows.map((row) => hydrate(row));
  }

  uuidFor(key: NodeId): string | undefined {
    const row = this.#db.query("SELECT uuid FROM nodes WHERE natural_key = ?").get(key) as { uuid: string } | null;
    return row?.uuid ?? undefined;
  }

  /**
   * The node behind a state id such as `device/relay`.
   *
   * State arrives keyed the way the state graph speaks, which is not how the
   * graph addresses a node; `state_node` is the column that joins the two.
   */
  uuidForStateNode(stateNode: string): string | undefined {
    const row = this.#db.query("SELECT uuid FROM nodes WHERE state_node = ?").get(stateNode) as { uuid: string } | null;
    return row?.uuid ?? undefined;
  }

  /**
   * Write one node's state. Called for a real change; a poll that found the
   * same value again refreshes `observed_at` through `touch` instead, which is
   * why write volume tracks changes rather than poll frequency.
   */
  saveState(stateNode: string, record: StoredState): void {
    const uuid = this.uuidForStateNode(stateNode);
    if (!uuid) return;
    this.#db.query(`INSERT INTO node_state (uuid, version, value, fault, observed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET version = excluded.version, value = excluded.value,
        fault = excluded.fault, observed_at = excluded.observed_at, updated_at = excluded.updated_at`)
      .run(uuid, record.version,
        record.value === undefined ? null : JSON.stringify(record.value),
        record.fault ? JSON.stringify(record.fault) : null,
        record.observedAt ?? null, record.updatedAt);
  }

  /** Refresh freshness only, for polls that changed nothing. Batched by the caller. */
  touchState(entries: ReadonlyMap<string, string>): void {
    if (!entries.size) return;
    const update = this.#db.query("UPDATE node_state SET observed_at = ? WHERE uuid = (SELECT uuid FROM nodes WHERE state_node = ?)");
    this.#db.transaction(() => {
      for (const [stateNode, observedAt] of entries) update.run(observedAt, stateNode);
    })();
  }

  /** Every stored record, by natural key, for seeding the graph at boot. */
  loadState(): readonly StoredState[] {
    const rows = this.#db.query(`SELECT nodes.state_node AS key, node_state.* FROM node_state
      JOIN nodes ON nodes.uuid = node_state.uuid WHERE nodes.state_node IS NOT NULL`).all() as (StateRow & { key: string })[];
    return rows.map((row) => ({
      node: row.key,
      version: row.version,
      ...(row.value === null ? {} : { value: JSON.parse(row.value) as unknown }),
      ...(row.fault === null ? {} : { fault: JSON.parse(row.fault) as { code: string; message: string } }),
      ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
      updatedAt: row.updated_at,
    }));
  }

  /** Remove tombstoned nodes and anything hanging off them. Never automatic. */
  prune(): number {
    const before = this.#db.query("SELECT COUNT(*) AS n FROM nodes WHERE present = 0").get() as { n: number };
    this.#db.query("DELETE FROM nodes WHERE present = 0").run();
    return before.n;
  }
}

function hydrate(row: NodeRow): StoredNode {
  return {
    id: row.natural_key,
    uuid: row.uuid,
    side: row.side === "schema" ? "schema" : "instance",
    kind: row.kind as StoredNode["kind"],
    name: row.name,
    context: row.context,
    page: row.page,
    icon: JSON.parse(row.icon) as Icon,
    ids: JSON.parse(row.ids) as string[],
    ...(row.schema_key ? { schema: row.schema_key } : {}),
    ...(row.state_node ? { stateNode: row.state_node } : {}),
    present: row.present === 1,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}
