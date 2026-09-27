/** Build topology from already-known domain data. This module performs no I/O. */
import type { KindleConfig } from "../kindle/config";
import type { Site } from "../site";
import { Graph } from "./graph";
import { buildInstanceGraph, CATALOGS, catalogNode, type DiscoveredSensor, type InstanceSnapshot, type SavedSignal } from "./instance-graph";
import { schemaGraph } from "./schema-graph";
import { buildTagGraph, type TagSnapshot } from "./tag-graph";
import type { TagStore } from "../tags/store";
import type { GraphEdge, Icon, NodeId } from "./types";

export interface SnapshotSources {
  readonly site: Site;
  readonly signals?: ReadonlyMap<string, readonly SavedSignal[]>;
  readonly kindle?: KindleConfig;
  readonly discoveredSensors?: ReadonlyMap<string, readonly DiscoveredSensor[]>;
  readonly tags?: Pick<TagStore, "list" | "names" | "assignments">;
  readonly icons?: ReadonlyMap<NodeId, Icon>;
  readonly siteTitle?: string;
}

/** Configuration and previously observed identities, never live sensor readings. */
export function collectSnapshot(sources: SnapshotSources): InstanceSnapshot {
  const { site } = sources;
  const groups = site.deviceGroups;
  const tags: TagSnapshot | undefined = sources.tags
    ? { tags: sources.tags.list(), names: sources.tags.names(), assignments: sources.tags.assignments() }
    : undefined;
  return {
    site, groups, pages: site.pages(groups), references: site.deviceReferences,
    discoveredSensors: sources.discoveredSensors ?? new Map(),
    signals: sources.signals ?? new Map(),
    ...(tags ? { tags } : {}),
    ...(sources.kindle ? { kindle: sources.kindle } : {}),
    ...(sources.icons ? { icons: sources.icons } : {}),
    ...(sources.siteTitle ? { siteTitle: sources.siteTitle } : {}),
  };
}

/**
 * Both halves, joined, with the schema side filed under the root's catalogs.
 *
 * Without that last step the schema graph floats free: schemas, models and
 * event types have no path back to HomeTruth itself, and any view that works
 * outwards from the root simply cannot see them. Their own controls and
 * properties already hang off them through `defines`.
 */
export function buildGraph(snapshot: InstanceSnapshot, now = () => new Date()): Graph {
  const schema = schemaGraph();
  const instance = buildInstanceGraph(snapshot);
  const tags = buildTagGraph(snapshot.tags ?? { tags: [], names: [], assignments: new Map() });

  const catalogs = new Map<string, NodeId>();
  for (const catalog of CATALOGS) for (const kind of catalog.kinds) catalogs.set(kind, catalogNode(catalog.id));
  const filed: GraphEdge[] = [];
  for (const node of schema.nodes) {
    const catalog = catalogs.get(node.kind);
    // A control or property definition belongs to its schema, not to a catalog.
    if (!catalog || node.ids.length > 1) continue;
    filed.push({ from: catalog, to: node.id, relation: "contains", origin: "structure" });
  }
  // The tag side needs the same anchor, or the ontology floats free of the root
  // and nothing working outwards from HomeTruth can reach a room. Only the
  // names are filed: each value already hangs off its name through `declares`.
  for (const node of tags.nodes) {
    const catalog = catalogs.get(node.kind);
    if (catalog) filed.push({ from: catalog, to: node.id, relation: "contains", origin: "structure" });
  }

  return new Graph({
    nodes: [...schema.nodes, ...instance.nodes, ...tags.nodes],
    edges: [...schema.edges, ...instance.edges, ...filed, ...tags.edges],
    generatedAt: now().toISOString(),
  });
}
